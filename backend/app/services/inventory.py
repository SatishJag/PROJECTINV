"""Inventory: receipts, allocation (intent vs Oracle reservation vs project transfer), issue,
group transfers and stock views (FR12, FR14).

Oracle is the stock authority: commands record the hub decision and enqueue an ORACLE outbox
message; the external reference and the confirmed state are written back only on ACK
(app.integrations.oracle_sim → apply_* functions below).
"""

from datetime import datetime

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.api.common import row
from app.core import audit
from app.core.auth import Principal
from app.core.errors import Conflict, DomainError, NotFound
from app.core.outbox import enqueue
from app.models import (
    AllocationRecord,
    Location,
    PhysicalUnit,
    PoLine,
    Project,
    PurchaseOrder,
    Receipt,
    ReceiptLine,
    RecoveryCase,
    Reservation,
    Shipment,
    StockTransaction,
    TransferManifest,
    UnitComponent,
    WbsElement,
    utcnow,
)
from app.services import structure
from app.services.identity import next_asset_codes, prefix_for_model
from app.services.inventory_common import (
    STOCK_LOCATION_KINDS,
    TERMINAL_UNIT_STATES,
    code_of,
    get_project,
    get_tenant_row,
    get_unit,
    lock,
    parse_dt,
    unit_brief,
    unit_row,
    unit_visible,
)

ALLOCATION_KINDS = ("PLANNING_INTENT", "ORACLE_RESERVATION", "PROJECT_TRANSFER")
ORACLE_KINDS = ("ORACLE_RESERVATION", "PROJECT_TRANSFER")
ACTIVE_ALLOCATION_STATES = ("PENDING", "CONFIRMED")
OPEN_CASE_EXCLUDED = ("RELEASED", "CLOSED")
TRANSFER_OPEN_STATES = ("DRAFT", "APPROVED", "IN_TRANSIT", "PARTIALLY_RECEIVED")


# ---------------------------------------------------------------- shared lookups


def active_allocation(db: Session, unit_id: str) -> AllocationRecord | None:
    return db.scalar(
        select(AllocationRecord).where(AllocationRecord.unit_id == unit_id, AllocationRecord.state.in_(ACTIVE_ALLOCATION_STATES))
    )


def open_recovery_cases(db: Session, tenant_id: str, unit_id: str) -> list[RecoveryCase]:
    return list(
        db.scalars(
            select(RecoveryCase).where(
                RecoveryCase.tenant_id == tenant_id, RecoveryCase.parent_unit_id == unit_id, RecoveryCase.state.notin_(OPEN_CASE_EXCLUDED)
            )
        )
    )


def in_transit_location(db: Session, tenant_id: str) -> Location | None:
    return db.scalar(select(Location).where(Location.tenant_id == tenant_id, Location.kind == "IN_TRANSIT").order_by(Location.code))


def fitted_unit_ids(db: Session, tenant_id: str) -> set[str]:
    return set(db.scalars(select(UnitComponent.child_unit_id).where(UnitComponent.tenant_id == tenant_id, UnitComponent.valid_to.is_(None))))


def allocation_row(db: Session, a: AllocationRecord) -> dict:
    unit = db.get(PhysicalUnit, a.unit_id)
    return row(
        a,
        asset_code=unit.asset_code if unit else None,
        from_project_code=code_of(db, Project, a.from_project_id),
        to_project_code=code_of(db, Project, a.to_project_id),
    )


def _txn(db: Session, p: Principal | None, tenant_id: str, request_ref: str, unit: PhysicalUnit, txn_type: str, *,
         from_location_id=None, to_location_id=None, from_project_id=None, to_project_id=None, post: bool = True) -> StockTransaction:
    txn = StockTransaction(
        tenant_id=tenant_id,
        created_by=p.email if p else "system",
        request_ref=request_ref,
        unit_id=unit.id,
        txn_type=txn_type,
        from_location_id=from_location_id,
        to_location_id=to_location_id,
        from_project_id=from_project_id,
        to_project_id=to_project_id,
    )
    db.add(txn)
    db.flush()
    if post:
        enqueue(db, tenant_id, "ORACLE", "stock_txn.post", "StockTransaction", txn.id, {"stock_transaction_id": txn.id})
    return txn


def _next_ref(db: Session, tenant_id: str, prefix: str) -> str:
    n = db.scalar(select(func.count()).select_from(StockTransaction).where(StockTransaction.tenant_id == tenant_id, StockTransaction.request_ref.like(f"{prefix}%")))
    return f"{prefix}{(n or 0) + 1}"


# ---------------------------------------------------------------- receipts


