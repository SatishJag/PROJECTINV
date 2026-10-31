"""Procurement: PO import with alias dedupe, permanent physical-unit identity and allocation."""

from __future__ import annotations

from decimal import Decimal
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.api.common import row
from app.core.auth import Principal
from app.core.commands import bump
from app.core.decimal import QTY_Q, dstr
from app.core.errors import Conflict, DomainError
from app.core.outbox import enqueue
from app.models import (
    AwardDecision,
    AwardLine,
    EquipmentOption,
    ItemModel,
    PhysicalUnit,
    PoAlias,
    PoDistribution,
    PoLine,
    Programme,
    Project,
    PurchaseOrder,
    Requirement,
    RequirementPoAllocation,
    Supplier,
    utcnow,
)
from app.services.helpers import audit, dec, get_row, need, optional_date
from app.services.identity import next_asset_codes, prefix_for_model


def _po_out(db: Session, po: PurchaseOrder) -> dict:
    aliases = db.scalars(select(PoAlias).where(PoAlias.po_id == po.id))
    lines = []
    for line in db.scalars(select(PoLine).where(PoLine.po_id == po.id).order_by(PoLine.line_no)):
        distributions = []
        for distribution in db.scalars(select(PoDistribution).where(PoDistribution.po_line_id == line.id)):
            project = db.get(Project, distribution.project_id) if distribution.project_id else None
            distributions.append(row(distribution, project_code=project.code if project else None))
        unit_count = len(list(db.scalars(select(PhysicalUnit.id).where(PhysicalUnit.po_line_id == line.id, PhysicalUnit.state != "CANCELLED"))))
        lines.append(
            row(
                line,
                item_code=line.item_model.item_code if line.item_model else None,
                item_description=line.item_model.description if line.item_model else None,
                distributions=distributions,
                unit_count=unit_count,
            )
        )
    units = db.scalars(select(PhysicalUnit).where(PhysicalUnit.po_line_id.in_([line.id for line in db.scalars(select(PoLine).where(PoLine.po_id == po.id))])).order_by(PhysicalUnit.asset_code))
    supplier = db.get(Supplier, po.supplier_id)
    programme = db.get(Programme, po.programme_id)
    return {
        "po": row(po, supplier_key=supplier.key if supplier else None, supplier_name=supplier.name if supplier else None, programme_code=programme.code if programme else None),
        "aliases": [row(a) for a in aliases],
        "lines": lines,
        "units": [row(u, item_code=u.item_model.item_code if u.item_model else None) for u in units],
    }


def list_purchase_orders(db: Session, p: Principal) -> list[dict]:
    pos = db.scalars(select(PurchaseOrder).where(PurchaseOrder.tenant_id == p.tenant_id).order_by(PurchaseOrder.issued_at.desc()))
    out = []
    for po in pos:
        lines = list(db.scalars(select(PoLine).where(PoLine.po_id == po.id)))
        units = db.scalars(select(PhysicalUnit.id).where(PhysicalUnit.po_line_id.in_([line.id for line in lines])))
        supplier = db.get(Supplier, po.supplier_id)
        out.append(
            row(
                po,
                supplier_key=supplier.key if supplier else None,
                supplier_name=supplier.name if supplier else None,
                line_count=len(lines),
                unit_count=len(list(units)),
            )
        )
    return out


def get_purchase_order(db: Session, p: Principal, po_id: str) -> dict:
    return _po_out(db, get_row(db, PurchaseOrder, po_id, p, "Purchase order"))


def _requirement_sequence(distributions: list[dict], quantity: int) -> list[str | None]:
    sequence: list[str | None] = []
    for distribution in distributions:
        count = int(dec(distribution.get("quantity"), "distribution.quantity", required=True))
        sequence.extend([distribution.get("requirement_id")] * count)
    if not sequence:
        return [None] * quantity
    if len(sequence) < quantity:
        sequence.extend([sequence[-1]] * (quantity - len(sequence)))
    return sequence[:quantity]


