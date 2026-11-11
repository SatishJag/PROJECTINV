"""Shared IntegrationException helpers, parameterised by integration source (PROCORE, STEP1, ...)."""

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.commands import bump
from app.models import IntegrationException


def open_exception(
    db: Session,
    tenant_id: str,
    *,
    source: str,
    kind: str,
    subject_type: str,
    subject_id: str,
    message: str,
    owner_role: str = "INTEGRATION",
    actor: str = "system",
) -> IntegrationException:
    """One OPEN exception per (source, kind, subject); re-raising refreshes the message instead of duplicating."""
    exc = db.scalar(
        select(IntegrationException).where(
            IntegrationException.tenant_id == tenant_id,
            IntegrationException.source == source,
            IntegrationException.kind == kind,
            IntegrationException.subject_type == subject_type,
            IntegrationException.subject_id == subject_id,
            IntegrationException.state == "OPEN",
        )
    )
    if exc:
        if exc.message != message:
            exc.message = message
            bump(exc)
        return exc
    exc = IntegrationException(
        tenant_id=tenant_id, created_by=actor, source=source, kind=kind, subject_type=subject_type, subject_id=subject_id, message=message, owner_role=owner_role
    )
    db.add(exc)
    db.flush()
    return exc


def auto_resolve(db: Session, tenant_id: str, *, source: str, kind: str, subject_type: str, subject_id: str, resolution: str) -> int:
    n = 0
    for exc in db.scalars(
        select(IntegrationException).where(
            IntegrationException.tenant_id == tenant_id,
            IntegrationException.source == source,
            IntegrationException.kind == kind,
            IntegrationException.subject_type == subject_type,
            IntegrationException.subject_id == subject_id,
            IntegrationException.state == "OPEN",
        )
    ):
        exc.state = "RESOLVED"
        exc.resolution = resolution
        bump(exc)
        n += 1
    return n
