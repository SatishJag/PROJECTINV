"""Scenario B: shipments, receipts with components, allocation, FAT/NCR recovery, handbooks,
costs/TCO, FM work orders and arrival snapshots for the BKK programme (deterministic)."""

from __future__ import annotations

from datetime import date, datetime

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.auth import Principal
from app.core.outbox import process_message
from app.models import (
    EquipmentOption,
    HandbookTemplate,
    Location,
    OutboxMessage,
    PhysicalUnit,
    Project,
    PurchaseOrder,
    Tenant,
    TestRecord,
)
from app.services import costs, delivery, handbook, planning


def _actor(tenant: Tenant) -> Principal:
    return Principal(user_id="seed-delivery", tenant_id=tenant.id, email="seed@pcx", name="Seed delivery", roles=frozenset({"ADMIN"}))


def _unit(db: Session, tenant_id: str, code: str) -> PhysicalUnit:
    row = db.scalar(select(PhysicalUnit).where(PhysicalUnit.tenant_id == tenant_id, PhysicalUnit.asset_code == code))
    if row is None:
        raise RuntimeError(f"unit {code} not found; run scenario_planning first")
    return row


def _location(db: Session, tenant_id: str, code: str) -> Location:
    return db.scalar(select(Location).where(Location.tenant_id == tenant_id, Location.code == code))


def _project(db: Session, tenant_id: str, code: str) -> Project:
    return db.scalar(select(Project).where(Project.tenant_id == tenant_id, Project.code == code))


def _gen_components(index: int) -> list[dict]:
    stamp = f"{index:03d}"
    return [
        {"slot_code": "ENGINE", "serial_number": f"MER-V16-{stamp}"},
        {"slot_code": "ALTERNATOR", "serial_number": f"MER-ALT-{stamp}"},
        {"slot_code": "CONTROLLER", "serial_number": f"MER-PC3-{stamp}"},
        {"slot_code": "RADIATOR", "serial_number": f"MER-R25-{stamp}"},
        {"slot_code": "STARTING_BATTERY", "serial_number": f"ATLAS-SB24-{stamp}"},
        {"slot_code": "OUTPUT_BREAKER", "serial_number": f"ATLAS-ACB-{stamp}"},
        {"slot_code": "TURBO", "serial_number": f"MER-TB16-{stamp}"},
        {"slot_code": "FUEL_PUMP", "serial_number": f"MER-FIP16-{stamp}"},
    ]


def _chiller_components(index: int) -> list[dict]:
    stamp = f"{index:03d}"
    return [
        {"slot_code": "COMPRESSOR_1", "serial_number": f"POL-SC750-{stamp}-1", "asset_code": f"CMP-{100 + index * 2 - 1:03d}"},
        {"slot_code": "COMPRESSOR_2", "serial_number": f"POL-SC750-{stamp}-2", "asset_code": f"CMP-{100 + index * 2:03d}"},
        {"slot_code": "DRIVE_1", "serial_number": f"POL-VD750-{stamp}-1", "asset_code": f"DRV-{100 + index * 2 - 1:03d}"},
        {"slot_code": "DRIVE_2", "serial_number": f"POL-VD750-{stamp}-2", "asset_code": f"DRV-{100 + index * 2:03d}"},
        {"slot_code": "EVAPORATOR", "serial_number": f"POL-EV-{stamp}", "asset_code": f"EVP-{100 + index:03d}"},
        {"slot_code": "CONDENSER", "serial_number": f"POL-CD-{stamp}", "asset_code": f"CND-{100 + index:03d}"},
        {"slot_code": "CONTROL_PANEL", "serial_number": f"POL-UC-{stamp}", "asset_code": f"CTL-{100 + index:03d}"},
        {"slot_code": "EXPANSION_VALVE", "serial_number": f"POL-EXV-{stamp}", "asset_code": f"EXV-{100 + index:03d}"},
    ]