def import_po(db: Session, p: Principal, body: dict) -> tuple[dict, bool]:
    source_system = str(need(body, "source_system")).upper()
    if source_system not in ("GEP", "ORACLE", "PROCORE"):
        raise DomainError("VALIDATION", "source_system must be GEP, ORACLE or PROCORE")
    source_number = need(body, "source_number")
    existing_alias = db.scalar(
        select(PoAlias).where(PoAlias.tenant_id == p.tenant_id, PoAlias.source_system == source_system, PoAlias.source_number == source_number)
    )
    if existing_alias:
        return _po_out(db, db.get(PurchaseOrder, existing_alias.po_id)), True
    canonical = body.get("canonical_number") or source_number
    existing_po = db.scalar(select(PurchaseOrder).where(PurchaseOrder.tenant_id == p.tenant_id, PurchaseOrder.canonical_number == canonical))
    if existing_po:
        db.add(PoAlias(tenant_id=p.tenant_id, created_by=p.email, po_id=existing_po.id, source_system=source_system, source_number=source_number))
        audit(db, p, "PO_ALIAS_ADDED", "purchase_order", existing_po.id, after={"source_system": source_system, "source_number": source_number})
        return _po_out(db, existing_po), True

    supplier = get_row(db, Supplier, need(body, "supplier_id"), p, "Supplier")
    programme = get_row(db, Programme, need(body, "programme_id"), p, "Programme")
    award = None
    if body.get("award_id"):
        award = get_row(db, AwardDecision, body["award_id"], p, "Award")
        if award.state != "APPROVED":
            raise Conflict("AWARD_NOT_APPROVED", "Purchase orders can only be derived from an approved award")
    po = PurchaseOrder(
        tenant_id=p.tenant_id,
        created_by=p.email,
        canonical_number=canonical,
        supplier_id=supplier.id,
        programme_id=programme.id,
        award_id=award.id if award else None,
        currency=body.get("currency") or programme.currency,
        incoterms=body.get("incoterms"),
        state="ISSUED",
    )
    db.add(po)
    db.flush()
    db.add(PoAlias(tenant_id=p.tenant_id, created_by=p.email, po_id=po.id, source_system=source_system, source_number=source_number))
    distrusted_requirement_ids: set[str] = set()
    for line_body in body.get("lines") or []:
        item = db.scalar(select(ItemModel).where(ItemModel.tenant_id == p.tenant_id, ItemModel.item_code == need(line_body, "item_code")))
        if item is None:
            raise DomainError("VALIDATION", f"Unknown item code {line_body.get('item_code')}")
        option = None
        if line_body.get("option_code"):
            option = db.scalar(
                select(EquipmentOption).where(EquipmentOption.tenant_id == p.tenant_id, EquipmentOption.option_code == line_body["option_code"])
            )
            if option is None:
                raise DomainError("VALIDATION", f"Unknown option {line_body['option_code']}")
        quantity = dec(line_body.get("quantity"), "quantity", required=True)
        if quantity <= 0 or quantity != quantity.to_integral_value():
            raise DomainError("VALIDATION", "PO line quantity must be a positive whole number of serialized units")
        unit_price = dec(line_body.get("unit_price"), "unit_price", required=True)
        line = PoLine(
            tenant_id=p.tenant_id,
            created_by=p.email,
            po_id=po.id,
            line_no=int(need(line_body, "line_no")),
            item_model_id=item.id,
            option_id=option.id if option else None,
            quantity=quantity,
            uom=line_body.get("uom") or "EA",
            unit_price=unit_price,
            need_by=optional_date(line_body.get("need_by")),
        )
        db.add(line)
        db.flush()
        distributions = line_body.get("distributions") or [{"project_id": None, "quantity": dstr(quantity)}]
        for distribution in distributions:
            db.add(
                PoDistribution(
                    tenant_id=p.tenant_id,
                    created_by=p.email,
                    po_line_id=line.id,
                    project_id=distribution.get("project_id"),
                    wbs_id=distribution.get("wbs_id"),
                    requirement_id=distribution.get("requirement_id"),
                    quantity=dec(distribution.get("quantity"), "distribution.quantity", required=True),
                )
            )
            if distribution.get("requirement_id"):
                distrusted_requirement_ids.add(distribution["requirement_id"])
        db.flush()
        if line_body.get("award_line_id"):
            award_line = get_row(db, AwardLine, line_body["award_line_id"], p, "Award line")
            already = sum(
                (row.allocated_quantity for row in db.scalars(select(RequirementPoAllocation).where(RequirementPoAllocation.award_line_id == award_line.id))),
                Decimal(0),
            )
            if already + quantity > award_line.selected_quantity:
                raise Conflict("ALLOCATION_EXCEEDS_AWARD", f"PO quantity exceeds awarded quantity {dstr(award_line.selected_quantity)}")
            db.add(
                RequirementPoAllocation(
                    tenant_id=p.tenant_id,
                    created_by=p.email,
                    award_line_id=award_line.id,
                    po_line_id=line.id,
                    allocated_quantity=quantity,
                    uom=line.uom,
                )
            )
        if not item.serial_controlled:
            continue
        count = int(quantity)
        sequence = _requirement_sequence(distributions, count)
        prefix = prefix_for_model(db, item)
        codes = next_asset_codes(db, p.tenant_id, prefix, count)
        for index, code in enumerate(codes):
            db.add(
                PhysicalUnit(
                    tenant_id=p.tenant_id,
                    created_by=p.email,
                    asset_code=code,
                    item_model_id=item.id,
                    programme_id=programme.id,
                    po_line_id=line.id,
                    requirement_id=sequence[index],
                    state="PLANNED",
                    allocation_status="UNALLOCATED",
                )
            )
        db.flush()
    enqueue(
        db,
        p.tenant_id,
        "PROCORE",
        "purchase_order.upsert",
        "purchase_order",
        po.id,
        {"po_id": po.id, "canonical_number": po.canonical_number},
        aggregate_version=po.version,
    )
    audit(db, p, "PURCHASE_ORDER_IMPORTED", "purchase_order", po.id, after={"canonical_number": canonical, "source": f"{source_system}:{source_number}"})
    return _po_out(db, po), False


