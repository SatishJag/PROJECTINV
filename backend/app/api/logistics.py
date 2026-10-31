from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from app.core.auth import Principal, require_internal
from app.db import get_db
from app.services import delivery
from app.services.helpers import command

router = APIRouter(prefix="/api/logistics", tags=["logistics"])


@router.get("/shipments")
def list_shipments(db: Session = Depends(get_db), p: Principal = Depends(require_internal)):
    return delivery.list_shipments(db, p)


@router.post("/shipments")
def create_shipment(body: dict, db: Session = Depends(get_db), p: Principal = Depends(require_internal)):
    data, _ = command(db, p, "logistics.shipments.create", None, body, lambda: delivery.create_shipment(db, p, body), 201)
    return data


@router.get("/shipments/{shipment_id}")
def get_shipment(shipment_id: str, db: Session = Depends(get_db), p: Principal = Depends(require_internal)):
    return delivery.get_shipment(db, p, shipment_id)


@router.post("/shipments/{shipment_id}/milestones")
def add_milestone(shipment_id: str, body: dict, db: Session = Depends(get_db), p: Principal = Depends(require_internal)):
    data, _ = command(db, p, f"logistics.shipments.{shipment_id}.milestones", None, body, lambda: delivery.add_milestone(db, p, shipment_id, body), 201)
    return data


@router.post("/shipments/{shipment_id}/tracking-failure")
def tracking_failure(shipment_id: str, body: dict, db: Session = Depends(get_db), p: Principal = Depends(require_internal)):
    data, _ = command(db, p, f"logistics.shipments.{shipment_id}.tracking-failure", None, body, lambda: delivery.tracking_failure(db, p, shipment_id, body))
    return data


@router.get("/arrival")
def arrival(
    project_id: str | None = None,
    selected_date: str | None = None,
    as_known_at: str | None = None,
    db: Session = Depends(get_db),
    p: Principal = Depends(require_internal),
):
    return delivery.arrival_overview(db, p, project_id, selected_date, as_known_at)


@router.post("/arrival/snapshots")
def arrival_snapshots(body: dict | None = None, db: Session = Depends(get_db), p: Principal = Depends(require_internal)):
    data, _ = command(db, p, "logistics.arrival.snapshots", None, body or {}, lambda: delivery.create_arrival_snapshots(db, p, body or {}), 201)
    return data
