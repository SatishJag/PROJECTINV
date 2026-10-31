"""In-process fake of the Procore REST/OAuth surface used by SIMULATED mode and the tests.

It models only documented behaviour this connector relies on: single-use authorization codes
(10 min), 5400 s access tokens, rotating refresh tokens, client-credentials tokens without refresh,
the Procore-Company-Id header, v1 page/per_page pagination with Total/Per-Page/Link headers, v2
`data` envelopes with string ids, X-Rate-Limit-* headers and 429 responses. Write behaviour follows
`app.integrations.sim_state` for target PROCORE:

    ACK        apply and answer 200/201
    REJECT     422 validation error, nothing applied
    TIMEOUT    apply, then lose the answer (ProcoreTimeout) - the outcome is unknown to the caller
    TRANSIENT  writes answer 503 + Retry-After; reads answer 429 on every other request

Tokens are signed (itsdangerous) so a seeded connection keeps working after a server restart;
only the used-code / revoked-token sets are process-local.
"""

import copy
import re
import secrets
import threading
import time
from datetime import UTC, datetime
from typing import Any

from itsdangerous import BadSignature, SignatureExpired, URLSafeTimedSerializer

from app.config import get_settings
from app.integrations import sim_state
from app.integrations.procore.transport import ProcoreTimeout, Resp

COMPANY_ID = "562949953421312"
COMPANY_NAME = "Demo Data Centre Owner"
ACCESS_TTL = 5400
CODE_TTL = 600
RATE_LIMIT = 3600

PROJECT_IDS = {"BKK1": "598134325870420", "BKK2": "598134325870421", "BKK3": "598134325870433"}
VENDOR_IDS = {"MERIDIAN": "7740011", "NORTHWIND": "7740012", "POLAR": "7740013", "SIAM": "7740099"}


def _base_dataset() -> dict:
    p1, p2, p3 = (int(PROJECT_IDS[k]) for k in ("BKK1", "BKK2", "BKK3"))
    return {
        "companies": [{"id": int(COMPANY_ID), "name": COMPANY_NAME, "is_active": True}],
        "projects": [
            {"id": p1, "name": "Bangkok DC1", "project_number": "BKK1", "active": True, "company": {"id": int(COMPANY_ID)}, "updated_at": "2026-09-01T03:00:00Z"},
            {"id": p2, "name": "Bangkok DC2", "project_number": "BKK2", "active": True, "company": {"id": int(COMPANY_ID)}, "updated_at": "2026-09-01T03:00:00Z"},
            {"id": p3, "name": "Bangkok DC3 (feasibility)", "project_number": "BKK3", "active": True, "company": {"id": int(COMPANY_ID)}, "updated_at": "2026-09-15T03:00:00Z"},
        ],
        "vendors": [
            {"id": int(VENDOR_IDS["MERIDIAN"]), "name": "Meridian Gensets Ltd", "abbreviated_name": "MERIDIAN", "is_active": True, "updated_at": "2026-08-01T00:00:00Z"},
            {"id": int(VENDOR_IDS["NORTHWIND"]), "name": "Northwind Power Systems", "abbreviated_name": "NORTHWIND", "is_active": True, "updated_at": "2026-08-01T00:00:00Z"},
            {"id": int(VENDOR_IDS["POLAR"]), "name": "Polar Cooling Co", "abbreviated_name": "POLAR", "is_active": True, "updated_at": "2026-08-01T00:00:00Z"},
            {"id": int(VENDOR_IDS["SIAM"]), "name": "Siam Heavy Rigging Co", "abbreviated_name": "SIAMRIG", "is_active": True, "updated_at": "2026-08-01T00:00:00Z"},
        ],
        "cost_codes": {
            str(pid): [
                {"id": pid * 10 + 1, "code": "3213", "full_code": "26-3213", "name": "Engine generators", "updated_at": "2026-07-01T00:00:00Z"},
                {"id": pid * 10 + 2, "code": "6400", "full_code": "23-6400", "name": "Central cooling plant", "updated_at": "2026-07-01T00:00:00Z"},
                {"id": pid * 10 + 3, "code": "3000", "full_code": "03-3000", "name": "Cast-in-place concrete", "updated_at": "2026-07-01T00:00:00Z"},
            ]
            for pid in (p1, p2)
        },
        "commitments": [
            {"id": 562949955001001, "project_id": p1, "number": "PO-BKK-GEN-0001", "title": "Standby generator sets 2500 kVA (BKK programme)", "status": "Approved", "vendor": {"id": int(VENDOR_IDS["MERIDIAN"])}, "updated_at": "2026-09-20T08:00:00Z"},
            {"id": 562949955001002, "project_id": p1, "number": "PO-BKK-CHL-0001", "title": "Air-cooled chillers 1500 kW", "status": "Approved", "vendor": {"id": int(VENDOR_IDS["POLAR"])}, "updated_at": "2026-09-21T08:00:00Z"},
            {"id": 562949955001003, "project_id": p1, "number": "SC-BKK1-CIV-0042", "title": "Generator yard civil works", "status": "Draft", "vendor": {"id": int(VENDOR_IDS["SIAM"])}, "updated_at": "2026-09-22T08:00:00Z"},
        ],
        "line_items": {
            "562949955001001": [{"id": 1, "description": "GEN-MER-2500S", "quantity": 10, "uom": "EA"}],
            "562949955001002": [{"id": 1, "description": "CH-POL-1500A", "quantity": 4, "uom": "EA"}],
        },
        "equipment": [],
        "uploads": [],
        "hooks": [],
    }


