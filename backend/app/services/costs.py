"""Cost events, exact allocation, TCO, FM/EAM import and observed outcomes (FR17, §22).

Economics are event-sourced: a repeated economic_key supersedes the prior revision, and only the
latest ACTUAL revision is recognised (T18). Allocations partition an amount exactly (T19).
"""

from __future__ import annotations

from collections import defaultdict
from datetime import date
from decimal import Decimal

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.api.common import rows as row_list
from app.api.common import row
from app.core.auth import Principal, Forbidden
from app.core.commands import bump
from app.core.decimal import allocate_exact, dstr, money
from app.core.errors import Conflict, DomainError
from app.core.outbox import publish_event
from app.models import (
    AllocationRecord,
    BenchmarkObservation,
    CostAllocation,
    CostEvent,
    EquipmentClass,
    FmWorkOrder,
    ItemModel,
    Location,
    PhysicalUnit,
    PoLine,
    Programme,
    Project,
    TcoScenario,
    TestRecord,
    UnitComponent,
    utcnow,
)
from app.services.helpers import audit, dec, get_row, need, optional_date

CATEGORIES = {
    "PURCHASE",
    "ANCILLARY",
    "INSTALLATION",
    "CONSULTANT",
    "COMMISSIONING",
    "SERVICE",
    "REPLACEMENT",
    "DISPOSAL",
    "RECOVERY",
    "TRANSFER",
    "REPAIR",
}
STATUSES = {"PROVISIONAL", "ACTUAL", "REVERSED"}


def _event_out(event: CostEvent) -> dict:
    return row(event, amount=dstr(event.amount))


def _allocations_for(db: Session, event_id: str) -> list[CostAllocation]:
    return list(db.scalars(select(CostAllocation).where(CostAllocation.cost_event_id == event_id)))


def create_event(db: Session, p: Principal, body: dict) -> dict:
    if not p.can_see_commercial:
        raise Forbidden("Cost data requires a commercial role")
    economic_key = str(need(body, "economic_key")).strip()
    category = str(need(body, "category")).upper()
    if category not in CATEGORIES:
        raise DomainError("VALIDATION", f"category must be one of {sorted(CATEGORIES)}")
    status = str(body.get("status") or "ACTUAL").upper()
    if status not in STATUSES:
        raise DomainError("VALIDATION", f"status must be one of {sorted(STATUSES)}")
    amount = dec(need(body, "amount"), "amount", required=True)
    unit = get_row(db, PhysicalUnit, body.get("unit_id"), p, "Unit") if body.get("unit_id") else None
    po_line = get_row(db, PoLine, body.get("po_line_id"), p, "PO line") if body.get("po_line_id") else None
    project = get_row(db, Project, body.get("posting_project_id"), p, "Project") if body.get("posting_project_id") else None
    occurred_on = optional_date(need(body, "occurred_on"))
    prior = db.scalar(
        select(CostEvent)
        .where(CostEvent.tenant_id == p.tenant_id, CostEvent.economic_key == economic_key)
        .order_by(CostEvent.revision_no.desc())
    )
    if prior and prior.status != "SUPERSEDED":
        prior.status = "SUPERSEDED"
    event = CostEvent(
        tenant_id=p.tenant_id,
        created_by=p.email,
        economic_key=economic_key,
        revision_no=(prior.revision_no + 1) if prior else 1,
        supersedes_id=prior.id if prior else None,
        unit_id=unit.id if unit else None,
        po_line_id=po_line.id if po_line else None,
        posting_project_id=project.id if project else None,
        category=category,
        status=status,
        amount=money(amount),
        currency=str(body.get("currency") or "USD").upper()[:3],
        source_system=str(body.get("source_system") or "MANUAL").upper(),
        source_ref=str(need(body, "source_ref")),
        occurred_on=occurred_on or date.today(),
        service_from=optional_date(body.get("service_from")),
        service_to=optional_date(body.get("service_to")),
    )
    db.add(event)
    db.flush()
    if body.get("auto_allocate_to_unit") and unit:
        db.add(
            CostAllocation(
                tenant_id=p.tenant_id,
                created_by=p.email,
                cost_event_id=event.id,
                unit_id=unit.id,
                attributed_project_id=unit.assigned_project_id,
                amount=event.amount,
                basis="EVENT_UNIT",
            )
        )
    audit(db, p, "COST_EVENT_RECORDED", "cost_event", event.id, after={"economic_key": economic_key, "revision": event.revision_no, "status": status})
    db.flush()
    return _event_out(event)


