"""Transactional outbox with a handler registry.

Domain code calls `enqueue(...)` inside its transaction. A worker calls `process_outbox`,
which dispatches each message to the handler registered for (target, event_type).
Handlers return a HandlerResult; they may update domain rows using the given session.
Messages with no handler for target INTERNAL are domain events and are acknowledged.
"""

import logging
from collections.abc import Callable
from dataclasses import dataclass
from datetime import timedelta

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models import IntegrationException, OutboxMessage, utcnow

log = logging.getLogger("pcx.outbox")

MAX_ATTEMPTS = 6


@dataclass
class HandlerResult:
    status: str  # ACKNOWLEDGED | REJECTED | TRANSIENT_FAILURE | TIMEOUT_UNKNOWN
    external_ref: str | None = None
    message: str | None = None


Handler = Callable[[Session, OutboxMessage], HandlerResult]
_handlers: dict[tuple[str, str], Handler] = {}


def register_handler(target: str, event_type: str):
    def deco(fn: Handler) -> Handler:
        _handlers[(target, event_type)] = fn
        return fn

    return deco


def enqueue(
    db: Session,
    tenant_id: str,
    target: str,
    event_type: str,
    aggregate_type: str,
    aggregate_id: str,
    payload: dict,
    *,
    dedup_key: str | None = None,
    aggregate_version: int | None = None,
    correlation_id: str | None = None,
) -> OutboxMessage:
    key = dedup_key or f"{target}:{event_type}:{aggregate_id}:{aggregate_version or 0}"
    existing = db.scalar(select(OutboxMessage).where(OutboxMessage.tenant_id == tenant_id, OutboxMessage.dedup_key == key))
    if existing:
        return existing
    msg = OutboxMessage(
        tenant_id=tenant_id,
        target=target,
        event_type=event_type,
        aggregate_type=aggregate_type,
        aggregate_id=aggregate_id,
        aggregate_version=aggregate_version,
        dedup_key=key,
        payload=payload,
        correlation_id=correlation_id,
    )
    db.add(msg)
    db.flush()
    return msg


def publish_event(db: Session, tenant_id: str, event_type: str, aggregate_type: str, aggregate_id: str, payload: dict, version: int | None = None):
    """Domain event (e.g. RequirementRevisionApproved) recorded via the outbox with target INTERNAL."""
    return enqueue(db, tenant_id, "INTERNAL", event_type, aggregate_type, aggregate_id, payload, aggregate_version=version)


def _raise_exception(db: Session, msg: OutboxMessage, kind: str, text: str) -> None:
    db.add(
        IntegrationException(
            tenant_id=msg.tenant_id,
            source=msg.target,
            kind=kind,
            subject_type=msg.aggregate_type,
            subject_id=msg.aggregate_id,
            message=f"{msg.event_type}: {text}",
        )
    )


def process_message(db: Session, msg: OutboxMessage) -> OutboxMessage:
    handler = _handlers.get((msg.target, msg.event_type))
    msg.attempts += 1
    if handler is None:
        if msg.target == "INTERNAL":
            msg.state = "ACKNOWLEDGED"
            msg.processed_at = utcnow()
            return msg
        msg.state = "DEAD"
        msg.last_error = "No handler registered"
        _raise_exception(db, msg, "MAPPING", "no handler registered for target/event")
        return msg
    try:
        res = handler(db, msg)
    except Exception as exc:  # handler bug or unexpected adapter error → retry with backoff
        log.exception("outbox handler failed")
        res = HandlerResult("TRANSIENT_FAILURE", message=str(exc))
    msg.last_error = res.message
    if res.external_ref:
        msg.external_ref = res.external_ref
    if res.status == "ACKNOWLEDGED":
        msg.state = "ACKNOWLEDGED"
        msg.processed_at = utcnow()
    elif res.status == "REJECTED":
        msg.state = "REJECTED"
        msg.processed_at = utcnow()
        _raise_exception(db, msg, "REJECTED", res.message or "rejected by target")
    elif res.status == "TIMEOUT_UNKNOWN":
        # Never blindly replay: the target may have applied it. Reconcile first (T27).
        msg.state = "UNKNOWN"
        _raise_exception(db, msg, "UNKNOWN_ACK", res.message or "acknowledgement lost; reconcile before replay")
    else:
        if msg.attempts >= MAX_ATTEMPTS:
            msg.state = "DEAD"
            _raise_exception(db, msg, "RETRIES_EXHAUSTED", res.message or "transient failures exhausted")
        else:
            msg.state = "PENDING"
            msg.next_attempt_at = utcnow() + timedelta(seconds=min(300, 2**msg.attempts))
    return msg


def process_outbox(db: Session, tenant_id: str | None = None, limit: int = 50) -> list[OutboxMessage]:
    q = select(OutboxMessage).where(OutboxMessage.state == "PENDING", OutboxMessage.next_attempt_at <= utcnow())
    if tenant_id:
        q = q.where(OutboxMessage.tenant_id == tenant_id)
    msgs = list(db.scalars(q.order_by(OutboxMessage.created_at).limit(limit)))
    for msg in msgs:
        process_message(db, msg)
        db.commit()
    return msgs
