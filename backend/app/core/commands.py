"""Idempotency-Key handling and ETag (If-Match) checks for commands (spec §32)."""

import hashlib
import json
from typing import Any

from fastapi.encoders import jsonable_encoder
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.core.auth import Principal
from app.core.errors import Conflict, DomainError, PreconditionFailed
from app.models import IdempotencyRecord


def canonical_hash(body: Any) -> str:
    return hashlib.sha256(json.dumps(jsonable_encoder(body), sort_keys=True, separators=(",", ":")).encode()).hexdigest()


def replay(db: Session, p: Principal, route: str, key: str | None, body: Any) -> Any | None:
    """Return the stored response for (principal, route, key) or None if this is a new request.

    Same key + same body → stored response. Same key + different body → 409.
    """
    if not key:
        return None
    rec = db.scalar(
        select(IdempotencyRecord).where(
            IdempotencyRecord.tenant_id == p.tenant_id,
            IdempotencyRecord.principal == p.user_id,
            IdempotencyRecord.route == route,
            IdempotencyRecord.key == key,
        )
    )
    if rec is None:
        return None
    if rec.request_hash != canonical_hash(body):
        raise Conflict("IDEMPOTENCY_KEY_REUSED", "Idempotency-Key was already used with a different request body")
    return rec.response


def remember(db: Session, p: Principal, route: str, key: str | None, body: Any, response: Any, status_code: int = 200) -> None:
    """Store the response in the same transaction as the business change (call before commit)."""
    if not key:
        return
    db.add(
        IdempotencyRecord(
            tenant_id=p.tenant_id,
            principal=p.user_id,
            route=route,
            key=key,
            request_hash=canonical_hash(body),
            status_code=status_code,
            response=jsonable_encoder(response),
        )
    )
    try:
        db.flush()
    except IntegrityError as exc:
        db.rollback()
        raise Conflict("IDEMPOTENCY_RACE", "A concurrent request with the same Idempotency-Key is in progress") from exc


def etag_of(obj) -> str:
    return f'W/"{obj.version}"'


def check_if_match(obj, if_match: str | None, required: bool = False) -> None:
    if if_match is None:
        if required:
            raise DomainError("IF_MATCH_REQUIRED", "If-Match header is required for this command", status=428)
        return
    if if_match.strip() not in (etag_of(obj), str(obj.version)):
        raise PreconditionFailed()


def bump(obj) -> None:
    obj.version = (obj.version or 0) + 1