def cancel_quantity(db: Session, p: Principal, po_id: str, body: dict) -> dict:
    po = get_row(db, PurchaseOrder, po_id, p, "Purchase order")
    line = get_row(db, PoLine, need(body, "po_line_id"), p, "PO line")
    if line.po_id != po.id:
        raise DomainError("VALIDATION", "PO line does not belong to this PO")
    quantity = dec(body.get("quantity"), "quantity", required=True)
    remaining = line.quantity - line.cancelled_quantity
    if quantity <= 0 or quantity > remaining:
        raise Conflict("INVALID_CANCELLATION", f"Cancellation must be between 0 and {dstr(remaining)}")
    units = list(
        db.scalars(
            select(PhysicalUnit)
            .where(PhysicalUnit.po_line_id == line.id, PhysicalUnit.state == "PLANNED")
            .order_by(PhysicalUnit.asset_code.desc())
            .limit(int(quantity))
        )
    )
    if len(units) < int(quantity):
        raise Conflict("INSUFFICIENT_PLANNED_UNITS", "Not enough PLANNED units remain on this line to cancel")
    for unit in units:
        unit.state = "CANCELLED"
        bump(unit)
    line.cancelled_quantity = line.cancelled_quantity + quantity
    bump(po)
    audit(db, p, "PO_QUANTITY_CANCELLED", "purchase_order", po.id, after={"line_no": line.line_no, "quantity": dstr(quantity), "units": [u.asset_code for u in units]})
    return _po_out(db, po)
