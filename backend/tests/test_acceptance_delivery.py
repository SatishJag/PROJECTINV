"""Acceptance tests T13-T25: arrival, structure, recovery, transfers, costs/TCO and handbooks."""

from datetime import date, datetime, timedelta
from decimal import Decimal

from sqlalchemy import select

from app.models import (
    AllocationRecord,
    CompatibleSpare,
    HandbookCriterion,
    HandbookEntry,
    HandbookPackage,
    HandbookTemplate,
    PhysicalUnit,
    PurchaseOrder,
    RecoveryCase,
    Shipment,
    UnitComponent,
)
from tests import support


def _admin(login):
    return login("admin@demo.pcx")


def _engine_of(db, parent: PhysicalUnit) -> PhysicalUnit:
    link = db.scalar(
        select(UnitComponent).where(
            UnitComponent.parent_unit_id == parent.id, UnitComponent.slot_code == "ENGINE", UnitComponent.valid_to.is_(None)
        )
    )
    assert link is not None
    return db.get(PhysicalUnit, link.child_unit_id)


# ------------------------------------------------------------------ T13-T14


def test_t13_arrival_probabilities_readiness_and_unknowns(client, login, scenario_ab):
    h = _admin(login)
    bkk1 = support.project(scenario_ab, "BKK1")

    early = client.get(
        f"/api/logistics/arrival?project_id={bkk1.id}&selected_date=2026-07-01&as_known_at=2026-08-01T00:00:00",
        headers=h,
    )
    late = client.get(
        f"/api/logistics/arrival?project_id={bkk1.id}&selected_date=2026-08-15&as_known_at=2026-08-01T00:00:00",
        headers=h,
    )
    assert early.status_code == 200 and late.status_code == 200
    early_gen2 = next(row for row in early.json() if row["asset_code"] == "GEN-002")
    late_gen2 = next(row for row in late.json() if row["asset_code"] == "GEN-002")
    assert early_gen2["p_on_date"] == "0"
    assert late_gen2["p_on_date"] == "1"
    assert early_gen2["p_by_date"] != late_gen2["p_by_date"]

    gen1 = next(row for row in late.json() if row["asset_code"] == "GEN-001")
    gen2 = next(row for row in late.json() if row["asset_code"] == "GEN-002")
    assert gen1["receiving_readiness"]["ready"] is False
    assert gen1["receiving_readiness"]["blockers"] != gen2["receiving_readiness"]["blockers"]

    all_units = client.get("/api/logistics/arrival?as_known_at=2026-08-01T00:00:00", headers=h).json()
    spare = next(row for row in all_units if row["asset_code"] == "ALT-SP-01")
    assert spare["quality"] == "UNKNOWN"
    assert spare["eta_p50"] is None
    assert spare["p_on_date"] is None
    assert spare["unknown_reason"]


def test_t14_late_event_is_not_visible_in_prior_view_and_failure_is_stale(client, login, scenario_ab):
    h = _admin(login)
    bkk1 = support.project(scenario_ab, "BKK1")

    before = client.get(
        f"/api/logistics/arrival?project_id={bkk1.id}&as_known_at=2026-07-20T00:00:00", headers=h
    ).json()
    after = client.get(
        f"/api/logistics/arrival?project_id={bkk1.id}&as_known_at=2026-07-23T00:00:00", headers=h
    ).json()
    before_gen2 = next(row for row in before if row["asset_code"] == "GEN-002")
    after_gen2 = next(row for row in after if row["asset_code"] == "GEN-002")
    assert before_gen2["eta_p50"] != after_gen2["eta_p50"]
    assert after_gen2["quality"] == "GOOD"

    shipment = scenario_ab.scalar(select(Shipment).where(Shipment.code == "SHIP-BKK-GEN-01"))
    failure = client.post(
        f"/api/logistics/shipments/{shipment.id}/tracking-failure",
        json={"message": "Carrier API timed out"},
        headers=h,
    )
    assert failure.status_code == 200, failure.text
    assert failure.json()["quality"] == "UNKNOWN"

    # The delivered shipment keeps its actual site-delivery evidence; add a new undelivered
    # shipment for the spare so staleness is observable.
    spare = support.unit(scenario_ab, "ALT-SP-01")
    gen_po = scenario_ab.scalar(select(PurchaseOrder).where(PurchaseOrder.canonical_number == "PO-BKK-GEN-0001"))
    created = client.post(
        "/api/logistics/shipments",
        json={"code": "SHIP-T14-SPARE", "po_id": gen_po.id, "mode": "SEA", "unit_ids": [spare.id]},
        headers=h,
    )
    assert created.status_code in (200, 201), created.text
    shipment_id = created.json()["id"]
    milestone = client.post(
        f"/api/logistics/shipments/{shipment_id}/milestones",
        json={
            "code": "DISPATCHED",
            "planned_at": "2026-11-20T08:00:00",
            "estimated_at": "2026-11-20T08:00:00",
            "recorded_at": "2026-10-31T08:00:00",
            "source": "CARRIER_FEED",
        },
        headers=h,
    )
    assert milestone.status_code == 200, milestone.text

    failed = client.post(
        f"/api/logistics/shipments/{shipment_id}/tracking-failure",
        json={"message": "Feed unavailable"},
        headers=h,
    )
    assert failed.status_code == 200
    stale = client.get("/api/logistics/arrival?as_known_at=2026-11-01T00:00:00", headers=h).json()
    spare_row = next(row for row in stale if row["asset_code"] == "ALT-SP-01")
    assert spare_row["quality"] == "STALE"
    assert spare_row["unknown_reason"]