def list_events(db: Session, p: Principal, unit_id: str | None = None, economic_key: str | None = None) -> list[dict]:
    if not p.can_see_commercial:
        raise Forbidden("Cost data requires a commercial role")
    query = select(CostEvent).where(CostEvent.tenant_id == p.tenant_id).order_by(CostEvent.occurred_on.desc(), CostEvent.created_at.desc())
    if unit_id:
        query = query.where(CostEvent.unit_id == unit_id)
    if economic_key:
        query = query.where(CostEvent.economic_key == economic_key)
    out = []
    for event in db.scalars(query):
        unit = db.get(PhysicalUnit, event.unit_id) if event.unit_id else None
        allocations = _allocations_for(db, event.id)
        out.append(
            _event_out(event)
            | {
                "asset_code": unit.asset_code if unit else None,
                "allocations": row_list(allocations),
                "allocated_total": dstr(sum((a.amount for a in allocations), Decimal("0"))) if allocations else None,
            }
        )
    return out


def allocate_event(db: Session, p: Principal, event_id: str, body: dict) -> dict:
    if not p.can_see_commercial:
        raise Forbidden("Cost allocation requires a commercial role")
    event = get_row(db, CostEvent, event_id, p, "Cost event")
    basis = str(need(body, "basis"))
    targets = body.get("targets") or []
    if not targets:
        raise DomainError("VALIDATION", "targets must not be empty")
    weights: list[Decimal] = []
    for target in targets:
        weight = dec(target.get("weight", "1"), "weight", required=True)
        if weight <= 0:
            raise DomainError("VALIDATION", "weights must be greater than zero")
        if target.get("unit_id"):
            get_row(db, PhysicalUnit, target["unit_id"], p, "Unit")
        if target.get("attributed_project_id"):
            get_row(db, Project, target["attributed_project_id"], p, "Project")
        weights.append(weight)
    parts = allocate_exact(event.amount, weights)
    for old in _allocations_for(db, event.id):
        db.delete(old)
    db.flush()
    created = []
    for target, amount in zip(targets, parts, strict=True):
        allocation = CostAllocation(
            tenant_id=p.tenant_id,
            created_by=p.email,
            cost_event_id=event.id,
            unit_id=target.get("unit_id"),
            attributed_project_id=target.get("attributed_project_id"),
            amount=amount,
            basis=basis,
            unallocated=bool(target.get("unallocated") or not target.get("unit_id") and not target.get("attributed_project_id")),
            reason=target.get("reason"),
            period_from=optional_date(target.get("period_from")),
            period_to=optional_date(target.get("period_to")),
        )
        db.add(allocation)
        created.append(allocation)
    db.flush()
    if sum((a.amount for a in created), Decimal("0")) != event.amount:
        raise DomainError("ALLOCATION_MISMATCH", "Allocation does not sum to the event amount")
    audit(db, p, "COST_ALLOCATED", "cost_event", event.id, after={"basis": basis, "targets": len(created)})
    return _event_out(event) | {"allocations": row_list(created), "allocated_total": dstr(event.amount)}


def _allocated_to_unit(db: Session, unit_id: str) -> list[CostAllocation]:
    return list(db.scalars(select(CostAllocation).where(CostAllocation.unit_id == unit_id)))


