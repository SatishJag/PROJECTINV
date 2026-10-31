"""Integration operations: Procore lifecycle, outbox/inbox visibility, exceptions and simulators."""

from fastapi import APIRouter, BackgroundTasks, Depends, Header, Request
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.auth import Principal, current_principal, require_internal
from app.core.errors import DomainError
from app.db import get_db
from app.integrations import sim_state
from app.integrations.procore import service as procore
from app.integrations.procore import settings as ps
from app.integrations.procore import webhooks
from app.integrations.procore.simulated import COMPANY_ID
from app.integrations.procore.links import parse_ts
from app.api.common import row
from app.config import get_settings
from app.models import ExternalObjectLink, InboxMessage, IntegrationException, OutboxMessage, ProcoreConnection, Project, utcnow
from app.services import integrations as ops
from app.services.helpers import command

router = APIRouter(prefix="/api/integrations", tags=["integrations"])


# ---------------------------------------------------------------- Procore connection


@router.get("/procore/status")
def procore_status(db: Session = Depends(get_db), p: Principal = Depends(require_internal)):
    return procore.status(db, p.tenant_id)


@router.get("/procore/oauth/authorize-url")
def procore_authorize_url(company_id: str | None = None, db: Session = Depends(get_db), p: Principal = Depends(require_internal)):
    if not p.has("INTEGRATION"):
        raise DomainError("FORBIDDEN", "Only INTEGRATION or ADMIN users may connect Procore", status=403)
    return procore.start_authorization(p, company_id)


@router.get("/procore/oauth/callback")
def procore_callback(code: str, state: str, db: Session = Depends(get_db)):
    conn = procore.complete_authorization(db, code, state)
    return {"status": "connected", "connection": row(conn)}


@router.post("/procore/connect")
def procore_connect(body: dict, db: Session = Depends(get_db), p: Principal = Depends(require_internal)):
    if not p.has("INTEGRATION"):
        raise DomainError("FORBIDDEN", "Only INTEGRATION or ADMIN users may connect Procore", status=403)
    auth_mode = str(body.get("auth_mode") or ("SIMULATED" if ps.mode() == ps.SIMULATED else "CLIENT_CREDENTIALS")).upper()
    company_id = str(body.get("company_id") or COMPANY_ID if ps.mode() == ps.SIMULATED else body.get("company_id") or "")

    def run():
        conn = procore.connect_service_account(db, p.tenant_id, p, auth_mode, company_id)
        return {"connection": row(conn), "status": procore.status(db, p.tenant_id)}

    data, _ = command(db, p, "integrations.procore.connect", None, body, run, 201)
    return data


@router.post("/procore/disconnect")
def procore_disconnect(db: Session = Depends(get_db), p: Principal = Depends(require_internal)):
    if not p.has("INTEGRATION"):
        raise DomainError("FORBIDDEN", "Only INTEGRATION or ADMIN users may disconnect Procore", status=403)

    def run():
        conn = procore.disconnect(db, p)
        return {"connection": row(conn)}

    data, _ = command(db, p, "integrations.procore.disconnect", None, {}, run)
    return data


@router.post("/procore/sync")
def procore_sync(body: dict | None = None, db: Session = Depends(get_db), p: Principal = Depends(require_internal)):
    if not p.has("INTEGRATION"):
        raise DomainError("FORBIDDEN", "Only INTEGRATION or ADMIN users may sync Procore", status=403)
    body = body or {}

    def run():
        return procore.run_sync(db, p, p.tenant_id, body.get("resources"), body.get("only_project"))

    data, _ = command(db, p, "integrations.procore.sync", None, body, run)
    return data


@router.post("/procore/webhooks")
async def procore_webhook(request: Request, background: BackgroundTasks, db: Session = Depends(get_db), authorization: str | None = Header(default=None)):
    raw = await request.body()
    result = webhooks.receive(db, authorization, raw)
    if result.get("status") == "accepted" and result.get("inbox_id"):
        background.add_task(webhooks.process_async, result["inbox_id"])
    return result


@router.get("/procore/embedded/context")
def embedded_context(company_id: str, project_id: str | None = None, db: Session = Depends(get_db), p: Principal = Depends(current_principal)):
    conn = db.scalar(
        select(ProcoreConnection).where(
            ProcoreConnection.tenant_id == p.tenant_id,
            ProcoreConnection.company_id == str(company_id),
        )
    )
    if conn is None:
        raise DomainError("PROCORE_NOT_CONNECTED", f"No connection for Procore company {company_id}", status=404)
    project = None
    if project_id:
        link = db.scalar(
            select(ExternalObjectLink).where(
                ExternalObjectLink.tenant_id == p.tenant_id,
                ExternalObjectLink.platform == "PROCORE",
                ExternalObjectLink.company_key == conn.company_id,
                ExternalObjectLink.object_type == "project",
                ExternalObjectLink.object_key == str(project_id),
            )
        )
        if link:
            project = db.get(Project, link.domain_id)
    return {
        "connected": conn.state == "CONNECTED",
        "environment": conn.environment,
        "company": {"id": conn.company_id, "name": conn.company_name},
        "project": row(project) if project else None,
        "context": {
            "tenant_id": p.tenant_id,
            "company_id": conn.company_id,
            "procore_project_id": project_id,
            "pcx_project_id": project.id if project else None,
        },
    }


