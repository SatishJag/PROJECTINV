"""Delivery chain: receipts, custody, allocation, temporal structure, FAT/NCR recovery and arrival."""

from __future__ import annotations

from datetime import date, datetime, timedelta
from decimal import Decimal
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.api.common import row
from app.core.auth import Principal
from app.core.commands import bump
from app.core.decimal import MONEY_Q, dstr
from app.core.errors import Conflict, DomainError, Forbidden
from app.core.outbox import enqueue
from app.models import (
    AllocationRecord,
    ArrivalSnapshot,
    BomLine,
    CompatibleSpare,
    CostEvent,
    EquipmentClass,
    ExternalObjectLink,
    HandbookPackage,
    ItemModel,
    Location,
    PhysicalUnit,
    PoLine,
    Project,
    PurchaseOrder,
    Receipt,
    ReceiptLine,
    RecoveryCase,
    Requirement,
    Shipment,
    ShipmentMilestone,
    StockTransaction,
    TestRecord,
    TransferManifest,
    UnitComponent,
    utcnow,
)
from app.services.helpers import audit, dec, get_row, need, optional_date, optional_dt, sha256
from app.services.identity import next_asset_codes, prefix_for_model


# ---------------------------------------------------------------- access & serialization


def unit_scoped(db: Session, p: Principal, unit_id: str) -> PhysicalUnit:
    unit = get_row(db, PhysicalUnit, unit_id, p, "Unit")
    if not p.can_see_project(unit.assigned_project_id):
        raise DomainError("NOT_FOUND", "Unit not found", status=404)
    return unit


def unit_out(db: Session, unit: PhysicalUnit) -> dict:
    project = db.get(Project, unit.assigned_project_id) if unit.assigned_project_id else None
    custody = db.get(Location, unit.custody_location_id) if unit.custody_location_id else None
    return row(
        unit,
        item_code=unit.item_model.item_code if unit.item_model else None,
        item_description=unit.item_model.description if unit.item_model else None,
        project_code=project.code if project else None,
        custody_code=custody.code if custody else None,
        custody_name=custody.name if custody else None,
    )


def _open_links(db: Session, parent_id: str, at: datetime | None = None) -> list[UnitComponent]:
    query = select(UnitComponent).where(UnitComponent.parent_unit_id == parent_id)
    if at is None:
        query = query.where(UnitComponent.valid_to.is_(None))
    else:
        query = query.where(UnitComponent.valid_from <= at, (UnitComponent.valid_to.is_(None)) | (UnitComponent.valid_to > at))
    return list(db.scalars(query.order_by(UnitComponent.slot_code)))


def _tree(db: Session, unit: PhysicalUnit, at: datetime | None, seen: set[str]) -> list[dict]:
    nodes = []
    for link in _open_links(db, unit.id, at):
        if link.child_unit_id in seen:
            continue
        seen.add(link.child_unit_id)
        child = db.get(PhysicalUnit, link.child_unit_id)
        if child is None:
            continue
        nodes.append(
            {
                "link_id": link.id,
                "slot_code": link.slot_code,
                "valid_from": link.valid_from.isoformat() + "Z",
                "valid_to": link.valid_to.isoformat() + "Z" if link.valid_to else None,
                "recovery_case_id": link.recovery_case_id,
                "unit": unit_out(db, child),
                "children": _tree(db, child, at, seen),
            }
        )
    return nodes


def structure(db: Session, unit: PhysicalUnit, at: datetime | None = None) -> dict:
    return {"unit": unit_out(db, unit), "as_of": (at.isoformat() + "Z") if at else None, "components": _tree(db, unit, at, {unit.id})}


def _parent_of(db: Session, unit: PhysicalUnit) -> dict | None:
    link = db.scalar(select(UnitComponent).where(UnitComponent.child_unit_id == unit.id, UnitComponent.valid_to.is_(None)))
    if not link:
        return None
    parent = db.get(PhysicalUnit, link.parent_unit_id)
    return {"unit": unit_out(db, parent), "slot_code": link.slot_code, "link_id": link.id} if parent else None


# ---------------------------------------------------------------- receipts & stock


def _receipt_out(db: Session, receipt: Receipt) -> dict:
    lines = db.scalars(select(ReceiptLine).where(ReceiptLine.receipt_id == receipt.id))
    location = db.get(Location, receipt.location_id)
    return row(receipt, location_code=location.code if location else None, lines=[row(line, asset_code=(db.get(PhysicalUnit, line.unit_id).asset_code if db.get(PhysicalUnit, line.unit_id) else None)) for line in lines])


def _provisional_cost(db: Session, p: Principal, unit: PhysicalUnit, receipt: Receipt, po_line: PoLine | None) -> None:
    if po_line is None:
        return
    db.add(
        CostEvent(
            tenant_id=p.tenant_id,
            created_by=p.email,
            economic_key=f"PURCHASE:{unit.asset_code}",
            revision_no=1,
            unit_id=unit.id,
            po_line_id=po_line.id,
            posting_project_id=unit.assigned_project_id or (db.get(Location, receipt.location_id).project_id if db.get(Location, receipt.location_id) else None),
            category="PURCHASE",
            status="PROVISIONAL",
            amount=po_line.unit_price,
            currency=db.get(PurchaseOrder, receipt.po_id).currency,
            source_system="ORACLE",
            source_ref=receipt.receipt_ref,
            occurred_on=receipt.received_at.date(),
        )
    )


def _component_slot(db: Session, root: PhysicalUnit, slot: str, parent_slot: str | None = None) -> tuple[PhysicalUnit, BomLine]:
    """Resolve a receipt component against the root BOM or any fitted descendant's BOM (nested BOM)."""
    bom = db.scalar(select(BomLine).where(BomLine.parent_model_id == root.item_model_id, BomLine.slot_code == slot))
    if bom and bom.child_model_id and bom.individually_tracked:
        return root, bom
    candidates: list[tuple[PhysicalUnit, BomLine]] = []
    for candidate in _descendants_units(db, root, set()):
        if candidate.id == root.id or candidate.item_model_id is None:
            continue
        if parent_slot and _parent_of(db, candidate) and _parent_of(db, candidate)["slot_code"] != parent_slot:
            continue
        line = db.scalar(select(BomLine).where(BomLine.parent_model_id == candidate.item_model_id, BomLine.slot_code == slot))
        if line and line.child_model_id and line.individually_tracked:
            candidates.append((candidate, line))
    if len(candidates) == 1:
        return candidates[0]
    if not candidates:
        raise DomainError("VALIDATION", f"{slot} is not an individually tracked BOM slot on {root.item_model.item_code} or its fitted components")
    raise DomainError("VALIDATION", f"Slot {slot} is ambiguous across fitted components; supply parent_slot_code")


def _descendants_units(db: Session, unit: PhysicalUnit, seen: set[str]) -> list[PhysicalUnit]:
    seen.add(unit.id)
    out = [unit]
    for link in _open_links(db, unit.id):
        child = db.get(PhysicalUnit, link.child_unit_id)
        if child and child.id not in seen:
            out.extend(_descendants_units(db, child, seen))
    return out