def unit_summary(db: Session, p: Principal, unit_id: str) -> dict:
    unit = get_row(db, PhysicalUnit, unit_id, p, "Unit")
    direct = list(db.scalars(select(CostEvent).where(CostEvent.tenant_id == p.tenant_id, CostEvent.unit_id == unit.id)))
    shared_allocations = _allocated_to_unit(db, unit.id)
    shared_event_ids = {a.cost_event_id for a in shared_allocations}
    shared_events = [db.get(CostEvent, eid) for eid in shared_event_ids]
    events = {e.id: e for e in direct + [e for e in shared_events if e and e.id not in {d.id for d in direct}]}
    recognized = Decimal("0")
    provisional = Decimal("0")
    by_category: dict[str, dict] = {}
    by_project: dict[str, Decimal] = defaultdict(lambda: Decimal("0"))
    unallocated = Decimal("0")
    sources = []
    for event in events.values():
        amount = event.amount
        if event.id in shared_event_ids and event.id not in {d.id for d in direct}:
            amount = sum((a.amount for a in shared_allocations if a.cost_event_id == event.id), Decimal("0"))
        if event.status == "ACTUAL":
            recognized += amount
        elif event.status == "PROVISIONAL":
            provisional += amount
        cat = by_category.setdefault(event.category, {"category": event.category, "recognized": Decimal("0"), "provisional": Decimal("0")})
        cat["recognized" if event.status == "ACTUAL" else "provisional"] += amount
        for allocation in _allocations_for(db, event.id):
            if allocation.attributed_project_id and event.status == "ACTUAL":
                by_project[allocation.attributed_project_id] += allocation.amount
            if allocation.unallocated and event.status == "ACTUAL":
                unallocated += allocation.amount
        if event.status == "ACTUAL" and not _allocations_for(db, event.id):
            project_id = event.posting_project_id or unit.assigned_project_id
            if project_id:
                by_project[project_id] += amount
            else:
                unallocated += amount
        sources.append(
            {
                "cost_event_id": event.id,
                "economic_key": event.economic_key,
                "revision_no": event.revision_no,
                "status": event.status,
                "category": event.category,
                "amount": dstr(amount),
                "currency": event.currency,
                "source_system": event.source_system,
                "source_ref": event.source_ref,
                "occurred_on": event.occurred_on.isoformat(),
            }
        )
    project_rows = []
    for project_id, amount in by_project.items():
        project = db.get(Project, project_id)
        project_rows.append({"project_id": project_id, "project_code": project.code if project else None, "amount": dstr(amount)})
    return {
        "unit_id": unit.id,
        "asset_code": unit.asset_code,
        "currency": sources[0]["currency"] if sources else None,
        "recognized_total": dstr(recognized),
        "provisional_total": dstr(provisional),
        "by_category": [
            {"category": v["category"], "recognized": dstr(v["recognized"]), "provisional": dstr(v["provisional"])}
            for v in sorted(by_category.values(), key=lambda x: x["category"])
        ],
        "by_project": sorted(project_rows, key=lambda x: x["project_code"] or ""),
        "unallocated_total": dstr(unallocated),
        "sources": sources,
    }


def _leaves(db: Session, unit_id: str, seen: set[str]) -> list[str]:
    if unit_id in seen:
        return []
    seen.add(unit_id)
    children = list(
        db.scalars(
            select(UnitComponent.child_unit_id).where(UnitComponent.parent_unit_id == unit_id, UnitComponent.valid_to.is_(None))
        )
    )
    if not children:
        return [unit_id]
    out: list[str] = []
    for child in children:
        out.extend(_leaves(db, child, seen))
    return out


def rollup(db: Session, p: Principal, parent_unit_id: str) -> dict:
    parent = get_row(db, PhysicalUnit, parent_unit_id, p, "Unit")
    leaf_ids = _leaves(db, parent.id, set())
    leaves = []
    recognized = Decimal("0")
    provisional = Decimal("0")
    for leaf_id in leaf_ids:
        leaf = db.get(PhysicalUnit, leaf_id)
        summary = unit_summary(db, p, leaf_id)
        leaves.append(
            {
                "unit_id": leaf_id,
                "asset_code": leaf.asset_code if leaf else None,
                "item_code": leaf.item_model.item_code if leaf and leaf.item_model else None,
                "recognized_total": summary["recognized_total"],
                "provisional_total": summary["provisional_total"],
            }
        )
        recognized += Decimal(summary["recognized_total"] or "0")
        provisional += Decimal(summary["provisional_total"] or "0")
    direct = unit_summary(db, p, parent.id)
    direct_recognized = Decimal(direct["recognized_total"] or "0") - sum(
        (Decimal(unit_summary(db, p, lid)["recognized_total"] or "0") for lid in leaf_ids if lid == parent.id), Decimal("0")
    )
    return {
        "parent_unit_id": parent.id,
        "asset_code": parent.asset_code,
        "leaves": leaves,
        "recognized_total": dstr(recognized),
        "provisional_total": dstr(provisional),
        "direct_recognized_total": dstr(max(direct_recognized, Decimal("0"))),
    }


# ---------------------------------------------------------------- TCO


def _present_value(lines: list[dict], rate: Decimal, timing: str) -> Decimal:
    total = Decimal("0")
    for line in lines:
        amount = dec(line.get("amount"), "amount", required=True)
        year = int(line.get("year") or 0)
        exponent = year - 1 if timing == "BEGIN_OF_YEAR" and year > 0 else year
        total += amount / ((Decimal(1) + rate) ** exponent)
    return total


