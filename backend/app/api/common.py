"""Shared helpers for routers and domain services.

API JSON convention: snake_case keys equal to model column names; Decimal → string;
date/datetime → ISO 8601 (UTC, no offset suffix for naive UTC datetimes → we append 'Z').
"""

from datetime import date, datetime
from decimal import Decimal
from typing import Any, TypeVar

from sqlalchemy import inspect, select
from sqlalchemy.orm import Session

from app.core.auth import Principal
from app.core.decimal import dstr
from app.core.errors import Forbidden, NotFound

T = TypeVar("T")


def value(v: Any) -> Any:
    if isinstance(v, Decimal):
        return dstr(v)
    if isinstance(v, datetime):
        return v.isoformat(timespec="seconds") + "Z"
    if isinstance(v, date):
        return v.isoformat()
    return v


def row(obj, exclude: set[str] | None = None, **extra) -> dict:
    """Serialize all mapped columns of an ORM object (+ extra computed keys)."""
    if obj is None:
        return None  # type: ignore[return-value]
    exclude = (exclude or set()) | {"tenant_id", "password_hash", "access_token_enc", "refresh_token_enc"}
    out = {c.key: value(getattr(obj, c.key)) for c in inspect(obj).mapper.column_attrs if c.key not in exclude}
    if hasattr(obj, "version"):
        out["etag"] = f'W/"{obj.version}"'
    for k, v in extra.items():
        out[k] = value(v) if not isinstance(v, (dict, list)) else v
    return out


def rows(objs, **kw) -> list[dict]:
    return [row(o, **kw) for o in objs]


def get_owned(db: Session, model: type[T], ident: str | None, p: Principal, what: str | None = None) -> T:
    """Load a tenant-scoped row or raise 404 (never reveal cross-tenant existence, T26)."""
    obj = db.get(model, ident) if ident else None
    if obj is None or getattr(obj, "tenant_id", p.tenant_id) != p.tenant_id:
        raise NotFound(what or model.__name__, ident)
    project_id = getattr(obj, "project_id", None)
    if project_id and not p.can_see_project(project_id):
        raise NotFound(what or model.__name__, ident)
    return obj


def by_code(db: Session, model: type[T], tenant_id: str, code: str, field: str = "code") -> T:
    obj = db.scalar(select(model).where(model.tenant_id == tenant_id, getattr(model, field) == code))
    if obj is None:
        raise NotFound(model.__name__, code)
    return obj


def ensure_project_access(p: Principal, project_id: str | None) -> None:
    if not p.can_see_project(project_id):
        raise Forbidden("Project is outside your authorized scope")


def page_params(limit: int = 100, offset: int = 0) -> tuple[int, int]:
    return max(1, min(limit, 500)), max(0, offset)
