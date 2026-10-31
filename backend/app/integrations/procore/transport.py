"""HTTP transport abstraction for Procore.

`LiveTransport` performs real HTTPS calls with httpx. `app.integrations.procore.simulated.FakeProcore`
implements the same interface in-process. `ProcoreClient` (client.py) sits on top of either one, so
pagination, rate-limit handling, token refresh and error classification are exercised identically in
SIMULATED and LIVE mode.
"""

from dataclasses import dataclass, field
from typing import Any, Protocol

import httpx


@dataclass
class Resp:
    status: int
    headers: dict[str, str] = field(default_factory=dict)  # lower-case keys
    body: Any = None


class Transport(Protocol):
    def request(
        self,
        method: str,
        base: str,  # "login" | "api"
        path: str,
        *,
        params: dict | None = None,
        json: Any = None,
        data: dict | None = None,
        headers: dict | None = None,
    ) -> Resp: ...


class ProcoreError(Exception):
    """Classified Procore failure. Messages never contain tokens or secrets."""

    retryable = False
    outcome_unknown = False

    def __init__(self, message: str, status: int | None = None, body: Any = None):
        super().__init__(message)
        self.message = message
        self.status = status
        self.body = body


class ProcoreUnavailable(ProcoreError):
    """Not applied / safe to retry later (connect failure, 429/5xx after bounded retries)."""

    retryable = True


class ProcoreTimeout(ProcoreError):
    """Request may have reached Procore; outcome unknown. Never blindly replay a write."""

    retryable = True
    outcome_unknown = True


class ProcoreRejected(ProcoreError):
    """4xx business/validation rejection. Needs a human or a mapping fix."""


class ProcoreAuthError(ProcoreRejected):
    """Token invalid/revoked after a refresh attempt; connection needs re-authorization."""


def error_text(body: Any, limit: int = 400) -> str:
    """Short, safe description of a Procore error body (no payload echo beyond the error fields)."""
    if isinstance(body, dict):
        for key in ("errors", "error_description", "error", "message"):
            if key in body:
                return str(body[key])[:limit]
        return "error response"
    if isinstance(body, str):
        return body[:limit]
    return "error response"


class LiveTransport:
    def __init__(self, login_base: str, api_base: str, timeout: float):
        self.bases = {"login": login_base, "api": api_base}
        self.timeout = timeout

    def request(self, method, base, path, *, params=None, json=None, data=None, headers=None) -> Resp:
        url = self.bases[base] + path
        try:
            with httpx.Client(timeout=self.timeout) as http:
                r = http.request(method, url, params=params, json=json, data=data, headers=headers)
        except (httpx.ConnectError, httpx.ConnectTimeout, httpx.PoolTimeout) as exc:
            raise ProcoreUnavailable(f"Procore unreachable: {type(exc).__name__}") from exc
        except httpx.TimeoutException as exc:  # read/write timeout after the request was sent
            raise ProcoreTimeout(f"Procore did not answer in {self.timeout}s; outcome unknown") from exc
        except httpx.HTTPError as exc:
            raise ProcoreUnavailable(f"Procore transport error: {type(exc).__name__}") from exc
        try:
            body = r.json() if r.content else None
        except ValueError:
            body = r.text
        return Resp(r.status_code, {k.lower(): v for k, v in r.headers.items()}, body)
