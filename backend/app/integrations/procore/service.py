"""Procore connection lifecycle: connect (simulated / client credentials / authorization code),
disconnect, status, sync and webhook registration. Network calls never run while holding domain
writes that matter: tokens are committed first, and links are idempotent so a partial run is safe.
"""

import logging

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.core import audit
from app.core.auth import Principal
from app.core.commands import bump
from app.core.errors import Conflict, DomainError
from app.integrations.procore import oauth
from app.integrations.procore import settings as ps
from app.integrations.procore.client import ProcoreClient, transport_for
from app.integrations.procore.sync import RESOURCES, Sync
from app.integrations.procore.transport import ProcoreAuthError, ProcoreError, ProcoreRejected
from app.models import ExternalObjectLink, IntegrationException, OutboxMessage, ProcoreConnection

log = logging.getLogger("pcx.procore")


def tenant_connection(db: Session, tenant_id: str) -> ProcoreConnection | None:
    """The tenant's current connection: CONNECTED first, otherwise the most recently updated row."""
    rows = list(db.scalars(select(ProcoreConnection).where(ProcoreConnection.tenant_id == tenant_id).order_by(ProcoreConnection.updated_at.desc())))
    return next((c for c in rows if c.state == "CONNECTED"), rows[0] if rows else None)


def active_connection(db: Session, tenant_id: str) -> ProcoreConnection | None:
    c = tenant_connection(db, tenant_id)
    return c if c and c.state == "CONNECTED" else None


def _get_or_create(db: Session, tenant_id: str, company_id: str, environment: str, auth_mode: str, actor: str) -> ProcoreConnection:
    current = active_connection(db, tenant_id)
    if current and current.company_id != company_id:
        raise Conflict("PROCORE_ALREADY_CONNECTED", f"Tenant is connected to Procore company {current.company_id}; disconnect first")
    conn = db.scalar(select(ProcoreConnection).where(ProcoreConnection.tenant_id == tenant_id, ProcoreConnection.company_id == company_id))
    if conn is None:
        conn = ProcoreConnection(tenant_id=tenant_id, company_id=company_id, environment=environment, auth_mode=auth_mode, created_by=actor, state="DISCONNECTED")
        db.add(conn)
        db.flush()
    else:
        # Reconnection keeps the same row, so every ExternalObjectLink / identity survives (T28).
        conn.environment = environment
        conn.auth_mode = auth_mode
    return conn


def _verify_company(db: Session, conn: ProcoreConnection) -> None:
    """Confirm the token can see the company (documented: requires Procore-Company-Id header)."""
    client = ProcoreClient(db, conn)
    companies = client.companies()
    match = next((c for c in companies if str(c.get("id")) == str(conn.company_id)), None)
    if match is None:
        raise ProcoreRejected(f"Company {conn.company_id} is not accessible to this Procore principal")
    conn.company_name = match.get("name")


def _fail(db: Session, conn: ProcoreConnection, p: Principal | None, exc: ProcoreError, action: str) -> DomainError:
    oauth.clear_tokens(conn)
    conn.state = "ERROR"
    conn.last_error = exc.message[:500]
    bump(conn)
    audit.record(db, p, action, "ProcoreConnection", conn.id, after={"state": "ERROR", "error": conn.last_error}, tenant_id=conn.tenant_id)
    db.commit()
    status = 502 if exc.retryable else 422
    return DomainError("PROCORE_CONNECT_FAILED", conn.last_error, status=status)


def connect_service_account(db: Session, tenant_id: str, p: Principal | None, auth_mode: str, company_id: str) -> ProcoreConnection:
    """SIMULATED (in-process fake) or CLIENT_CREDENTIALS (Developer Managed Service Account)."""
    auth_mode = (auth_mode or "").upper()
    if auth_mode not in ("SIMULATED", "CLIENT_CREDENTIALS"):
        raise DomainError("INVALID_AUTH_MODE", "auth_mode must be SIMULATED or CLIENT_CREDENTIALS; use oauth/authorize-url for user authorization", status=422)
    if auth_mode == "SIMULATED" and ps.mode() != ps.SIMULATED:
        raise Conflict("PROCORE_LIVE_MODE", "SIMULATED connections are disabled when PCX_PROCORE_MODE is live")
    if not company_id or not str(company_id).isdigit():
        raise DomainError("COMPANY_ID_REQUIRED", "company_id (numeric Procore company id) is required", status=422)
    env = ps.environment()
    actor = p.email if p else "system"
    conn = _get_or_create(db, tenant_id, str(company_id), env, "CLIENT_CREDENTIALS", actor)
    db.commit()
    transport = transport_for(env)
    try:
        oauth.store_tokens(conn, oauth.client_credentials_grant(transport))
        db.commit()  # persist the token before first use
        _verify_company(db, conn)
    except ProcoreError as exc:
        raise _fail(db, conn, p, exc, "procore.connect") from exc
    conn.state = "CONNECTED"
    conn.last_error = None
    bump(conn)
    audit.record(db, p, "procore.connect", "ProcoreConnection", conn.id, after={"state": "CONNECTED", "auth_mode": auth_mode, "environment": env, "company_id": conn.company_id}, tenant_id=tenant_id)
    db.commit()
    return conn