# ------------------------------------------------------------------ T15-T16


def test_t15_structural_conflicts_are_rejected(client, login, scenario_ab):
    h = _admin(login)
    ch1 = support.unit(scenario_ab, "CH-001")
    ch2 = support.unit(scenario_ab, "CH-002")
    spare = support.unit(scenario_ab, "CMP-SP-01")

    occupied = client.post(
        f"/api/assets/units/{ch1.id}/components",
        json={"child_unit_id": spare.id, "slot_code": "COMPRESSOR_1"},
        headers=h,
    )
    assert occupied.status_code == 409
    assert occupied.json()["title"] == "SLOT_OCCUPIED"

    fitted = support.unit(scenario_ab, "CMP-102")
    already = client.post(
        f"/api/assets/units/{ch2.id}/components",
        json={"child_unit_id": fitted.id, "slot_code": "COMPRESSOR_1"},
        headers=h,
    )
    assert already.status_code == 409
    assert already.json()["title"] == "CHILD_ALREADY_FITTED"

    gen = support.unit(scenario_ab, "GEN-001")
    engine = _engine_of(scenario_ab, gen)
    scenario_ab.add(
        CompatibleSpare(
            tenant_id=scenario_ab.scalar(select(PhysicalUnit.tenant_id).where(PhysicalUnit.id == gen.id)),
            spare_model_id=gen.item_model_id,
            parent_model_id=engine.item_model_id,
            slot_code="TURBO",
            approved_by="test",
        )
    )
    scenario_ab.commit()
    cycle = client.post(
        f"/api/assets/units/{engine.id}/components",
        json={"child_unit_id": gen.id, "slot_code": "TURBO"},
        headers=h,
    )
    assert cycle.status_code == 422
    assert cycle.json()["title"] == "CYCLE"

    self_fit = client.post(
        f"/api/assets/units/{gen.id}/components",
        json={"child_unit_id": gen.id, "slot_code": "ENGINE"},
        headers=h,
    )
    assert self_fit.status_code == 422


