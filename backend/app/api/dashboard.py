"""Cross-domain summary and audit trail."""

from fastapi import APIRouter, Depends
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.api.common import page_params, row
from app.core.auth import Principal, require_internal
from app.db import get_db
from app.models import (
    AuditEvent,
    HandbookPackage,
    ImpactAction,
    IntegrationException,
    OutboxMessage,
    PhysicalUnit,
    RecoveryCase,
    Requirement,
)

router = APIRouter(prefix="/api", tags=["dashboard"])


def _count(db: Session, model, tenant_id: str, *where) -> int:
    return db.scalar(select(func.count()).select_from(model).where(model.tenant_id == tenant_id, *where)) or 0


@router.get("/dashboard/summary")
def summary(p: Principal = Depends(require_internal), db: Session = Depends(get_db)):
    t = p.tenant_id
    unit_states = dict(
        db.execute(select(PhysicalUnit.state, func.count()).where(PhysicalUnit.tenant_id == t).group_by(PhysicalUnit.state)).all()
    )
    allocation = dict(
        db.execute(
            select(PhysicalUnit.allocation_status, func.count()).where(PhysicalUnit.tenant_id == t).group_by(PhysicalUnit.allocation_status)
        ).all()
    )
    return {
        "requirements": _count(db, Requirement, t, Requirement.state == "ACTIVE"),
        "open_impact_actions": _count(db, ImpactAction, t, ImpactAction.state == "OPEN"),
        "units_by_state": unit_states,
        "units_by_allocation": allocation,
        "open_recovery_cases": _count(db, RecoveryCase, t, RecoveryCase.state.not_in(["RELEASED", "CLOSED"])),
        "handbooks_blocked": _count(db, HandbookPackage, t, HandbookPackage.state == "BLOCKED"),
        "handbooks_published": _count(db, HandbookPackage, t, HandbookPackage.state == "PUBLISHED"),
        "open_integration_exceptions": _count(db, IntegrationException, t, IntegrationException.state == "OPEN"),
        "outbox_pending": _count(db, OutboxMessage, t, OutboxMessage.state == "PENDING"),
        "outbox_unknown": _count(db, OutboxMessage, t, OutboxMessage.state == "UNKNOWN"),
    }


@router.get("/audit")
def audit(
    subject_type: str | None = None,
    subject_id: str | None = None,
    limit: int = 100,
    offset: int = 0,
    p: Principal = Depends(require_internal),
    db: Session = Depends(get_db),
):
    limit, offset = page_params(limit, offset)
    q = select(AuditEvent).where(AuditEvent.tenant_id == p.tenant_id)
    if subject_type:
        q = q.where(AuditEvent.subject_type == subject_type)
    if subject_id:
        q = q.where(AuditEvent.subject_id == subject_id)
    return [row(e) for e in db.scalars(q.order_by(AuditEvent.at.desc()).limit(limit).offset(offset))]