def receive(db: Session, p: Principal, data: dict) -> dict:
    t = p.tenant_id
    receipt_ref = (data.get("receipt_ref") or "").strip()
    if not receipt_ref:
        raise DomainError("RECEIPT_REF_REQUIRED", "receipt_ref is required")
    po = get_tenant_row(db, p, PurchaseOrder, data.get("po_id"), "Purchase order")
    loc = get_tenant_row(db, p, Location, data.get("location_id"), "Location")
    if loc.project_id and not p.can_see_project(loc.project_id):
        raise NotFound("Location", loc.id)
    if loc.kind not in STOCK_LOCATION_KINDS:
        raise DomainError("INVALID_RECEIPT_LOCATION", f"Goods can be received only into a warehouse or site store, not {loc.kind}")
    received_at = parse_dt(data.get("received_at"), "received_at")
    if received_at is None:
        raise DomainError("RECEIVED_AT_REQUIRED", "received_at is required")
    lines = data.get("lines") or []
    if not lines:
        raise DomainError("EMPTY_RECEIPT", "A receipt needs at least one line")
    unit_ids = [ln.get("unit_id") for ln in lines]
    if len(set(unit_ids)) != len(unit_ids):
        raise DomainError("DUPLICATE_LINE", "Each unit can appear only once in a receipt")
    if db.scalar(select(Receipt).where(Receipt.tenant_id == t, Receipt.receipt_ref == receipt_ref)):
        raise Conflict("RECEIPT_REF_EXISTS", f"Receipt {receipt_ref} already exists")

    receipt = Receipt(tenant_id=t, created_by=p.email, receipt_ref=receipt_ref, po_id=po.id, location_id=loc.id, received_at=received_at)
    db.add(receipt)
    db.flush()
    from app.services import costs  # local import: costs depends on structure/inventory helpers

    out_lines = []
    for ln in lines:
        unit = get_unit(db, p, ln.get("unit_id"))
        po_line = db.get(PoLine, unit.po_line_id) if unit.po_line_id else None
        if po_line is None or po_line.po_id != po.id:
            raise DomainError("UNIT_NOT_ON_PO", f"{unit.asset_code} is not on purchase order {po.canonical_number}")
        lock(db, unit)
        if db.scalar(select(ReceiptLine).where(ReceiptLine.tenant_id == t, ReceiptLine.unit_id == unit.id)) or unit.state not in ("PLANNED", "IN_TRANSIT"):
            if unit.state in TERMINAL_UNIT_STATES:
                raise DomainError("UNIT_NOT_RECEIVABLE", f"{unit.asset_code} is {unit.state}")
            raise Conflict("UNIT_ALREADY_RECEIVED", f"{unit.asset_code} has already been received")
        serial = (ln.get("serial_number") or "").strip()
        if not serial:
            raise DomainError("SERIAL_REQUIRED", f"serial_number is required for {unit.asset_code}")
        _check_serial(db, t, unit.item_model_id, serial, unit.id)
        from_loc = unit.custody_location_id
        unit.serial_number = serial
        unit.state = "RECEIVED"
        unit.custody_location_id = loc.id
        unit.condition = ln.get("condition") or "GOOD"
        if ln.get("barcode"):
            unit.barcode = ln["barcode"]
        db.add(ReceiptLine(tenant_id=t, created_by=p.email, receipt_id=receipt.id, po_line_id=po_line.id, unit_id=unit.id,
                           serial_number=serial, condition=unit.condition))
        _txn(db, p, t, f"RCV-{receipt_ref}-{unit.asset_code}", unit, "RECEIPT", from_location_id=from_loc, to_location_id=loc.id,
             to_project_id=unit.assigned_project_id, post=False)
        components = _receive_components(db, p, unit, ln.get("components") or [], received_at)
        structure.propagate(db, unit)
        costs.record_event(
            db, p,
            {
                "economic_key": f"PURCHASE:{po.canonical_number}:{po_line.line_no}:{unit.asset_code}",
                "unit_id": unit.id,
                "po_line_id": po_line.id,
                "posting_project_id": unit.assigned_project_id,
                "category": "PURCHASE",
                "status": "PROVISIONAL",
                "amount": str(po_line.unit_price),
                "currency": po.currency,
                "source_system": "ORACLE",
                "source_ref": receipt_ref,
                "occurred_on": received_at.date().isoformat(),
            },
            check_visibility=False,
        )
        out_lines.append({"unit": unit_brief(db, unit), "components": components})

    _mark_shipments_delivered(db, t, po.id, received_at)
    enqueue(db, t, "ORACLE", "receipt.create", "Receipt", receipt.id, {"receipt_id": receipt.id})
    audit.record(db, p, "receipt.create", "Receipt", receipt.id,
                 after={"receipt_ref": receipt_ref, "po": po.canonical_number, "location": loc.code, "unit_ids": unit_ids})
    return {"receipt": row(receipt, location_code=loc.code, po_number=po.canonical_number), "lines": out_lines}


def _check_serial(db: Session, tenant_id: str, item_model_id: str, serial: str, unit_id: str | None) -> None:
    q = select(PhysicalUnit).where(PhysicalUnit.tenant_id == tenant_id, PhysicalUnit.item_model_id == item_model_id, PhysicalUnit.serial_number == serial)
    if unit_id:
        q = q.where(PhysicalUnit.id != unit_id)
    other = db.scalars(q).first()
    if other is not None:
        raise Conflict("DUPLICATE_SERIAL", f"Serial {serial} is already recorded on {other.asset_code}")