def test_t16_prat_return_leaves_vacancy_and_replacement_identity(client, login, scenario_ab):
    h = _admin(login)
    ch1 = support.unit(scenario_ab, "CH-001")
    case = scenario_ab.scalar(select(RecoveryCase).where(RecoveryCase.ncr_number == "NCR-CH-001-001"))
    failed_id = case.failed_component_id

    removed = client.post(f"/api/quality/recovery-cases/{case.id}/remove-component", json={}, headers=h)
    assert removed.status_code == 200, removed.text

    structure = client.get(f"/api/assets/units/{ch1.id}/structure", headers=h).json()
    assert all(node["slot_code"] != "COMPRESSOR_1" for node in structure["components"])

    fitted = client.post(f"/api/quality/recovery-cases/{case.id}/fit-replacement", json={}, headers=h)
    assert fitted.status_code == 200, fitted.text
    replacement = support.unit(scenario_ab, "CMP-SP-01")
    assert replacement.id != failed_id
    assert replacement.replaces_unit_id == failed_id

    retest = client.post(
        "/api/quality/tests",
        json={
            "unit_id": ch1.id,
            "component_unit_id": replacement.id,
            "test_type": "RETEST",
            "test_ref": "RT-CH-001-01",
            "result": "PASS",
            "stage": "POST_RECEIPT",
            "performed_at": "2027-01-10T09:00:00",
        },
        headers=h,
    )
    assert retest.status_code in (200, 201), retest.text
    released = client.post(
        f"/api/quality/recovery-cases/{case.id}/release",
        json={"retest_id": retest.json()["id"]},
        headers=h,
    )
    assert released.status_code == 200, released.text

    # Repair route keeps the same UUID for the same serial.
    ch2 = support.unit(scenario_ab, "CH-002")
    component = support.unit(scenario_ab, "CMP-103")
    repair = client.post(
        "/api/quality/recovery-cases",
        json={
            "ncr_number": "NCR-T16-REPAIR",
            "parent_unit_id": ch2.id,
            "failed_component_id": component.id,
            "slot_code": "COMPRESSOR_1",
            "failure_stage": "POST_RECEIPT",
            "description": "Repair route proof",
        },
        headers=h,
    )
    assert repair.status_code in (200, 201), repair.text
    repair_case = repair.json()
    disposition = client.post(
        f"/api/quality/recovery-cases/{repair_case['id']}/disposition",
        json={"route": "REPAIR_AND_WAIT", "responsible_party": "Polar Cooling Co"},
        headers=h,
    )
    assert disposition.status_code == 200, disposition.text
    client.post(f"/api/quality/recovery-cases/{repair_case['id']}/remove-component", json={}, headers=h)
    refit = client.post(f"/api/quality/recovery-cases/{repair_case['id']}/fit-replacement", json={}, headers=h)
    assert refit.status_code == 200, refit.text
    same = scenario_ab.get(PhysicalUnit, component.id)
    scenario_ab.refresh(same)
    assert same.id == component.id


# ------------------------------------------------------------------ T17-T18


def test_t17_transfer_dedupes_descendants_partial_receipt_and_structure_change(client, login, scenario_ab):
    h = _admin(login)
    gen2 = support.unit(scenario_ab, "GEN-002")
    gen4 = support.unit(scenario_ab, "GEN-004")
    gen5 = support.unit(scenario_ab, "GEN-005")
    gen6 = support.unit(scenario_ab, "GEN-006")
    warehouse = support.location(scenario_ab, "BKK-CW")
    yard = support.location(scenario_ab, "BKK1-GY")
    engine2 = _engine_of(scenario_ab, gen2)

    manifest = client.post(
        "/api/inventory/transfers",
        json={
            "code": "TR-T17-DEDUP",
            "from_location_id": warehouse.id,
            "to_location_id": yard.id,
            "unit_ids": [gen2.id, engine2.id],
        },
        headers=h,
    )
    assert manifest.status_code in (200, 201), manifest.text
    member_ids = [unit["id"] for unit in manifest.json()["units"]]
    assert len(member_ids) == len(set(member_ids))
    assert len(member_ids) > 2

    partial = client.post(
        "/api/inventory/transfers",
        json={
            "code": "TR-T17-PARTIAL",
            "from_location_id": warehouse.id,
            "to_location_id": yard.id,
            "unit_ids": [gen4.id, gen5.id],
        },
        headers=h,
    ).json()
    assert client.post(f"/api/inventory/transfers/{partial['id']}/approve", json={}, headers=h).status_code == 200
    assert client.post(f"/api/inventory/transfers/{partial['id']}/dispatch", json={}, headers=h).status_code == 200
    received = client.post(
        f"/api/inventory/transfers/{partial['id']}/receive",
        json={"unit_ids": [gen4.id]},
        headers=h,
    )
    assert received.status_code == 200, received.text
    assert received.json()["state"] == "PARTIALLY_RECEIVED"
    in_transit = scenario_ab.get(PhysicalUnit, gen5.id)
    scenario_ab.refresh(in_transit)
    assert in_transit.state == "IN_TRANSIT"

    changed = client.post(
        "/api/inventory/transfers",
        json={
            "code": "TR-T17-CHANGED",
            "from_location_id": warehouse.id,
            "to_location_id": yard.id,
            "unit_ids": [gen6.id],
        },
        headers=h,
    ).json()
    assert client.post(f"/api/inventory/transfers/{changed['id']}/approve", json={}, headers=h).status_code == 200
    engine6 = _engine_of(scenario_ab, gen6)
    link = scenario_ab.scalar(
        select(UnitComponent).where(
            UnitComponent.parent_unit_id == gen6.id, UnitComponent.slot_code == "ENGINE", UnitComponent.valid_to.is_(None)
        )
    )
    removed = client.post(
        f"/api/assets/units/{gen6.id}/components/{link.id}/remove",
        json={"valid_to": "2026-10-31T12:00:00", "removal_reason": "T17 structure change"},
        headers=h,
    )
    assert removed.status_code == 200, removed.text
    dispatch = client.post(f"/api/inventory/transfers/{changed['id']}/dispatch", json={}, headers=h)
    assert dispatch.status_code == 409
    assert dispatch.json()["title"] == "STRUCTURE_CHANGED"
    assert engine6.id is not None