def _milestones(db: Session, p: Principal, shipment_id: str, start: datetime) -> None:
    from datetime import timedelta

    steps = [
        ("DISPATCHED", 0, True),
        ("DEPARTED_PORT", 2, True),
        ("ARRIVED_PORT", 32, True),
        ("CUSTOMS_CLEARED", 34, False),
        ("SITE_DELIVERED", 40, True),
    ]
    for code, offset, actual in steps:
        at = start + timedelta(days=offset)
        delivery.add_milestone(
            db,
            p,
            shipment_id,
            {
                "code": code,
                "planned_at": at.isoformat(),
                "estimated_at": at.isoformat(),
                "actual_at": at.isoformat() if actual and code != "ARRIVED_PORT" else None,
                "recorded_at": at.isoformat(),
                "source": "CARRIER_FEED",
                "source_event_id": f"{shipment_id}-{code}",
            },
        )
    if start.date() <= date(2026, 8, 1):
        # The port arrival is evidenced with a one-day slip; site delivery was recorded as actual.
        arrival = start + timedelta(days=31)
        delivery.add_milestone(
            db,
            p,
            shipment_id,
            {
                "code": "ARRIVED_PORT",
                "planned_at": (start + timedelta(days=32)).isoformat(),
                "estimated_at": (start + timedelta(days=33)).isoformat(),
                "actual_at": arrival.isoformat(),
                "recorded_at": arrival.isoformat(),
                "source": "CARRIER_FEED",
                "source_event_id": f"{shipment_id}-ARRIVED_PORT-actual",
            },
        )


