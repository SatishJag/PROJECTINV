"""Acceptance tests T01-T12: planning, benchmark, sourcing, award and permanent identity."""

from decimal import Decimal

from sqlalchemy import select

from app.models import (
    AwardDecision,
    AwardLine,
    Evaluation,
    OfferLine,
    PoLine,
    PurchaseOrder,
    RequirementRevision,
    SupplierOffer,
)
from tests import support


def _admin(login):
    return login("admin@demo.pcx")


# ------------------------------------------------------------------ T01-T02


def test_t01_requirement_has_stable_uuid_and_source_revision_dedupes(client, login, scenario_a):
    h = _admin(login)
    project = support.project(scenario_a, "BKK1")
    cls = support.equipment_class(scenario_a, "GEN")
    body = {
        "title": "Duplicate source line proof",
        "project_id": project.id,
        "equipment_class_id": cls.id,
        "source_boq_key": "BOQ-T01",
        "source_line_key": "L-001",
        "revision": {"quantity": "1", "uom": "EA", "currency": "USD"},
    }
    first = client.post("/api/planning/requirements", json=body, headers=h)
    assert first.status_code in (200, 201), first.text
    requirement_id = first.json()["requirement"]["id"]
    assert requirement_id

    second = client.post("/api/planning/requirements", json={**body, "title": "Changed title, same source"}, headers=h)
    assert second.status_code == 200, second.text
    assert second.json()["requirement"]["id"] == requirement_id
    assert len(second.json()["requirement"]["revisions"]) == 1


def test_t02_approved_baseline_survives_draft_revision(client, login, scenario_a):
    h = _admin(login)
    requirement = support.requirement(scenario_a, "REQ-BKK1-GEN")
    detail = client.get(f"/api/planning/requirements/{requirement.id}", headers=h).json()

    approved = detail["current_revision"]
    latest = detail["latest_revision"]
    assert approved["state"] == "APPROVED"
    assert approved["quantity"] == "6"
    assert latest["state"] == "DRAFT"
    assert latest["quantity"] == "7"
    assert latest["revision_no"] == approved["revision_no"] + 1


# ------------------------------------------------------------------ T03-T04


def test_t03_benchmark_exposes_sample_scope_and_exclusions(client, login, scenario_a):
    h = _admin(login)
    revision = scenario_a.scalar(
        select(RequirementRevision).where(
            RequirementRevision.requirement_id == support.requirement(scenario_a, "REQ-BKK1-GEN").id,
            RequirementRevision.state == "APPROVED",
        )
    )
    response = client.post("/api/planning/benchmark-runs", json={"requirement_revision_id": revision.id}, headers=h)
    assert response.status_code in (200, 201), response.text
    body = response.json()
    assert body["run"]["state"] in ("PUBLISHED", "INSUFFICIENT_EVIDENCE")
    assert body["quality"]["sample_count"] >= 0
    assert "purchase_cost" in body["quality"]["coverage"]
    assert body["quality"]["basis"] == "per_unit"
    matched = [r for r in body["results"] if r["metric_code"] == "PURCHASE_COST"][0]
    assert matched["basis"]


def test_t04_sparse_class_is_insufficient_evidence(client, login, scenario_a):
    h = _admin(login)
    chiller = support.requirement(scenario_a, "REQ-BKK1-CHL")
    revision = scenario_a.scalar(
        select(RequirementRevision).where(RequirementRevision.requirement_id == chiller.id, RequirementRevision.state == "APPROVED")
    )
    response = client.post("/api/planning/benchmark-runs", json={"requirement_revision_id": revision.id}, headers=h)
    assert response.status_code in (200, 201), response.text
    body = response.json()
    assert body["run"]["state"] == "INSUFFICIENT_EVIDENCE"
    assert body["quality"]["sample_count"] < 3


# ------------------------------------------------------------------ T05-T06


