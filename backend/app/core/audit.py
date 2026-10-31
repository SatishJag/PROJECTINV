from datetime import date, datetime
from decimal import Decimal
from typing import Any

from sqlalchemy.orm import Session

from app.core.auth import Principal
from app.models import AuditEvent


def _jsonable(value: Any) -> Any:
    if isinstance(value, Decimal):
        return str(value)
    if isinstance(value, (datetime, date)):
        return value.isoformat()
    if isinstance(value, dict):
        return {k: _jsonable(v) for k, v in value.items()}
    if isinstance(value, (list, tuple, set)):
        return [_jsonable(v) for v in value]
    return value


def snapshot(obj, *fields: str) -> dict:
    """Small before/after snapshot of selected ORM attributes."""
    return {f: _jsonable(getattr(obj, f)) for f in fields}


def record(
    db: Session,
    p: Principal | None,
    action: str,
    subject_type: str,
    subject_id: str,
    *,
    before: dict | None = None,
    after: dict | None = None,
    reason: str | None = None,
    correlation_id: str | None = None,
    tenant_id: str | None = None,
) -> AuditEvent:
    """Append an audit row inside the caller's transaction. Never updated afterwards."""
    ev = AuditEvent(
        tenant_id=tenant_id or (p.tenant_id if p else ""),
        actor=p.email if p else "system",
        actor_roles=",".join(sorted(p.roles)) if p else "SYSTEM",
        action=action,
        subject_type=subject_type,
        subject_id=subject_id,
        before=_jsonable(before),
        after=_jsonable(after),
        reason=reason,
        correlation_id=correlation_id,
    )
    db.add(ev)
    return ev
