"""Scenario A: BKK engineering needs, benchmark, consolidated sourcing, award and PO identity."""

from __future__ import annotations

from datetime import date, datetime

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.auth import Principal
from app.models import (
    EquipmentClass,
    EquipmentOption,
    ItemModel,
    OfferLine,
    PackageLine,
    PoAlias,
    Programme,
    Project,
    Requirement,
    Supplier,
    Tenant,
    WbsElement,
)
from app.services import planning, procurement, sourcing


def _actor(tenant: Tenant) -> Principal:
    return Principal(
        user_id="seed-planning",
        tenant_id=tenant.id,
        email="seed@pcx.local",
        name="Scenario seed",
        roles=frozenset({"ADMIN"}),
    )


def _one(db: Session, model, tenant_id: str, code: str):
    return db.scalar(select(model).where(model.tenant_id == tenant_id, model.code == code))


def _requirement(db: Session, p: Principal, body: dict) -> dict:
    data, _ = planning.create_requirement(db, p, body)
    return data


def _approve(db: Session, p: Principal, requirement_id: str) -> dict:
    requirement = planning.get_requirement(db, p, requirement_id)
    revision = requirement["latest_revision"]
    planning.submit_revision(db, p, revision["id"])
    data = planning.approve_revision(db, p, revision["id"], f'W/"{requirement["version"]}"')
    return data