def test_t18_final_replacement_invoice_is_recognized_cost(client, login, scenario_ab):
    h = _admin(login)
    spare = support.unit(scenario_ab, "CMP-SP-01")
    summary = client.get(f"/api/costs/units/{spare.id}/summary", headers=h).json()
    assert summary["recognized_total"] == "1050"
    assert summary["provisional_total"] == "0"
    refs = {source["source_ref"]: source["status"] for source in summary["sources"]}
    assert refs["INV-POL-8801"] == "SUPERSEDED"
    assert refs["INV-POL-8850"] == "ACTUAL"

    events = client.get(f"/api/costs/events?economic_key=PURCHASE:CMP-SP-01", headers=h).json()
    assert [event["revision_no"] for event in events] == [2, 1]
    assert events[0]["supersedes_id"] == events[1]["id"]


# ------------------------------------------------------------------ T19-T21


def test_t19_allocation_rounding_and_rollup_leaves(client, login, scenario_ab):
    h = _admin(login)
    gen1 = support.unit(scenario_ab, "GEN-001")
    gen2 = support.unit(scenario_ab, "GEN-002")
    gen3 = support.unit(scenario_ab, "GEN-003")
    bkk1 = support.project(scenario_ab, "BKK1")

    event = client.post(
        "/api/costs/events",
        json={
            "economic_key": "T19:ROUNDING",
            "unit_id": gen1.id,
            "category": "SERVICE",
            "status": "ACTUAL",
            "amount": "100",
            "currency": "USD",
            "source_system": "MANUAL",
            "source_ref": "T19-1",
            "occurred_on": "2026-10-01",
        },
        headers=h,
    )
    assert event.status_code in (200, 201), event.text
    allocated = client.post(
        f"/api/costs/events/{event.json()['id']}/allocate",
        json={
            "basis": "T19_EQUAL",
            "targets": [
                {"unit_id": gen2.id, "weight": "1"},
                {"unit_id": gen3.id, "weight": "1"},
                {"attributed_project_id": bkk1.id, "weight": "1"},
            ],
        },
        headers=h,
    )
    assert allocated.status_code == 200, allocated.text
    amounts = [Decimal(part["amount"]) for part in allocated.json()["allocations"]]
    assert sum(amounts) == Decimal("100")
    assert len(set(amounts)) == 2

    rollup = client.get(f"/api/costs/rollup?parent_unit_id={gen1.id}", headers=h).json()
    leaf_ids = [leaf["unit_id"] for leaf in rollup["leaves"]]
    assert len(leaf_ids) == len(set(leaf_ids))
    assert gen1.id not in leaf_ids
    assert Decimal(rollup["recognized_total"]) == sum(Decimal(leaf["recognized_total"]) for leaf in rollup["leaves"])