def _receive_components(db: Session, p: Principal, unit: PhysicalUnit, comps: list[dict], received_at: datetime) -> list[dict]:
    t = unit.tenant_id
    resolved = []
    for c in comps:
        slot = (c.get("slot_code") or "").strip()
        if not slot:
            raise DomainError("SLOT_REQUIRED", "Each component needs a slot_code")
        resolved.append((structure.resolve_slot_path(db, t, unit.item_model_id, slot), c))
    paths = ["/".join(path) for path, _ in resolved]
    if len(set(paths)) != len(paths):
        raise DomainError("DUPLICATE_SLOT", f"A slot appears more than once for {unit.asset_code}")
    out = []
    for path, c in sorted(resolved, key=lambda pc: len(pc[0])):
        parent = unit
        for part in path[:-1]:
            link = next((ln for ln in structure.children_links(db, t, parent.id) if ln.slot_code == part), None)
            if link is None:
                raise DomainError("PARENT_SLOT_EMPTY", f"{'/'.join(path)} needs {part} to be received first")
            parent = db.get(PhysicalUnit, link.child_unit_id)
        line = structure.slot_line(db, t, parent.item_model_id, path[-1])
        if line is None or not line.individually_tracked or line.child_model_id is None:
            raise DomainError("SLOT_NOT_TRACKED", f"Slot {'/'.join(path)} is not individually tracked")
        serial = (c.get("serial_number") or "").strip()
        if not serial:
            raise DomainError("SERIAL_REQUIRED", f"serial_number is required for component {'/'.join(path)}")
        _check_serial(db, t, line.child_model_id, serial, None)
        model = line.item_model if hasattr(line, "item_model") else None
        from app.models import ItemModel

        model = db.get(ItemModel, line.child_model_id)
        code = (c.get("asset_code") or "").strip() or next_asset_codes(db, t, prefix_for_model(db, model), 1)[0]
        if db.scalar(select(PhysicalUnit).where(PhysicalUnit.tenant_id == t, PhysicalUnit.asset_code == code)):
            raise Conflict("ASSET_CODE_EXISTS", f"Asset code {code} is already in use")
        child = PhysicalUnit(
            tenant_id=t, created_by=p.email, asset_code=code, item_model_id=model.id, programme_id=unit.programme_id,
            serial_number=serial, state="RECEIVED", custody_location_id=unit.custody_location_id, condition="GOOD",
        )
        db.add(child)
        db.flush()
        structure.fit(db, p, parent, child, path[-1], received_at, install_reason="RECEIPT")
        out.append({"slot_path": "/".join(path), "unit": unit_brief(db, child)})
    return out


def _mark_shipments_delivered(db: Session, tenant_id: str, po_id: str, received_at: datetime) -> None:
    for s in db.scalars(select(Shipment).where(Shipment.tenant_id == tenant_id, Shipment.po_id == po_id, Shipment.state != "DELIVERED")):
        ids = s.unit_ids or []
        if not ids:
            continue
        received = set(db.scalars(select(ReceiptLine.unit_id).where(ReceiptLine.tenant_id == tenant_id, ReceiptLine.unit_id.in_(ids))))
        if received.issuperset(ids):
            s.state = "DELIVERED"
            s.version = (s.version or 0) + 1


def list_receipts(db: Session, p: Principal, po_id: str | None = None) -> list[dict]:
    q = select(Receipt).where(Receipt.tenant_id == p.tenant_id)
    if po_id:
        q = q.where(Receipt.po_id == po_id)
    out = []
    for r in db.scalars(q.order_by(Receipt.received_at.desc())):
        unit_ids = list(db.scalars(select(ReceiptLine.unit_id).where(ReceiptLine.receipt_id == r.id)))
        out.append(row(r, location_code=code_of(db, Location, r.location_id), po_number=code_of(db, PurchaseOrder, r.po_id, "canonical_number"), unit_ids=unit_ids))
    return out


# ---------------------------------------------------------------- stock view


def stock(db: Session, p: Principal, programme_id: str | None = None, location_id: str | None = None, project_id: str | None = None) -> dict:
    t = p.tenant_id
    q = select(PhysicalUnit).where(PhysicalUnit.tenant_id == t, PhysicalUnit.state.notin_(("PLANNED", "CANCELLED", "SCRAPPED", "RETIRED")))
    if programme_id:
        q = q.where(PhysicalUnit.programme_id == programme_id)
    if location_id:
        q = q.where(PhysicalUnit.custody_location_id == location_id)
    if project_id:
        q = q.where(PhysicalUnit.assigned_project_id == project_id)
    fitted = fitted_unit_ids(db, t)
    units = [u for u in db.scalars(q.order_by(PhysicalUnit.asset_code)) if u.id not in fitted and unit_visible(p, u)]
    buckets: dict[str | None, dict] = {}
    for u in units:
        b = buckets.get(u.custody_location_id)
        if b is None:
            loc = db.get(Location, u.custody_location_id) if u.custody_location_id else None
            b = buckets[u.custody_location_id] = {
                "location": {"id": loc.id, "code": loc.code, "name": loc.name, "kind": loc.kind} if loc else None,
                "total": 0, "unallocated": 0, "allocated": 0, "reserved": 0, "issued": 0,
            }
        b["total"] += 1
        key = u.allocation_status.lower()
        if key in b:
            b[key] += 1
    by_location = sorted(buckets.values(), key=lambda b: (b["location"] or {}).get("code") or "")
    return {"by_location": by_location, "units": [unit_row(db, u) for u in units]}


