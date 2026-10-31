"""Read-only master/reference data: organization, places, suppliers, catalogue (PIM), BOM."""

from fastapi import APIRouter, Depends
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.api.common import get_owned, row, rows
from app.core.auth import Principal, current_principal, require_internal
from app.db import get_db
from app.models import (
    BomLine,
    CompatibleSpare,
    EquipmentClass,
    EquipmentOption,
    ItemModel,
    Location,
    Programme,
    Project,
    Supplier,
    WbsElement,
)

router = APIRouter(prefix="/api", tags=["reference"])


@router.get("/programmes")
def list_programmes(p: Principal = Depends(require_internal), db: Session = Depends(get_db)):
    return rows(db.scalars(select(Programme).where(Programme.tenant_id == p.tenant_id).order_by(Programme.code)))


@router.get("/projects")
def list_projects(p: Principal = Depends(require_internal), db: Session = Depends(get_db)):
    items = db.scalars(select(Project).where(Project.tenant_id == p.tenant_id).order_by(Project.code))
    return [row(x) for x in items if p.can_see_project(x.id)]


@router.get("/projects/{project_id}/wbs")
def list_wbs(project_id: str, p: Principal = Depends(require_internal), db: Session = Depends(get_db)):
    get_owned(db, Project, project_id, p, "Project")
    if not p.can_see_project(project_id):
        return []
    return rows(db.scalars(select(WbsElement).where(WbsElement.tenant_id == p.tenant_id, WbsElement.project_id == project_id).order_by(WbsElement.code)))


@router.get("/locations")
def list_locations(p: Principal = Depends(require_internal), db: Session = Depends(get_db)):
    return rows(db.scalars(select(Location).where(Location.tenant_id == p.tenant_id).order_by(Location.code)))


@router.get("/suppliers")
def list_suppliers(p: Principal = Depends(current_principal), db: Session = Depends(get_db)):
    q = select(Supplier).where(Supplier.tenant_id == p.tenant_id)
    if p.is_supplier:
        q = q.where(Supplier.id == p.supplier_id)
    return rows(db.scalars(q.order_by(Supplier.name)))


@router.get("/equipment-classes")
def list_classes(include_components: bool = False, p: Principal = Depends(require_internal), db: Session = Depends(get_db)):
    q = select(EquipmentClass).where(EquipmentClass.tenant_id == p.tenant_id)
    if not include_components:
        q = q.where(EquipmentClass.is_component_class.is_(False))
    return rows(db.scalars(q.order_by(EquipmentClass.category, EquipmentClass.name)))


@router.get("/item-models")
def list_models(equipment_class_id: str | None = None, p: Principal = Depends(require_internal), db: Session = Depends(get_db)):
    q = select(ItemModel).where(ItemModel.tenant_id == p.tenant_id)
    if equipment_class_id:
        q = q.where(ItemModel.equipment_class_id == equipment_class_id)
    return [row(m, equipment_class_code=m.equipment_class.code) for m in db.scalars(q.order_by(ItemModel.item_code))]


def _bom_tree(db: Session, tenant_id: str, model_id: str, depth: int = 0) -> list[dict]:
    if depth > 6:
        return []
    lines = db.scalars(select(BomLine).where(BomLine.tenant_id == tenant_id, BomLine.parent_model_id == model_id).order_by(BomLine.slot_code))
    out = []
    for ln in lines:
        child = db.get(ItemModel, ln.child_model_id) if ln.child_model_id else None
        out.append(
            row(
                ln,
                child_item_code=child.item_code if child else None,
                child_description=child.description if child else None,
                children=_bom_tree(db, tenant_id, child.id, depth + 1) if child else [],
            )
        )
    return out


@router.get("/item-models/{model_id}")
def get_model(model_id: str, p: Principal = Depends(require_internal), db: Session = Depends(get_db)):
    m = get_owned(db, ItemModel, model_id, p, "Item model")
    spares = db.scalars(select(CompatibleSpare).where(CompatibleSpare.tenant_id == p.tenant_id, CompatibleSpare.parent_model_id == m.id))
    options = db.scalars(select(EquipmentOption).where(EquipmentOption.tenant_id == p.tenant_id, EquipmentOption.item_model_id == m.id))
    return row(
        m,
        equipment_class_code=m.equipment_class.code,
        bom=_bom_tree(db, p.tenant_id, m.id),
        compatible_spares=[row(s, spare_item_code=db.get(ItemModel, s.spare_model_id).item_code) for s in spares],
        options=rows(options),
    )


@router.get("/options")
def list_options(p: Principal = Depends(require_internal), db: Session = Depends(get_db)):
    q = select(EquipmentOption).where(EquipmentOption.tenant_id == p.tenant_id).order_by(EquipmentOption.option_code, EquipmentOption.revision_no)
    return [row(o, item_code=o.item_model.item_code, equipment_class_id=o.item_model.equipment_class_id) for o in db.scalars(q)]
