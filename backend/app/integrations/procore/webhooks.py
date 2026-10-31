"""Procore webhook receiver.

Authenticity: Procore does not sign deliveries; the only control is the Authorization header we
configure in the hook's `destination_headers`. Each connection gets its own derived secret, compared
in constant time; the matching secret also identifies the tenant (several tenants may connect the
same Procore company id). Deliveries are at-least-once (retried with backoff for up to ~12 h), so
the receiver persists to InboxMessage, deduplicated on `ulid` (or `id`), answers immediately and
processes asynchronously. Missed deliveries are covered by POST /procore/sync (catch-up).
"""

import hashlib
import hmac
import json
import logging
import re

from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.config import get_settings
from app.core.crypto import sha256_hex
from app.core.errors import DomainError
from app.integrations.procore import settings as ps
from app.integrations.procore.links import find_link, open_exception
from app.integrations.procore.sync import Sync
from app.integrations.procore.transport import ProcoreError
from app.models import InboxMessage, ProcoreConnection, utcnow

log = logging.getLogger("pcx.procore.webhooks")
SOURCE = "PROCORE"

# normalised Procore resource_name -> (sync resource, link object_type)
RESOURCE_MAP = {
    "projects": ("projects", "project"),
    "project": ("projects", "project"),
    "vendors": ("vendors", "vendor"),
    "vendor": ("vendors", "vendor"),
    "purchaseordercontracts": ("commitments", "purchase_order_contract"),
    "purchaseordercontract": ("commitments", "purchase_order_contract"),
    "commitmentcontracts": ("commitments", "purchase_order_contract"),
    "costcodes": ("cost_codes", "cost_code"),
}


def _norm_resource(name) -> str:
    return re.sub(r"[^a-z]", "", str(name or "").lower())


def webhook_secret(conn: ProcoreConnection) -> str:
    key = (get_settings().secret_key + "|" + (get_settings().procore_webhook_secret or "")).encode()
    return hmac.new(key, f"procore-webhook:{conn.id}".encode(), hashlib.sha256).hexdigest()


def destination_headers(conn: ProcoreConnection) -> dict:
    return {"Authorization": f"Bearer {webhook_secret(conn)}"}


def trigger_specs() -> list[tuple[str, str]]:
    out = []
    for part in ps.procore_settings().webhook_triggers.split(","):
        if ":" in part:
            r, e = part.rsplit(":", 1)
            out.append((r.strip(), e.strip()))
    return out


def _authenticate(db: Session, authorization: str | None, company_id: str) -> ProcoreConnection | None:
    if not company_id:
        return None
    presented = (authorization or "").encode()
    match = None
    for conn in db.scalars(select(ProcoreConnection).where(ProcoreConnection.company_id == company_id, ProcoreConnection.state == "CONNECTED")):
        expected = f"Bearer {webhook_secret(conn)}".encode()
        if hmac.compare_digest(presented, expected) and match is None:
            match = conn
    return match