def list_stock_transactions(db: Session, p: Principal, unit_id: str | None = None) -> list[dict]:
    q = select(StockTransaction).where(StockTransaction.tenant_id == p.tenant_id)
    if unit_id:
        get_unit(db, p, unit_id)
        q = q.where(StockTransaction.unit_id == unit_id)
    out = []
    for txn in db.scalars(q.order_by(StockTransaction.created_at.desc())):
        unit = db.get(PhysicalUnit, txn.unit_id)
        if not unit_visible(p, unit):
            continue
        out.append(row(txn, asset_code=unit.asset_code, from_location_code=code_of(db, Location, txn.from_location_id),
                       to_location_code=code_of(db, Location, txn.to_location_id)))
    return out


# ---------------------------------------------------------------- allocation


def allocate(db: Session, p: Principal, data: dict) -> list[dict]:
    kind = data.get("kind")
    if kind not in ALLOCATION_KINDS:
        raise DomainError("INVALID_ALLOCATION_KIND", f"kind must be one of {', '.join(ALLOCATION_KINDS)}")
    project = get_project(db, p, data.get("to_project_id"))
    if project.status != "ACTIVE":
        raise DomainError("PROJECT_NOT_ACTIVE", f"Project {project.code} is {project.status}")
    wbs = None
    if data.get("to_wbs_id"):
        wbs = get_tenant_row(db, p, WbsElement, data["to_wbs_id"], "WBS element")
        if wbs.project_id != project.id:
            raise DomainError("WBS_NOT_IN_PROJECT", "to_wbs_id belongs to another project")
    reason = (data.get("reason") or "").strip()
    if not reason:
        raise DomainError("REASON_REQUIRED", "An allocation needs a reason")
    unit_ids = list(dict.fromkeys(data.get("unit_ids") or []))
    if not unit_ids:
        raise DomainError("UNITS_REQUIRED", "unit_ids must not be empty")
    return [allocation_row(db, _allocate_one(db, p, get_unit(db, p, uid), kind, project, wbs, reason)) for uid in unit_ids]


def _allocate_one(db: Session, p: Principal, unit: PhysicalUnit, kind: str, project: Project, wbs: WbsElement | None, reason: str) -> AllocationRecord:
    t = p.tenant_id
    lock(db, unit)
    if unit.programme_id and unit.programme_id != project.programme_id:
        raise DomainError("PROGRAMME_MISMATCH", f"{unit.asset_code} belongs to another programme than {project.code}")
    if structure.parent_link(db, t, unit.id) is not None:
        raise DomainError("COMPONENT_FOLLOWS_PARENT", f"{unit.asset_code} is fitted to a parent; allocate the parent instead")
    if unit.state in TERMINAL_UNIT_STATES:
        raise DomainError("UNIT_NOT_ALLOCATABLE", f"{unit.asset_code} is {unit.state}")
    if unit.allocation_status == "ISSUED" or unit.state in ("ISSUED", "INSTALLED"):
        raise Conflict("UNIT_ISSUED", f"{unit.asset_code} has been issued to {code_of(db, Project, unit.assigned_project_id)}; return it to stock first")
    prior = active_allocation(db, unit.id)
    if prior is not None:
        if prior.state == "PENDING" and prior.kind in ORACLE_KINDS:
            raise Conflict("ALLOCATION_IN_FLIGHT", f"{unit.asset_code} has an Oracle {prior.kind.lower()} awaiting acknowledgement")
        if prior.to_project_id == project.id and prior.kind == kind:
            raise Conflict("UNIT_ALREADY_ALLOCATED", f"{unit.asset_code} is already allocated to {project.code} as {kind}")
        if prior.kind == "PROJECT_TRANSFER" and kind != "PROJECT_TRANSFER":
            raise DomainError("PROJECT_TRANSFER_REQUIRED", f"{unit.asset_code} was transferred to a project ledger in Oracle; a move needs another PROJECT_TRANSFER")
    if kind in ORACLE_KINDS:
        loc = db.get(Location, unit.custody_location_id) if unit.custody_location_id else None
        if unit.state != "RECEIVED" or loc is None or loc.kind not in STOCK_LOCATION_KINDS:
            raise DomainError("UNIT_NOT_IN_STOCK", f"{unit.asset_code} must be received into a warehouse or site store before an Oracle {kind.lower()}")
    reservation = db.scalar(select(Reservation).where(Reservation.unit_id == unit.id, Reservation.state == "ACTIVE"))
    if reservation is not None and reservation.project_id != project.id:
        raise Conflict("UNIT_ALREADY_RESERVED", f"{unit.asset_code} is reserved for {code_of(db, Project, reservation.project_id)}")

    now = utcnow()
    from_project_id = unit.assigned_project_id
    if prior is not None:
        prior.state = "SUPERSEDED"
        prior.effective_to = now
        prior.version += 1
        if prior.kind == "ORACLE_RESERVATION":
            _release_reservation_rows(db, unit.id, prior)
            enqueue(db, t, "ORACLE", "reservation.release", "AllocationRecord", prior.id, {"allocation_id": prior.id})
        db.flush()
    alloc = AllocationRecord(
        tenant_id=t, created_by=p.email, unit_id=unit.id, kind=kind, from_project_id=from_project_id, to_project_id=project.id,
        to_wbs_id=wbs.id if wbs else None, reason=reason, requested_by=p.email,
        generates_project_charge=kind == "PROJECT_TRANSFER",
    )
    if kind == "PLANNING_INTENT":
        alloc.state = "CONFIRMED"
        alloc.approved_by = p.email
        alloc.effective_from = now
    db.add(alloc)
    db.flush()
    unit.assigned_project_id = project.id
    unit.assigned_wbs_id = wbs.id if wbs else None
    unit.allocation_status = "ALLOCATED"
    structure.propagate(db, unit)
    if kind == "ORACLE_RESERVATION":
        enqueue(db, t, "ORACLE", "reservation.create", "AllocationRecord", alloc.id, {"allocation_id": alloc.id})
    elif kind == "PROJECT_TRANSFER":
        _txn(db, p, t, f"PT-{alloc.id}", unit, "PROJECT_TRANSFER", from_location_id=unit.custody_location_id, to_location_id=unit.custody_location_id,
             from_project_id=from_project_id, to_project_id=project.id, post=False)
        enqueue(db, t, "ORACLE", "project_transfer.create", "AllocationRecord", alloc.id, {"allocation_id": alloc.id})
    audit.record(db, p, "allocation.create", "PhysicalUnit", unit.id, reason=reason,
                 after={"allocation_id": alloc.id, "kind": kind, "from_project_id": from_project_id, "to_project_id": project.id,
                        "superseded_id": prior.id if prior else None})
    return alloc