def test_t05_second_reservation_is_rejected(client, login, scenario_ab):
    h = _admin(login)
    unit = support.unit(scenario_ab, "GEN-010")
    bkk1 = support.project(scenario_ab, "BKK1")
    bkk2 = support.project(scenario_ab, "BKK2")

    first = client.post("/api/planning/reservations", json={"unit_id": unit.id, "project_id": bkk1.id}, headers=h)
    assert first.status_code in (200, 201), first.text
    second = client.post("/api/planning/reservations", json={"unit_id": unit.id, "project_id": bkk2.id}, headers=h)
    assert second.status_code == 409
    assert second.json()["title"] == "UNIT_ALREADY_RESERVED"


def test_t06_reuse_excludes_sunk_purchase_cost(client, login, scenario_a):
    h = _admin(login)
    revision = scenario_a.scalar(
        select(RequirementRevision).where(
            RequirementRevision.requirement_id == support.requirement(scenario_a, "REQ-BKK2-GEN").id,
            RequirementRevision.state == "APPROVED",
        )
    )
    unit = support.unit(scenario_a, "GEN-001")
    response = client.post(
        "/api/planning/reuse-assessments",
        json={
            "requirement_revision_id": revision.id,
            "unit_id": unit.id,
            "currency": "USD",
            "transfer_cost": "100",
            "refurbishment_cost": "200",
            "retest_cost": "50",
            "forward_new_cost": "402000",
        },
        headers=h,
    )
    assert response.status_code in (200, 201), response.text
    assessment = response.json()
    assert assessment["forward_reuse_cost"] == "350"
    assert assessment["sunk_cost_excluded"] == "402000"


# ------------------------------------------------------------------ T07-T10


def _revised_offer_lines(detail: dict, offer_detail: dict, price: str) -> list[dict]:
    key_by_package_line = {line["id"]: line["line_key"] for line in detail["lines"]}
    return [
        {
            "line_key": key_by_package_line[line["package_line_id"]],
            "option_code": line["option_code"],
            "quantity": line["quantity"],
            "unit_price": price if key_by_package_line[line["package_line_id"]] == "GEN-BKK1" else line["unit_price"],
            "lead_time_days": line["lead_time_days"],
            "scope_json": line["scope_json"],
            "annual_om_estimate": line["annual_om_estimate"],
            "warranty_months": line["warranty_months"],
        }
        for line in offer_detail["lines"]
    ]


def test_t07_offer_revision_preserves_prior_and_unpriced_scope_stays_null(client, login, scenario_a):
    h = _admin(login)
    package = support.sourcing_package(scenario_a, "PKG-BKK-GEN")
    detail = client.get(f"/api/sourcing/packages/{package.id}", headers=h).json()
    meridian = next(o for o in detail["offers"] if o["supplier_key"] == "MERIDIAN")
    meridian_full = client.get(f"/api/sourcing/offers/{meridian['id']}", headers=h).json()

    revised_lines = _revised_offer_lines(detail, meridian_full, "410000")
    response = client.post(
        f"/api/sourcing/packages/{package.id}/offers",
        json={
            "supplier_id": meridian_full["supplier_id"],
            "source_offer_key": meridian_full["source_offer_key"],
            "currency": "USD",
            "valid_until": "2027-01-31",
            "incoterms": "DAP Bangkok",
            "lines": revised_lines,
        },
        headers=h,
    )
    assert response.status_code in (200, 201), response.text
    revised = response.json()
    assert revised["revision_no"] == meridian_full["revision_no"] + 1

    prior = scenario_a.get(SupplierOffer, meridian["id"])
    scenario_a.refresh(prior)
    assert prior.state == "SUPERSEDED"

    evaluation = scenario_a.scalar(select(Evaluation).order_by(Evaluation.revision_no))
    evaluation_detail = client.get(f"/api/sourcing/evaluations/{evaluation.id}", headers=h).json()
    northwind_line = next(
        line for line in evaluation_detail["results"]["lines"] if line.get("supplier_key") == "NORTHWIND"
    )
    assert northwind_line["normalized_installed_cost"] is None
    assert any("FREIGHT" in unknown for unknown in northwind_line["unknowns"])


