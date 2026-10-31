from fastapi import APIRouter, Depends, Header
from fastapi.responses import JSONResponse
from sqlalchemy.orm import Session

from app.core.auth import Principal, require_internal
from app.core.commands import remember, replay
from app.db import get_db
from app.services import procurement
from app.services.helpers import command

router = APIRouter(prefix="/api/procurement", tags=["procurement"])


@router.get("/purchase-orders")
def list_purchase_orders(db: Session = Depends(get_db), p: Principal = Depends(require_internal)):
    return procurement.list_purchase_orders(db, p)


@router.post("/purchase-orders/import")
def import_po(
    body: dict,
    db: Session = Depends(get_db),
    p: Principal = Depends(require_internal),
    idem: str | None = Header(default=None, alias="Idempotency-Key"),
):
    cached = replay(db, p, "procurement.purchase-orders.import", idem, body)
    if cached is not None:
        return cached
    data, existing = procurement.import_po(db, p, body)
    remember(db, p, "procurement.purchase-orders.import", idem, body, data, 200 if existing else 201)
    db.commit()
    return JSONResponse(status_code=200 if existing else 201, content=data)


@router.get("/purchase-orders/{po_id}")
def get_purchase_order(po_id: str, db: Session = Depends(get_db), p: Principal = Depends(require_internal)):
    return procurement.get_purchase_order(db, p, po_id)


@router.post("/purchase-orders/{po_id}/cancel-quantity")
def cancel_quantity(po_id: str, body: dict, db: Session = Depends(get_db), p: Principal = Depends(require_internal)):
    data, _ = command(db, p, f"procurement.purchase-orders.{po_id}.cancel-quantity", None, body, lambda: procurement.cancel_quantity(db, p, po_id, body))
    return data