def _release_reservation_rows(db: Session, unit_id: str, alloc: AllocationRecord) -> None:
    for r in db.scalars(select(Reservation).where(Reservation.unit_id == unit_id, Reservation.state == "ACTIVE", Reservation.authority == "ORACLE")):
        if alloc.oracle_ref is None or r.oracle_reservation_ref in (None, alloc.oracle_ref):
            r.state = "RELEASED"
            r.version += 1


def release_allocation(db: Session, p: Principal, allocation_id: str, data: dict) -> dict:
    alloc = get_tenant_row(db, p, AllocationRecord, allocation_id, "Allocation")
    unit = get_unit(db, p, alloc.unit_id, "Allocation")
    lock(db, unit, alloc)
    if alloc.state not in ACTIVE_ALLOCATION_STATES:
        raise Conflict("ALLOCATION_NOT_ACTIVE", f"Allocation is {alloc.state}")
    if alloc.state == "PENDING" and alloc.kind in ORACLE_KINDS:
        raise Conflict("ALLOCATION_IN_FLIGHT", "The Oracle request has not been acknowledged yet")
    if alloc.kind == "PROJECT_TRANSFER":
        raise Conflict("PROJECT_TRANSFER_POSTED", "A posted Oracle project transfer is reversed by another PROJECT_TRANSFER, not released")
    if unit.allocation_status == "ISSUED":
        raise Conflict("UNIT_ISSUED", f"{unit.asset_code} has been issued")
    alloc.state = "RELEASED"
    alloc.effective_to = utcnow()
    if alloc.kind == "ORACLE_RESERVATION":
        _release_reservation_rows(db, unit.id, alloc)
        enqueue(db, p.tenant_id, "ORACLE", "reservation.release", "AllocationRecord", alloc.id, {"allocation_id": alloc.id})
    unit.assigned_project_id = None
    unit.assigned_wbs_id = None
    unit.allocation_status = "UNALLOCATED"
    structure.propagate(db, unit)
    audit.record(db, p, "allocation.release", "PhysicalUnit", unit.id, reason=data.get("reason"),
                 after={"allocation_id": alloc.id, "kind": alloc.kind})
    return allocation_row(db, alloc)


def list_allocations(db: Session, p: Principal, unit_id: str | None = None) -> list[dict]:
    q = select(AllocationRecord).where(AllocationRecord.tenant_id == p.tenant_id)
    if unit_id:
        get_unit(db, p, unit_id)
        q = q.where(AllocationRecord.unit_id == unit_id)
    out = []
    for a in db.scalars(q.order_by(AllocationRecord.created_at.desc())):
        if unit_visible(p, db.get(PhysicalUnit, a.unit_id)):
            out.append(allocation_row(db, a))
    return out


# Oracle write-back (called by app.integrations.oracle_sim)


