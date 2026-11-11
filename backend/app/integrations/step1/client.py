"""Client for the Step 1 register REST API (a separate Node app). One attempt per call, no retries."""

from __future__ import annotations

from typing import Any, Protocol

import httpx

from app.config import get_settings


class Step1Unavailable(Exception):
    """Step 1 could not be reached or returned something unusable. Never carries credentials."""


class Step1Client(Protocol):
    def projects(self) -> list[dict]: ...

    def register(self, step1_project_id: str) -> list[dict]: ...


class HttpStep1Client:
    def __init__(
        self,
        base_url: str,
        password: str,
        *,
        timeout: float = 20.0,
        transport: httpx.BaseTransport | None = None,
    ) -> None:
        self._base_url = base_url.rstrip("/")
        self._password = password
        self._timeout = timeout
        self._transport = transport

    def __repr__(self) -> str:
        return f"HttpStep1Client(base_url={self._base_url!r})"

    def _get(self, path: str, params: dict[str, str] | None = None) -> Any:
        headers = {"Authorization": f"Bearer {self._password}", "X-User-Name": "pcx-sync", "Accept": "application/json"}
        try:
            with httpx.Client(timeout=self._timeout, transport=self._transport) as http:
                response = http.get(f"{self._base_url}{path}", params=params, headers=headers)
        except httpx.HTTPError as exc:
            raise Step1Unavailable(f"Step 1 request failed: {type(exc).__name__}") from None
        except (httpx.InvalidURL, UnicodeError):
            # Fixed message on purpose: a UnicodeEncodeError from a non-ASCII password carries the password in .object.
            raise Step1Unavailable("Step 1 request could not be built; check the Step 1 base URL and app password") from None
        if not response.is_success:
            raise Step1Unavailable(f"Step 1 returned HTTP {response.status_code}")
        try:
            return response.json()
        except ValueError:
            raise Step1Unavailable("Step 1 returned a response that is not JSON") from None

    def projects(self) -> list[dict]:
        body = self._get("/api/projects")
        if not isinstance(body, list):
            raise Step1Unavailable("Step 1 projects response is not a list")
        return body

    def register(self, step1_project_id: str) -> list[dict]:
        body = self._get(f"/api/projects/{step1_project_id}/register", {"includeSuperseded": "true"})
        rows = body.get("rows") if isinstance(body, dict) else None
        if not isinstance(rows, list):
            raise Step1Unavailable("Step 1 register response has no rows list")
        return rows


def client_from_settings() -> Step1Client | None:
    settings = get_settings()
    if not settings.step1_base_url or not settings.step1_app_password:
        return None
    return HttpStep1Client(settings.step1_base_url, settings.step1_app_password)
