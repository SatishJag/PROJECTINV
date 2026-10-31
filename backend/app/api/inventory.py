from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from app.core.auth import Principal, require_internal
from app.db import get_db
from app.services import delivery
from app.services.helpers import command

router = APIRouter(prefix="/api/inventory", tags=["inventory"])


@router.post("/receipts")
def create_receipt(body: dict, db: Session = Depends(get_db), p: Principal = Depends(require_internal)):
    data, _ = command(db, p, "inventory.receipts.create", None, body, lambda: delivery.create_receipt(db, p, body), 201)
    return data


@router.get("/stock")
def stock(
    programme_id: str | None = None,
    location_id: str | None = None,
    project_id: str | None = None,
    db: Session = Depends(get_db),
    p: Principal = Depends(require_internal),
):
    return delivery.stock_overview(db, p, programme_id, location_id, project_id)


@router.post("/allocations")
def create_allocations(body: dict, db: Session = Depends(get_db), p: Principal = Depends(require_internal)):
    data, _ = command(db, p, "inventory.allocations.create", None, body, lambda: delivery.create_allocations(db, p, body), 201)
    return data


@router.get("/allocations")
def list_allocations(unit_id: str | None = None, db: Session = Depends(get_db), p: Principal = Depends(require_internal)):
    return delivery.list_allocations(db, p, unit_id)


@router.post("/allocations/{allocation_id}/release")
def release_allocation(allocation_id: str, db: Session = Depends(get_db), p: Principal = Depends(require_internal)):
    data, _ = command(db, p, f"inventory.allocations.{allocation_id}.release", None, {}, lambda: delivery.release_allocation(db, p, allocation_id))
    return data


@router.post("/issues")
def issue_unit(body: dict, db: Session = Depends(get_db), p: Principal = Depends(require_internal)):
    data, _ = command(db, p, "inventory.issues.create", None, body, lambda: delivery.issue_unit(db, p, body), 201)
    return data


@router.get("/transfers")
def list_transfers(db: Session = Depends(get_db), p: Principal = Depends(require_internal)):
    return delivery.list_transfers(db, p)


@router.post("/transfers")
def create_transfer(body: dict, db: Session = Depends(get_db), p: Principal = Depends(require_internal)):
    data, _ = command(db, p, "inventory.transfers.create", None, body, lambda: delivery.create_transfer(db, p, body), 201)
    return data


@router.post("/transfers/{manifest_id}/approve")
def approve_transfer(manifest_id: str, body: dict | None = None, db: Session = Depends(get_db), p: Principal = Depends(require_internal)):
    data, _ = command(db, p, f"inventory.transfers.{manifest_id}.approve", None, body or {}, lambda: delivery.transfer_command(db, p, manifest_id, "approve", body or {}))
    return data


@router.post("/transfers/{manifest_id}/dispatch")
def dispatch_transfer(manifest_id: str, body: dict | None = None, db: Session = Depends(get_db), p: Principal = Depends(require_internal)):
    data, _ = command(db, p, f"inventory.transfers.{manifest_id}.dispatch", None, body or {}, lambda: delivery.transfer_command(db, p, manifest_id, "dispatch", body or {}))
    return data


@router.post("/transfers/{manifest_id}/receive")
def receive_transfer(manifest_id: str, body: dict, db: Session = Depends(get_db), p: Principal = Depends(require_internal)):
    data, _ = command(db, p, f"inventory.transfers.{manifest_id}.receive", None, body, lambda: delivery.transfer_command(db, p, manifest_id, "receive", body))
    return data


@router.get("/stock-transactions")
def stock_transactions(unit_id: str | None = None, db: Session = Depends(get_db), p: Principal = Depends(require_internal)):
    return delivery.list_stock_transactions(db, p, unit_id)