def start_authorization(p: Principal, company_id: str | None) -> dict:
    if company_id is not None and not str(company_id).isdigit():
        raise DomainError("INVALID_COMPANY_ID", "company_id must be a numeric Procore company id", status=422)
    if ps.mode() == ps.SIMULATED and not company_id:
        from app.integrations.procore.simulated import COMPANY_ID

        company_id = COMPANY_ID
    state = oauth.build_state(p.tenant_id, p.user_id, company_id)
    if ps.mode() == ps.SIMULATED:
        from urllib.parse import urlencode

        from app.config import get_settings
        from app.integrations.procore.simulated import FAKE

        cid, _ = oauth.client_credentials_pair()
        code = FAKE.issue_authorization_code(cid, get_settings().procore_redirect_uri)
        url = f"{get_settings().procore_redirect_uri}?{urlencode({'code': code, 'state': state})}"
        return {"authorize_url": url, "mode": ps.SIMULATED, "expires_in": ps.procore_settings().oauth_state_ttl_seconds, "note": "Simulated consent: the URL goes straight to the callback."}
    return {"authorize_url": oauth.authorize_url(state), "mode": "LIVE", "environment": ps.environment(), "expires_in": ps.procore_settings().oauth_state_ttl_seconds}


def complete_authorization(db: Session, code: str, state: str) -> ProcoreConnection:
    """OAuth callback. The state binds tenant + user + optional company and is single use."""
    from app.core.auth import principal_from_user
    from app.models import User

    data = oauth.consume_state(db, state)
    user = db.get(User, data["uid"])
    if user is None or user.tenant_id != data["tid"] or not user.active:
        raise DomainError("OAUTH_STATE_INVALID", "OAuth state is invalid", status=400)
    p = principal_from_user(user)
    if not p.has("INTEGRATION"):
        raise DomainError("FORBIDDEN", "Only INTEGRATION or ADMIN users may connect Procore", status=403)
    db.commit()  # burn the state before talking to Procore
    env = ps.environment()
    transport = transport_for(env)
    try:
        tokens = oauth.exchange_code(transport, code)
    except ProcoreError as exc:
        raise DomainError("OAUTH_EXCHANGE_FAILED", exc.message, status=502 if exc.retryable else 400) from exc
    company_id = data.get("cid")
    if not company_id:
        # No company chosen up front: accept only an unambiguous single company.
        r = transport.request("GET", "api", "/rest/v1.0/companies", headers={"Authorization": f"Bearer {tokens.access_token}"})
        companies = r.body if r.status == 200 and isinstance(r.body, list) else []
        if len(companies) != 1:
            raise DomainError("COMPANY_ID_REQUIRED", "Token can see several (or no) companies; restart with company_id", status=422)
        company_id = str(companies[0]["id"])
    conn = _get_or_create(db, p.tenant_id, str(company_id), env, "AUTHORIZATION_CODE", p.email)
    oauth.store_tokens(conn, tokens)
    db.commit()
    try:
        _verify_company(db, conn)
    except ProcoreError as exc:
        raise _fail(db, conn, p, exc, "procore.oauth_callback") from exc
    conn.state = "CONNECTED"
    conn.last_error = None
    bump(conn)
    audit.record(db, p, "procore.connect", "ProcoreConnection", conn.id, after={"state": "CONNECTED", "auth_mode": "AUTHORIZATION_CODE", "environment": env, "company_id": conn.company_id})
    db.commit()
    return conn


def disconnect(db: Session, p: Principal) -> ProcoreConnection:
    conn = tenant_connection(db, p.tenant_id)
    if conn is None or conn.state == "DISCONNECTED":
        raise Conflict("PROCORE_NOT_CONNECTED", "No active Procore connection")
    token = oauth.refresh_token(conn) or oauth.access_token(conn)
    revoked = False
    if token:
        try:
            oauth.revoke(transport_for(conn.environment), token)
            revoked = True
        except ProcoreError as exc:  # best effort; local tokens are destroyed regardless
            log.warning("Procore token revocation failed: %s", exc.message)
    oauth.clear_tokens(conn)
    conn.state = "DISCONNECTED"
    bump(conn)
    audit.record(db, p, "procore.disconnect", "ProcoreConnection", conn.id, after={"state": "DISCONNECTED", "token_revoked": revoked, "links_preserved": True})
    db.commit()
    return conn