def create_receipt(db: Session, p: Principal, body: dict) -> dict:
    po = get_row(db, PurchaseOrder, need(body, "po_id"), p, "Purchase order")
    location = get_row(db, Location, need(body, "location_id"), p, "Location")
    if location.project_id:
        if not p.can_see_project(location.project_id):
            raise Forbidden("Location is outside your authorized scope")
    receipt_ref = need(body, "receipt_ref")
    if db.scalar(select(Receipt.id).where(Receipt.tenant_id == p.tenant_id, Receipt.receipt_ref == receipt_ref)):
        raise Conflict("DUPLICATE_RECEIPT", f"Receipt {receipt_ref} already exists")
    received_at = optional_dt(body.get("received_at")) or utcnow()
    receipt = Receipt(
        tenant_id=p.tenant_id,
        created_by=p.email,
        receipt_ref=receipt_ref,
        po_id=po.id,
        location_id=location.id,
        received_at=received_at,
        state="PENDING",
    )
    db.add(receipt)
    db.flush()
    for line_body in body.get("lines") or []:
        unit = unit_scoped(db, p, need(line_body, "unit_id"))
        po_line = db.get(PoLine, unit.po_line_id) if unit.po_line_id else None
        if po_line and po_line.po_id != po.id:
            raise DomainError("VALIDATION", f"Unit {unit.asset_code} does not belong to PO {po.canonical_number}")
        if db.scalar(select(ReceiptLine.id).where(ReceiptLine.unit_id == unit.id)):
            raise Conflict("UNIT_ALREADY_RECEIVED", f"Unit {unit.asset_code} has already been received")
        if unit.state == "CANCELLED":
            raise Conflict("UNIT_CANCELLED", f"Unit {unit.asset_code} was cancelled")
        serial = line_body.get("serial_number") or unit.serial_number
        if not serial:
            raise DomainError("VALIDATION", f"serial_number is required for {unit.asset_code}")
        unit.state = "RECEIVED"
        unit.custody_location_id = location.id
        unit.serial_number = serial
        unit.condition = line_body.get("condition") or "GOOD"
        unit.quality_status = "NOT_TESTED"
        if location.project_id and unit.assigned_project_id is None:
            unit.assigned_project_id = location.project_id
        bump(unit)
        db.add(ReceiptLine(tenant_id=p.tenant_id, created_by=p.email, receipt_id=receipt.id, po_line_id=unit.po_line_id, unit_id=unit.id, serial_number=serial, condition=unit.condition))
        _provisional_cost(db, p, unit, receipt, po_line)
        for component in line_body.get("components") or []:
            slot = str(need(component, "slot_code")).upper()
            target_parent, bom = _component_slot(db, unit, slot, component.get("parent_slot_code"))
            child_model = db.get(ItemModel, bom.child_model_id)
            asset_code = component.get("asset_code") or next_asset_codes(db, p.tenant_id, prefix_for_model(db, child_model), 1)[0]
            child = PhysicalUnit(
                tenant_id=p.tenant_id,
                created_by=p.email,
                asset_code=asset_code,
                item_model_id=child_model.id,
                programme_id=unit.programme_id,
                po_line_id=unit.po_line_id,
                requirement_id=unit.requirement_id,
                serial_number=need(component, "serial_number"),
                state="RECEIVED",
                custody_location_id=location.id,
                condition="NEW",
            )
            db.add(child)
            db.flush()
            fit_component(db, p, target_parent, child, slot, received_at, install_reason=f"Received with {unit.asset_code}")
        stock = StockTransaction(
            tenant_id=p.tenant_id,
            created_by=p.email,
            request_ref=f"RCV-{receipt.receipt_ref}-{unit.asset_code}",
            unit_id=unit.id,
            txn_type="RECEIPT",
            to_location_id=location.id,
            to_project_id=unit.assigned_project_id,
            quantity=Decimal(1),
            state="PENDING",
        )
        db.add(stock)
        db.flush()
        enqueue(db, p.tenant_id, "ORACLE", "stock_txn.post", "stock_transaction", stock.id, {"stock_transaction_id": stock.id})
        enqueue(
            db,
            p.tenant_id,
            "PROCORE",
            "equipment.upsert",
            "physical_unit",
            unit.id,
            {"unit_id": unit.id},
            aggregate_version=unit.version,
        )
    enqueue(db, p.tenant_id, "ORACLE", "receipt.create", "receipt", receipt.id, {"receipt_id": receipt.id})
    audit(db, p, "RECEIPT_POSTED", "receipt", receipt.id, after={"receipt_ref": receipt_ref, "lines": len(body.get("lines") or [])})
    db.flush()
    return _receipt_out(db, receipt)


def stock_overview(db: Session, p: Principal, programme_id: str | None = None, location_id: str | None = None, project_id: str | None = None) -> dict:
    query = select(PhysicalUnit).where(PhysicalUnit.tenant_id == p.tenant_id, PhysicalUnit.state.notin_(("CANCELLED", "RETIRED")))
    if programme_id:
        query = query.where(PhysicalUnit.programme_id == programme_id)
    if location_id:
        query = query.where(PhysicalUnit.custody_location_id == location_id)
    if project_id:
        query = query.where(PhysicalUnit.assigned_project_id == project_id)
    units = [u for u in db.scalars(query.order_by(PhysicalUnit.asset_code)) if p.can_see_project(u.assigned_project_id)]
    by_location: dict[str, dict] = {}
    for unit in units:
        key = unit.custody_location_id or "UNKNOWN"
        entry = by_location.setdefault(key, {"location": key, "code": None, "name": None, "total": 0, "unallocated": 0, "allocated": 0, "reserved": 0, "issued": 0})
        entry["total"] += 1
        status = (unit.allocation_status or "UNALLOCATED").lower()
        if status in entry:
            entry[status] += 1
    for key, entry in by_location.items():
        location = db.get(Location, key) if key != "UNKNOWN" else None
        entry["code"] = location.code if location else "UNKNOWN"
        entry["name"] = location.name if location else "Unknown custody"
        entry["location"] = row(location) if location else None
    return {"by_location": list(by_location.values()), "units": [unit_out(db, u) for u in units]}


# ---------------------------------------------------------------- allocation


def _live_allocation(db: Session, unit_id: str) -> AllocationRecord | None:
    return db.scalar(
        select(AllocationRecord).where(AllocationRecord.unit_id == unit_id, AllocationRecord.state.in_(("PENDING", "CONFIRMED"))).order_by(AllocationRecord.created_at.desc())
    )


def create_allocations(db: Session, p: Principal, body: dict) -> dict:
    kind = need(body, "kind")
    if kind not in ("PLANNING_INTENT", "ORACLE_RESERVATION", "PROJECT_TRANSFER"):
        raise DomainError("VALIDATION", "kind must be PLANNING_INTENT, ORACLE_RESERVATION or PROJECT_TRANSFER")
    project = get_row(db, Project, need(body, "to_project_id"), p, "Project")
    if project.status != "ACTIVE":
        raise Conflict("PROJECT_CLOSED", "Cannot allocate to a closed project")
    records = []
    for unit_id in body.get("unit_ids") or []:
        unit = unit_scoped(db, p, unit_id)
        if unit.state in ("CANCELLED", "SCRAPPED", "RETIRED"):
            raise Conflict("UNIT_NOT_ALLOCATABLE", f"Unit {unit.asset_code} is {unit.state}")
        prior = _live_allocation(db, unit.id)
        from_project = unit.assigned_project_id
        if prior:
            prior.state = "SUPERSEDED"
            prior.effective_to = utcnow()
            from_project = prior.to_project_id or from_project
            bump(prior)
        state = "CONFIRMED" if kind == "PLANNING_INTENT" else "PENDING"
        record = AllocationRecord(
            tenant_id=p.tenant_id,
            created_by=p.email,
            unit_id=unit.id,
            kind=kind,
            from_project_id=from_project,
            to_project_id=project.id,
            to_wbs_id=body.get("to_wbs_id"),
            state=state,
            reason=body.get("reason"),
            requested_by=p.email,
            approved_by=p.email if kind == "PLANNING_INTENT" else None,
            effective_from=utcnow(),
            generates_project_charge=kind == "PROJECT_TRANSFER",
        )
        db.add(record)
        db.flush()
        unit.assigned_project_id = project.id
        if body.get("to_wbs_id"):
            unit.assigned_wbs_id = body["to_wbs_id"]
        unit.allocation_status = "ALLOCATED" if kind == "PLANNING_INTENT" else "RESERVED"
        bump(unit)
        if kind == "ORACLE_RESERVATION":
            enqueue(db, p.tenant_id, "ORACLE", "reservation.create", "allocation_record", record.id, {"allocation_id": record.id})
        elif kind == "PROJECT_TRANSFER":
            enqueue(db, p.tenant_id, "ORACLE", "project_transfer.create", "allocation_record", record.id, {"allocation_id": record.id})
        records.append(row(record, asset_code=unit.asset_code))
    audit(db, p, "UNITS_ALLOCATED", "allocation_record", records[0]["id"] if records else project.id, after={"kind": kind, "count": len(records), "to_project": project.code})
    db.flush()
    return {"kind": kind, "to_project": row(project), "allocations": records}