def create_tco(db: Session, p: Principal, body: dict) -> dict:
    lines = body.get("lines") or []
    if not lines:
        raise DomainError("VALIDATION", "lines must not be empty")
    rate = dec(body.get("discount_rate"), "discount_rate", required=True)
    if rate < 0 or rate >= 1:
        raise DomainError("VALIDATION", "discount_rate must be between 0 and 1 (for example 0.08)")
    timing = str(body.get("timing") or "END_OF_YEAR").upper()
    if timing not in ("END_OF_YEAR", "BEGIN_OF_YEAR"):
        raise DomainError("VALIDATION", "timing must be END_OF_YEAR or BEGIN_OF_YEAR")
    normalized = []
    for line in lines:
        amount = dec(line.get("amount"), "amount", required=True)
        normalized.append(
            {
                "year": int(line.get("year") or 0),
                "category": str(line.get("category") or "OTHER").upper(),
                "amount": dstr(amount),
                "kind": str(line.get("kind") or "FORECAST").upper(),
            }
        )
    undiscounted = sum((Decimal(line["amount"]) for line in normalized), Decimal("0"))
    pv = _present_value(normalized, rate, timing)
    scenario = TcoScenario(
        tenant_id=p.tenant_id,
        created_by=p.email,
        name=str(need(body, "name")),
        subject_type=str(body.get("subject_type") or "OPTION").upper(),
        subject_id=body.get("subject_id"),
        currency=str(body.get("currency") or "USD").upper()[:3],
        horizon_years=int(body.get("horizon_years") or max(line["year"] for line in normalized)),
        discount_rate=rate,
        timing=timing,
        lines=normalized,
        undiscounted_total=money(undiscounted),
        present_value=money(pv),
        is_illustrative=bool(body.get("is_illustrative", True)),
    )
    db.add(scenario)
    db.flush()
    audit(db, p, "TCO_SCENARIO_CREATED", "tco_scenario", scenario.id, after={"name": scenario.name, "undiscounted": dstr(undiscounted)})
    return _tco_out(scenario)


def _tco_out(scenario: TcoScenario) -> dict:
    return row(
        scenario,
        discount_rate=dstr(scenario.discount_rate),
        undiscounted_total=dstr(scenario.undiscounted_total),
        present_value=dstr(scenario.present_value),
    )


def list_tco(db: Session, p: Principal) -> list[dict]:
    return [_tco_out(s) for s in db.scalars(select(TcoScenario).where(TcoScenario.tenant_id == p.tenant_id).order_by(TcoScenario.created_at.desc()))]


# ---------------------------------------------------------------- FM / EAM import


def _project_at(db: Session, unit: PhysicalUnit, service_from: date, seen: set[str] | None = None) -> str | None:
    seen = seen if seen is not None else set()
    if unit.id in seen:
        return None
    seen.add(unit.id)
    record = db.scalar(
        select(AllocationRecord)
        .where(
            AllocationRecord.unit_id == unit.id,
            AllocationRecord.state.in_(("PENDING", "CONFIRMED", "RELEASED", "SUPERSEDED")),
            AllocationRecord.effective_from <= date_to_dt(service_from),
            (AllocationRecord.effective_to.is_(None)) | (AllocationRecord.effective_to >= date_to_dt(service_from)),
        )
        .order_by(AllocationRecord.effective_from.desc())
    )
    if record and record.to_project_id:
        return record.to_project_id
    link = db.scalar(
        select(UnitComponent)
        .where(
            UnitComponent.child_unit_id == unit.id,
            UnitComponent.valid_from <= date_to_dt(service_from),
            (UnitComponent.valid_to.is_(None)) | (UnitComponent.valid_to >= date_to_dt(service_from)),
        )
        .order_by(UnitComponent.valid_from.desc())
    )
    if link:
        parent = db.get(PhysicalUnit, link.parent_unit_id)
        if parent and parent.tenant_id == unit.tenant_id:
            inherited = _project_at(db, parent, service_from, seen)
            if inherited:
                return inherited
    return unit.assigned_project_id


def date_to_dt(value: date):
    from datetime import datetime as _dt

    return _dt(value.year, value.month, value.day)


