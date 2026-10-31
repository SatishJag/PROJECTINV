from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from app.core.auth import Principal, require_internal
from app.db import get_db
from app.services import costs
from app.services.helpers import command

router = APIRouter(prefix="/api/costs", tags=["costs"])


@router.post("/events")
def create_event(body: dict, db: Session = Depends(get_db), p: Principal = Depends(require_internal)):
    data, _ = command(db, p, "costs.events.create", None, body, lambda: costs.create_event(db, p, body), 201)
    return data


@router.get("/events")
def list_events(unit_id: str | None = None, economic_key: str | None = None, db: Session = Depends(get_db), p: Principal = Depends(require_internal)):
    return costs.list_events(db, p, unit_id, economic_key)


@router.post("/events/{event_id}/allocate")
def allocate_event(event_id: str, body: dict, db: Session = Depends(get_db), p: Principal = Depends(require_internal)):
    data, _ = command(db, p, f"costs.events.{event_id}.allocate", None, body, lambda: costs.allocate_event(db, p, event_id, body))
    return data


@router.get("/units/{unit_id}/summary")
def unit_summary(unit_id: str, db: Session = Depends(get_db), p: Principal = Depends(require_internal)):
    return costs.unit_summary(db, p, unit_id)


@router.get("/rollup")
def rollup(parent_unit_id: str, db: Session = Depends(get_db), p: Principal = Depends(require_internal)):
    return costs.rollup(db, p, parent_unit_id)


@router.post("/tco-scenarios")
def create_tco(body: dict, db: Session = Depends(get_db), p: Principal = Depends(require_internal)):
    data, _ = command(db, p, "costs.tco.create", None, body, lambda: costs.create_tco(db, p, body), 201)
    return data


@router.get("/tco-scenarios")
def list_tco(db: Session = Depends(get_db), p: Principal = Depends(require_internal)):
    return costs.list_tco(db, p)


@router.post("/fm-work-orders/import")
def import_fm(body: dict, db: Session = Depends(get_db), p: Principal = Depends(require_internal)):
    data, _ = command(db, p, "costs.fm.import", None, body, lambda: costs.import_fm_work_orders(db, p, body), 201)
    return data


@router.get("/fm-work-orders")
def list_fm(db: Session = Depends(get_db), p: Principal = Depends(require_internal)):
    return costs.list_fm_work_orders(db, p)


@router.post("/outcomes/publish")
def publish_outcome(body: dict, db: Session = Depends(get_db), p: Principal = Depends(require_internal)):
    data, _ = command(db, p, "costs.outcomes.publish", None, body, lambda: costs.publish_outcome(db, p, body), 201)
    return data


@router.get("/outcomes")
def list_outcomes(equipment_class_id: str | None = None, db: Session = Depends(get_db), p: Principal = Depends(require_internal)):
    return costs.list_outcomes(db, p, equipment_class_id)