def run(db: Session, tenant: Tenant) -> None:
    p = _actor(tenant)
    bkk = _one(db, Programme, tenant.id, "BKK")
    bkk1 = _one(db, Project, tenant.id, "BKK1")
    bkk2 = _one(db, Project, tenant.id, "BKK2")
    gen_class = _one(db, EquipmentClass, tenant.id, "GEN")
    chl_class = _one(db, EquipmentClass, tenant.id, "CHL-AC")
    wbs1 = db.scalar(select(WbsElement).where(WbsElement.tenant_id == tenant.id, WbsElement.code == "BKK1-E-GEN"))
    wbs2 = db.scalar(select(WbsElement).where(WbsElement.tenant_id == tenant.id, WbsElement.code == "BKK2-E-GEN"))
    wbs1_chw = db.scalar(select(WbsElement).where(WbsElement.tenant_id == tenant.id, WbsElement.code == "BKK1-M-CHW"))
    wbs2_chw = db.scalar(select(WbsElement).where(WbsElement.tenant_id == tenant.id, WbsElement.code == "BKK2-M-CHW"))
    suppliers = {s.key: s for s in db.scalars(select(Supplier).where(Supplier.tenant_id == tenant.id))}

    def need(code: str, project: Project, cls, wbs, title: str, quantity: str, capacity: str, unit: str, budget: str, cost_code: str, site: date, operational: date):
        body = {
            "code": code,
            "title": title,
            "project_id": project.id,
            "wbs_id": wbs.id,
            "equipment_class_id": cls.id,
            "revision": {
                "quantity": quantity,
                "uom": "EA",
                "duty": "STANDBY" if cls.id == gen_class.id else None,
                "capacity": capacity,
                "capacity_unit": unit,
                "redundancy": "N+1",
                "install_location": "Generator yard" if cls.id == gen_class.id else "Central cooling plant",
                "specification_json": {"ambient_c": "46", "enclosure": "Containerised"} if cls.id == gen_class.id else {"ambient_c": "46", "free_cooling": True},
                "cost_code": cost_code,
                "budget_amount": budget,
                "currency": "USD",
                "required_site_date": site.isoformat(),
                "required_install_date": date(site.year, site.month, min(site.day, 28)).isoformat(),
                "required_operational_date": operational.isoformat(),
            },
        }
        data = _requirement(db, p, body)
        return data["requirement"]["id"]

    req1 = need(
        "REQ-BKK1-GEN",
        bkk1,
        gen_class,
        wbs1,
        "BKK1 standby generation, 2500 kVA N+1",
        "6",
        "2500",
        "kVA",
        "2700000",
        "26-3213",
        date(2027, 3, 31),
        date(2027, 9, 30),
    )
    _requirement(
        db,
        p,
        {
            "code": "REQ-BKK2-GEN",
            "title": "BKK2 standby generation, 2500 kVA",
            "project_id": bkk2.id,
            "wbs_id": wbs2.id,
            "equipment_class_id": gen_class.id,
            "revision": {
                "quantity": "4",
                "uom": "EA",
                "duty": "STANDBY",
                "capacity": "2500",
                "capacity_unit": "kVA",
                "redundancy": "N",
                "install_location": "Generator yard",
                "specification_json": {"ambient_c": "46", "enclosure": "Containerised"},
                "cost_code": "26-3213",
                "budget_amount": "1800000",
                "currency": "USD",
                "required_site_date": "2027-06-30",
                "required_install_date": "2027-09-30",
                "required_operational_date": "2028-03-31",
            },
        },
    )
    for code, project, wbs, title in (
        ("REQ-BKK1-CHL", bkk1, wbs1_chw, "BKK1 central cooling, 1500 kW air-cooled"),
        ("REQ-BKK2-CHL", bkk2, wbs2_chw, "BKK2 central cooling, 1500 kW air-cooled"),
    ):
        _requirement(
            db,
            p,
            {
                "code": code,
                "title": title,
                "project_id": project.id,
                "wbs_id": wbs.id,
                "equipment_class_id": chl_class.id,
                "revision": {
                    "quantity": "2",
                    "uom": "EA",
                    "capacity": "1500",
                    "capacity_unit": "kW",
                    "redundancy": "N+1",
                    "install_location": "Central cooling plant",
                    "specification_json": {"ambient_c": "46", "refrigerant": "R1234ze"},
                    "cost_code": "23-6400",
                    "budget_amount": "1300000",
                    "currency": "USD",
                    "required_site_date": "2027-08-31",
                    "required_operational_date": "2028-06-30",
                },
            },
        )

    req1 = planning.get_requirement(db, p, req1)
    req1 = _approve(db, p, req1["id"])
    req1_approved = req1["requirement"]["current_revision"]

    for code in ("REQ-BKK2-GEN",):
        requirement = db.scalar(select(Requirement).where(Requirement.tenant_id == tenant.id, Requirement.code == code))
        _approve(db, p, requirement.id)
    for code in ("REQ-BKK1-CHL", "REQ-BKK2-CHL"):
        requirement = db.scalar(select(Requirement).where(Requirement.tenant_id == tenant.id, Requirement.code == code))
        _approve(db, p, requirement.id)

    # A later draft revision (quantity 7) demonstrates that approved projections only move on approval.
    planning.add_revision(
        db,
        p,
        req1["requirement"]["id"],
        {"changes": {"quantity": "7", "required_site_date": "2027-05-31"}, "change_reason": "BKK1 resilience review added a seventh unit (draft only)"},
    )

    planning.create_benchmark_run(db, p, {"requirement_revision_id": req1_approved["id"]})

    # ---------------------------------------------------------------- sourcing
    req_bkk2 = db.scalar(select(Requirement).where(Requirement.tenant_id == tenant.id, Requirement.code == "REQ-BKK2-GEN"))
    req_chl1 = db.scalar(select(Requirement).where(Requirement.tenant_id == tenant.id, Requirement.code == "REQ-BKK1-CHL"))
    rev_bkk2 = planning.approved_revision(db, req_bkk2)
    rev_chl1 = planning.approved_revision(db, req_chl1)

    package = sourcing.create_package(
        db,
        p,
        {
            "code": "PKG-BKK-GEN",
            "title": "BKK consolidated standby generation 10 x 2500 kVA",
            "programme_id": bkk.id,
            "currency": "USD",
            "bid_due_at": "2026-11-20T10:00:00",
            "invited_supplier_ids": [suppliers["MERIDIAN"].id, suppliers["NORTHWIND"].id],
            "evaluation_policy_json": {"weights": {"INSTALLED_COST": "0.4", "TCO": "0.3", "DELIVERY": "0.2", "TECHNICAL": "0.1"}, "horizon_years": 5, "discount_rate": "0.08"},
            "lines": [
                {
                    "line_key": "GEN-BKK1",
                    "requirement_revision_id": req1_approved["id"],
                    "quantity": "6",
                    "uom": "EA",
                    "scope_json": {"required": ["SUPPLY", "FREIGHT", "INSTALLATION", "COMMISSIONING"]},
                },
                {
                    "line_key": "GEN-BKK2",
                    "requirement_revision_id": rev_bkk2.id,
                    "quantity": "4",
                    "uom": "EA",
                    "scope_json": {"required": ["SUPPLY", "FREIGHT", "INSTALLATION", "COMMISSIONING"]},
                },
            ],
        },
    )
    package = sourcing.issue_package(db, p, package["id"], {"bid_due_at": "2026-11-20T10:00:00"})
    lines = {line["line_key"]: line for line in package["lines"]}

    meridian_offer = sourcing.submit_offer(
        db,
        p,
        package["id"],
        {
            "supplier_id": suppliers["MERIDIAN"].id,
            "source_offer_key": "MER-BKK-2026-A",
            "currency": "USD",
            "valid_until": "2027-01-31",
            "incoterms": "DAP Bangkok",
            "lines": [
                {
                    "line_key": "GEN-BKK1",
                    "option_code": "OPT-GEN-A",
                    "quantity": "6",
                    "unit_price": "402000",
                    "promised_delivery_date": "2027-02-28",
                    "lead_time_days": 300,
                    "scope_json": {"included": ["SUPPLY", "FREIGHT", "INSTALLATION", "COMMISSIONING"], "excluded": []},
                    "annual_om_estimate": "72000",
                    "warranty_months": 24,
                },
                {
                    "line_key": "GEN-BKK2",
                    "option_code": "OPT-GEN-A",
                    "quantity": "4",
                    "unit_price": "402000",
                    "promised_delivery_date": "2027-05-31",
                    "lead_time_days": 300,
                    "scope_json": {"included": ["SUPPLY", "FREIGHT", "INSTALLATION", "COMMISSIONING"], "excluded": []},
                    "annual_om_estimate": "48000",
                    "warranty_months": 24,
                },
            ],
        },
    )
    northwind_offer = sourcing.submit_offer(
        db,
        p,
        package["id"],
        {
            "supplier_id": suppliers["NORTHWIND"].id,
            "source_offer_key": "NWP-BKK-2026-1",
            "currency": "USD",
            "valid_until": "2027-01-15",
            "incoterms": "FCA Indiana",
            "lines": [
                {
                    "line_key": "GEN-BKK1",
                    "option_code": "OPT-GEN-B",
                    "quantity": "6",
                    "unit_price": "385000",
                    "promised_delivery_date": "2027-02-15",
                    "lead_time_days": 270,
                    "scope_json": {"included": ["SUPPLY"], "excluded": ["FREIGHT", "INSTALLATION", "COMMISSIONING"]},
                    "annual_om_estimate": "66000",
                    "warranty_months": 24,
                },
                {
                    "line_key": "GEN-BKK2",
                    "option_code": "OPT-GEN-B",
                    "quantity": "4",
                    "unit_price": "385000",
                    "promised_delivery_date": "2027-05-15",
                    "lead_time_days": 270,
                    "scope_json": {"included": ["SUPPLY"], "excluded": ["FREIGHT", "INSTALLATION", "COMMISSIONING"]},
                    "annual_om_estimate": "44000",
                    "warranty_months": 24,
                },
            ],
        },
    )
    northwind_line = next(line for line in northwind_offer["lines"] if line["package_line_id"] == lines["GEN-BKK1"]["id"])
    sourcing.add_adjustment(
        db,
        p,
        northwind_line["id"],
        {
            "category": "FREIGHT",
            "amount": None,
            "currency": "USD",
            "rationale": "Air/sea freight to Bangkok not quoted; scope excluded from offer price. Unknown, not zero.",
            "evidence_ref": "NWP-EXCL-01",
        },
    )
    sourcing.add_deviation(
        db,
        p,
        northwind_line["id"],
        {
            "criterion_ref": "46C_DERATING",
            "mandatory": True,
            "severity": "MAJOR",
            "description": "Rated at 40 C ambient; derating at the specified 46 C site ambient is not confirmed.",
            "proposed_alternative": "Derating calculation to be supplied before award.",
        },
    )

    evaluation = sourcing.create_evaluation(
        db,
        p,
        package["id"],
        {"criteria_policy_json": {"weights": {"INSTALLED_COST": "0.4", "TCO": "0.3", "DELIVERY": "0.2", "TECHNICAL": "0.1"}, "horizon_years": 5, "discount_rate": "0.08"}},
    )
    evaluation = sourcing.submit_evaluation(db, p, evaluation["evaluation"]["id"])
    evaluation = sourcing.approve_evaluation(db, p, evaluation["evaluation"]["id"], f'W/"{evaluation["evaluation"]["version"]}"')

    meridian_lines = {line["package_line_id"]: line for line in meridian_offer["lines"]}
    award = sourcing.create_award(
        db,
        p,
        evaluation["evaluation"]["id"],
        {
            "rationale": "Meridian is the only eligible full-scope offer; Northwind excludes freight and carries an open 46 C derating deviation.",
            "input_fingerprint": evaluation["evaluation"]["input_fingerprint"],
            "lines": [
                {"package_line_id": lines["GEN-BKK1"]["id"], "offer_line_id": meridian_lines[lines["GEN-BKK1"]["id"]]["id"], "selected_quantity": "6"},
                {"package_line_id": lines["GEN-BKK2"]["id"], "offer_line_id": meridian_lines[lines["GEN-BKK2"]["id"]]["id"], "selected_quantity": "4"},
            ],
        },
    )
    award = sourcing.submit_award(db, p, award["award"]["id"])
    award = sourcing.approve_award(
        db,
        p,
        award["award"]["id"],
        f'W/"{award["award"]["version"]}"',
        {"input_fingerprint": award["award"]["input_fingerprint"]},
    )

    # ---------------------------------------------------------------- purchase order and identity
    model_gen = db.scalar(select(ItemModel).where(ItemModel.tenant_id == tenant.id, ItemModel.item_code == "GEN-MER-2500S"))
    award_lines = {line["line_key"]: line for line in award["lines"]}
    po, _ = procurement.import_po(
        db,
        p,
        {
            "source_system": "GEP",
            "source_number": "GEP-PO-55120",
            "canonical_number": "PO-BKK-GEN-0001",
            "award_id": award["award"]["id"],
            "supplier_id": suppliers["MERIDIAN"].id,
            "programme_id": bkk.id,
            "currency": "USD",
            "incoterms": "DAP Bangkok",
            "lines": [
                {
                    "line_no": 1,
                    "item_code": "GEN-MER-2500S",
                    "option_code": "OPT-GEN-A",
                    "quantity": "6",
                    "unit_price": "402000",
                    "need_by": "2027-02-28",
                    "award_line_id": award_lines.get("GEN-BKK1", {}).get("id"),
                    "distributions": [{"project_id": bkk1.id, "wbs_id": wbs1.id, "requirement_id": req1["requirement"]["id"], "quantity": "6"}],
                },
                {
                    "line_no": 2,
                    "item_code": "GEN-MER-2500S",
                    "option_code": "OPT-GEN-A",
                    "quantity": "4",
                    "unit_price": "402000",
                    "need_by": "2027-05-31",
                    "award_line_id": award_lines.get("GEN-BKK2", {}).get("id"),
                    "distributions": [{"project_id": bkk2.id, "wbs_id": wbs2.id, "requirement_id": req_bkk2.id, "quantity": "4"}],
                },
            ],
        },
    )
    po_id = po["po"]["id"]
    db.add(PoAlias(tenant_id=tenant.id, created_by=p.email, po_id=po_id, source_system="ORACLE", source_number="ORA-PO-880120"))

    model_chl = db.scalar(select(ItemModel).where(ItemModel.tenant_id == tenant.id, ItemModel.item_code == "CH-POL-1500A"))
    procurement.import_po(
        db,
        p,
        {
            "source_system": "GEP",
            "source_number": "GEP-PO-55201",
            "canonical_number": "PO-BKK-CHL-0001",
            "supplier_id": suppliers["POLAR"].id,
            "programme_id": bkk.id,
            "currency": "USD",
            "incoterms": "DAP Bangkok",
            "lines": [
                {
                    "line_no": 1,
                    "item_code": model_chl.item_code,
                    "option_code": "OPT-CHL-A",
                    "quantity": "4",
                    "unit_price": "598000",
                    "need_by": "2027-08-31",
                    "distributions": [
                        {"project_id": bkk1.id, "wbs_id": wbs1_chw.id, "requirement_id": req_chl1.id, "quantity": "2"},
                        {"project_id": bkk2.id, "wbs_id": wbs2_chw.id, "requirement_id": db.scalar(select(Requirement.id).where(Requirement.tenant_id == tenant.id, Requirement.code == "REQ-BKK2-CHL")), "quantity": "2"},
                    ],
                }
            ],
        },
    )
    db.flush()
