"""Shared service helpers: scoped loading, exact decimals, audit, idempotent commands."""

from __future__ import annotations

import hashlib
import json
from datetime import date, datetime
from decimal import Decimal
from typing import Any, Callable

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.api.common import get_owned, row
from app.core.audit import record
from app.core.auth import Principal
from app.core.commands import remember, replay
from app.core.decimal import to_decimal
from app.core.errors import Conflict, DomainError
from app.models import Requirement, RequirementRevision


def sha256(data: Any) -> str:
    return hashlib.sha256(json.dumps(data, sort_keys=True, default=str, separators=(",", ":")).encode()).hexdigest()


def dec(value: Any, field: str = "value", *, required: bool = False) -> Decimal | None:
    if value is None or value == "":
        if required:
            raise DomainError("VALIDATION", f"{field} is required")
        return None
    try:
        return to_decimal(value)
    except (TypeError, ValueError) as exc:
        raise DomainError("VALIDATION", f"{field} must be a decimal string") from exc


def get_row(db: Session, model, ident: str | None, p: Principal, what: str | None = None):
    return get_owned(db, model, ident, p, what)


def audit(db: Session, p: Principal, action: str, subject_type: str, subject_id: str, **kw) -> None:
    record(db, p, action, subject_type, subject_id, tenant_id=p.tenant_id, **kw)


def command(db: Session, p: Principal, route: str, key: str | None, body: Any, fn: Callable[[], Any], status: int = 200) -> tuple[Any, int]:
    """Run a mutating command with idempotency, then commit once."""
    cached = replay(db, p, route, key, body)
    if cached is not None:
        return cached, status
    result = fn()
    remember(db, p, route, key, body, result, status)
    db.commit()
    return result, status


def need(body: dict, key: str) -> Any:
    value = body.get(key)
    if value is None or value == "":
        raise DomainError("VALIDATION", f"{key} is required")
    return value


def optional_date(value: Any) -> date | None:
    if not value:
        return None
    if isinstance(value, date):
        return value
    return date.fromisoformat(str(value)[:10])


def optional_dt(value: Any) -> datetime | None:
    if not value:
        return None
    if isinstance(value, datetime):
        return value
    text = str(value).replace("Z", "+00:00")
    parsed = datetime.fromisoformat(text)
    return parsed.replace(tzinfo=None) if parsed.tzinfo else parsed


def latest_requirement_revision(db: Session, requirement_id: str) -> RequirementRevision | None:
    return db.scalar(
        select(RequirementRevision)
        .where(RequirementRevision.requirement_id == requirement_id)
        .order_by(RequirementRevision.revision_no.desc())
    )


def approved_revision(db: Session, requirement: Requirement) -> RequirementRevision | None:
    return db.get(RequirementRevision, requirement.current_revision_id) if requirement.current_revision_id else None


def requirement_of_revision(db: Session, revision_id: str) -> Requirement:
    rev = db.get(RequirementRevision, revision_id)
    if rev is None:
        raise DomainError("NOT_FOUND", "Requirement revision not found", status=404)
    return db.get(Requirement, rev.requirement_id)


def check_quantity(value: Decimal, quantity: Decimal, field: str = "quantity") -> None:
    if value <= 0:
        raise DomainError("VALIDATION", f"{field} must be greater than zero")


def conflict_integrity(exc: Exception, code: str, detail: str) -> Conflict:
    return Conflict(code, detail)


def iso(value: Any) -> Any:
    if isinstance(value, (date, datetime)):
        return value.isoformat()
    if isinstance(value, Decimal):
        return format(value.normalize(), "f")
    return value


def serialize(obj, **extra) -> dict:
    return row(obj, **extra)


def page(rows: list, limit: int, offset: int) -> list:
    return rows[offset : offset + limit]