def test_t20_fm_service_resolves_unit_and_project_at_service_date(client, login, scenario_ab):
    h = _admin(login)
    gen5 = support.unit(scenario_ab, "GEN-005")
    bkk1 = support.project(scenario_ab, "BKK1")
    bkk2 = support.project(scenario_ab, "BKK2")
    engine5 = _engine_of(scenario_ab, gen5)

    allocated = client.post(
        "/api/inventory/allocations",
        json={"kind": "PROJECT_TRANSFER", "to_project_id": bkk2.id, "unit_ids": [gen5.id], "reason": "T20 transfer"},
        headers=h,
    )
    assert allocated.status_code in (200, 201), allocated.text

    tomorrow = (date.today() + timedelta(days=1)).isoformat()
    imported = client.post(
        "/api/costs/fm-work-orders/import",
        json={
            "work_orders": [
                {
                    "work_order_ref": "WO-T20-0001",
                    "invoice_ref": "INV-T20-0001",
                    "parent_unit_id": gen5.id,
                    "slot_code": "ENGINE",
                    "service_from": tomorrow,
                    "service_to": tomorrow,
                    "description": "Engine service across a transfer",
                    "amount": "500.0000",
                    "currency": "USD",
                    "posting_project_id": bkk1.id,
                }
            ]
        },
        headers=h,
    )
    assert imported.status_code in (200, 201), imported.text
    assert imported.json()["resolved"] == 1

    work_order = imported.json()["imported"][0]
    assert work_order["resolved_unit_id"] == engine5.id
    summary = client.get(f"/api/costs/units/{engine5.id}/summary", headers=h).json()
    projects = {row["project_code"]: row["amount"] for row in summary["by_project"]}
    assert projects.get("BKK2") == "500"
    assert work_order["posting_project_id"] == bkk1.id


def test_t21_illustrative_tco_matches_reference_schedule(client, login, scenario_ab):
    h = _admin(login)
    scenarios = client.get("/api/costs/tco-scenarios", headers=h).json()
    illustrative = next(item for item in scenarios if item["is_illustrative"])
    assert illustrative["undiscounted_total"] == "2090"
    assert illustrative["present_value"] == "1953.9222"
    assert illustrative["timing"] == "END_OF_YEAR"
    assert illustrative["discount_rate"] == "0.08"


# ------------------------------------------------------------------ T22-T25


def _chiller_package(client, login, scenario_ab):
    ch2 = support.unit(scenario_ab, "CH-002")
    template = scenario_ab.scalar(select(HandbookTemplate).where(HandbookTemplate.template_code == "HB-CHL"))
    response = client.post(
        "/api/handbooks",
        json={"unit_id": ch2.id, "template_id": template.id},
        headers=_admin(login),
    )
    assert response.status_code in (200, 201), response.text
    return ch2, response.json()


def test_t22_wrong_model_document_fails_despite_attachment(client, login, scenario_ab):
    h = _admin(login)
    ch2, package = _chiller_package(client, login, scenario_ab)
    evidence = client.post(
        "/api/handbooks/evidence",
        json={
            "unit_id": ch2.id,
            "doc_type": "OM_MANUAL",
            "title": "Wrong model manual",
            "revision": "A",
            "model_ref": "CH-WRONG-999",
            "storage_ref": "S3://pcx-demo/wrong.pdf",
        },
        headers=h,
    )
    assert evidence.status_code in (200, 201), evidence.text
    approved = client.post(f"/api/handbooks/evidence/{evidence.json()['id']}/approve", headers=h)
    assert approved.status_code == 200, approved.text

    validated = client.post(f"/api/handbooks/{package['id']}/validate", headers=h)
    assert validated.status_code == 200, validated.text
    body = validated.json()
    entry = next(item for item in body["entries"] if item["criterion"]["criterion_code"] == "OM_MANUAL")
    assert entry["validation"] == "FAIL"
    assert "does not match" in entry["message"]
    assert body["state"] == "BLOCKED"


def _gen_package(scenario_ab):
    gen1 = support.unit(scenario_ab, "GEN-001")
    package = scenario_ab.scalar(
        select(HandbookPackage)
        .where(HandbookPackage.unit_id == gen1.id)
        .order_by(HandbookPackage.version_no.desc())
    )
    return gen1, package


def _waive(client, login, package_id: str, code: str, headers: dict):
    detail = client.get(f"/api/handbooks/{package_id}", headers=headers).json()
    entry = next(item for item in detail["entries"] if item["criterion"]["criterion_code"] == code)
    response = client.post(
        f"/api/handbooks/{package_id}/entries/{entry['id']}/waive",
        json={"reason": "Commissioning postponed to site energisation plan", "expires_at": "2027-12-31"},
        headers=headers,
    )
    assert response.status_code == 200, response.text
    waived = next(item for item in response.json()["entries"] if item["criterion"]["criterion_code"] == code)
    assert waived["validation"] == "WAIVED"
    assert waived["waiver_reason"]
    assert waived["waiver_expires_at"] == "2027-12-31"
    return response.json()