def release_allocation(db: Session, p: Principal, allocation_id: str) -> dict:
    record = get_row(db, AllocationRecord, allocation_id, p, "Allocation")
    if record.state not in ("PENDING", "CONFIRMED"):
        raise Conflict("INVALID_STATE", f"Allocation is {record.state}")
    record.state = "RELEASED"
    record.effective_to = utcnow()
    bump(record)
    unit = db.get(PhysicalUnit, record.unit_id)
    if unit and unit.allocation_status != "ISSUED":
        unit.assigned_project_id = None
        unit.assigned_wbs_id = None
        unit.allocation_status = "UNALLOCATED"
        bump(unit)
    if record.kind == "ORACLE_RESERVATION":
        enqueue(db, p.tenant_id, "ORACLE", "reservation.release", "allocation_record", record.id, {"allocation_id": record.id})
    audit(db, p, "ALLOCATION_RELEASED", "allocation_record", record.id)
    return row(record, asset_code=unit.asset_code if unit else None)


def list_allocations(db: Session, p: Principal, unit_id: str | None = None) -> list[dict]:
    query = select(AllocationRecord).where(AllocationRecord.tenant_id == p.tenant_id).order_by(AllocationRecord.created_at.desc())
    if unit_id:
        query = query.where(AllocationRecord.unit_id == unit_id)
    out = []
    for record in db.scalars(query):
        unit = db.get(PhysicalUnit, record.unit_id)
        if unit and not p.can_see_project(unit.assigned_project_id):
            continue
        to_project = db.get(Project, record.to_project_id) if record.to_project_id else None
        out.append(row(record, asset_code=unit.asset_code if unit else None, to_project_code=to_project.code if to_project else None))
    return out


def issue_unit(db: Session, p: Principal, body: dict) -> dict:
    unit = unit_scoped(db, p, need(body, "unit_id"))
    if not unit.assigned_project_id:
        raise Conflict("UNIT_NOT_ASSIGNED", "Assign the unit to a project before issuing it")
    if not p.can_see_project(unit.assigned_project_id):
        raise Forbidden("Unit is outside your project scope")
    location = get_row(db, Location, need(body, "to_location_id"), p, "Location")
    if location.project_id and location.project_id != unit.assigned_project_id:
        raise DomainError("VALIDATION", "Issue location belongs to a different project than the unit assignment")
    from_location = unit.custody_location_id
    stock = StockTransaction(
        tenant_id=p.tenant_id,
        created_by=p.email,
        request_ref=f"ISS-{unit.asset_code}-{int(utcnow().timestamp())}",
        unit_id=unit.id,
        txn_type="ISSUE",
        from_location_id=from_location,
        to_location_id=location.id,
        from_project_id=unit.assigned_project_id,
        to_project_id=unit.assigned_project_id,
        quantity=Decimal(1),
        state="PENDING",
    )
    db.add(stock)
    db.flush()
    unit.state = "ISSUED"
    unit.custody_location_id = location.id
    unit.allocation_status = "ISSUED"
    unit.installed_position = body.get("installed_position") or unit.installed_position
    bump(unit)
    enqueue(db, p.tenant_id, "ORACLE", "stock_txn.post", "stock_transaction", stock.id, {"stock_transaction_id": stock.id})
    enqueue(
        db,
        p.tenant_id,
        "PROCORE",
        "equipment.upsert",
        "physical_unit",
        unit.id,
        {"unit_id": unit.id},
        aggregate_version=unit.version,
    )
    audit(db, p, "UNIT_ISSUED", "physical_unit", unit.id, after={"to_location": location.code})
    db.flush()
    return {"unit": unit_out(db, unit), "stock_transaction": row(stock)}


# ---------------------------------------------------------------- transfers


def _descendants(db: Session, unit_id: str, seen: set[str]) -> list[str]:
    seen.add(unit_id)
    for link in _open_links(db, unit_id):
        if link.child_unit_id not in seen:
            _descendants(db, link.child_unit_id, seen)
    return list(seen)


def _structure_hash(db: Session, unit_ids: list[str]) -> str:
    links = []
    for unit_id in sorted(unit_ids):
        for link in _open_links(db, unit_id):
            if link.child_unit_id in unit_ids:
                links.append([link.parent_unit_id, link.slot_code, link.child_unit_id])
    return sha256({"units": sorted(unit_ids), "links": sorted(links)})


def create_transfer(db: Session, p: Principal, body: dict) -> dict:
    from_location = get_row(db, Location, need(body, "from_location_id"), p, "Location")
    to_location = get_row(db, Location, need(body, "to_location_id"), p, "Location")
    if body.get("to_project_id") and not p.can_see_project(body["to_project_id"]):
        raise Forbidden("Destination project is outside your scope")
    members: set[str] = set()
    for unit_id in body.get("unit_ids") or []:
        unit = unit_scoped(db, p, unit_id)
        _descendants(db, unit.id, members)
    if not members:
        raise DomainError("VALIDATION", "unit_ids must not be empty")
    manifest = TransferManifest(
        tenant_id=p.tenant_id,
        created_by=p.email,
        code=need(body, "code"),
        from_location_id=from_location.id,
        to_location_id=to_location.id,
        to_project_id=body.get("to_project_id"),
        state="DRAFT",
        unit_ids=sorted(members),
        structure_hash=_structure_hash(db, sorted(members)),
    )
    db.add(manifest)
    db.flush()
    audit(db, p, "TRANSFER_CREATED", "transfer_manifest", manifest.id, after={"code": manifest.code, "units": len(members)})
    return _transfer_out(db, manifest)


def _transfer_out(db: Session, manifest: TransferManifest) -> dict:
    units = [unit_out(db, u) for uid in manifest.unit_ids if (u := db.get(PhysicalUnit, uid))]
    return row(manifest, units=units, from_location=row(db.get(Location, manifest.from_location_id)), to_location=row(db.get(Location, manifest.to_location_id)), received_count=len(manifest.received_unit_ids or []))


def _transfer_command(db: Session, p: Principal, manifest_id: str, action: str, body: dict | None = None) -> dict:
    manifest = get_row(db, TransferManifest, manifest_id, p, "Transfer manifest")
    body = body or {}
    if action == "approve":
        if manifest.state != "DRAFT":
            raise Conflict("INVALID_STATE", f"Transfer is {manifest.state}")
        manifest.state = "APPROVED"
        manifest.approved_by = p.email
    elif action == "dispatch":
        if manifest.state != "APPROVED":
            raise Conflict("INVALID_STATE", f"Transfer is {manifest.state}")
        current_hash = _structure_hash(db, manifest.unit_ids)
        if current_hash != manifest.structure_hash:
            manifest.state = "INVALIDATED"
            raise Conflict("STRUCTURE_CHANGED", "The frozen structure changed since approval; re-approve a new manifest")
        manifest.state = "IN_TRANSIT"
        for unit_id in manifest.unit_ids:
            unit = db.get(PhysicalUnit, unit_id)
            if unit:
                unit.state = "IN_TRANSIT"
                unit.custody_location_id = db.scalar(select(Location.id).where(Location.tenant_id == p.tenant_id, Location.code == "IN-TRANSIT")) or unit.custody_location_id
                bump(unit)
    elif action == "receive":
        if manifest.state not in ("IN_TRANSIT", "PARTIALLY_RECEIVED"):
            raise Conflict("INVALID_STATE", f"Transfer is {manifest.state}")
        received = set(manifest.received_unit_ids or [])
        for unit_id in body.get("unit_ids") or []:
            if unit_id not in manifest.unit_ids:
                raise DomainError("VALIDATION", "Unit is not a member of this manifest")
            received.add(unit_id)
            unit = db.get(PhysicalUnit, unit_id)
            if unit:
                unit.state = "RECEIVED"
                unit.custody_location_id = manifest.to_location_id
                if manifest.to_project_id:
                    unit.assigned_project_id = manifest.to_project_id
                    unit.allocation_status = "ALLOCATED"
                bump(unit)
        manifest.received_unit_ids = sorted(received)
        manifest.state = "RECEIVED" if received >= set(manifest.unit_ids) else "PARTIALLY_RECEIVED"
    bump(manifest)
    audit(db, p, f"TRANSFER_{action.upper()}", "transfer_manifest", manifest.id, after={"state": manifest.state})
    db.flush()
    return _transfer_out(db, manifest)