def test_t08_mandatory_deviation_blocks_award_despite_price(client, login, scenario_a):
    h = _admin(login)
    evaluation = scenario_a.scalar(select(Evaluation).order_by(Evaluation.revision_no))
    northwind_offer = scenario_a.scalar(select(SupplierOffer).where(SupplierOffer.supplier_id == support.supplier(scenario_a, "NORTHWIND").id))
    northwind_line = scenario_a.scalar(select(OfferLine).where(OfferLine.offer_id == northwind_offer.id))
    package_line_id = northwind_line.package_line_id

    response = client.post(
        f"/api/sourcing/evaluations/{evaluation.id}/awards",
        json={
            "rationale": "Cheapest offer should still be blocked by the open mandatory deviation",
            "input_fingerprint": evaluation.input_fingerprint,
            "lines": [
                {
                    "package_line_id": package_line_id,
                    "offer_line_id": northwind_line.id,
                    "selected_quantity": "1",
                }
            ],
        },
        headers=h,
    )
    assert response.status_code == 422
    assert response.json()["title"] == "OFFER_INELIGIBLE"


def test_t09_changed_offer_marks_evaluation_stale_and_blocks_approval(client, login, scenario_a):
    h = _admin(login)
    package = support.sourcing_package(scenario_a, "PKG-BKK-GEN")
    detail = client.get(f"/api/sourcing/packages/{package.id}", headers=h).json()
    meridian = next(o for o in detail["offers"] if o["supplier_key"] == "MERIDIAN")
    full = client.get(f"/api/sourcing/offers/{meridian['id']}", headers=h).json()
    lines = _revised_offer_lines(detail, full, "401000")
    changed = client.post(
        f"/api/sourcing/packages/{package.id}/offers",
        json={
            "supplier_id": full["supplier_id"],
            "source_offer_key": full["source_offer_key"],
            "currency": "USD",
            "valid_until": "2027-01-31",
            "incoterms": "DAP Bangkok",
            "lines": lines,
        },
        headers=h,
    )
    assert changed.status_code in (200, 201), changed.text

    evaluation = scenario_a.scalar(select(Evaluation).order_by(Evaluation.revision_no))
    live = client.get(f"/api/sourcing/evaluations/{evaluation.id}", headers=h).json()
    assert live["is_stale"] is True
    assert live["stale_reason"]

    scenario_a.refresh(evaluation)
    approval = client.post(
        f"/api/sourcing/evaluations/{evaluation.id}/approve",
        headers={**h, "If-Match": f'W/"{evaluation.version}"'},
    )
    assert approval.status_code == 409
    assert approval.json()["title"] == "EVALUATION_STALE"


def test_t10_award_quantities_are_conserved(client, login, scenario_a):
    h = _admin(login)
    award = scenario_a.scalar(select(AwardDecision).where(AwardDecision.state == "APPROVED"))
    lines = list(scenario_a.scalars(select(AwardLine).where(AwardLine.award_id == award.id)))
    assert sum(line.selected_quantity for line in lines) == Decimal("10")

    evaluation = scenario_a.get(Evaluation, award.evaluation_id)
    package_line_id = lines[0].package_line_id
    meridian_line = lines[0]
    response = client.post(
        f"/api/sourcing/evaluations/{evaluation.id}/awards",
        json={
            "rationale": "Attempt to over-award the BKK1 line",
            "input_fingerprint": evaluation.input_fingerprint,
            "lines": [
                {
                    "package_line_id": package_line_id,
                    "offer_line_id": meridian_line.offer_line_id,
                    "selected_quantity": "7",
                }
            ],
        },
        headers=h,
    )
    assert response.status_code == 409
    assert response.json()["title"] == "OVER_AWARD"


# ------------------------------------------------------------------ T11-T12