def receive(db: Session, authorization: str | None, raw: bytes) -> dict:
    try:
        payload = json.loads(raw or b"null")
    except ValueError as exc:
        raise DomainError("WEBHOOK_INVALID_JSON", "Body is not valid JSON", status=400) from exc
    if not isinstance(payload, dict):
        raise DomainError("WEBHOOK_INVALID_PAYLOAD", "Body must be a JSON object", status=400)
    conn = _authenticate(db, authorization, str(payload.get("company_id") or ""))
    if conn is None:
        # Same answer for a wrong secret and an unknown company: no existence leak.
        raise DomainError("WEBHOOK_UNAUTHORIZED", "Delivery is not authorized", status=401)
    event_id = str(payload.get("ulid") or payload.get("id") or "").strip()
    if not event_id:
        raise DomainError("WEBHOOK_EVENT_ID_REQUIRED", "Delivery has neither ulid nor id", status=400)
    event_type = f"{payload.get('resource_name') or payload.get('resource_type') or 'unknown'}.{payload.get('event_type') or payload.get('reason') or 'unknown'}"[:80]
    payload_hash = sha256_hex(json.dumps(payload, sort_keys=True, separators=(",", ":")))
    existing = db.scalar(select(InboxMessage).where(InboxMessage.tenant_id == conn.tenant_id, InboxMessage.source == SOURCE, InboxMessage.source_event_id == event_id))
    if existing:
        if existing.payload_hash != payload_hash:
            log.warning("webhook %s redelivered with a different payload; first copy kept", event_id)
        return {"status": "duplicate", "inbox_id": existing.id, "tenant_id": conn.tenant_id}
    msg = InboxMessage(tenant_id=conn.tenant_id, created_by="procore-webhook", source=SOURCE, source_event_id=event_id[:120], event_type=event_type, payload_hash=payload_hash, payload=payload)
    db.add(msg)
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        dup = db.scalar(select(InboxMessage).where(InboxMessage.tenant_id == conn.tenant_id, InboxMessage.source == SOURCE, InboxMessage.source_event_id == event_id))
        return {"status": "duplicate", "inbox_id": dup.id if dup else None, "tenant_id": conn.tenant_id}
    return {"status": "accepted", "inbox_id": msg.id, "tenant_id": conn.tenant_id}


def process_message(db: Session, msg: InboxMessage) -> InboxMessage:
    from app.integrations.procore.service import active_connection

    if msg.state not in ("RECEIVED",):
        return msg
    conn = active_connection(db, msg.tenant_id)
    payload = msg.payload or {}
    if conn is None or str(payload.get("company_id")) != str(conn.company_id):
        msg.state, msg.error, msg.processed_at = "FAILED", "No active Procore connection for this company", utcnow()
        return msg
    mapped = RESOURCE_MAP.get(_norm_resource(payload.get("resource_name") or payload.get("resource_type")))
    if mapped is None:
        msg.state, msg.error, msg.processed_at = "IGNORED", "Resource not consumed by pcx", utcnow()
        return msg
    resource, object_type = mapped
    event = str(payload.get("event_type") or payload.get("reason") or "").lower()
    resource_id = str(payload.get("resource_id") or "")
    try:
        if event == "delete":
            link = find_link(db, conn, object_type, resource_id)
            if link:
                link.sync_state = "NEEDS_REVIEW"
                link.version += 1
                open_exception(
                    db,
                    msg.tenant_id,
                    kind="MAPPING",
                    subject_type=f"procore.{object_type}",
                    subject_id=resource_id,
                    message=f"NEEDS_REVIEW: Procore reported {object_type} {resource_id} deleted; pcx link kept for identity, review before unlinking",
                )
        else:
            project = str(payload.get("project_id") or "") or None
            sync = Sync(db, conn)
            if resource in ("commitments", "cost_codes"):
                getattr(sync, resource)(project)
            else:
                getattr(sync, resource)()
        msg.state, msg.error, msg.processed_at = "PROCESSED", None, utcnow()
    except ProcoreError as exc:
        msg.error = exc.message[:500]
        if not exc.retryable:
            msg.state, msg.processed_at = "FAILED", utcnow()
    return msg


def process_pending(db: Session, tenant_id: str | None = None, limit: int = 50) -> list[InboxMessage]:
    q = select(InboxMessage).where(InboxMessage.source == SOURCE, InboxMessage.state == "RECEIVED")
    if tenant_id:
        q = q.where(InboxMessage.tenant_id == tenant_id)
    msgs = list(db.scalars(q.order_by(InboxMessage.created_at).limit(limit)))
    for m in msgs:
        process_message(db, m)
        db.commit()
    return msgs


def process_async(inbox_id: str) -> None:
    """BackgroundTasks entry: own session, after the 2xx was sent."""
    from app import db as dbm

    with dbm.SessionLocal() as db:
        try:
            msg = db.get(InboxMessage, inbox_id)
            if msg:
                process_message(db, msg)
                db.commit()
        except Exception:  # never let a background failure surface to Procore
            log.exception("webhook processing failed for inbox %s", inbox_id)
            db.rollback()