def transfer_command(db: Session, p: Principal, manifest_id: str, action: str, body: dict | None = None) -> dict:
    return _transfer_command(db, p, manifest_id, action, body)


def list_transfers(db: Session, p: Principal) -> list[dict]:
    return [_transfer_out(db, m) for m in db.scalars(select(TransferManifest).where(TransferManifest.tenant_id == p.tenant_id).order_by(TransferManifest.created_at.desc()))]


def list_stock_transactions(db: Session, p: Principal, unit_id: str | None = None) -> list[dict]:
    query = select(StockTransaction).where(StockTransaction.tenant_id == p.tenant_id).order_by(StockTransaction.created_at.desc())
    if unit_id:
        query = query.where(StockTransaction.unit_id == unit_id)
    return [row(t, asset_code=(db.get(PhysicalUnit, t.unit_id).asset_code if db.get(PhysicalUnit, t.unit_id) else None)) for t in db.scalars(query)]


# ---------------------------------------------------------------- assets & structure


def list_units(
    db: Session,
    p: Principal,
    programme_id: str | None = None,
    project_id: str | None = None,
    state: str | None = None,
    allocation_status: str | None = None,
    q: str | None = None,
    include_components: bool = False,
) -> list[dict]:
    query = select(PhysicalUnit).where(PhysicalUnit.tenant_id == p.tenant_id).order_by(PhysicalUnit.asset_code)
    if programme_id:
        query = query.where(PhysicalUnit.programme_id == programme_id)
    if project_id:
        query = query.where(PhysicalUnit.assigned_project_id == project_id)
    if state:
        query = query.where(PhysicalUnit.state == state)
    if allocation_status:
        query = query.where(PhysicalUnit.allocation_status == allocation_status)
    out = []
    for unit in db.scalars(query):
        if not p.can_see_project(unit.assigned_project_id):
            continue
        if not include_components and unit.item_model and unit.item_model.equipment_class and unit.item_model.equipment_class.is_component_class and unit.is_spare is False:
            parent = _parent_of(db, unit)
            if parent:
                continue
        if q:
            haystack = " ".join(filter(None, [unit.asset_code, unit.serial_number, unit.item_model.item_code if unit.item_model else None, unit.installed_position]))
            if q.lower() not in haystack.lower():
                continue
        out.append(unit_out(db, unit))
    return out


def register_unit(db: Session, p: Principal, body: dict) -> dict:
    model = db.scalar(select(ItemModel).where(ItemModel.tenant_id == p.tenant_id, ItemModel.item_code == need(body, "item_code")))
    if model is None:
        raise DomainError("VALIDATION", f"Unknown item code {body.get('item_code')}")
    location = get_row(db, Location, need(body, "custody_location_id"), p, "Location")
    code = body.get("asset_code") or next_asset_codes(db, p.tenant_id, prefix_for_model(db, model), 1)[0]
    unit = PhysicalUnit(
        tenant_id=p.tenant_id,
        created_by=p.email,
        asset_code=code,
        item_model_id=model.id,
        programme_id=body.get("programme_id"),
        serial_number=need(body, "serial_number"),
        state="RECEIVED",
        custody_location_id=location.id,
        is_spare=bool(body.get("is_spare", True)),
        condition=body.get("condition") or "NEW",
    )
    db.add(unit)
    db.flush()
    audit(db, p, "UNIT_REGISTERED", "physical_unit", unit.id, after={"asset_code": code, "item_code": model.item_code})
    return unit_out(db, unit)


def _validate_fit(db: Session, parent: PhysicalUnit, child: PhysicalUnit, slot: str, valid_from: datetime, valid_to: datetime | None) -> None:
    if parent.id == child.id:
        raise DomainError("VALIDATION", "A unit cannot contain itself")
    bom = db.scalar(select(BomLine).where(BomLine.parent_model_id == parent.item_model_id, BomLine.slot_code == slot))
    if bom is None:
        raise DomainError("VALIDATION", f"{slot} is not a slot on {parent.item_model.item_code}")
    allowed = False
    if bom.child_model_id and bom.child_model_id == child.item_model_id:
        allowed = True
    if not allowed:
        allowed = db.scalar(
            select(CompatibleSpare.id).where(
                CompatibleSpare.parent_model_id == parent.item_model_id,
                CompatibleSpare.slot_code == slot,
                CompatibleSpare.spare_model_id == child.item_model_id,
            )
        ) is not None
    if not allowed:
        raise DomainError("INCOMPATIBLE_COMPONENT", f"{child.item_model.item_code} is not approved for {parent.item_model.item_code} slot {slot}")
    # cycle: child must not be an ancestor of parent
    cursor = parent
    seen = set()
    while cursor is not None and cursor.id not in seen:
        if cursor.id == child.id:
            raise DomainError("CYCLE", "Fitting this child would create a structure cycle")
        seen.add(cursor.id)
        link = db.scalar(select(UnitComponent).where(UnitComponent.child_unit_id == cursor.id, UnitComponent.valid_to.is_(None)))
        cursor = db.get(PhysicalUnit, link.parent_unit_id) if link else None
    end = valid_to or datetime.max
    for link in db.scalars(select(UnitComponent).where(UnitComponent.child_unit_id == child.id)):
        if link.valid_from < end and (link.valid_to is None or link.valid_to > valid_from):
            raise Conflict("CHILD_ALREADY_FITTED", f"{child.asset_code} is already fitted elsewhere for an overlapping period")
    for link in db.scalars(select(UnitComponent).where(UnitComponent.parent_unit_id == parent.id, UnitComponent.slot_code == slot)):
        if link.valid_from < end and (link.valid_to is None or link.valid_to > valid_from):
            raise Conflict("SLOT_OCCUPIED", f"Slot {slot} on {parent.asset_code} is occupied for an overlapping period")


def fit_component(db: Session, p: Principal, parent: PhysicalUnit, child: PhysicalUnit, slot: str, valid_from: datetime, install_reason: str | None = None, recovery_case_id: str | None = None) -> UnitComponent:
    _validate_fit(db, parent, child, slot, valid_from, None)
    link = UnitComponent(
        tenant_id=p.tenant_id,
        created_by=p.email,
        parent_unit_id=parent.id,
        child_unit_id=child.id,
        slot_code=slot,
        valid_from=valid_from,
        install_reason=install_reason,
        recovery_case_id=recovery_case_id,
    )
    db.add(link)
    db.flush()
    return link