def _resolve_unit(db: Session, p: Principal, wo: dict, service_from: date) -> PhysicalUnit | None:
    if wo.get("parent_unit_id") and wo.get("slot_code"):
        parent = db.get(PhysicalUnit, wo["parent_unit_id"])
        if parent and parent.tenant_id == p.tenant_id:
            link = db.scalar(
                select(UnitComponent)
                .where(
                    UnitComponent.parent_unit_id == parent.id,
                    UnitComponent.slot_code == str(wo["slot_code"]).upper(),
                    UnitComponent.valid_from <= date_to_dt(service_from),
                    (UnitComponent.valid_to.is_(None)) | (UnitComponent.valid_to >= date_to_dt(service_from)),
                )
                .order_by(UnitComponent.valid_from.desc())
            )
            if link:
                return db.get(PhysicalUnit, link.child_unit_id)
            return None
    if wo.get("parent_unit_id"):
        parent = db.get(PhysicalUnit, wo["parent_unit_id"])
        return parent if parent and parent.tenant_id == p.tenant_id else None
    if wo.get("planon_asset_id"):
        unit = db.scalar(
            select(PhysicalUnit).where(
                PhysicalUnit.tenant_id == p.tenant_id,
                PhysicalUnit.planon_asset_id == str(wo["planon_asset_id"]),
            )
        )
        if unit:
            return unit
    return None


def import_fm_work_orders(db: Session, p: Principal, body: dict) -> dict:
    imported = []
    resolved_count = 0
    for wo in body.get("work_orders") or []:
        work_order_ref = str(need(wo, "work_order_ref"))
        invoice_ref = str(need(wo, "invoice_ref"))
        existing = db.scalar(
            select(FmWorkOrder).where(
                FmWorkOrder.tenant_id == p.tenant_id,
                FmWorkOrder.source_system == "PLANON",
                FmWorkOrder.work_order_ref == work_order_ref,
                FmWorkOrder.invoice_ref == invoice_ref,
            )
        )
        if existing:
            imported.append(row(existing))
            continue
        service_from = optional_date(need(wo, "service_from"))
        service_to = optional_date(need(wo, "service_to"))
        amount = money(dec(need(wo, "amount"), "amount", required=True))
        unit = _resolve_unit(db, p, wo, service_from)
        work_order = FmWorkOrder(
            tenant_id=p.tenant_id,
            created_by=p.email,
            work_order_ref=work_order_ref,
            invoice_ref=invoice_ref,
            planon_asset_id=wo.get("planon_asset_id"),
            parent_unit_id=wo.get("parent_unit_id"),
            slot_code=str(wo["slot_code"]).upper() if wo.get("slot_code") else None,
            service_from=service_from,
            service_to=service_to,
            description=str(wo.get("description") or ""),
            amount=amount,
            currency=str(wo.get("currency") or "USD").upper()[:3],
            posting_project_id=wo.get("posting_project_id"),
        )
        if unit is None:
            work_order.state = "UNRESOLVED"
            work_order.resolution_note = "No unit was fitted for this parent/slot at the service date"
            db.add(work_order)
            db.flush()
            imported.append(row(work_order))
            continue
        attributed = _project_at(db, unit, service_from)
        event = CostEvent(
            tenant_id=p.tenant_id,
            created_by=p.email,
            economic_key=f"FM:{work_order_ref}:{invoice_ref}",
            revision_no=1,
            unit_id=unit.id,
            posting_project_id=work_order.posting_project_id,
            category="SERVICE",
            status="ACTUAL",
            amount=amount,
            currency=work_order.currency,
            source_system="PLANON",
            source_ref=invoice_ref,
            occurred_on=service_to,
            service_from=service_from,
            service_to=service_to,
        )
        db.add(event)
        db.flush()
        db.add(
            CostAllocation(
                tenant_id=p.tenant_id,
                created_by=p.email,
                cost_event_id=event.id,
                unit_id=unit.id,
                attributed_project_id=attributed,
                amount=amount,
                basis="FM_SERVICE_AT_DATE",
                period_from=service_from,
                period_to=service_to,
            )
        )
        work_order.resolved_unit_id = unit.id
        work_order.cost_event_id = event.id
        work_order.state = "RESOLVED"
        db.add(work_order)
        db.flush()
        resolved_count += 1
        imported.append(row(work_order))
    audit(db, p, "FM_WORK_ORDERS_IMPORTED", "fm_work_order", p.tenant_id, after={"count": len(imported), "resolved": resolved_count})
    return {"imported": imported, "resolved": resolved_count, "unresolved": len(imported) - resolved_count}