def apply_allocation_ack(db: Session, alloc: AllocationRecord, oracle_ref: str) -> None:
    if alloc.state != "PENDING":
        return
    unit = db.get(PhysicalUnit, alloc.unit_id)
    alloc.state = "CONFIRMED"
    alloc.oracle_ref = oracle_ref
    alloc.effective_from = alloc.effective_from or utcnow()
    alloc.approved_by = alloc.approved_by or "oracle"
    alloc.version += 1
    if unit.assigned_project_id == alloc.to_project_id and unit.allocation_status == "ALLOCATED":
        unit.allocation_status = "RESERVED"
        structure.propagate(db, unit)
    if alloc.kind == "ORACLE_RESERVATION":
        res = db.scalar(select(Reservation).where(Reservation.unit_id == unit.id, Reservation.state == "ACTIVE"))
        if res is None:
            db.add(Reservation(tenant_id=alloc.tenant_id, created_by="oracle", unit_id=unit.id, requirement_id=unit.requirement_id,
                               project_id=alloc.to_project_id, authority="ORACLE", oracle_reservation_ref=oracle_ref, approved_by=alloc.requested_by))
        elif res.project_id == alloc.to_project_id:
            res.authority = "ORACLE"
            res.oracle_reservation_ref = oracle_ref
            res.version += 1
    else:
        txn = db.scalar(select(StockTransaction).where(StockTransaction.tenant_id == alloc.tenant_id, StockTransaction.request_ref == f"PT-{alloc.id}"))
        if txn is not None:
            txn.state = "CONFIRMED"
            txn.oracle_txn_id = oracle_ref
            txn.confirmed_at = utcnow()


def apply_allocation_reject(db: Session, alloc: AllocationRecord, message: str) -> None:
    """Oracle refused the request: the hub decision is undone and an exception is raised by the outbox."""
    if alloc.state != "PENDING":
        return
    unit = db.get(PhysicalUnit, alloc.unit_id)
    alloc.state = "REJECTED"
    alloc.effective_to = utcnow()
    alloc.version += 1
    txn = db.scalar(select(StockTransaction).where(StockTransaction.tenant_id == alloc.tenant_id, StockTransaction.request_ref == f"PT-{alloc.id}"))
    if txn is not None:
        txn.state = "REJECTED"
        txn.message = message
    db.flush()
    restored = None
    if alloc.from_project_id:
        prior = db.scalars(
            select(AllocationRecord)
            .where(AllocationRecord.unit_id == unit.id, AllocationRecord.state == "SUPERSEDED", AllocationRecord.to_project_id == alloc.from_project_id)
            .order_by(AllocationRecord.effective_to.desc())
        ).first()
        if prior is not None and prior.kind == "PLANNING_INTENT":
            prior.state = "CONFIRMED"
            prior.effective_to = None
            prior.version += 1
            restored = prior
    if unit.assigned_project_id == alloc.to_project_id and unit.allocation_status != "ISSUED":
        unit.assigned_project_id = restored.to_project_id if restored else None
        unit.assigned_wbs_id = restored.to_wbs_id if restored else None
        unit.allocation_status = "ALLOCATED" if restored else "UNALLOCATED"
        structure.propagate(db, unit)


# ---------------------------------------------------------------- issue


def issue(db: Session, p: Principal, data: dict) -> dict:
    t = p.tenant_id
    unit = get_unit(db, p, data.get("unit_id"))
    loc = get_tenant_row(db, p, Location, data.get("to_location_id"), "Location")
    lock(db, unit)
    if structure.parent_link(db, t, unit.id) is not None:
        raise DomainError("COMPONENT_FOLLOWS_PARENT", f"{unit.asset_code} is fitted to a parent; issue the parent")
    if unit.assigned_project_id is None:
        raise DomainError("UNIT_NOT_ASSIGNED", f"{unit.asset_code} must be allocated to a project before it is issued")
    if unit.allocation_status == "ISSUED" or unit.state in ("ISSUED", "INSTALLED"):
        raise Conflict("UNIT_ALREADY_ISSUED", f"{unit.asset_code} has already been issued")
    if unit.state != "RECEIVED":
        raise DomainError("UNIT_NOT_IN_STOCK", f"{unit.asset_code} is {unit.state}; only received stock can be issued")
    alloc = active_allocation(db, unit.id)
    if alloc is not None and alloc.state == "PENDING":
        raise Conflict("ALLOCATION_IN_FLIGHT", "The Oracle allocation has not been acknowledged yet")
    if loc.kind not in ("SITE_STORE", "INSTALLED"):
        raise DomainError("INVALID_ISSUE_LOCATION", f"Units are issued to a site store or installed position, not {loc.kind}")
    if loc.project_id != unit.assigned_project_id:
        raise DomainError("LOCATION_NOT_IN_PROJECT", f"{loc.code} does not belong to {code_of(db, Project, unit.assigned_project_id)}")
    if unit.quality_status in ("FAILED", "ON_HOLD") or open_recovery_cases(db, t, unit.id):
        raise DomainError("QUALITY_HOLD", f"{unit.asset_code} is on quality hold ({unit.quality_status})")
    from_loc = unit.custody_location_id
    unit.custody_location_id = loc.id
    if data.get("installed_position"):
        unit.installed_position = data["installed_position"]
    unit.state = "INSTALLED" if loc.kind == "INSTALLED" else "ISSUED"
    unit.allocation_status = "ISSUED"
    structure.propagate(db, unit)
    for r in db.scalars(select(Reservation).where(Reservation.unit_id == unit.id, Reservation.state == "ACTIVE")):
        r.state = "CONSUMED"
        r.version += 1
    txn = _txn(db, p, t, _next_ref(db, t, f"ISS-{unit.asset_code}-"), unit, "ISSUE", from_location_id=from_loc, to_location_id=loc.id,
               from_project_id=unit.assigned_project_id, to_project_id=unit.assigned_project_id)
    audit.record(db, p, "unit.issue", "PhysicalUnit", unit.id,
                 after={"to_location": loc.code, "installed_position": unit.installed_position, "stock_transaction_id": txn.id})
    return {"unit": unit_row(db, unit), "stock_transaction": row(txn)}