def fit_component_api(db: Session, p: Principal, parent_id: str, body: dict) -> dict:
    parent = unit_scoped(db, p, parent_id)
    child = unit_scoped(db, p, need(body, "child_unit_id"))
    valid_from = optional_dt(body.get("valid_from")) or utcnow()
    if not parent.item_model or not child.item_model:
        raise DomainError("VALIDATION", "Both units need an item model")
    link = fit_component(db, p, parent, child, str(need(body, "slot_code")).upper(), valid_from, body.get("install_reason"))
    audit(db, p, "COMPONENT_FITTED", "unit_component", link.id, after={"parent": parent.asset_code, "child": child.asset_code, "slot": link.slot_code})
    return row(link, parent_asset_code=parent.asset_code, child_asset_code=child.asset_code)


def remove_component(db: Session, p: Principal, parent_id: str, link_id: str, body: dict) -> dict:
    parent = unit_scoped(db, p, parent_id)
    link = get_row(db, UnitComponent, link_id, p, "Component link")
    if link.parent_unit_id != parent.id:
        raise DomainError("VALIDATION", "Component link does not belong to this unit")
    if link.valid_to is not None:
        raise Conflict("ALREADY_REMOVED", "Component was already removed")
    valid_to = optional_dt(body.get("valid_to")) or utcnow()
    if valid_to <= link.valid_from:
        raise DomainError("VALIDATION", "valid_to must be after the install date")
    link.valid_to = valid_to
    link.removal_reason = body.get("removal_reason")
    bump(link) if hasattr(link, "version") else None
    audit(db, p, "COMPONENT_REMOVED", "unit_component", link.id, after={"reason": link.removal_reason})
    return row(link)


def unit_structure(db: Session, p: Principal, unit_id: str, at: str | None = None) -> dict:
    unit = unit_scoped(db, p, unit_id)
    return structure(db, unit, optional_dt(at))


def unit_passport(db: Session, p: Principal, unit_id: str) -> dict:
    unit = unit_scoped(db, p, unit_id)
    model = unit.item_model
    equipment_class = db.get(EquipmentClass, model.equipment_class_id) if model else None
    po_line = db.get(PoLine, unit.po_line_id) if unit.po_line_id else None
    po = db.get(PurchaseOrder, po_line.po_id) if po_line else None
    assigned = db.get(Project, unit.assigned_project_id) if unit.assigned_project_id else None
    custody = db.get(Location, unit.custody_location_id) if unit.custody_location_id else None
    tests = db.scalars(select(TestRecord).where(TestRecord.unit_id == unit.id).order_by(TestRecord.performed_at.desc()))
    cases = db.scalars(select(RecoveryCase).where(RecoveryCase.parent_unit_id == unit.id).order_by(RecoveryCase.created_at.desc()))
    allocations = db.scalars(select(AllocationRecord).where(AllocationRecord.unit_id == unit.id).order_by(AllocationRecord.created_at.desc()))
    arrival = db.scalar(select(ArrivalSnapshot).where(ArrivalSnapshot.unit_id == unit.id).order_by(ArrivalSnapshot.recorded_at.desc()))
    handbook = db.scalar(select(HandbookPackage).where(HandbookPackage.unit_id == unit.id).order_by(HandbookPackage.version_no.desc()))
    links = db.scalars(select(ExternalObjectLink).where(ExternalObjectLink.tenant_id == p.tenant_id, ExternalObjectLink.domain_id == unit.id))
    from app.services import costs

    return {
        "unit": unit_out(db, unit),
        "item_model": row(model) if model else None,
        "equipment_class": row(equipment_class) if equipment_class else None,
        "requirement": row(db.get(Requirement, unit.requirement_id)) if unit.requirement_id else None,
        "po": {"canonical_number": po.canonical_number, "line_no": po_line.line_no, "unit_price": dstr(po_line.unit_price) if p.can_see_commercial else None} if po and po_line else None,
        "assigned_project": row(assigned) if assigned else None,
        "custody_location": row(custody) if custody else None,
        "parent": _parent_of(db, unit),
        "structure": structure(db, unit),
        "tests": [row(t) for t in tests],
        "recovery_cases": [row(c) for c in cases],
        "allocations": [row(a) for a in allocations],
        "latest_arrival": row(arrival) if arrival else None,
        "handbook": row(handbook) if handbook else None,
        "cost_summary": costs.unit_summary(db, p, unit.id) if p.can_see_commercial else None,
        "external_links": [row(link) for link in links],
    }


def unit_history(db: Session, p: Principal, unit_id: str) -> dict:
    unit = unit_scoped(db, p, unit_id)
    links = db.scalars(select(UnitComponent).where((UnitComponent.parent_unit_id == unit.id) | (UnitComponent.child_unit_id == unit.id)))
    allocations = db.scalars(select(AllocationRecord).where(AllocationRecord.unit_id == unit.id))
    stocks = db.scalars(select(StockTransaction).where(StockTransaction.unit_id == unit.id))
    from app.models import AuditEvent

    audits = db.scalars(select(AuditEvent).where(AuditEvent.tenant_id == p.tenant_id, AuditEvent.subject_id == unit.id).order_by(AuditEvent.at.desc()))
    return {
        "unit_id": unit.id,
        "component_links": [row(link) for link in links],
        "allocations": [row(a) for a in allocations],
        "stock_transactions": [row(t) for t in stocks],
        "audit": [{**row(a), "actor": a.actor, "action": a.action, "at": a.at.isoformat() + "Z", "reason": a.reason} for a in audits],
    }


# ---------------------------------------------------------------- quality & recovery


def record_test(db: Session, p: Principal, body: dict) -> dict:
    unit = unit_scoped(db, p, need(body, "unit_id"))
    component_id = body.get("component_unit_id")
    result = str(need(body, "result")).upper()
    if result not in ("PASS", "FAIL"):
        raise DomainError("VALIDATION", "result must be PASS or FAIL")
    test = TestRecord(
        tenant_id=p.tenant_id,
        created_by=p.email,
        unit_id=unit.id,
        component_unit_id=component_id,
        test_type=str(need(body, "test_type")).upper(),
        test_ref=need(body, "test_ref"),
        procedure_ref=body.get("procedure_ref"),
        result=result,
        measurement=body.get("measurement"),
        stage=body.get("stage") or "SUPPLIER_FACTORY",
        performed_at=optional_dt(body.get("performed_at")) or utcnow(),
        witnessed_by=body.get("witnessed_by"),
        approved_by=p.email,
        evidence_ref=body.get("evidence_ref"),
    )
    db.add(test)
    db.flush()
    target = db.get(PhysicalUnit, component_id) if component_id else unit
    if target:
        if result == "FAIL":
            target.quality_status = "FAILED"
            target.condition = "FAILED"
            if target.id != unit.id:
                unit.quality_status = "ON_HOLD"
        elif not db.scalar(select(RecoveryCase.id).where(RecoveryCase.parent_unit_id == unit.id, RecoveryCase.state.notin_(("RELEASED", "CLOSED")))):
            target.quality_status = "PASSED"
    audit(db, p, "TEST_RECORDED", "test_record", test.id, after={"result": result, "test_type": test.test_type})
    db.flush()
    return row(test, asset_code=unit.asset_code)


def create_recovery_case(db: Session, p: Principal, body: dict) -> dict:
    parent = unit_scoped(db, p, need(body, "parent_unit_id"))
    ncr = need(body, "ncr_number")
    if db.scalar(select(RecoveryCase.id).where(RecoveryCase.tenant_id == p.tenant_id, RecoveryCase.ncr_number == ncr)):
        raise Conflict("DUPLICATE_NCR", f"NCR {ncr} already exists")
    case = RecoveryCase(
        tenant_id=p.tenant_id,
        created_by=p.email,
        ncr_number=ncr,
        parent_unit_id=parent.id,
        failed_component_id=body.get("failed_component_id"),
        slot_code=body.get("slot_code"),
        failed_test_id=body.get("failed_test_id"),
        failure_stage=body.get("failure_stage") or "SUPPLIER_FACTORY",
        description=need(body, "description"),
        state="OPEN",
    )
    db.add(case)
    db.flush()
    audit(db, p, "RECOVERY_CASE_OPENED", "recovery_case", case.id, after={"ncr": ncr})
    return row(case)