def test_t11_po_alias_dedupe_keeps_one_canonical_po_and_unit_set(client, login, scenario_a):
    h = _admin(login)
    po = scenario_a.scalar(select(PurchaseOrder).where(PurchaseOrder.canonical_number == "PO-BKK-GEN-0001"))
    before = client.get(f"/api/procurement/purchase-orders/{po.id}", headers=h).json()
    before_units = {u["asset_code"] for u in before["units"]}

    meridian = support.supplier(scenario_a, "MERIDIAN")
    response = client.post(
        "/api/procurement/purchase-orders/import",
        json={
            "source_system": "ORACLE",
            "source_number": "ORA-PO-880120",
            "supplier_id": meridian.id,
            "programme_id": po.programme_id,
            "currency": "USD",
            "lines": [],
        },
        headers=h,
    )
    assert response.status_code == 200, response.text
    after = response.json()
    assert after["po"]["id"] == po.id
    assert after["po"]["canonical_number"] == "PO-BKK-GEN-0001"
    assert {u["asset_code"] for u in after["units"]} == before_units
    assert len(before_units) == 10


def test_t12_replay_cannot_receive_or_ship_twice_and_codes_are_never_reused(client, login, scenario_ab):
    h = _admin(login)
    po = scenario_ab.scalar(select(PurchaseOrder).where(PurchaseOrder.canonical_number == "PO-BKK-GEN-0001"))
    warehouse = support.location(scenario_ab, "BKK-CW")
    unit = support.unit(scenario_ab, "GEN-002")

    duplicate = client.post(
        "/api/inventory/receipts",
        json={
            "receipt_ref": "RCPT-T12-REPLAY",
            "po_id": po.id,
            "location_id": warehouse.id,
            "received_at": "2026-08-02T10:00:00",
            "lines": [{"unit_id": unit.id, "serial_number": "MER-2500S-0002", "condition": "GOOD"}],
        },
        headers=h,
    )
    assert duplicate.status_code == 409
    assert duplicate.json()["title"] == "UNIT_ALREADY_RECEIVED"

    spare = support.unit(scenario_ab, "ALT-SP-01")
    shipment = client.post(
        "/api/logistics/shipments",
        json={"code": "SHIP-T12-A", "po_id": po.id, "mode": "SEA", "unit_ids": [spare.id]},
        headers=h,
    )
    assert shipment.status_code in (200, 201), shipment.text
    second = client.post(
        "/api/logistics/shipments",
        json={"code": "SHIP-T12-B", "po_id": po.id, "mode": "SEA", "unit_ids": [spare.id]},
        headers=h,
    )
    assert second.status_code == 409
    assert second.json()["title"] == "UNIT_ALREADY_SHIPPED"

    new_po = client.post(
        "/api/procurement/purchase-orders/import",
        json={
            "source_system": "GEP",
            "source_number": "GEP-T12-9001",
            "supplier_id": support.supplier(scenario_ab, "MERIDIAN").id,
            "programme_id": po.programme_id,
            "currency": "USD",
            "lines": [{"line_no": 1, "item_code": "GEN-MER-2500S", "quantity": "2", "unit_price": "402000", "distributions": []}],
        },
        headers=h,
    )
    assert new_po.status_code in (200, 201), new_po.text
    created = new_po.json()
    line = created["lines"][0]
    cancelling = client.post(
        f"/api/procurement/purchase-orders/{created['po']['id']}/cancel-quantity",
        json={"po_line_id": line["id"], "quantity": "1"},
        headers=h,
    )
    assert cancelling.status_code == 200, cancelling.text
    cancelled = [u for u in cancelling.json()["units"] if u["state"] == "CANCELLED"]
    assert len(cancelled) == 1
    cancelled_code = cancelled[0]["asset_code"]
    assert cancelled_code not in {"GEN-001", "GEN-002"}

    receipt = client.post(
        "/api/inventory/receipts",
        json={
            "receipt_ref": "RCPT-T12-CANCELLED",
            "po_id": created["po"]["id"],
            "location_id": warehouse.id,
            "lines": [{"unit_id": cancelled[0]["id"], "serial_number": "T12-CANCELLED", "condition": "GOOD"}],
        },
        headers=h,
    )
    assert receipt.status_code == 409
    assert receipt.json()["title"] == "UNIT_CANCELLED"