# ---------------------------------------------------------------- transfers (FR14, T17)


def _units_on_open_transfers(db: Session, tenant_id: str, exclude_id: str | None = None) -> dict[str, str]:
    out = {}
    for m in db.scalars(select(TransferManifest).where(TransferManifest.tenant_id == tenant_id, TransferManifest.state.in_(TRANSFER_OPEN_STATES))):
        if m.id == exclude_id:
            continue
        received = set(m.received_unit_ids or [])
        for uid in m.unit_ids or []:
            if uid not in received:
                out[uid] = m.code
    return out


def transfer_row(db: Session, m: TransferManifest) -> dict:
    received = set(m.received_unit_ids or [])
    members = []
    for uid in m.unit_ids or []:
        u = db.get(PhysicalUnit, uid)
        brief = unit_brief(db, u)
        brief["received"] = uid in received
        members.append(brief)
    return row(
        m,
        from_location_code=code_of(db, Location, m.from_location_id),
        to_location_code=code_of(db, Location, m.to_location_id),
        to_project_code=code_of(db, Project, m.to_project_id),
        members=members,
        remaining_unit_ids=[uid for uid in m.unit_ids or [] if uid not in received],
    )


def _get_transfer(db: Session, p: Principal, transfer_id: str) -> TransferManifest:
    m = get_tenant_row(db, p, TransferManifest, transfer_id, "Transfer")
    if m.to_project_id and not p.can_see_project(m.to_project_id):
        raise NotFound("Transfer", transfer_id)
    for uid in m.unit_ids or []:
        if not unit_visible(p, db.get(PhysicalUnit, uid)):
            raise NotFound("Transfer", transfer_id)
    return m


def create_transfer(db: Session, p: Principal, data: dict) -> dict:
    t = p.tenant_id
    code = (data.get("code") or "").strip()
    if not code:
        raise DomainError("CODE_REQUIRED", "code is required")
    if db.scalar(select(TransferManifest).where(TransferManifest.tenant_id == t, TransferManifest.code == code)):
        raise Conflict("TRANSFER_CODE_EXISTS", f"Transfer {code} already exists")
    src = get_tenant_row(db, p, Location, data.get("from_location_id"), "Location")
    dst = get_tenant_row(db, p, Location, data.get("to_location_id"), "Location")
    if src.id == dst.id:
        raise DomainError("SAME_LOCATION", "Source and destination must differ")
    if dst.kind not in ("CENTRAL_WAREHOUSE", "SITE_STORE", "INSTALLED", "SUPPLIER"):
        raise DomainError("INVALID_DESTINATION", f"Cannot transfer into a {dst.kind} location")
    to_project = get_project(db, p, data["to_project_id"]) if data.get("to_project_id") else None
    if to_project and dst.project_id and dst.project_id != to_project.id:
        raise DomainError("LOCATION_NOT_IN_PROJECT", f"{dst.code} does not belong to {to_project.code}")
    listed = list(dict.fromkeys(data.get("unit_ids") or []))
    if not listed:
        raise DomainError("UNITS_REQUIRED", "unit_ids must not be empty")
    units = [get_unit(db, p, uid) for uid in listed]
    lock(db, *units)
    listed_set = set(listed)
    roots = []
    for u in units:
        ancestors = []
        cur = u
        while (link := structure.parent_link(db, t, cur.id)) is not None and len(ancestors) < structure.MAX_DEPTH:
            ancestors.append(link.parent_unit_id)
            cur = db.get(PhysicalUnit, link.parent_unit_id)
        if ancestors and not listed_set.intersection(ancestors):
            raise DomainError("COMPONENT_WITHOUT_PARENT", f"{u.asset_code} is fitted to a parent; remove it or transfer the parent")
        if not ancestors:
            roots.append(u)
    for u in roots:
        if u.custody_location_id != src.id:
            raise DomainError("UNIT_NOT_AT_SOURCE", f"{u.asset_code} is not at {src.code}")
        if u.state in TERMINAL_UNIT_STATES or u.state in ("PLANNED", "IN_TRANSIT", "INSTALLED"):
            raise DomainError("UNIT_NOT_TRANSFERABLE", f"{u.asset_code} is {u.state}")
    members = structure.manifest_members(db, t, [u.id for u in roots])
    busy = _units_on_open_transfers(db, t)
    for uid in members:
        if uid in busy:
            raise Conflict("UNIT_ON_ACTIVE_TRANSFER", f"{db.get(PhysicalUnit, uid).asset_code} is already on transfer {busy[uid]}")
    m = TransferManifest(
        tenant_id=t, created_by=p.email, code=code, from_location_id=src.id, to_location_id=dst.id,
        to_project_id=to_project.id if to_project else None, unit_ids=members, structure_hash=structure.structure_hash(db, t, members),
    )
    db.add(m)
    db.flush()
    audit.record(db, p, "transfer.create", "TransferManifest", m.id, after={"code": code, "unit_ids": members, "structure_hash": m.structure_hash})
    return transfer_row(db, m)


