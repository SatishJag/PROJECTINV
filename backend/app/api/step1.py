"""Step 1 feed: crosswalk queue and classification (more routes are added here by later tasks)."""

from fastapi import APIRouter, Depends, Header
from sqlalchemy.orm import Session

from app.core.auth import Principal, require_internal
from app.db import get_db
from app.services import step1_items
from app.services.helpers import command

router = APIRouter(prefix="/api/integrations/step1", tags=["step1"])


@router.get("/items")
def list_items(decision: str | None = None, db: Session = Depends(get_db), p: Principal = Depends(require_internal)):
    return step1_items.list_items(db, p, decision)


@router.post("/items/{item_id}/classify")
def classify_item(
    item_id: str,
    body: dict,
    db: Session = Depends(get_db),
    p: Principal = Depends(require_internal),
    idem: str | None = Header(default=None, alias="Idempotency-Key"),
    if_match: str | None = Header(default=None, alias="If-Match"),
):
    data, _ = command(db, p, f"step1.items.{item_id}.classify", idem, body, lambda: step1_items.classify_item(db, p, item_id, body, if_match))
    return data
