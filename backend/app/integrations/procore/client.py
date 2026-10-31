"""Procore REST client: auth headers, Procore-Company-Id, pagination, rate limits, bounded retries."""

import logging
import random
import re
import time
from collections.abc import Callable
from typing import Any

from sqlalchemy.orm import Session

from app.integrations.procore import oauth
from app.integrations.procore import settings as ps
from app.integrations.procore.transport import (
    LiveTransport,
    ProcoreAuthError,
    ProcoreRejected,
    ProcoreUnavailable,
    Resp,
    Transport,
    error_text,
)
from app.models import ProcoreConnection

log = logging.getLogger("pcx.procore")

IDEMPOTENT = {"GET", "HEAD", "PUT", "DELETE"}


def transport_for(environment: str) -> Transport:
    """SIMULATED connections always use the in-process fake; anything else goes over HTTPS."""
    if environment == ps.SIMULATED:
        from app.integrations.procore.simulated import FAKE

        return FAKE
    login, api = ps.base_urls(environment)
    return LiveTransport(login, api, ps.procore_settings().timeout_seconds)


class ProcoreClient:
    def __init__(self, db: Session, conn: ProcoreConnection, transport: Transport | None = None, sleep: Callable[[float], None] = time.sleep):
        self.db = db
        self.conn = conn
        self.transport = transport or transport_for(conn.environment)
        self.sleep = sleep
        self.settings = ps.procore_settings()
        self.per_page = min(100, self.settings.per_page)
        self.rate_limit: dict[str, str | None] = {"limit": None, "remaining": None, "reset": None}
        self.calls = 0

    # ------------------------------------------------------------------ core request
    def request(self, method: str, path: str, *, params: dict | None = None, json: Any = None) -> Resp:
        token = oauth.renew(self.db, self.conn, self.transport)
        refreshed = False
        attempt = 0
        while True:
            attempt += 1
            self.calls += 1
            headers = {"Authorization": f"Bearer {token}", "Procore-Company-Id": str(self.conn.company_id), "Accept": "application/json"}
            r = self.transport.request(method, "api", path, params=params, json=json, headers=headers)
            self._note_rate(r)
            if r.status == 401 and not refreshed:
                token = oauth.renew(self.db, self.conn, self.transport, force=True)
                refreshed = True
                continue
            if r.status == 401:
                raise ProcoreAuthError("Procore rejected the access token after refresh; re-authorize the connection", 401)
            if r.status == 429:
                # A 429 was not processed by Procore, so waiting and retrying is safe for any method.
                if attempt > self.settings.max_retries:
                    raise ProcoreUnavailable("Procore rate limit still exhausted after retries", 429)
                self._wait(self._reset_wait(r))
                continue
            if r.status >= 500:
                retry_after = self._retry_after(r)
                if method.upper() in IDEMPOTENT and attempt <= self.settings.max_retries:
                    self._wait(retry_after if retry_after is not None else min(30.0, 2**attempt + random.random()))
                    continue
                raise ProcoreUnavailable(f"Procore returned {r.status}; retry later", r.status, r.body)
            if r.status >= 400:
                raise ProcoreRejected(f"Procore rejected {method} {self._safe_path(path)} ({r.status}): {error_text(r.body)}", r.status, r.body)
            return r

    def get(self, path: str, **params) -> Any:
        return self.request("GET", path, params=params or None).body

    def get_all(self, path: str, params: dict | None = None, *, v2: bool = False) -> tuple[list, int]:
        """Follow page/per_page until the Link header has no rel=next (or a short page arrives)."""
        out: list = []
        page = 1
        while page <= self.settings.max_pages:
            r = self.request("GET", path, params={**(params or {}), "page": page, "per_page": self.per_page})
            items = (r.body or {}).get("data", []) if v2 and isinstance(r.body, dict) else (r.body or [])
            out.extend(items)
            link = r.headers.get("link", "")
            total = r.headers.get("total")
            if 'rel="next"' not in link or not items or len(items) < self.per_page or (total and total.isdigit() and len(out) >= int(total)):
                return out, page
            page += 1
        raise ProcoreUnavailable(f"Pagination exceeded {self.settings.max_pages} pages for {self._safe_path(path)}")

    # ------------------------------------------------------------------ helpers
    def _note_rate(self, r: Resp) -> None:
        for key in ("limit", "remaining", "reset"):
            v = r.headers.get(f"x-rate-limit-{key}")
            if v is not None:
                self.rate_limit[key] = v

    def _reset_wait(self, r: Resp) -> float:
        reset = r.headers.get("x-rate-limit-reset")
        if reset and reset.isdigit():
            return max(0.0, int(reset) - time.time())
        ra = self._retry_after(r)
        return ra if ra is not None else 5.0

    @staticmethod
    def _retry_after(r: Resp) -> float | None:
        v = r.headers.get("retry-after")
        if v and re.fullmatch(r"\d+(\.\d+)?", v.strip()):
            return float(v)
        return None

    def _wait(self, seconds: float) -> None:
        if seconds > self.settings.max_rate_limit_wait_seconds:
            raise ProcoreUnavailable(f"Procore asked to wait {int(seconds)}s; deferring to a later run")
        if seconds > 0:
            self.sleep(seconds)

    @staticmethod
    def _safe_path(path: str) -> str:
        return path.split("?", 1)[0]

    # ------------------------------------------------------------------ resources (documented paths)
    def companies(self) -> list:
        return self.get("/rest/v1.0/companies") or []

    def projects(self) -> tuple[list, int]:
        return self.get_all("/rest/v1.1/projects", {"company_id": self.conn.company_id})

    def vendors(self) -> tuple[list, int]:
        return self.get_all("/rest/v1.1/vendors", {"company_id": self.conn.company_id})

    def cost_codes(self, project_id: str) -> tuple[list, int]:
        return self.get_all("/rest/v1.0/cost_codes", {"project_id": project_id})

    def purchase_order_contracts(self, project_id: str) -> tuple[list, int]:
        return self.get_all("/rest/v1.0/purchase_order_contracts", {"project_id": project_id})

    def commitment_contracts_path(self, project_id: str) -> str:
        return f"/rest/v2.0/companies/{self.conn.company_id}/projects/{project_id}/commitment_contracts"

    def equipment_register_path(self, project_id: str) -> str:
        return f"/rest/v2.1/companies/{self.conn.company_id}/projects/{project_id}/equipment_register"

    def uploads_path(self, project_id: str) -> str:
        return f"/rest/v1.1/projects/{project_id}/uploads"