def _compatible(db: Session, parent: PhysicalUnit, slot: str, replacement: PhysicalUnit) -> bool:
    bom = db.scalar(select(BomLine).where(BomLine.parent_model_id == parent.item_model_id, BomLine.slot_code == slot))
    if bom and bom.child_model_id == replacement.item_model_id:
        return True
    return db.scalar(
        select(CompatibleSpare.id).where(
            CompatibleSpare.parent_model_id == parent.item_model_id,
            CompatibleSpare.slot_code == slot,
            CompatibleSpare.spare_model_id == replacement.item_model_id,
        )
    ) is not None


def disposition_case(db: Session, p: Principal, case_id: str, body: dict) -> dict:
    case = get_row(db, RecoveryCase, case_id, p, "Recovery case")
    if case.state != "OPEN":
        raise Conflict("INVALID_STATE", f"Recovery case is {case.state}")
    route = need(body, "route")
    if route not in ("REPAIR_AND_WAIT", "REPLACE_FROM_SPARE", "TAKE_FROM_DONOR"):
        raise DomainError("VALIDATION", "Unknown recovery route")
    parent = db.get(PhysicalUnit, case.parent_unit_id)
    impacts = []
    parent_project = db.get(Project, parent.assigned_project_id) if parent.assigned_project_id else None
    impacts.append({"project_id": parent.assigned_project_id, "project_code": parent_project.code if parent_project else None, "unit_id": parent.id, "impact": f"{parent.asset_code} held pending {route}", "eta": body.get("replacement_eta")})
    replacement = None
    if route == "REPLACE_FROM_SPARE":
        replacement_id = body.get("replacement_unit_id")
        if not replacement_id:
            raise DomainError("VALIDATION", "replacement_unit_id is required for REPLACE_FROM_SPARE")
        replacement = unit_scoped(db, p, replacement_id)
        if not case.slot_code or not _compatible(db, parent, case.slot_code, replacement):
            raise DomainError("INCOMPATIBLE_COMPONENT", "Replacement is not an approved spare for this slot")
        if db.scalar(select(UnitComponent.id).where(UnitComponent.child_unit_id == replacement.id, UnitComponent.valid_to.is_(None))):
            raise Conflict("REPLACEMENT_IN_USE", "Replacement unit is currently fitted elsewhere")
        case.replacement_unit_id = replacement.id
    if route == "TAKE_FROM_DONOR":
        donor_id = body.get("donor_unit_id")
        if not donor_id:
            raise DomainError("VALIDATION", "donor_unit_id is required for TAKE_FROM_DONOR")
        donor = unit_scoped(db, p, donor_id)
        link = db.scalar(select(UnitComponent).where(UnitComponent.parent_unit_id == donor.id, UnitComponent.slot_code == case.slot_code, UnitComponent.valid_to.is_(None)))
        if link is None:
            raise DomainError("VALIDATION", "Donor has no fitted component in that slot")
        donor_component = db.get(PhysicalUnit, link.child_unit_id)
        if not _compatible(db, parent, case.slot_code, donor_component):
            raise DomainError("INCOMPATIBLE_COMPONENT", "Donor component is not approved for this slot")
        donor_project = db.get(Project, donor.assigned_project_id) if donor.assigned_project_id else None
        impacts.append({"project_id": donor.assigned_project_id, "project_code": donor_project.code if donor_project else None, "unit_id": donor.id, "impact": f"{donor.asset_code} will lose its {case.slot_code} component", "eta": body.get("replacement_eta")})
        case.donor_unit_id = donor.id
    case.route = route
    case.state = "DISPOSITIONED"
    case.responsible_party = body.get("responsible_party")
    case.expected_completion = optional_date(body.get("expected_completion"))
    case.replacement_eta = optional_date(body.get("replacement_eta"))
    case.impacts_json = impacts
    case.disposition_by = p.email
    bump(case)
    audit(db, p, "RECOVERY_DISPOSITIONED", "recovery_case", case.id, after={"route": route, "impacts": impacts})
    return row(case, asset_code=parent.asset_code)


def remove_case_component(db: Session, p: Principal, case_id: str, body: dict) -> dict:
    case = get_row(db, RecoveryCase, case_id, p, "Recovery case")
    if case.state not in ("DISPOSITIONED", "OPEN"):
        raise Conflict("INVALID_STATE", f"Recovery case is {case.state}")
    removed_at = optional_dt(body.get("removed_at")) or utcnow()
    link = None
    if case.failed_component_id:
        link = db.scalar(select(UnitComponent).where(UnitComponent.child_unit_id == case.failed_component_id, UnitComponent.valid_to.is_(None)))
    if link is None and case.slot_code:
        link = db.scalar(select(UnitComponent).where(UnitComponent.parent_unit_id == case.parent_unit_id, UnitComponent.slot_code == case.slot_code, UnitComponent.valid_to.is_(None)))
    if link is None:
        raise DomainError("VALIDATION", "No fitted component to remove for this case")
    link.valid_to = removed_at
    link.removal_reason = f"NCR {case.ncr_number} removal"
    link.recovery_case_id = case.id
    case.state = "COMPONENT_REMOVED"
    case.supplier_return_ref = body.get("supplier_return_ref") or case.supplier_return_ref
    bump(case)
    db.flush()
    audit(db, p, "RECOVERY_COMPONENT_REMOVED", "recovery_case", case.id, after={"link_id": link.id})
    return row(case)


def fit_replacement(db: Session, p: Principal, case_id: str, body: dict) -> dict:
    case = get_row(db, RecoveryCase, case_id, p, "Recovery case")
    if case.state not in ("COMPONENT_REMOVED", "DISPOSITIONED"):
        raise Conflict("INVALID_STATE", f"Recovery case is {case.state}")
    parent = db.get(PhysicalUnit, case.parent_unit_id)
    fitted_at = optional_dt(body.get("fitted_at")) or utcnow()
    if not case.slot_code:
        raise DomainError("VALIDATION", "Case has no slot_code")
    if case.route == "REPAIR_AND_WAIT":
        child_id = case.failed_component_id
        if not child_id:
            raise DomainError("VALIDATION", "Repair route requires a failed component")
    elif case.route == "REPLACE_FROM_SPARE":
        child_id = body.get("replacement_unit_id") or case.replacement_unit_id
    else:
        donor = db.get(PhysicalUnit, case.donor_unit_id) if case.donor_unit_id else None
        donor_link = db.scalar(
            select(UnitComponent).where(UnitComponent.parent_unit_id == donor.id, UnitComponent.slot_code == case.slot_code, UnitComponent.valid_to.is_(None))
        ) if donor else None
        if donor_link is None:
            raise DomainError("VALIDATION", "Donor component is not fitted; remove or use a spare instead")
        donor_link.valid_to = fitted_at
        donor_link.removal_reason = f"Donor for NCR {case.ncr_number}"
        child_id = donor_link.child_unit_id
        case.replacement_unit_id = child_id
    if not child_id:
        raise DomainError("VALIDATION", "No replacement unit resolved")
    child = unit_scoped(db, p, child_id)
    if case.failed_component_id and child.id != case.failed_component_id:
        child.replaces_unit_id = case.failed_component_id
    if child.state in ("INSTALLED",) or db.scalar(select(UnitComponent.id).where(UnitComponent.child_unit_id == child.id, UnitComponent.valid_to.is_(None))):
        raise Conflict("REPLACEMENT_IN_USE", "Replacement unit is currently fitted")
    fit_component(db, p, parent, child, case.slot_code, fitted_at, install_reason=f"NCR {case.ncr_number} replacement", recovery_case_id=case.id)
    child.state = "RECEIVED"
    bump(child)
    parent.quality_status = "ON_HOLD"
    parent.condition = "REPAIRABLE"
    bump(parent)
    case.state = "RETEST_REQUIRED"
    bump(case)
    audit(db, p, "RECOVERY_REPLACEMENT_FITTED", "recovery_case", case.id, after={"child": child.asset_code, "fitted_at": fitted_at.isoformat()})
    return row(case, asset_code=parent.asset_code, replacement_asset_code=child.asset_code)