def test_t23_missing_critical_blocks_publication_and_waiver_is_recorded(client, login, scenario_ab):
    h = _admin(login)
    _gen1, package = _gen_package(scenario_ab)
    detail = client.get(f"/api/handbooks/{package.id}", headers=h).json()
    assert detail["state"] == "BLOCKED"
    blocker_codes = {item["criterion_code"] for item in detail["blockers"]}
    assert "COMMISSIONING" in blocker_codes

    blocked = client.post(
        f"/api/handbooks/{package.id}/approve",
        headers={**h, "If-Match": f'W/"{package.version}"'},
    )
    assert blocked.status_code == 409
    assert blocked.json()["title"] == "HANDBOOK_NOT_READY"

    engineering = login("engineering@demo.pcx")
    waived = _waive(client, login, package.id, "COMMISSIONING", engineering)
    assert waived["state"] == "READY"

    forbidden = login("fm@demo.pcx")
    detail = client.get(f"/api/handbooks/{package.id}", headers=forbidden).json()
    entry = next(item for item in detail["entries"] if item["criterion"]["criterion_code"] == "COMMISSIONING")
    denied = client.post(
        f"/api/handbooks/{package.id}/entries/{entry['id']}/waive",
        json={"reason": "FM attempt", "expires_at": "2027-01-31"},
        headers=forbidden,
    )
    assert denied.status_code == 403


def _publish_gen_handbook(client, login, scenario_ab):
    h = _admin(login)
    _gen1, package = _gen_package(scenario_ab)
    _waive(client, login, package.id, "COMMISSIONING", h)
    detail = client.get(f"/api/handbooks/{package.id}", headers=h).json()
    approved = client.post(
        f"/api/handbooks/{package.id}/approve",
        headers={**h, "If-Match": detail["etag"]},
    )
    assert approved.status_code == 200, approved.text
    detail = approved.json()
    published = client.post(
        f"/api/handbooks/{package.id}/publish",
        headers={**h, "If-Match": detail["etag"]},
    )
    assert published.status_code == 200, published.text
    return package.id, published.json()


def test_t24_published_hash_and_evidence_stay_immutable(client, login, scenario_ab):
    h = _admin(login)
    package_id, published = _publish_gen_handbook(client, login, scenario_ab)
    first_hash = published["package_hash"]
    assert published["state"] == "PUBLISHED"
    assert first_hash

    gen1 = support.unit(scenario_ab, "GEN-001")
    new_doc = client.post(
        "/api/handbooks/evidence",
        json={
            "unit_id": gen1.id,
            "doc_type": "DRAWING",
            "title": "Post-publication drawing",
            "revision": "B",
            "storage_ref": "S3://pcx-demo/drawing-B.pdf",
        },
        headers=h,
    )
    assert new_doc.status_code in (200, 201), new_doc.text
    client.post(f"/api/handbooks/evidence/{new_doc.json()['id']}/approve", headers=h)

    unchanged = client.get(f"/api/handbooks/{package_id}", headers=h).json()
    assert unchanged["state"] == "PUBLISHED"
    assert unchanged["package_hash"] == first_hash

    revalidate = client.post(f"/api/handbooks/{package_id}/validate", headers=h)
    assert revalidate.status_code == 409
    assert revalidate.json()["title"] == "IMMUTABLE"

    clone = client.post(f"/api/handbooks/{package_id}/new-version", headers=h)
    assert clone.status_code in (200, 201), clone.text
    assert clone.json()["version_no"] == unchanged["version_no"] + 1
    assert clone.json()["state"] == "DRAFT"
    original = client.get(f"/api/handbooks/{package_id}", headers=h).json()
    assert original["package_hash"] == first_hash


def test_t25_export_excludes_commercial_and_unrelated_data(client, login, scenario_ab):
    h = _admin(login)
    package_id, _published = _publish_gen_handbook(client, login, scenario_ab)
    fm = login("fm@demo.pcx")
    exported = client.get(f"/api/handbooks/{package_id}/export", headers=fm).json()

    codes = {entry["criterion_code"] for section in exported["sections"] for entry in section["entries"]}
    assert "PURCHASE_PRICE" not in codes
    assert "SERIAL" in codes
    assert exported["commercial_annex"] is None
    assert "purchase" not in str(exported).lower()
    assert "cost" not in str(exported).lower()
    assert exported["asset"]["asset_code"] == "GEN-001"

    supplier = login("supplier.meridian@demo.pcx")
    denied = client.get(f"/api/handbooks/{package_id}/export", headers=supplier)
    assert denied.status_code == 403
