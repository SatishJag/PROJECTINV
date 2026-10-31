"""Shared helpers for the planning, sourcing and procurement workstream (routers and services).

- `Dec`: pydantic type for exact decimals. Accepts decimal strings (and ints); rejects JSON floats.
- `parse_decimal` / `parse_date`: coercion used by services so seed code can pass str/Decimal/date.
- `stable_hash`: deterministic SHA-256 over JSON-like data with normalized decimals.
- `run_command`: Idempotency-Key replay + single commit for routers.
- `mask`: null commercial fields for principals without commercial visibility.
"""

import hashlib
import json
from collections.abc import Callable, Iterable
from datetime import date, datetime
from decimal import Decimal, InvalidOperation
from typing import Annotated, Any

from fastapi import Request
from fastapi.encoders import jsonable_encoder
from fastapi.responses import JSONResponse
from pydantic import BeforeValidator, PlainSerializer
from sqlalchemy.orm import Session

from app.core.auth import Principal
from app.core.commands import remember, replay
from app.core.decimal import MONEY_Q, QTY_Q, dstr
from app.core.errors import DomainError


def parse_decimal(v: Any, field: str = "value") -> Decimal | None:
    if v is None:
        return None
    if isinstance(v, bool):
        raise ValueError(f"{field}: boolean is not a decimal")
    if isinstance(v, float):
        raise ValueError(f"{field}: send decimals as strings, not JSON floats")
    if isinstance(v, Decimal):
        d = v
    elif isinstance(v, int):
        d = Decimal(v)
    elif isinstance(v, str):
        try:
            d = Decimal(v.strip())
        except InvalidOperation as exc:
            raise ValueError(f"{field}: invalid decimal {v!r}") from exc
    else:
        raise ValueError(f"{field}: expected a decimal string")
    if not d.is_finite():
        raise ValueError(f"{field}: decimal must be finite")
    return d


def _pyd_decimal(v: Any) -> Decimal | None:
    return parse_decimal(v)


Dec = Annotated[Decimal, BeforeValidator(_pyd_decimal), PlainSerializer(lambda d: dstr(d), return_type=str)]


def dec(v: Any, field: str) -> Decimal | None:
    """Service-side coercion that reports business-rule (422) errors instead of ValueError."""
    try:
        return parse_decimal(v, field)
    except ValueError as exc:
        raise DomainError("INVALID_DECIMAL", str(exc)) from exc


def parse_date(v: Any, field: str = "date") -> date | None:
    if v is None or isinstance(v, date) and not isinstance(v, datetime):
        return v
    if isinstance(v, datetime):
        return v.date()
    try:
        return date.fromisoformat(str(v))
    except ValueError as exc:
        raise DomainError("INVALID_DATE", f"{field}: expected YYYY-MM-DD") from exc


def to_naive_utc(v: datetime | None) -> datetime | None:
    if v is None or v.tzinfo is None:
        return v
    from datetime import UTC

    return v.astimezone(UTC).replace(tzinfo=None)


def check_precision(value: Decimal, quantum: Decimal, field: str) -> None:
    if value != value.quantize(quantum):
        raise DomainError("PRECISION_EXCEEDED", f"{field} allows at most {-quantum.as_tuple().exponent} decimal places")


def check_qty(value: Decimal | None, field: str = "quantity", allow_zero: bool = False) -> Decimal:
    if value is None:
        raise DomainError("QUANTITY_REQUIRED", f"{field} is required")
    if value < 0 or (value == 0 and not allow_zero):
        raise DomainError("QUANTITY_NOT_POSITIVE", f"{field} must be positive")
    check_precision(value, QTY_Q, field)
    return value


def check_money(value: Decimal | None, field: str, allow_negative: bool = False) -> Decimal | None:
    if value is None:
        return None
    if value < 0 and not allow_negative:
        raise DomainError("AMOUNT_NEGATIVE", f"{field} cannot be negative")
    check_precision(value, MONEY_Q, field)
    return value


def check_currency(code: str | None, field: str = "currency") -> str | None:
    if code is None:
        return None
    code = code.strip().upper()
    if len(code) != 3 or not code.isalpha():
        raise DomainError("INVALID_CURRENCY", f"{field} must be an ISO 4217 code")
    return code


def _canon(v: Any) -> Any:
    if isinstance(v, Decimal):
        return dstr(v)
    if isinstance(v, datetime):
        return v.isoformat()
    if isinstance(v, date):
        return v.isoformat()
    if isinstance(v, dict):
        return {str(k): _canon(x) for k, x in v.items()}
    if isinstance(v, (list, tuple)):
        return [_canon(x) for x in v]
    return v


def stable_hash(obj: Any) -> str:
    return hashlib.sha256(json.dumps(_canon(obj), sort_keys=True, separators=(",", ":")).encode()).hexdigest()


def canon(obj: Any) -> Any:
    """JSON-safe copy with decimals as normalized strings (for JSON columns)."""
    return _canon(obj)


def mask(d: dict, fields: Iterable[str], allowed: bool) -> dict:
    if not allowed:
        hidden = False
        for f in fields:
            if f in d and d[f] is not None:
                d[f] = None
                hidden = True
        if hidden:
            d["commercial_hidden"] = True
    return d


def run_command(
    db: Session,
    p: Principal,
    request: Request,
    idempotency_key: str | None,
    body: Any,
    fn: Callable[[], tuple[int, Any]],
) -> JSONResponse:
    """Replay a stored response for a repeated Idempotency-Key, else run fn, store and commit once."""
    route = f"{request.method} {request.url.path}"
    req_body = body.model_dump(mode="json") if hasattr(body, "model_dump") else (body or {})
    cached = replay(db, p, route, idempotency_key, req_body)
    if cached is not None:
        return JSONResponse(cached["body"], status_code=cached["status"])
    status, result = fn()
    result = jsonable_encoder(_canon(result))
    remember(db, p, route, idempotency_key, req_body, {"status": status, "body": result}, status)
    db.commit()
    return JSONResponse(result, status_code=status)