def _now_iso() -> str:
    return datetime.now(UTC).strftime("%Y-%m-%dT%H:%M:%SZ")


class FakeProcore:
    """Fake Procore. Thread-safe; one process-wide instance (`FAKE`)."""

    def __init__(self) -> None:
        self._lock = threading.RLock()
        self.reset()

    # ------------------------------------------------------------------ state
    def reset(self) -> None:
        with getattr(self, "_lock", threading.RLock()):
            self.data = _base_dataset()
            self.used_codes: set[str] = set()
            self.revoked: set[str] = set()
            self.calls: list[tuple[str, str]] = []
            self._toggle = 0
            self._remaining = RATE_LIMIT
            self._seq = 0

    def _signer(self) -> URLSafeTimedSerializer:
        return URLSafeTimedSerializer(get_settings().secret_key, salt="pcx-procore-simulator")

    def _token(self, kind: str, **claims) -> str:
        return f"sim-{kind}-" + self._signer().dumps({"k": kind, "n": secrets.token_hex(8), **claims})

    def _read(self, token: str | None, kind: str, max_age: int | None) -> dict | None:
        prefix = f"sim-{kind}-"
        if not token or not token.startswith(prefix):
            return None
        try:
            claims = self._signer().loads(token[len(prefix):], max_age=max_age)
        except (BadSignature, SignatureExpired):
            return None
        if claims.get("k") != kind or claims.get("n") in self.revoked:
            return None
        return claims

    def issue_authorization_code(self, client_id: str, redirect_uri: str) -> str:
        """Stands in for the user approving the app on login.procore.com/oauth/authorize."""
        return self._token("code", cid=client_id, ru=redirect_uri)

    def _next_id(self) -> int:
        self._seq += 1
        return 900000000 + self._seq

    # ------------------------------------------------------------------ entry
    def request(self, method, base, path, *, params=None, json=None, data=None, headers=None) -> Resp:
        with self._lock:
            self.calls.append((method, path))
            params = {k: v for k, v in (params or {}).items() if v is not None}
            headers = {k.lower(): v for k, v in (headers or {}).items()}
            if base == "login":
                return self._login(method, path, data or json or {}, headers)
            return self._api(method, path, params, json, headers)

    # ------------------------------------------------------------------ OAuth
    def _pair(self, grant: str, with_refresh: bool) -> dict:
        out = {"access_token": self._token("at", g=grant), "token_type": "bearer", "expires_in": ACCESS_TTL, "created_at": int(time.time())}
        if with_refresh:
            out["refresh_token"] = self._token("rt", g=grant)
        return out

    def _login(self, method: str, path: str, form: dict, headers: dict) -> Resp:
        bad = Resp(400, {}, {"error": "invalid_grant", "error_description": "The provided authorization grant is invalid, expired or revoked."})
        if method == "POST" and path == "/oauth/token":
            if not form.get("client_id") or not form.get("client_secret"):
                return Resp(401, {}, {"error": "invalid_client"})
            grant = form.get("grant_type")
            if grant == "authorization_code":
                claims = self._read(form.get("code"), "code", CODE_TTL)
                if not claims or claims["n"] in self.used_codes or claims.get("ru") != form.get("redirect_uri"):
                    return bad
                self.used_codes.add(claims["n"])  # single use
                return Resp(200, {}, self._pair("authorization_code", True))
            if grant == "refresh_token":
                claims = self._read(form.get("refresh_token"), "rt", None)
                if not claims:
                    return bad
                self.revoked.add(claims["n"])  # rotation: old refresh token invalid immediately
                return Resp(200, {}, self._pair("authorization_code", True))
            if grant == "client_credentials":
                return Resp(200, {}, self._pair("client_credentials", False))
            return Resp(400, {}, {"error": "unsupported_grant_type"})
        if method == "POST" and path == "/oauth/revoke":
            token = form.get("token") or ""
            for kind in ("at", "rt"):
                claims = self._read(token, kind, None)
                if claims:
                    self.revoked.add(claims["n"])
            return Resp(200, {}, {})
        if method == "GET" and path == "/oauth/token/info":
            claims = self._read(headers.get("authorization", "").removeprefix("Bearer ").strip(), "at", ACCESS_TTL)
            if not claims:
                return Resp(401, {}, {"error": "invalid_token"})
            return Resp(200, {}, {"resource_owner_id": 1001, "scopes": [], "expires_in_seconds": ACCESS_TTL, "application": {"uid": "sim-client"}})
        return Resp(404, {}, {"error": "not_found"})

    # ------------------------------------------------------------------ REST
    def _rate_headers(self) -> dict:
        self._remaining = max(0, self._remaining - 1)
        return {
            "x-rate-limit-limit": str(RATE_LIMIT),
            "x-rate-limit-remaining": str(self._remaining),
            "x-rate-limit-reset": str(int(time.time()) + 3600),
        }

    def _page(self, items: list, params: dict, path: str, v2: bool = False) -> Resp:
        default, cap = (10, 100) if v2 else (100, 100)
        per_page = max(1, min(int(params.get("per_page", default)), cap))
        page = max(1, int(params.get("page", 1)))
        total = len(items)
        chunk = items[(page - 1) * per_page : page * per_page]
        last = max(1, -(-total // per_page))
        links = []
        if page < last:
            links.append(f'<https://sandbox.procore.com{path}?page={page + 1}&per_page={per_page}>; rel="next"')
        links.append(f'<https://sandbox.procore.com{path}?page={last}&per_page={per_page}>; rel="last"')
        headers = {**self._rate_headers(), "total": str(total), "per-page": str(per_page), "link": ", ".join(links)}
        if v2:
            return Resp(200, headers, {"data": [self._v2(x) for x in chunk]})
        return Resp(200, headers, copy.deepcopy(chunk))

    @staticmethod
    def _v2(obj: dict) -> dict:
        out = copy.deepcopy(obj)
        out["id"] = str(out["id"])
        for k in ("project_id",):
            if k in out and out[k] is not None:
                out[k] = str(out[k])
        if isinstance(out.get("vendor"), dict) and "id" in out["vendor"]:
            out["vendor"]["id"] = str(out["vendor"]["id"])
        return out

    def _write_gate(self, apply) -> Resp:
        mode = sim_state.get_mode("PROCORE")
        if mode == "REJECT":
            return Resp(422, self._rate_headers(), {"errors": {"base": ["Simulated Procore validation rejection (simulator mode REJECT)"]}})
        if mode == "TRANSIENT":
            return Resp(503, {"retry-after": "1"}, {"errors": "Service temporarily unavailable (simulator mode TRANSIENT)"})
        resp = apply()
        if mode == "TIMEOUT":
            raise ProcoreTimeout("Simulated Procore timeout after the write was applied; outcome unknown")
        return resp

    def _project(self, pid: str) -> dict | None:
        return next((p for p in self.data["projects"] if str(p["id"]) == str(pid)), None)

    def _api(self, method: str, path: str, params: dict, body: Any, headers: dict) -> Resp:
        claims = self._read(headers.get("authorization", "").removeprefix("Bearer ").strip(), "at", ACCESS_TTL)
        if not claims:
            return Resp(401, {}, {"errors": "Unauthorized: access token is invalid, expired or revoked"})
        company = headers.get("procore-company-id")
        if company != COMPANY_ID:
            return Resp(403, {}, {"errors": "Procore-Company-Id header missing or not accessible to this token"})
        if method == "GET" and sim_state.get_mode("PROCORE") == "TRANSIENT":
            self._toggle += 1
            if self._toggle % 2 == 1:
                return Resp(429, {"x-rate-limit-limit": str(RATE_LIMIT), "x-rate-limit-remaining": "0", "x-rate-limit-reset": str(int(time.time()))}, {"errors": "Rate limit exceeded"})
        d = self.data
        body = body or {}
        payload = body.get("data", body) if isinstance(body, dict) else {}

        if method == "GET" and path == "/rest/v1.0/companies":
            return Resp(200, self._rate_headers(), copy.deepcopy(d["companies"]))
        if method == "GET" and path == "/rest/v1.0/me":
            return Resp(200, self._rate_headers(), {"id": 1001, "login": "integration@demo.pcx", "name": "PCX Service Account"})
        if method == "GET" and path == "/rest/v1.1/projects":
            if str(params.get("company_id")) != COMPANY_ID:
                return Resp(403, {}, {"errors": "company not accessible"})
            return self._page(d["projects"], params, path)
        if method == "GET" and path == "/rest/v1.1/vendors":
            return self._page(d["vendors"], params, path)
        m = re.fullmatch(r"/rest/v1\.0/projects/(\d+)/vendors", path)
        if method == "GET" and m:
            return self._page(d["vendors"], params, path) if self._project(m[1]) else Resp(404, {}, {"errors": "not found"})
        if method == "GET" and path == "/rest/v1.0/cost_codes":
            pid = str(params.get("project_id"))
            if not self._project(pid):
                return Resp(404, {}, {"errors": "project not found"})
            return self._page(d["cost_codes"].get(pid, []), params, path)
        m = re.fullmatch(r"/rest/v1\.0/projects/(\d+)/work_breakdown_structure/wbs_codes", path)
        if method == "GET" and m:
            return self._page([], params, path)
        if method == "GET" and path == "/rest/v1.0/purchase_order_contracts":
            pid = str(params.get("project_id"))
            if not self._project(pid):
                return Resp(404, {}, {"errors": "project not found"})
            return self._page([c for c in d["commitments"] if str(c["project_id"]) == pid], params, path)
        m = re.fullmatch(r"/rest/v1\.0/purchase_order_contracts/(\d+)/line_items", path)
        if method == "GET" and m:
            return self._page(d["line_items"].get(m[1], []), params, path)

        m = re.fullmatch(r"/rest/v2\.0/companies/(\d+)/projects/(\d+)/commitment_contracts(?:/(\d+))?", path)
        if m:
            if m[1] != COMPANY_ID or not self._project(m[2]):
                return Resp(404, {}, {"errors": "not found"})
            pid = int(m[2])
            items = [c for c in d["commitments"] if c["project_id"] == pid]
            if method == "GET" and not m[3]:
                return self._page(items, params, path, v2=True)
            if method == "POST" and not m[3]:
                def create():
                    obj = {**{k: v for k, v in payload.items() if k not in ("id", "project_id")}, "id": self._next_id(), "project_id": pid, "updated_at": _now_iso()}
                    d["commitments"].append(obj)
                    return Resp(201, self._rate_headers(), {"data": self._v2(obj)})
                return self._write_gate(create)
            if method == "PATCH" and m[3]:
                obj = next((c for c in items if str(c["id"]) == m[3]), None)
                if obj is None:
                    return Resp(404, self._rate_headers(), {"errors": "commitment not found"})
                def update():
                    obj.update({k: v for k, v in payload.items() if k not in ("id", "project_id")})
                    obj["updated_at"] = _now_iso()
                    return Resp(200, self._rate_headers(), {"data": self._v2(obj)})
                return self._write_gate(update)

        m = re.fullmatch(r"/rest/v2\.1/companies/(\d+)/projects/(\d+)/equipment_register(?:/(\d+))?", path)
        if m:
            if m[1] != COMPANY_ID or not self._project(m[2]):
                return Resp(404, {}, {"errors": "not found"})
            pid = int(m[2])
            items = [e for e in d["equipment"] if e["project_id"] == pid]
            if method == "GET" and not m[3]:
                return self._page(items, params, path, v2=True)
            if method == "POST" and not m[3]:
                def create_eq():
                    obj = {**{k: v for k, v in payload.items() if k not in ("id", "project_id")}, "id": self._next_id(), "project_id": pid, "updated_at": _now_iso()}
                    d["equipment"].append(obj)
                    return Resp(201, self._rate_headers(), {"data": self._v2(obj)})
                return self._write_gate(create_eq)
            if method == "PATCH" and m[3]:
                obj = next((e for e in items if str(e["id"]) == m[3]), None)
                if obj is None:
                    return Resp(404, self._rate_headers(), {"errors": "equipment not found"})
                def update_eq():
                    obj.update({k: v for k, v in payload.items() if k not in ("id", "project_id")})
                    obj["updated_at"] = _now_iso()
                    return Resp(200, self._rate_headers(), {"data": self._v2(obj)})
                return self._write_gate(update_eq)

        m = re.fullmatch(r"/rest/v1\.1/projects/(\d+)/uploads", path)
        if method == "POST" and m:
            if not self._project(m[1]):
                return Resp(404, {}, {"errors": "project not found"})
            def upload():
                uid = f"sim-upload-{secrets.token_hex(6)}"
                d["uploads"].append({"uuid": uid, "project_id": int(m[1]), "request": copy.deepcopy(body), "created_at": _now_iso()})
                return Resp(201, self._rate_headers(), {"uuid": uid, "url": "https://sim-uploads.invalid/put", "fields": {}})
            return self._write_gate(upload)

        if method == "POST" and path == "/rest/v1.0/webhooks/hooks":
            hook = {"id": self._next_id(), **copy.deepcopy(body.get("hook", {})), "triggers": []}
            d["hooks"].append(hook)
            return Resp(201, self._rate_headers(), {k: v for k, v in hook.items() if k != "destination_headers"})
        m = re.fullmatch(r"/rest/v1\.0/webhooks/hooks/(\d+)/triggers", path)
        if method == "POST" and m:
            hook = next((h for h in d["hooks"] if str(h["id"]) == m[1]), None)
            if hook is None:
                return Resp(404, {}, {"errors": "hook not found"})
            trig = {"id": self._next_id(), **copy.deepcopy(body.get("trigger", {}))}
            hook["triggers"].append(trig)
            return Resp(201, self._rate_headers(), trig)
        m = re.fullmatch(r"/rest/v1\.0/webhooks/hooks/(\d+)/deliveries", path)
        if method == "GET" and m:
            return self._page([], params, path)
        return Resp(404, {}, {"errors": f"No simulated route for {method} {path}"})

    # ------------------------------------------------------------------ helpers for demos/tests
    def webhook_payload(self, resource_name: str, event_type: str, resource_id: str, project_id: str | None = None, api_version: str = "v2") -> dict:
        """A delivery shaped like Procore's v2 payload (v4 uses string ids, reason, resource_type)."""
        ulid = "01J" + secrets.token_hex(12).upper()[:23]
        body = {
            "id": self._next_id(),
            "ulid": ulid,
            "timestamp": _now_iso(),
            "metadata": {"source_user_id": 1001, "source_operation_id": None, "source_application_id": None},
            "user_id": 1001,
            "company_id": int(COMPANY_ID),
            "project_id": int(project_id) if project_id else None,
            "api_version": api_version,
            "event_type": event_type,
            "resource_name": resource_name,
            "resource_id": int(resource_id),
        }
        if api_version == "v4":
            body.update({"id": str(body["id"]), "company_id": COMPANY_ID, "project_id": project_id, "resource_id": str(resource_id), "reason": event_type, "resource_type": resource_name})
        return body


FAKE = FakeProcore()


def reset() -> None:
    FAKE.reset()
