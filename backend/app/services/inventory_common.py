"""Shared helpers for the delivery workstream (inventory, assets, quality, logistics, handbook, costs).

Visibility rule for physical units: a unit is visible when the principal can see its assigned
project (unassigned programme stock is visible to every internal user of the tenant).
"""

import hashlib
import json
from collections.abc import Callable
from datetime import UTC, date, datetime
from decimal import Decimal
from typing import Any

from fastapi.encoders import jsonable_encoder
from sqlalchemy.exc import IntegrityError, OperationalError
from sqlalchemy.orm import Session

from app.api.common import row
from app.core.auth import Principal
from app.core.commands import remember, replay
from app.core.decimal import to_decimal
from app.core.errors import Conflict, DomainError, NotFound
from app.models import Location, PhysicalUnit, Project

STOCK_LOCATION_KINDS = {"CENTRAL_WAREHOUSE", "SITE_STORE"}
TERMINAL_UNIT_STATES = {"CANCELLED", "SCRAPPED", "RETIRED"}


def naive_utc(dt: datetime | None) -> datetime | None:
    if dt is None:
        return None
    if dt.tzinfo is not None:
        dt = dt.astimezone(UTC).replace(tzinfo=None)
    return dt


def parse_dt(value: str | datetime | None, field: str) -> datetime | None:
    if value is None or value == "":
        return None
    if isinstance(value, datetime):
        return naive_utc(value)
    try:
        parsed = datetime.fromisoformat(value.strip().replace("Z", "+00:00"))
    except ValueError as exc:
        raise DomainError("INVALID_DATETIME", f"{field} must be an ISO 8601 datetime") from exc
    return naive_utc(parsed)


def parse_date(value: str | date | None, field: str) -> date | None:
    if value is None or value == "":
        return None
    if isinstance(value, datetime):
        return value.date()
    if isinstance(value, date):
        return value
    try:
        return date.fromisoformat(value.strip()[:10])
    except ValueError as exc:
        raise DomainError("INVALID_DATE", f"{field} must be YYYY-MM-DD") from exc


def dec(value: Any, field: str, *, positive: bool = False, non_negative: bool = False) -> Decimal:
    """Parse a decimal string from external input (floats are refused)."""
    if value is None or value == "":
        raise DomainError("INVALID_DECIMAL", f"{field} is required")
    try:
        d = to_decimal(value)
    except (TypeError, ValueError) as exc:
        raise DomainError("INVALID_DECIMAL", f"{field} must be a decimal string") from exc
    if not d.is_finite():
        raise DomainError("INVALID_DECIMAL", f"{field} must be finite")
    if positive and d <= 0:
        raise DomainError("INVALID_DECIMAL", f"{field} must be greater than zero")
    if non_negative and d < 0:
        raise DomainError("INVALID_DECIMAL", f"{field} must not be negative")
    return d


def content_hash(data: Any) -> str:
    return hashlib.sha256(json.dumps(jsonable_encoder(data), sort_keys=True, separators=(",", ":")).encode()).hexdigest()


def run_command(db: Session, p: Principal, route: str, key: str | None, body: Any, fn: Callable[[], Any], status_code: int = 200) -> Any:
    """Idempotent command wrapper: replay, execute, remember, commit once.

    Database-level conflicts (unique partial indexes, SQLite write-lock snapshots) surface as 409.
    """
    cached = replay(db, p, route, key, body)
    if cached is not None:
        return cached
    try:
        result = fn()
        remember(db, p, route, key, body, result, status_code)
        db.commit()
    except IntegrityError as exc:
        db.rollback()
        raise Conflict("CONCURRENT_CONFLICT", "A concurrent change conflicts with this command; reload and retry") from exc
    except OperationalError as exc:
        db.rollback()
        raise Conflict("CONCURRENT_UPDATE", "The record is being changed by another request; retry") from exc
    return jsonable_encoder(result)


def lock(db: Session, *objs) -> None:
    """Take a write lock on versioned rows before check-then-write logic.

    An UPDATE of the row (version + 1) serializes concurrent writers on SQLite (database write
    lock) and Postgres/Azure SQL (row lock); the refresh re-reads committed state after the lock.
    """
    for obj in objs:
        obj.version = type(obj).version + 1
    db.flush()
    for obj in objs:
        db.refresh(obj)


def code_of(db: Session, model, ident: str | None, field: str = "code") -> str | None:
    if not ident:
        return None
    obj = db.get(model, ident)
    return getattr(obj, field) if obj is not None else None


def unit_visible(p: Principal, unit: PhysicalUnit | None) -> bool:
    return unit is not None and unit.tenant_id == p.tenant_id and not p.is_supplier and p.can_see_project(unit.assigned_project_id)


def get_unit(db: Session, p: Principal, unit_id: str | None, what: str = "Unit") -> PhysicalUnit:
    unit = db.get(PhysicalUnit, unit_id) if unit_id else None
    if not unit_visible(p, unit):
        raise NotFound(what, unit_id)
    return unit


def get_tenant_row(db: Session, p: Principal, model, ident: str | None, what: str):
    obj = db.get(model, ident) if ident else None
    if obj is None or obj.tenant_id != p.tenant_id:
        raise NotFound(what, ident)
    return obj


def get_project(db: Session, p: Principal, project_id: str | None) -> Project:
    prj = get_tenant_row(db, p, Project, project_id, "Project")
    if not p.can_see_project(prj.id):
        raise NotFound("Project", project_id)
    return prj


def unit_brief(db: Session, u: PhysicalUnit | None) -> dict | None:
    if u is None:
        return None
    return {
        "id": u.id,
        "asset_code": u.asset_code,
        "serial_number": u.serial_number,
        "item_code": u.item_model.item_code,
        "state": u.state,
        "quality_status": u.quality_status,
        "allocation_status": u.allocation_status,
        "condition": u.condition,
        "assigned_project_id": u.assigned_project_id,
        "project_code": code_of(db, Project, u.assigned_project_id),
        "custody_location_id": u.custody_location_id,
        "custody_code": code_of(db, Location, u.custody_location_id),
        "is_spare": u.is_spare,
        "replaces_unit_id": u.replaces_unit_id,
    }


def unit_row(db: Session, u: PhysicalUnit, **extra) -> dict:
    return row(
        u,
        item_code=u.item_model.item_code,
        project_code=code_of(db, Project, u.assigned_project_id),
        custody_code=code_of(db, Location, u.custody_location_id),
        **extra,
    )