def run_sync(db: Session, p: Principal | None, tenant_id: str, resources: list[str] | None, only_project: str | None = None, client: ProcoreClient | None = None) -> dict:
    conn = active_connection(db, tenant_id)
    if conn is None:
        raise Conflict("PROCORE_NOT_CONNECTED", "Connect Procore before syncing")
    bad = [r for r in (resources or []) if r not in RESOURCES]
    if bad:
        raise DomainError("UNKNOWN_RESOURCE", f"Unknown resources: {', '.join(bad)}; allowed: {', '.join(RESOURCES)}", status=422)
    sync = Sync(db, conn, client)
    try:
        result = sync.run(resources, only_project)
    except ProcoreError as exc:
        db.flush()  # links written so far are valid and idempotent; keep them
        conn.last_error = exc.message[:500]
        if isinstance(exc, ProcoreAuthError):
            conn.state = "ERROR"
        audit.record(db, p, "procore.sync_failed", "ProcoreConnection", conn.id, after={"error": conn.last_error}, tenant_id=tenant_id)
        db.commit()
        raise DomainError("PROCORE_SYNC_FAILED", conn.last_error, status=502 if exc.retryable else 422) from exc
    counts = {r: {k: v for k, v in s.items() if k != "review"} for r, s in result["resources"].items()}
    audit.record(db, p, "procore.sync", "ProcoreConnection", conn.id, after=counts, tenant_id=tenant_id)
    db.commit()
    return result


def status(db: Session, tenant_id: str) -> dict:
    from app.api.common import row
    from app.config import get_settings

    conn = tenant_connection(db, tenant_id)
    s = get_settings()
    counts: dict[str, int] = {}
    if conn:
        q = (
            select(ExternalObjectLink.object_type, func.count())
            .where(ExternalObjectLink.tenant_id == tenant_id, ExternalObjectLink.platform == "PROCORE", ExternalObjectLink.company_key == conn.company_id)
            .group_by(ExternalObjectLink.object_type)
        )
        counts = {k: n for k, n in db.execute(q)}

    def _count(model, *conds):
        return db.scalar(select(func.count()).select_from(model).where(model.tenant_id == tenant_id, *conds)) or 0

    return {
        "mode": ps.mode(),
        "environment": ps.environment(),
        "oauth_configured": bool(s.procore_client_id and s.procore_client_secret) or ps.mode() == ps.SIMULATED,
        "redirect_uri": s.procore_redirect_uri,
        "webhook_destination_url": ps.webhook_destination_url(),
        "writeback_enabled": ps.mode() == ps.SIMULATED or ps.procore_settings().writeback_enabled,
        "connected": bool(conn and conn.state == "CONNECTED"),
        "connection": row(conn) if conn else None,
        "token_present": bool(conn and conn.access_token_enc),
        "has_refresh_token": bool(conn and conn.refresh_token_enc),
        "environment_mismatch": bool(conn and conn.environment != ps.environment()),
        "link_counts": counts,
        "outbox": {
            st: _count(OutboxMessage, OutboxMessage.target == "PROCORE", OutboxMessage.state == st) for st in ("PENDING", "UNKNOWN", "REJECTED", "DEAD", "ACKNOWLEDGED")
        },
        "open_exceptions": _count(IntegrationException, IntegrationException.source == "PROCORE", IntegrationException.state == "OPEN"),
        "resources": list(RESOURCES),
    }


def register_webhooks(db: Session, p: Principal, conn: ProcoreConnection) -> dict:
    """Create the hook + triggers via the documented webhooks API (body format per Procore docs)."""
    from app.integrations.procore.webhooks import destination_headers, trigger_specs

    client = ProcoreClient(db, conn)
    s = ps.procore_settings()
    hook = client.request(
        "POST",
        "/rest/v1.0/webhooks/hooks",
        json={
            "company_id": int(conn.company_id),
            "hook": {"api_version": "v2", "namespace": s.webhook_namespace, "destination_url": ps.webhook_destination_url(), "destination_headers": destination_headers(conn)},
        },
    ).body
    hook_id = str(hook.get("id"))
    created = []
    for resource_name, event_type in trigger_specs():
        client.request("POST", f"/rest/v1.0/webhooks/hooks/{hook_id}/triggers", json={"company_id": int(conn.company_id), "trigger": {"resource_name": resource_name, "event_type": event_type}})
        created.append({"resource_name": resource_name, "event_type": event_type})
    conn.webhook_hook_id = hook_id
    bump(conn)
    audit.record(db, p, "procore.webhooks_registered", "ProcoreConnection", conn.id, after={"hook_id": hook_id, "triggers": created})
    db.commit()
    return {"hook_id": hook_id, "triggers": created, "destination_url": ps.webhook_destination_url()}