def release_case(db: Session, p: Principal, case_id: str, body: dict) -> dict:
    if not p.has("ENGINEERING"):
        raise Forbidden("Only ENGINEERING may release a recovery case")
    case = get_row(db, RecoveryCase, case_id, p, "Recovery case")
    if case.state not in ("RETEST_REQUIRED", "DISPOSITIONED"):
        raise Conflict("INVALID_STATE", f"Recovery case is {case.state}")
    retest = get_row(db, TestRecord, need(body, "retest_id"), p, "Retest")
    if retest.unit_id != case.parent_unit_id and retest.component_unit_id != case.parent_unit_id:
        if retest.unit_id != case.replacement_unit_id:
            raise DomainError("VALIDATION", "Retest does not belong to this case's units")
    if retest.result != "PASS" or retest.test_type not in ("RETEST", "FAT", "SAT", "COMMISSIONING"):
        raise Conflict("RETEST_REQUIRED", "A passing retest is required before release")
    link = db.scalar(select(UnitComponent).where(UnitComponent.recovery_case_id == case.id).order_by(UnitComponent.valid_from.desc()))
    if link and retest.performed_at < link.valid_from:
        raise Conflict("RETEST_ORDER", "The retest was recorded before the replacement was fitted")
    case.state = "RELEASED"
    case.released_by = p.email
    case.released_at = utcnow()
    parent = db.get(PhysicalUnit, case.parent_unit_id)
    parent.quality_status = "PASSED"
    parent.condition = "GOOD"
    parent.state = "RECEIVED"
    bump(parent)
    bump(case)
    audit(db, p, "RECOVERY_RELEASED", "recovery_case", case.id, after={"retest_id": retest.id})
    return row(case, asset_code=parent.asset_code)


def close_case(db: Session, p: Principal, case_id: str, body: dict) -> dict:
    case = get_row(db, RecoveryCase, case_id, p, "Recovery case")
    if case.state not in ("RELEASED",):
        raise Conflict("INVALID_STATE", "Only a released case can be closed")
    case.state = "CLOSED"
    amount = dec(body.get("recovery_cost"), "recovery_cost")
    if amount is not None:
        case.recovery_cost = amount
        case.currency = body.get("currency") or "USD"
        db.add(
            CostEvent(
                tenant_id=p.tenant_id,
                created_by=p.email,
                economic_key=f"RECOVERY:{case.ncr_number}",
                revision_no=1,
                unit_id=case.parent_unit_id,
                category="RECOVERY",
                status="ACTUAL",
                amount=amount,
                currency=case.currency,
                source_system="MANUAL",
                source_ref=case.ncr_number,
                occurred_on=date.today(),
            )
        )
    bump(case)
    audit(db, p, "RECOVERY_CLOSED", "recovery_case", case.id)
    return row(case)


def list_recovery_cases(db: Session, p: Principal, state: str | None = None) -> list[dict]:
    query = select(RecoveryCase).where(RecoveryCase.tenant_id == p.tenant_id).order_by(RecoveryCase.created_at.desc())
    if state:
        query = query.where(RecoveryCase.state == state)
    out = []
    for case in db.scalars(query):
        parent = db.get(PhysicalUnit, case.parent_unit_id)
        if parent and not p.can_see_project(parent.assigned_project_id):
            continue
        out.append(row(case, asset_code=parent.asset_code if parent else None))
    return out


def get_recovery_case(db: Session, p: Principal, case_id: str) -> dict:
    case = get_row(db, RecoveryCase, case_id, p, "Recovery case")
    parent = db.get(PhysicalUnit, case.parent_unit_id)
    tests = db.scalars(select(TestRecord).where(TestRecord.unit_id == case.parent_unit_id).order_by(TestRecord.performed_at.desc()))
    links = db.scalars(select(UnitComponent).where(UnitComponent.recovery_case_id == case.id))
    return {**row(case, asset_code=parent.asset_code if parent else None), "tests": [row(t) for t in tests], "links": [row(link) for link in links]}


# ---------------------------------------------------------------- logistics & arrival

SEA_TRANSIT_DAYS = 25
AIR_TRANSIT_DAYS = 3
ROAD_TRANSIT_DAYS = 2


def create_shipment(db: Session, p: Principal, body: dict) -> dict:
    po = get_row(db, PurchaseOrder, need(body, "po_id"), p, "Purchase order")
    units = [unit_scoped(db, p, uid) for uid in body.get("unit_ids") or []]
    for unit in units:
        for other in db.scalars(select(Shipment).where(Shipment.tenant_id == p.tenant_id, Shipment.state.in_(("PLANNED", "IN_TRANSIT")))):
            if unit.id in (other.unit_ids or []):
                raise Conflict("UNIT_ALREADY_SHIPPED", f"{unit.asset_code} is already on shipment {other.code}")
    shipment = Shipment(
        tenant_id=p.tenant_id,
        created_by=p.email,
        code=need(body, "code"),
        po_id=po.id,
        carrier=body.get("carrier"),
        mode=body.get("mode") or "SEA",
        container_ref=body.get("container_ref"),
        bol_awb=body.get("bol_awb"),
        origin=body.get("origin"),
        destination_location_id=body.get("destination_location_id"),
        unit_ids=[u.id for u in units],
        state="PLANNED",
    )
    db.add(shipment)
    db.flush()
    audit(db, p, "SHIPMENT_CREATED", "shipment", shipment.id, after={"code": shipment.code, "units": len(units)})
    return _shipment_out(db, shipment)


def _shipment_out(db: Session, shipment: Shipment) -> dict:
    milestones = db.scalars(select(ShipmentMilestone).where(ShipmentMilestone.shipment_id == shipment.id).order_by(ShipmentMilestone.recorded_at))
    units = [unit_out(db, u) for uid in shipment.unit_ids if (u := db.get(PhysicalUnit, uid))]
    return row(shipment, milestones=[row(m) for m in milestones], units=units)


def add_milestone(db: Session, p: Principal, shipment_id: str, body: dict) -> dict:
    shipment = get_row(db, Shipment, shipment_id, p, "Shipment")
    source_event_id = body.get("source_event_id")
    if source_event_id:
        existing = db.scalar(
            select(ShipmentMilestone).where(ShipmentMilestone.tenant_id == p.tenant_id, ShipmentMilestone.source_event_id == source_event_id)
        )
        if existing:
            return row(existing)
    milestone = ShipmentMilestone(
        tenant_id=p.tenant_id,
        created_by=p.email,
        shipment_id=shipment.id,
        code=str(need(body, "code")).upper(),
        planned_at=optional_dt(body.get("planned_at")),
        estimated_at=optional_dt(body.get("estimated_at")),
        actual_at=optional_dt(body.get("actual_at")),
        recorded_at=optional_dt(body.get("recorded_at")) or utcnow(),
        source=body.get("source") or "MANUAL",
        source_event_id=source_event_id,
    )
    db.add(milestone)
    shipment.last_tracked_at = milestone.recorded_at
    if milestone.actual_at and milestone.code == "SITE_DELIVERED":
        shipment.state = "DELIVERED"
    elif milestone.actual_at and milestone.code in ("DEPARTED_PORT",):
        shipment.state = "IN_TRANSIT"
    bump(shipment)
    db.flush()
    audit(db, p, "SHIPMENT_MILESTONE", "shipment", shipment.id, after={"code": milestone.code})
    return row(milestone)