def _ensure_structure_unchanged(db: Session, p: Principal, m: TransferManifest) -> None:
    current = structure.structure_hash(db, m.tenant_id, m.unit_ids)
    if current != m.structure_hash:
        m.state = "INVALIDATED"
        m.version += 1
        audit.record(db, p, "transfer.invalidated", "TransferManifest", m.id, reason="Structure changed since the manifest was frozen")
        db.commit()
        raise Conflict("STRUCTURE_CHANGED", f"The structure of a unit on {m.code} changed after it was frozen; the manifest is invalidated")


def approve_transfer(db: Session, p: Principal, transfer_id: str, if_match: str | None) -> dict:
    from app.core.commands import check_if_match

    m = _get_transfer(db, p, transfer_id)
    check_if_match(m, if_match, required=True)
    lock(db, m)
    if m.state != "DRAFT":
        raise Conflict("INVALID_TRANSFER_STATE", f"Transfer is {m.state}")
    _ensure_structure_unchanged(db, p, m)
    m.state = "APPROVED"
    m.approved_by = p.email
    audit.record(db, p, "transfer.approve", "TransferManifest", m.id)
    return transfer_row(db, m)


def dispatch_transfer(db: Session, p: Principal, transfer_id: str) -> dict:
    m = _get_transfer(db, p, transfer_id)
    lock(db, m)
    if m.state != "APPROVED":
        raise Conflict("INVALID_TRANSFER_STATE", f"Only an approved transfer can be dispatched (state {m.state})")
    _ensure_structure_unchanged(db, p, m)
    transit = in_transit_location(db, m.tenant_id)
    member_set = set(m.unit_ids)
    for uid in m.unit_ids:
        u = db.get(PhysicalUnit, uid)
        if structure.parent_link(db, m.tenant_id, uid) is not None and structure.parent_link(db, m.tenant_id, uid).parent_unit_id in member_set:
            continue
        lock(db, u)
        _txn(db, p, m.tenant_id, f"TRF-{m.code}-{u.asset_code}-OUT", u, "SUBINVENTORY_TRANSFER", from_location_id=m.from_location_id,
             to_location_id=transit.id if transit else None, from_project_id=u.assigned_project_id, to_project_id=u.assigned_project_id)
        u.custody_location_id = transit.id if transit else None
        structure.propagate(db, u)
    m.state = "IN_TRANSIT"
    audit.record(db, p, "transfer.dispatch", "TransferManifest", m.id)
    return transfer_row(db, m)


def receive_transfer(db: Session, p: Principal, transfer_id: str, data: dict) -> dict:
    m = _get_transfer(db, p, transfer_id)
    lock(db, m)
    if m.state not in ("IN_TRANSIT", "PARTIALLY_RECEIVED"):
        raise Conflict("INVALID_TRANSFER_STATE", f"Transfer is {m.state}")
    requested = list(dict.fromkeys(data.get("unit_ids") or []))
    if not requested:
        raise DomainError("UNITS_REQUIRED", "unit_ids must not be empty")
    members = list(m.unit_ids)
    received = list(m.received_unit_ids or [])
    newly: list[str] = []
    for uid in requested:
        if uid not in members:
            raise DomainError("UNIT_NOT_ON_TRANSFER", f"Unit {uid} is not on transfer {m.code}")
        if uid in received:
            raise Conflict("UNIT_ALREADY_RECEIVED", f"{db.get(PhysicalUnit, uid).asset_code} was already received on {m.code}")
        for member in [uid, *structure.descendants(db, m.tenant_id, uid)]:
            if member in members and member not in received and member not in newly:
                newly.append(member)
    member_set = set(members)
    for uid in newly:
        u = db.get(PhysicalUnit, uid)
        link = structure.parent_link(db, m.tenant_id, uid)
        if link is not None and link.parent_unit_id in member_set:
            continue
        lock(db, u)
        _txn(db, p, m.tenant_id, f"TRF-{m.code}-{u.asset_code}-IN", u, "SUBINVENTORY_TRANSFER", from_location_id=u.custody_location_id,
             to_location_id=m.to_location_id, from_project_id=u.assigned_project_id, to_project_id=u.assigned_project_id)
        u.custody_location_id = m.to_location_id
        structure.propagate(db, u)
    m.received_unit_ids = received + newly
    m.state = "RECEIVED" if set(m.received_unit_ids) >= member_set else "PARTIALLY_RECEIVED"
    audit.record(db, p, "transfer.receive", "TransferManifest", m.id, after={"received_unit_ids": newly, "state": m.state})
    return transfer_row(db, m)


def list_transfers(db: Session, p: Principal, state: str | None = None) -> list[dict]:
    q = select(TransferManifest).where(TransferManifest.tenant_id == p.tenant_id)
    if state:
        q = q.where(TransferManifest.state == state)
    out = []
    for m in db.scalars(q.order_by(TransferManifest.created_at.desc())):
        try:
            _get_transfer(db, p, m.id)
        except NotFound:
            continue
        out.append(transfer_row(db, m))
    return out


def get_transfer(db: Session, p: Principal, transfer_id: str) -> dict:
    return transfer_row(db, _get_transfer(db, p, transfer_id))
