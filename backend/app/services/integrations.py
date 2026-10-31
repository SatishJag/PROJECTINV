"""Integration platform operations shared by all targets: outbox retry / reconcile / process,
inbox listing, exception resolution and per-target reconcilers.

Rules (spec §32, §35, T27):
* an UNKNOWN acknowledgement is never replayed blindly - it must be reconciled first;
* reconcile APPLIED records the external reference and lets the target's reconciler update the
  domain crosswalk; NOT_APPLIED re-queues the message (handlers look up by business key before
  creating, so a mistaken NOT_APPLIED still produces one business effect);
* every command writes an audit row in the same transaction.
"""

from collections.abc import Callable

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core import audit
from app.core.auth import Principal
from app.core.commands import bump
from app.core.errors import Conflict, DomainError, Forbidden, NotFound
from app.core.outbox import process_message, process_outbox
from app.models import IntegrationException, OutboxMessage, utcnow

Reconciler = Callable[[Session, OutboxMessage, str | None], None]
_reconcilers: dict[tuple[str, str], Reconciler] = {}


def register_reconciler(target: str, event_type: str):
    """Optional hook: called after a message is reconciled as APPLIED with (db, msg, external_ref)."""

    def deco(fn: Reconciler) -> Reconciler:
        _reconcilers[(target, event_type)] = fn
        return fn

    return deco


def get_message(db: Session, p: Principal, message_id: str) -> OutboxMessage:
    msg = db.get(OutboxMessage, message_id)
    if msg is None or msg.tenant_id != p.tenant_id:
        raise NotFound("Outbox message", message_id)
    return msg


def _resolve_open(db: Session, msg: OutboxMessage, kinds: tuple[str, ...], resolution: str) -> int:
    n = 0
    for exc in db.scalars(
        select(IntegrationException).where(
            IntegrationException.tenant_id == msg.tenant_id,
            IntegrationException.source == msg.target,
            IntegrationException.kind.in_(kinds),
            IntegrationException.subject_type == msg.aggregate_type,
            IntegrationException.subject_id == msg.aggregate_id,
            IntegrationException.state == "OPEN",
            IntegrationException.message.like(f"{msg.event_type}:%"),
        )
    ):
        exc.state = "RESOLVED"
        exc.resolution = resolution
        bump(exc)
        n += 1
    return n


def retry(db: Session, p: Principal, msg: OutboxMessage) -> OutboxMessage:
    if msg.state == "UNKNOWN":
        raise Conflict("ACK_UNKNOWN_RECONCILE_FIRST", "Acknowledgement is unknown; reconcile with the target before replaying")
    if msg.state == "ACKNOWLEDGED":
        raise Conflict("ALREADY_ACKNOWLEDGED", "Message was already acknowledged by the target")
    before = {"state": msg.state, "attempts": msg.attempts, "last_error": msg.last_error}
    msg.state = "PENDING"
    msg.attempts = 0
    msg.next_attempt_at = utcnow()
    _resolve_open(db, msg, ("REJECTED", "RETRIES_EXHAUSTED", "MAPPING"), f"Retried by {p.email}")
    audit.record(db, p, "outbox.retry", "OutboxMessage", msg.id, before=before, after={"state": "PENDING"}, correlation_id=msg.correlation_id)
    db.flush()
    process_message(db, msg)
    return msg


def reconcile(db: Session, p: Principal, msg: OutboxMessage, outcome: str, external_ref: str | None, note: str | None = None) -> OutboxMessage:
    if outcome not in ("APPLIED", "NOT_APPLIED"):
        raise DomainError("INVALID_OUTCOME", "outcome must be APPLIED or NOT_APPLIED", status=422)
    if msg.state not in ("UNKNOWN", "DEAD", "REJECTED"):
        raise Conflict("NOT_RECONCILABLE", f"Message in state {msg.state} does not need reconciliation")
    before = {"state": msg.state, "external_ref": msg.external_ref}
    if outcome == "APPLIED":
        msg.state = "ACKNOWLEDGED"
        msg.processed_at = utcnow()
        if external_ref:
            msg.external_ref = external_ref[:120]
        msg.last_error = None
        fn = _reconcilers.get((msg.target, msg.event_type))
        if fn:
            fn(db, msg, external_ref)
        resolution = f"Reconciled APPLIED by {p.email}" + (f" (ref {external_ref})" if external_ref else "")
    else:
        msg.state = "PENDING"
        msg.attempts = 0
        msg.next_attempt_at = utcnow()
        resolution = f"Reconciled NOT_APPLIED by {p.email}; re-queued"
    if note:
        resolution += f": {note}"
    _resolve_open(db, msg, ("UNKNOWN_ACK", "RETRIES_EXHAUSTED", "REJECTED"), resolution)
    audit.record(
        db, p, "outbox.reconcile", "OutboxMessage", msg.id, before=before, after={"state": msg.state, "outcome": outcome, "external_ref": msg.external_ref}, reason=note, correlation_id=msg.correlation_id
    )
    return msg


def process(db: Session, p: Principal, limit: int = 50) -> list[OutboxMessage]:
    msgs = process_outbox(db, tenant_id=p.tenant_id, limit=limit)
    audit.record(db, p, "outbox.process", "Tenant", p.tenant_id, after={"processed": len(msgs)})
    return msgs


def resolve_exception(db: Session, p: Principal, exc_id: str, resolution: str) -> IntegrationException:
    exc = db.get(IntegrationException, exc_id)
    if exc is None or exc.tenant_id != p.tenant_id:
        raise NotFound("Integration exception", exc_id)
    if not p.has("INTEGRATION", exc.owner_role):
        raise Forbidden(f"Requires role INTEGRATION or {exc.owner_role}")
    if exc.state != "OPEN":
        raise Conflict("EXCEPTION_NOT_OPEN", f"Exception is already {exc.state}")
    if not (resolution or "").strip():
        raise DomainError("RESOLUTION_REQUIRED", "A resolution note is required", status=422)
    before = {"state": exc.state}
    exc.state = "RESOLVED"
    exc.resolution = resolution.strip()
    bump(exc)
    audit.record(db, p, "integration_exception.resolve", "IntegrationException", exc.id, before=before, after={"state": "RESOLVED"}, reason=exc.resolution)
    return exc