def list_fm_work_orders(db: Session, p: Principal) -> list[dict]:
    out = []
    for wo in db.scalars(select(FmWorkOrder).where(FmWorkOrder.tenant_id == p.tenant_id).order_by(FmWorkOrder.service_from.desc())):
        unit = db.get(PhysicalUnit, wo.resolved_unit_id) if wo.resolved_unit_id else None
        out.append(row(wo, amount=dstr(wo.amount), resolved_asset_code=unit.asset_code if unit else None))
    return out


# ---------------------------------------------------------------- observed outcomes


def publish_outcome(db: Session, p: Principal, body: dict) -> dict:
    unit = get_row(db, PhysicalUnit, need(body, "unit_id"), p, "Unit")
    model = unit.item_model
    if model is None:
        raise Conflict("MODEL_MISSING", "The unit has no item model")
    programme = db.get(Programme, unit.programme_id) if unit.programme_id else None
    project = db.get(Project, unit.assigned_project_id) if unit.assigned_project_id else None
    if project is None and unit.po_line_id:
        po_line = db.get(PoLine, unit.po_line_id)
        project = db.get(Project, po_line.project_id) if po_line and po_line.project_id else project
    summary = unit_summary(db, p, unit.id)
    recognized = Decimal(summary["recognized_total"] or "0")
    by_category = {entry["category"]: Decimal(entry["recognized"] or "0") for entry in summary["by_category"]}
    service = by_category.get("SERVICE", Decimal("0"))
    years = max(0, (date.today() - unit.in_service_date).days // 365) if unit.in_service_date else 0
    annual = (service / years) if years else service
    failures = db.scalar(select(TestRecord.id).where(TestRecord.unit_id == unit.id, TestRecord.result == "FAIL"))
    observation = db.scalar(
        select(BenchmarkObservation).where(BenchmarkObservation.tenant_id == p.tenant_id, BenchmarkObservation.unit_id == unit.id)
    )
    data = {
        "equipment_class_id": model.equipment_class_id,
        "item_model_id": model.id,
        "unit_id": unit.id,
        "source_project_code": project.code if project else "UNALLOCATED",
        "duty": (model.duty_modes or "").split(",")[0] or None,
        "capacity": model.rated_capacity,
        "capacity_unit": model.capacity_unit,
        "region": programme.region if programme else None,
        "currency": summary["currency"] or "USD",
        "purchase_cost": by_category.get("PURCHASE"),
        "installed_cost": by_category.get("PURCHASE", Decimal("0")) + by_category.get("INSTALLATION", Decimal("0")),
        "annual_opex": [{"year": 1, "amount": dstr(annual)}] if annual else [],
        "operating_years_observed": years,
        "scope_included": [c for c in ("PURCHASE", "INSTALLATION") if c in by_category],
        "commissioning_failures": 1 if failures else 0,
        "observed_at": date.today(),
        "source_ref": f"OUTCOME:{unit.asset_code}",
    }
    if observation:
        for key, value in data.items():
            setattr(observation, key, value)
    else:
        observation = BenchmarkObservation(tenant_id=p.tenant_id, created_by=p.email, **data)
        db.add(observation)
    db.flush()
    audit(db, p, "ASSET_OUTCOME_PUBLISHED", "benchmark_observation", observation.id, after={"unit": unit.asset_code, "purchase_cost": dstr(data["purchase_cost"])})
    publish_event(db, p.tenant_id, "AssetOutcomeObserved", "benchmark_observation", observation.id, {"observed_unit_id": unit.id, "equipment_class_id": model.equipment_class_id})
    return row(observation, purchase_cost=dstr(observation.purchase_cost), installed_cost=dstr(observation.installed_cost))


def list_outcomes(db: Session, p: Principal, equipment_class_id: str | None = None) -> list[dict]:
    query = select(BenchmarkObservation).where(BenchmarkObservation.tenant_id == p.tenant_id, BenchmarkObservation.unit_id.is_not(None))
    if equipment_class_id:
        query = query.where(BenchmarkObservation.equipment_class_id == equipment_class_id)
    return [
        row(o, purchase_cost=dstr(o.purchase_cost), installed_cost=dstr(o.installed_cost))
        | {"equipment_class_code": (db.get(EquipmentClass, o.equipment_class_id).code if db.get(EquipmentClass, o.equipment_class_id) else None)}
        for o in db.scalars(query.order_by(BenchmarkObservation.observed_at.desc()))
    ]