@router.get("/procore/app-manifest")
def app_manifest():
    s = get_settings()
    base = s.public_base_url.rstrip("/")
    return {
        "name": "Procore Equipment Intelligence",
        "description": "Long-lead equipment planning, delivery, handbook and cost intelligence for data-centre programmes.",
        "app_type": "embedded",
        "embedded": {
            "full_screen": {
                "url": f"{base}/?pcx_company_id={{{{procore.company.id}}}}&pcx_project_id={{{{procore.project.id}}}}",
                "default": True,
            },
            "side_panel": {
                "url": f"{base}/?pcx_company_id={{{{procore.company.id}}}}&pcx_project_id={{{{procore.project.id}}}}&pcx_embedded=side",
                "width_px": 400,
            },
        },
        "oauth": {
            "authorization_url": f"{base}/api/integrations/procore/oauth/authorize-url",
            "callback_url": s.procore_redirect_uri,
            "scopes": ["read", "write"],
        },
        "webhooks": {
            "destination_url": ps.webhook_destination_url(),
            "events": [f"{r}:{e}" for r, e in webhooks.trigger_specs()],
            "authenticity": "Authorization header set by Procore from destination_headers",
            "ack_window_seconds": 5,
            "dedupe_keys": ["ulid", "id"],
        },
        "frame_ancestors": s.frame_ancestors,
        "validation_required": ["commitment_contracts payload mapping", "equipment_register payload mapping"],
        "mode": ps.mode(),
    }


# ---------------------------------------------------------------- platform operations


@router.get("/links")
def list_links(domain_type: str | None = None, domain_id: str | None = None, platform: str | None = None, db: Session = Depends(get_db), p: Principal = Depends(require_internal)):
    query = select(ExternalObjectLink).where(ExternalObjectLink.tenant_id == p.tenant_id)
    if domain_type:
        query = query.where(ExternalObjectLink.domain_type == domain_type)
    if domain_id:
        query = query.where(ExternalObjectLink.domain_id == domain_id)
    if platform:
        query = query.where(ExternalObjectLink.platform == platform.upper())
    return [row(link) for link in db.scalars(query.order_by(ExternalObjectLink.last_synced_at.desc()))]


@router.get("/outbox")
def list_outbox(state: str | None = None, target: str | None = None, db: Session = Depends(get_db), p: Principal = Depends(require_internal)):
    query = select(OutboxMessage).where(OutboxMessage.tenant_id == p.tenant_id).order_by(OutboxMessage.created_at.desc())
    if state:
        query = query.where(OutboxMessage.state == state)
    if target:
        query = query.where(OutboxMessage.target == target.upper())
    return [row(msg) for msg in db.scalars(query)]


@router.post("/outbox/process")
def process_outbox(body: dict | None = None, db: Session = Depends(get_db), p: Principal = Depends(require_internal)):
    limit = int((body or {}).get("limit") or 50)
    msgs = ops.process(db, p, limit)
    db.commit()
    return {"processed": len(msgs), "messages": [row(m) for m in msgs]}


@router.post("/outbox/{message_id}/retry")
def retry_message(message_id: str, db: Session = Depends(get_db), p: Principal = Depends(require_internal)):
    msg = ops.get_message(db, p, message_id)
    ops.retry(db, p, msg)
    db.commit()
    return row(msg)


@router.post("/outbox/{message_id}/reconcile")
def reconcile_message(message_id: str, body: dict, db: Session = Depends(get_db), p: Principal = Depends(require_internal)):
    msg = ops.get_message(db, p, message_id)
    ops.reconcile(db, p, msg, str(body.get("outcome") or ""), body.get("external_ref"), body.get("note"))
    db.commit()
    return row(msg)


@router.get("/inbox")
def list_inbox(state: str | None = None, db: Session = Depends(get_db), p: Principal = Depends(require_internal)):
    query = select(InboxMessage).where(InboxMessage.tenant_id == p.tenant_id).order_by(InboxMessage.created_at.desc())
    if state:
        query = query.where(InboxMessage.state == state)
    return [row(msg) for msg in db.scalars(query)]


@router.post("/inbox/process")
def process_inbox(body: dict | None = None, db: Session = Depends(get_db), p: Principal = Depends(require_internal)):
    msgs = webhooks.process_pending(db, p.tenant_id, int((body or {}).get("limit") or 50))
    return {"processed": len(msgs), "messages": [row(m) for m in msgs]}


@router.get("/exceptions")
def list_exceptions(state: str | None = None, db: Session = Depends(get_db), p: Principal = Depends(require_internal)):
    query = select(IntegrationException).where(IntegrationException.tenant_id == p.tenant_id).order_by(IntegrationException.created_at.desc())
    if state:
        query = query.where(IntegrationException.state == state)
    return [row(exc) for exc in db.scalars(query)]


@router.post("/exceptions/{exception_id}/resolve")
def resolve_exception(exception_id: str, body: dict, db: Session = Depends(get_db), p: Principal = Depends(require_internal)):
    exc = ops.resolve_exception(db, p, exception_id, str(body.get("resolution") or ""))
    db.commit()
    return row(exc)


@router.get("/simulators")
def simulators():
    return {"modes": sim_state.all_modes(), "targets": list(sim_state.TARGETS), "available": list(sim_state.MODES)}


@router.post("/simulators/{target}/mode")
def set_simulator_mode(target: str, body: dict, p: Principal = Depends(require_internal)):
    if not p.has("INTEGRATION"):
        raise DomainError("FORBIDDEN", "Only INTEGRATION or ADMIN users may change simulator modes", status=403)
    sim_state.set_mode(target, str(body.get("mode") or ""))
    return {"modes": sim_state.all_modes()}