def run(db: Session, tenant: Tenant) -> None:
    p = _actor(tenant)
    t = tenant.id
    bkk1 = _project(db, t, "BKK1")
    bkk2 = _project(db, t, "BKK2")
    warehouse = _location(db, t, "BKK-CW")
    bkk1_yard = _location(db, t, "BKK1-GY")
    gen_po = db.scalar(select(PurchaseOrder).where(PurchaseOrder.tenant_id == t, PurchaseOrder.canonical_number == "PO-BKK-GEN-0001"))
    chl_po = db.scalar(select(PurchaseOrder).where(PurchaseOrder.tenant_id == t, PurchaseOrder.canonical_number == "PO-BKK-CHL-0001"))
    if gen_po is None or chl_po is None:
        return

    gens = [_unit(db, t, f"GEN-{n:03d}") for n in range(1, 11)]
    chillers = [_unit(db, t, f"CH-{n:03d}") for n in range(1, 5)]

    # shipments -------------------------------------------------------------
    gen_shipment = delivery.create_shipment(
        db,
        p,
        {
            "code": "SHIP-BKK-GEN-01",
            "po_id": gen_po.id,
            "carrier": "Meridian Logistics",
            "mode": "SEA",
            "container_ref": "MRKU-441200-7",
            "bol_awb": "BOL-PBKK-11881",
            "origin": "Meridian factory, Peterborough",
            "destination_location_id": warehouse.id,
            "unit_ids": [u.id for u in gens],
        },
    )
    _milestones(db, p, gen_shipment["id"], datetime(2026, 6, 20, 8, 0))

    chl_shipment = delivery.create_shipment(
        db,
        p,
        {
            "code": "SHIP-BKK-CHL-01",
            "po_id": chl_po.id,
            "carrier": "Polar Freight",
            "mode": "SEA",
            "container_ref": "POCU-778311-2",
            "bol_awb": "BOL-BREM-55201",
            "origin": "Polar Cooling factory, Bremen",
            "destination_location_id": warehouse.id,
            "unit_ids": [u.id for u in chillers],
        },
    )
    _milestones(db, p, chl_shipment["id"], datetime(2026, 6, 28, 8, 0))

    # receipts --------------------------------------------------------------
    if not db.scalar(select(OutboxMessage.id).where(OutboxMessage.tenant_id == t, OutboxMessage.event_type == "receipt.create")):
        delivery.create_receipt(
            db,
            p,
            {
                "receipt_ref": "RCPT-BKK-GEN-01",
                "po_id": gen_po.id,
                "location_id": warehouse.id,
                "received_at": "2026-08-01T10:00:00",
                "lines": [
                    {
                        "unit_id": unit.id,
                        "serial_number": f"MER-2500S-{n:04d}",
                        "condition": "GOOD",
                        "components": _gen_components(n),
                    }
                    for n, unit in enumerate(gens, start=1)
                ],
            },
        )
        delivery.create_receipt(
            db,
            p,
            {
                "receipt_ref": "RCPT-BKK-CHL-01",
                "po_id": chl_po.id,
                "location_id": warehouse.id,
                "received_at": "2026-08-04T10:00:00",
                "lines": [
                    {
                        "unit_id": unit.id,
                        "serial_number": f"POL-AC1500-{n:04d}",
                        "condition": "GOOD",
                        "components": _chiller_components(n),
                    }
                    for n, unit in enumerate(chillers, start=1)
                ],
            },
        )

    # loose spares ----------------------------------------------------------
    spare_alt = db.scalar(select(PhysicalUnit).where(PhysicalUnit.tenant_id == t, PhysicalUnit.asset_code == "ALT-SP-01"))
    if spare_alt is None:
        delivery.register_unit(
            db,
            p,
            {
                "item_code": "ALT-MER-2500",
                "asset_code": "ALT-SP-01",
                "serial_number": "MER-ALT-SP-001",
                "programme_id": gens[0].programme_id,
                "custody_location_id": warehouse.id,
                "is_spare": True,
            },
        )
    spare_cmp = db.scalar(select(PhysicalUnit).where(PhysicalUnit.tenant_id == t, PhysicalUnit.asset_code == "CMP-SP-01"))
    if spare_cmp is None:
        delivery.register_unit(
            db,
            p,
            {
                "item_code": "CMP-POL-SC750",
                "asset_code": "CMP-SP-01",
                "serial_number": "POL-SC750-SP-001",
                "programme_id": gens[0].programme_id,
                "custody_location_id": warehouse.id,
                "is_spare": True,
            },
        )
        spare_cmp = db.scalar(select(PhysicalUnit).where(PhysicalUnit.tenant_id == t, PhysicalUnit.asset_code == "CMP-SP-01"))

    if not db.scalar(select(OutboxMessage.id).where(OutboxMessage.tenant_id == t, OutboxMessage.event_type == "reservation.create")):
        delivery.create_allocations(
            db,
            p,
            {
                "kind": "PLANNING_INTENT",
                "to_project_id": bkk1.id,
                "unit_ids": [u.id for u in gens[:6]],
                "reason": "BKK1 generator yard scope (rev 1)",
            },
        )
        delivery.create_allocations(
            db,
            p,
            {
                "kind": "ORACLE_RESERVATION",
                "to_project_id": bkk2.id,
                "unit_ids": [u.id for u in gens[6:9]],
                "reason": "BKK2 reservation requested by project controls",
            },
        )

    # quality: a passing factory test, then a chiller compressor failure -----
    gen1 = gens[0]
    if not db.scalar(select(TestRecord.id).where(TestRecord.tenant_id == t, TestRecord.test_ref == "FAT-GEN-001")):
        delivery.record_test(
            db,
            p,
            {
                "unit_id": gen1.id,
                "test_type": "FAT",
                "test_ref": "FAT-GEN-001",
                "result": "PASS",
                "stage": "SUPPLIER_FACTORY",
                "performed_at": "2026-06-10T09:00:00",
                "measurement": "2500 kVA at 11 kV, 46 C ambient; load bank test passed",
                "evidence_ref": "DOC-FAT-GEN-001",
            },
        )
    ch1 = chillers[0]
    comp1 = db.scalar(select(PhysicalUnit).where(PhysicalUnit.tenant_id == t, PhysicalUnit.asset_code == "CMP-101"))
    if comp1 is not None and not db.scalar(select(TestRecord.id).where(TestRecord.tenant_id == t, TestRecord.test_ref == "FAT-CH-001-CMP-101")):
        failed = delivery.record_test(
            db,
            p,
            {
                "unit_id": ch1.id,
                "component_unit_id": comp1.id,
                "test_type": "FAT",
                "test_ref": "FAT-CH-001-CMP-101",
                "result": "FAIL",
                "stage": "POST_RECEIPT",
                "performed_at": "2026-08-06T14:00:00",
                "measurement": "Compressor 1 vibration 12.4 mm/s RMS at full load; limit 7.1 mm/s",
                "evidence_ref": "DOC-FAT-CH-001",
            },
        )
        case = delivery.create_recovery_case(
            db,
            p,
            {
                "ncr_number": "NCR-CH-001-001",
                "parent_unit_id": ch1.id,
                "failed_component_id": comp1.id,
                "slot_code": "COMPRESSOR_1",
                "failed_test_id": failed["id"],
                "failure_stage": "POST_RECEIPT",
                "description": "Compressor 1 vibration exceeds the FAT acceptance limit at full load; replace from stock and retest.",
            },
        )
        spare = db.scalar(select(PhysicalUnit).where(PhysicalUnit.tenant_id == t, PhysicalUnit.asset_code == "CMP-SP-01"))
        delivery.disposition_case(
            db,
            p,
            case["id"],
            {
                "route": "REPLACE_FROM_SPARE",
                "replacement_unit_id": spare.id,
                "responsible_party": "Polar Cooling Co",
                "expected_completion": "2026-10-15",
                "replacement_eta": "2026-10-01",
            },
        )

    # issue GEN-001 and build its handbook ---------------------------------
    delivery.issue_unit(db, p, {"unit_id": gen1.id, "to_location_id": bkk1_yard.id, "installed_position": "Generator yard / Bay 1"})
    gen1.warranty_start = date(2026, 8, 1)
    gen1.warranty_end = date(2028, 8, 1)
    gen1.in_service_date = date(2026, 9, 15)
    db.flush()

    template = db.scalar(select(HandbookTemplate).where(HandbookTemplate.tenant_id == t, HandbookTemplate.template_code == "HB-GEN"))
    from app.models import HandbookPackage

    existing_pkg = db.scalar(select(HandbookPackage).where(HandbookPackage.tenant_id == t, HandbookPackage.unit_id == gen1.id))
    if existing_pkg is None and template is not None:
        pkg = handbook.create_package(db, p, {"unit_id": gen1.id, "template_id": template.id})
        model = gen1.item_model
        for body in (
            {
                "unit_id": gen1.id,
                "doc_type": "OM_MANUAL",
                "title": "Meridian MG-2500S O&M manual",
                "revision": "C",
                "model_ref": model.item_code,
                "storage_ref": "S3://pcx-demo/manuals/MG-2500S-OM-C.pdf",
            },
            {
                "unit_id": gen1.id,
                "doc_type": "FAT_REPORT",
                "title": f"Factory acceptance test report {gen1.serial_number}",
                "revision": "A",
                "serial_ref": gen1.serial_number,
                "storage_ref": "S3://pcx-demo/fat/FAT-GEN-001.pdf",
            },
            {
                "unit_id": gen1.id,
                "doc_type": "WARRANTY",
                "title": "Meridian two-year warranty certificate",
                "revision": "A",
                "serial_ref": gen1.serial_number,
                "expires_at": "2028-08-01",
                "storage_ref": "S3://pcx-demo/warranty/WC-GEN-001.pdf",
            },
        ):
            doc = handbook.create_evidence(db, p, body)
            handbook.approve_evidence(db, p, doc["id"])
        handbook.validate_package(db, p, pkg["id"])

    # cost evidence: provisional 1000 superseded by the final 1050 invoice --
    costs.create_event(
        db,
        p,
        {
            "economic_key": f"PURCHASE:{spare_cmp.asset_code}",
            "unit_id": spare_cmp.id,
            "category": "PURCHASE",
            "status": "PROVISIONAL",
            "amount": "1000.0000",
            "currency": "USD",
            "source_system": "ORACLE",
            "source_ref": "INV-POL-8801",
            "occurred_on": "2026-09-05",
        },
    )
    costs.create_event(
        db,
        p,
        {
            "economic_key": f"PURCHASE:{spare_cmp.asset_code}",
            "unit_id": spare_cmp.id,
            "category": "PURCHASE",
            "status": "ACTUAL",
            "amount": "1050.0000",
            "currency": "USD",
            "source_system": "ORACLE",
            "source_ref": "INV-POL-8850",
            "occurred_on": "2026-09-20",
        },
    )

    # illustrative TCO (spec §22, T21) --------------------------------------
    option = db.scalar(select(EquipmentOption).where(EquipmentOption.tenant_id == t, EquipmentOption.option_code == "OPT-GEN-A"))
    costs.create_tco(
        db,
        p,
        {
            "name": "Illustrative 5-year genset lifecycle (thousand AED)",
            "subject_type": "OPTION",
            "subject_id": option.id if option else None,
            "currency": "AED",
            "horizon_years": 5,
            "discount_rate": "0.08",
            "timing": "END_OF_YEAR",
            "is_illustrative": True,
            "lines": [
                {"year": 0, "category": "PURCHASE", "amount": "1000", "kind": "ASSUMPTION"},
                {"year": 0, "category": "ANCILLARY", "amount": "120", "kind": "ASSUMPTION"},
                {"year": 0, "category": "INSTALLATION", "amount": "150", "kind": "ASSUMPTION"},
                {"year": 0, "category": "CONSULTANT", "amount": "40", "kind": "ASSUMPTION"},
                {"year": 0, "category": "COMMISSIONING", "amount": "40", "kind": "ASSUMPTION"},
                {"year": 1, "category": "SERVICE", "amount": "120", "kind": "ASSUMPTION"},
                {"year": 2, "category": "SERVICE", "amount": "135", "kind": "ASSUMPTION"},
                {"year": 3, "category": "SERVICE", "amount": "150", "kind": "ASSUMPTION"},
                {"year": 3, "category": "REPLACEMENT", "amount": "200", "kind": "ASSUMPTION"},
                {"year": 4, "category": "SERVICE", "amount": "160", "kind": "ASSUMPTION"},
                {"year": 4, "category": "DISPOSAL", "amount": "25", "kind": "ASSUMPTION"},
                {"year": 4, "category": "RECOVERY", "amount": "-50", "kind": "ASSUMPTION"},
            ],
        },
    )

    # FM service: one resolved at the service date, one unresolved ----------
    costs.import_fm_work_orders(
        db,
        p,
        {
            "work_orders": [
                {
                    "work_order_ref": "WO-BKK1-1001",
                    "invoice_ref": "PLN-INV-4001",
                    "parent_unit_id": gen1.id,
                    "slot_code": None,
                    "service_from": "2026-10-05",
                    "service_to": "2026-10-06",
                    "description": "250-hour generator service and load check",
                    "amount": "4200.0000",
                    "currency": "USD",
                    "posting_project_id": bkk1.id,
                },
                {
                    "work_order_ref": "WO-BKK2-2002",
                    "invoice_ref": "PLN-INV-4002",
                    "planon_asset_id": "PLN-UNKNOWN-9",
                    "service_from": "2026-10-10",
                    "service_to": "2026-10-11",
                    "description": "Chiller condenser clean (asset not yet handed over)",
                    "amount": "1800.0000",
                    "currency": "USD",
                    "posting_project_id": bkk2.id,
                },
            ]
        },
    )

    delivery.create_arrival_snapshots(db, p, {"project_id": bkk1.id})

    # Apply Oracle acknowledgements and close domain events; Procore messages wait for scenario C.
    pending = select(OutboxMessage).where(
        OutboxMessage.tenant_id == t,
        OutboxMessage.target.in_(("ORACLE", "INTERNAL")),
        OutboxMessage.state == "PENDING",
    )
    for msg in list(db.scalars(pending)):
        process_message(db, msg)
    db.commit()