def tracking_failure(db: Session, p: Principal, shipment_id: str, body: dict) -> dict:
    shipment = get_row(db, Shipment, shipment_id, p, "Shipment")
    shipment.last_tracked_at = None
    bump(shipment)
    audit(db, p, "SHIPMENT_TRACKING_FAILED", "shipment", shipment.id, reason=body.get("message"))
    return {"shipment_id": shipment.id, "state": shipment.state, "quality": "UNKNOWN", "message": body.get("message") or "Tracking feed unavailable; forecasts marked stale."}


def list_shipments(db: Session, p: Principal) -> list[dict]:
    return [_shipment_out(db, s) for s in db.scalars(select(Shipment).where(Shipment.tenant_id == p.tenant_id).order_by(Shipment.created_at.desc()))]


def get_shipment(db: Session, p: Principal, shipment_id: str) -> dict:
    return _shipment_out(db, get_row(db, Shipment, shipment_id, p, "Shipment"))


def _shipment_for_unit(db: Session, unit_id: str) -> Shipment | None:
    for shipment in db.scalars(select(Shipment).where(Shipment.state.in_(("PLANNED", "IN_TRANSIT", "DELIVERED"))).order_by(Shipment.created_at.desc())):
        if unit_id in (shipment.unit_ids or []):
            return shipment
    return None


def _arrival_for(db: Session, unit: PhysicalUnit, as_known_at: datetime) -> dict:
    shipment = _shipment_for_unit(db, unit.id)
    if shipment is None:
        return {"quality": "UNKNOWN", "eta_p50": None, "earliest": None, "latest": None, "unknown_reason": "No shipment or logistics evidence for this unit"}
    milestones = list(
        db.scalars(
            select(ShipmentMilestone)
            .where(ShipmentMilestone.shipment_id == shipment.id, ShipmentMilestone.recorded_at <= as_known_at)
            .order_by(ShipmentMilestone.recorded_at)
        )
    )
    by_code: dict[str, ShipmentMilestone] = {}
    for milestone in milestones:
        by_code[milestone.code] = milestone
    site = by_code.get("SITE_DELIVERED")
    if site and site.actual_at:
        eta = site.actual_at.date()
        return {"quality": "GOOD", "eta_p50": eta, "earliest": eta, "latest": eta, "unknown_reason": None, "shipment": shipment, "evidence": "ACTUAL"}
    stale = shipment.last_tracked_at is None or (as_known_at - shipment.last_tracked_at).days > 14
    base = None
    evidence = None
    for code in ("SITE_DELIVERED", "ARRIVED_PORT", "DEPARTED_PORT", "DISPATCHED"):
        milestone = by_code.get(code)
        if milestone and (milestone.estimated_at or milestone.planned_at):
            base = (milestone.estimated_at or milestone.planned_at).date()
            evidence = code
            break
    if base is None:
        return {"quality": "UNKNOWN", "eta_p50": None, "earliest": None, "latest": None, "unknown_reason": "Milestones exist but carry no estimate", "shipment": shipment}
    if evidence == "ARRIVED_PORT":
        base += timedelta(days=5)
    elif evidence in ("DEPARTED_PORT", "DISPATCHED"):
        base += timedelta(days={"SEA": SEA_TRANSIT_DAYS, "AIR": AIR_TRANSIT_DAYS, "ROAD": ROAD_TRANSIT_DAYS}.get(shipment.mode, SEA_TRANSIT_DAYS))
    quality = "STALE" if stale else ("GOOD" if evidence in ("SITE_DELIVERED", "ARRIVED_PORT") else "SPARSE")
    uncertain = 14 if quality == "GOOD" else 28
    return {
        "quality": quality,
        "eta_p50": base,
        "earliest": base - timedelta(days=uncertain // 2),
        "latest": base + timedelta(days=uncertain),
        "unknown_reason": "Tracking stale; forecast is based on the last known milestone" if stale else None,
        "shipment": shipment,
        "evidence": evidence,
    }


def _readiness(db: Session, p: Principal, unit: PhysicalUnit) -> dict:
    blockers = []
    site_store = None
    if unit.assigned_project_id:
        site_store = db.scalar(
            select(Location).where(Location.tenant_id == p.tenant_id, Location.project_id == unit.assigned_project_id, Location.kind == "SITE_STORE")
        )
        if site_store is None:
            blockers.append("No site store configured for the destination project")
    else:
        blockers.append("Unit is not allocated to a destination project")
    if unit.state in ("RECEIVED", "ISSUED", "INSTALLED"):
        blockers.append(f"Unit is already {unit.state.lower()}")
    return {"ready": not blockers, "blockers": blockers, "site_store": site_store.code if site_store else None}


def arrival_overview(db: Session, p: Principal, project_id: str | None, selected_date: str | None, as_known_at: str | None) -> list[dict]:
    cutoff = optional_dt(as_known_at) or utcnow()
    selected = optional_date(selected_date) or date.today()
    query = select(PhysicalUnit).where(PhysicalUnit.tenant_id == p.tenant_id, PhysicalUnit.state.notin_(("CANCELLED", "RETIRED")))
    if project_id:
        query = query.where(PhysicalUnit.assigned_project_id == project_id)
    units = [u for u in db.scalars(query.order_by(PhysicalUnit.asset_code)) if p.can_see_project(u.assigned_project_id)]
    out = []
    for unit in units:
        arrival = _arrival_for(db, unit, cutoff)
        eta = arrival["eta_p50"]
        p_on = p_by = None
        if eta is not None:
            if arrival["quality"] in ("GOOD", "SPARSE"):
                p_on = "1" if eta <= selected else "0"
                p_by = "1" if arrival["latest"] and arrival["latest"] <= selected else ("0.5" if arrival["quality"] == "SPARSE" else "0.1")
            else:
                p_on = p_by = None
        out.append(
            {
                "unit_id": unit.id,
                "asset_code": unit.asset_code,
                "item_code": unit.item_model.item_code if unit.item_model else None,
                "project_id": unit.assigned_project_id,
                "shipment_id": arrival.get("shipment").id if arrival.get("shipment") else None,
                "eta_p50": eta.isoformat() if eta else None,
                "earliest": arrival["earliest"].isoformat() if arrival["earliest"] else None,
                "latest": arrival["latest"].isoformat() if arrival["latest"] else None,
                "p_on_date": p_on,
                "p_by_date": p_by,
                "quality": arrival["quality"],
                "unknown_reason": arrival["unknown_reason"],
                "receiving_readiness": _readiness(db, p, unit),
            }
        )
    return out


def create_arrival_snapshots(db: Session, p: Principal, body: dict) -> dict:
    cutoff = utcnow()
    project_id = body.get("project_id")
    query = select(PhysicalUnit).where(PhysicalUnit.tenant_id == p.tenant_id, PhysicalUnit.state.notin_(("CANCELLED", "RETIRED")))
    if project_id:
        query = query.where(PhysicalUnit.assigned_project_id == project_id)
    created = 0
    for unit in db.scalars(query):
        if not p.can_see_project(unit.assigned_project_id):
            continue
        arrival = _arrival_for(db, unit, cutoff)
        db.add(
            ArrivalSnapshot(
                tenant_id=p.tenant_id,
                created_by=p.email,
                unit_id=unit.id,
                shipment_id=arrival.get("shipment").id if arrival.get("shipment") else None,
                recorded_at=cutoff,
                evidence_cutoff=cutoff,
                eta_p50=arrival["eta_p50"],
                earliest=arrival["earliest"],
                latest=arrival["latest"],
                quality=arrival["quality"],
                unknown_reason=arrival["unknown_reason"],
            )
        )
        created += 1
    audit(db, p, "ARRIVAL_SNAPSHOTS_CREATED", "arrival_snapshot", project_id or "ALL", after={"count": created})
    db.flush()
    return {"created": created, "evidence_cutoff": cutoff.isoformat() + "Z"}
