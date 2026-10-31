from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from app.core.auth import Principal, require_internal
from app.db import get_db
from app.services import delivery
from app.services.helpers import command

router = APIRouter(prefix="/api/assets", tags=["assets"])


@router.get("/units")
def list_units(
    programme_id: str | None = None,
    project_id: str | None = None,
    state: str | None = None,
    allocation_status: str | None = None,
    q: str | None = None,
    include_components: bool = False,
    db: Session = Depends(get_db),
    p: Principal = Depends(require_internal),
):
    return delivery.list_units(db, p, programme_id, project_id, state, allocation_status, q, include_components)


@router.get("/units/{unit_id}")
def unit_passport(unit_id: str, db: Session = Depends(get_db), p: Principal = Depends(require_internal)):
    return delivery.unit_passport(db, p, unit_id)


@router.get("/units/{unit_id}/structure")
def unit_structure(unit_id: str, at: str | None = None, db: Session = Depends(get_db), p: Principal = Depends(require_internal)):
    return delivery.unit_structure(db, p, unit_id, at)


@router.get("/units/{unit_id}/history")
def unit_history(unit_id: str, db: Session = Depends(get_db), p: Principal = Depends(require_internal)):
    return delivery.unit_history(db, p, unit_id)


@router.post("/units")
def register_unit(body: dict, db: Session = Depends(get_db), p: Principal = Depends(require_internal)):
    data, _ = command(db, p, "assets.units.create", None, body, lambda: delivery.register_unit(db, p, body), 201)
    return data


@router.post("/units/{unit_id}/components")
def fit_component(unit_id: str, body: dict, db: Session = Depends(get_db), p: Principal = Depends(require_internal)):
    data, _ = command(db, p, f"assets.units.{unit_id}.components", None, body, lambda: delivery.fit_component_api(db, p, unit_id, body), 201)
    return data


@router.post("/units/{unit_id}/components/{link_id}/remove")
def remove_component(unit_id: str, link_id: str, body: dict, db: Session = Depends(get_db), p: Principal = Depends(require_internal)):
    data, _ = command(db, p, f"assets.units.{unit_id}.components.{link_id}.remove", None, body, lambda: delivery.remove_component(db, p, unit_id, link_id, body))
    return data
