"""Planning chain: engineering needs, revisions, BOQ import, benchmarks, reuse and reservations."""

from __future__ import annotations

from datetime import date, datetime, timedelta
from decimal import Decimal
from statistics import median
from typing import Any

from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.api.common import row
from app.config import get_settings
from app.core.auth import Principal
from app.core.commands import bump, check_if_match
from app.core.decimal import MONEY_Q, dstr
from app.core.errors import Conflict, DomainError, Forbidden
from app.core.outbox import publish_event
from app.models import (
    AwardDecision,
    BenchmarkObservation,
    BenchmarkResult,
    BenchmarkRun,
    BoqLine,
    BoqRevision,
    EquipmentClass,
    ImpactAction,
    ItemModel,
    PackageLine,
    PhysicalUnit,
    PoDistribution,
    PoLine,
    Project,
    PurchaseOrder,
    Requirement,
    RequirementRevision,
    Reservation,
    ReuseAssessment,
    Supplier,
    utcnow,
)
from app.services.helpers import (
    approved_revision,
    audit,
    dec,
    get_row,
    latest_requirement_revision,
    need,
    optional_date,
    optional_dt,
    requirement_of_revision,
    sha256,
)

REVISION_FIELDS = (
    "quantity",
    "uom",
    "duty",
    "capacity",
    "capacity_unit",
    "redundancy",
    "install_location",
    "specification_json",
    "cost_code",
    "budget_amount",
    "currency",
    "required_site_date",
    "required_install_date",
    "required_operational_date",
)
DATE_FIELDS = {"required_site_date", "required_install_date", "required_operational_date"}
DECIMAL_FIELDS = {"quantity", "capacity", "budget_amount"}


# ---------------------------------------------------------------- serialization


def _requirement_out(db: Session, req: Requirement, detail: bool = False) -> dict:
    project = db.get(Project, req.project_id)
    cls = db.get(EquipmentClass, req.equipment_class_id)
    current = approved_revision(db, req)
    latest = latest_requirement_revision(db, req.id)
    out = row(
        req,
        project_code=project.code if project else None,
        project_name=project.name if project else None,
        equipment_class_code=cls.code if cls else None,
        equipment_class_name=cls.name if cls else None,
        current_revision=row(current) if current else None,
        latest_revision=row(latest) if latest else None,
    )
    if detail:
        revisions = db.scalars(
            select(RequirementRevision).where(RequirementRevision.requirement_id == req.id).order_by(RequirementRevision.revision_no)
        )
        out["revisions"] = [row(r) for r in revisions]
        out["impact_actions"] = [
            row(a) for a in db.scalars(select(ImpactAction).where(ImpactAction.requirement_id == req.id).order_by(ImpactAction.created_at.desc()))
        ]
        out["benchmark_runs"] = [
            row(b) for b in db.scalars(select(BenchmarkRun).where(BenchmarkRun.requirement_revision_id.in_([r["id"] for r in out["revisions"]])).order_by(BenchmarkRun.created_at.desc()))
        ]
        out["reuse_assessments"] = [
            row(a)
            for a in db.scalars(
                select(ReuseAssessment)
                .where(ReuseAssessment.requirement_revision_id.in_([r["id"] for r in out["revisions"]]))
                .order_by(ReuseAssessment.created_at.desc())
            )
        ]
        out["reservations"] = [
            row(r) for r in db.scalars(select(Reservation).where(Reservation.requirement_id == req.id).order_by(Reservation.created_at.desc()))
        ]
    return out


def _apply_fields(rev: RequirementRevision, data: dict[str, Any]) -> None:
    for field in REVISION_FIELDS:
        if field not in data:
            continue
        value = data[field]
        if field in DECIMAL_FIELDS:
            value = dec(value, field)
        elif field in DATE_FIELDS:
            value = optional_date(value)
        elif field == "specification_json":
            value = value or {}
        elif field == "uom" and not value:
            value = "EA"
        setattr(rev, field, value)


def _auto_code(db: Session, p: Principal, project: Project, cls: EquipmentClass) -> str:
    base = f"REQ-{project.code}-{cls.code}"
    count = len(list(db.scalars(select(Requirement.id).where(Requirement.tenant_id == p.tenant_id, Requirement.code.like(f"{base}%")))))
    return base if count == 0 else f"{base}-{count + 1}"


# ---------------------------------------------------------------- requirements


def list_requirements(db: Session, p: Principal, project_id: str | None = None) -> list[dict]:
    q = select(Requirement).where(Requirement.tenant_id == p.tenant_id).order_by(Requirement.code)
    if project_id:
        q = q.where(Requirement.project_id == project_id)
    return [_requirement_out(db, r) for r in db.scalars(q) if p.can_see_project(r.project_id)]


def create_requirement(db: Session, p: Principal, body: dict) -> tuple[dict, bool]:
    project = get_row(db, Project, need(body, "project_id"), p, "Project")
    cls = get_row(db, EquipmentClass, need(body, "equipment_class_id"), p, "Equipment class")
    source_key = body.get("source_boq_key")
    line_key = body.get("source_line_key")
    if source_key and line_key:
        existing = db.scalar(
            select(Requirement).where(
                Requirement.tenant_id == p.tenant_id,
                Requirement.project_id == project.id,
                Requirement.source_boq_key == source_key,
                Requirement.source_line_key == line_key,
            )
        )
        if existing:
            return {"requirement": _requirement_out(db, existing, detail=True), "revision": row(latest_requirement_revision(db, existing.id))}, True

    revision_body = body.get("revision") or {}
    requirement = Requirement(
        tenant_id=p.tenant_id,
        created_by=p.email,
        code=body.get("code") or _auto_code(db, p, project, cls),
        title=need(body, "title"),
        project_id=project.id,
        wbs_id=body.get("wbs_id"),
        equipment_class_id=cls.id,
        sourcing_route=body.get("sourcing_route") or "NEW_PURCHASE",
        source_boq_key=source_key,
        source_line_key=line_key,
    )
    if requirement.code and db.scalar(select(Requirement.id).where(Requirement.tenant_id == p.tenant_id, Requirement.code == requirement.code)):
        raise Conflict("DUPLICATE_REQUIREMENT_CODE", f"Requirement code {requirement.code} already exists")
    db.add(requirement)
    db.flush()
    revision = RequirementRevision(tenant_id=p.tenant_id, created_by=p.email, requirement_id=requirement.id, revision_no=1)
    _apply_fields(revision, revision_body)
    if revision.quantity is None:
        raise DomainError("VALIDATION", "revision.quantity is required")
    if revision.quantity <= 0:
        raise DomainError("VALIDATION", "revision.quantity must be greater than zero")
    revision.currency = revision.currency or (db.get(Project, project.id) and "USD")
    db.add(revision)
    db.flush()
    audit(db, p, "REQUIREMENT_CREATED", "requirement", requirement.id, after={"code": requirement.code})
    return {"requirement": _requirement_out(db, requirement, detail=True), "revision": row(revision)}, False


def get_requirement(db: Session, p: Principal, requirement_id: str) -> dict:
    return _requirement_out(db, get_row(db, Requirement, requirement_id, p, "Requirement"), detail=True)


def add_revision(db: Session, p: Principal, requirement_id: str, body: dict) -> dict:
    requirement = get_row(db, Requirement, requirement_id, p, "Requirement")
    if requirement.state != "ACTIVE":
        raise Conflict("REQUIREMENT_CANCELLED", "Requirement is not active")
    latest = latest_requirement_revision(db, requirement.id)
    if latest and latest.state in ("DRAFT", "IN_REVIEW"):
        raise Conflict("OPEN_REVISION_EXISTS", f"Revision {latest.revision_no} is still {latest.state}; submit or cancel it first")
    base = approved_revision(db, requirement) or latest
    revision = RequirementRevision(
        tenant_id=p.tenant_id,
        created_by=p.email,
        requirement_id=requirement.id,
        revision_no=(latest.revision_no if latest else 0) + 1,
        predecessor_id=base.id if base else None,
        change_reason=body.get("change_reason"),
    )
    if base:
        for field in REVISION_FIELDS:
            setattr(revision, field, getattr(base, field))
    changes = body.get("changes") or {}
    _apply_fields(revision, changes)
    changed = []
    if base:
        for field in REVISION_FIELDS:
            if changes.get(field) is not None and getattr(revision, field) != getattr(base, field):
                changed.append(field)
    revision.changed_fields = changed
    db.add(revision)
    db.flush()
    audit(db, p, "REQUIREMENT_REVISION_DRAFTED", "requirement_revision", revision.id, after={"revision_no": revision.revision_no, "changed_fields": changed})
    return {"requirement": _requirement_out(db, requirement), "revision": row(revision)}


def submit_revision(db: Session, p: Principal, revision_id: str) -> dict:
    revision = get_row(db, RequirementRevision, revision_id, p, "Requirement revision")
    if revision.state != "DRAFT":
        raise Conflict("INVALID_STATE", f"Only a DRAFT revision can be submitted (current: {revision.state})")
    revision.state = "IN_REVIEW"
    revision.submitted_at = utcnow()
    audit(db, p, "REQUIREMENT_REVISION_SUBMITTED", "requirement_revision", revision.id)
    return row(revision)


def approve_revision(db: Session, p: Principal, revision_id: str, if_match: str | None) -> dict:
    revision = db.get(RequirementRevision, revision_id)
    if revision is None or revision.tenant_id != p.tenant_id:
        raise DomainError("NOT_FOUND", "Requirement revision not found", status=404)
    requirement = get_row(db, Requirement, revision.requirement_id, p, "Requirement")
    check_if_match(requirement, if_match, required=True)
    if revision.state not in ("IN_REVIEW", "DRAFT"):
        raise Conflict("INVALID_STATE", f"Revision {revision.revision_no} is {revision.state}")
    previous = approved_revision(db, requirement)
    if previous and previous.id == revision.id:
        return {"requirement": _requirement_out(db, requirement, detail=True), "revision": row(revision)}
    for other in db.scalars(
        select(RequirementRevision).where(
            RequirementRevision.requirement_id == requirement.id,
            RequirementRevision.state == "APPROVED",
            RequirementRevision.id != revision.id,
        )
    ):
        other.state = "SUPERSEDED"
    revision.state = "APPROVED"
    revision.approved_at = utcnow()
    revision.approved_by = p.email
    requirement.current_revision_id = revision.id
    bump(requirement)

    opened = _open_impacts(db, p, requirement, revision, previous)
    publish_event(
        db,
        p.tenant_id,
        "RequirementRevisionApproved",
        "requirement",
        requirement.id,
        {"requirement_id": requirement.id, "revision_id": revision.id, "revision_no": revision.revision_no, "affected": opened},
        version=requirement.version,
    )
    audit(db, p, "REQUIREMENT_REVISION_APPROVED", "requirement_revision", revision.id, after={"impact_actions": opened})
    return {"requirement": _requirement_out(db, requirement, detail=True), "revision": row(revision), "impact_actions_opened": opened}


def _open_impacts(db: Session, p: Principal, requirement: Requirement, revision: RequirementRevision, previous: RequirementRevision | None) -> int:
    if previous is None:
        return 0
    reason = (
        f"Approved requirement revision {revision.revision_no} supersedes revision {previous.revision_no} "
        f"(quantity {dstr(previous.quantity)} -> {dstr(revision.quantity)})"
    )
    opened: set[tuple[str, str]] = set()

    def add(subject_type: str, subject_id: str, owner: str) -> None:
        if (subject_type, subject_id) in opened:
            return
        opened.add((subject_type, subject_id))
        db.add(
            ImpactAction(
                tenant_id=p.tenant_id,
                created_by=p.email,
                requirement_id=requirement.id,
                revision_id=revision.id,
                subject_type=subject_type,
                subject_id=subject_id,
                reason=reason,
                owner_role=owner,
            )
        )

    for reservation in db.scalars(
        select(Reservation).where(Reservation.tenant_id == p.tenant_id, Reservation.requirement_id == requirement.id, Reservation.state == "ACTIVE")
    ):
        add("RESERVATION", reservation.id, "PROCUREMENT")
    for distribution in db.scalars(select(PoDistribution).where(PoDistribution.requirement_id == requirement.id)):
        po_line = db.get(PoLine, distribution.po_line_id)
        po = db.get(PurchaseOrder, po_line.po_id) if po_line else None
        if po and po.state not in ("CLOSED", "CANCELLED"):
            add("PURCHASE_ORDER", po.id, "PROCUREMENT")
    revision_ids = [
        r.id
        for r in db.scalars(select(RequirementRevision.id).where(RequirementRevision.requirement_id == requirement.id))
    ]
    from app.models import Evaluation  # local import: avoids a cycle with sourcing

    seen_evaluations: set[str] = set()
    for package_line in db.scalars(select(PackageLine).where(PackageLine.requirement_revision_id.in_(revision_ids))):
        for evaluation in db.scalars(select(Evaluation).where(Evaluation.package_id == package_line.package_id)):
            if evaluation.id in seen_evaluations:
                continue
            seen_evaluations.add(evaluation.id)
            if evaluation.state not in ("SUPERSEDED",):
                evaluation.state = "STALE"
                evaluation.stale_reason = "Requirement revision changed after evaluation"
                add("EVALUATION", evaluation.id, "PROCUREMENT")
    for assessment in db.scalars(
        select(ReuseAssessment).where(
            ReuseAssessment.requirement_revision_id.in_(revision_ids),
            ReuseAssessment.state.in_(("CANDIDATE", "ASSESSED", "APPROVED")),
        )
    ):
        assessment.state = "INVALIDATED"
        add("REUSE_ASSESSMENT", assessment.id, "ESTIMATOR")
    return len(opened)


def cancel_revision(db: Session, p: Principal, revision_id: str) -> dict:
    revision = get_row(db, RequirementRevision, revision_id, p, "Requirement revision")
    if revision.state not in ("DRAFT", "IN_REVIEW"):
        raise Conflict("INVALID_STATE", f"Revision is {revision.state}")
    revision.state = "CANCELLED"
    audit(db, p, "REQUIREMENT_REVISION_CANCELLED", "requirement_revision", revision.id)
    return row(revision)


def list_impact_actions(db: Session, p: Principal, state: str | None = None) -> list[dict]:
    q = select(ImpactAction).where(ImpactAction.tenant_id == p.tenant_id).order_by(ImpactAction.created_at.desc())
    if state:
        q = q.where(ImpactAction.state == state)
    return [row(a) for a in db.scalars(q)]


def resolve_impact_action(db: Session, p: Principal, action_id: str, body: dict) -> dict:
    action = get_row(db, ImpactAction, action_id, p, "Impact action")
    if action.state != "OPEN":
        raise Conflict("INVALID_STATE", "Impact action is already resolved")
    if not p.has(action.owner_role, "OWNER"):
        raise Forbidden(f"Only {action.owner_role} or OWNER may resolve this action")
    action.state = "RESOLVED"
    action.resolution = need(body, "resolution")
    bump(action)
    audit(db, p, "IMPACT_ACTION_RESOLVED", "impact_action", action.id, after={"resolution": action.resolution})
    return row(action)


# ---------------------------------------------------------------- BOQ import


def import_boq(db: Session, p: Principal, body: dict) -> tuple[dict, bool]:
    project = get_row(db, Project, need(body, "project_id"), p, "Project")
    source_key = need(body, "source_key")
    lines = body.get("lines") or []
    if not lines:
        raise DomainError("VALIDATION", "lines must not be empty")
    source_hash = sha256(sorted(lines, key=lambda item: str(item.get("source_line_key"))))
    existing = db.scalar(
        select(BoqRevision).where(
            BoqRevision.tenant_id == p.tenant_id,
            BoqRevision.project_id == project.id,
            BoqRevision.source_key == source_key,
            BoqRevision.source_hash == source_hash,
        )
    )
    if existing:
        return _boq_out(db, existing), True
    previous_no = db.scalar(
        select(BoqRevision.revision_no).where(
            BoqRevision.tenant_id == p.tenant_id,
            BoqRevision.project_id == project.id,
            BoqRevision.source_key == source_key,
        ).order_by(BoqRevision.revision_no.desc())
    )
    boq = BoqRevision(
        tenant_id=p.tenant_id,
        created_by=p.email,
        project_id=project.id,
        source_key=source_key,
        revision_no=(previous_no or 0) + 1,
        state="DRAFT",
        source_hash=source_hash,
    )
    db.add(boq)
    db.flush()
    for line in lines:
        line_key = need(line, "source_line_key")
        cls = db.scalar(select(EquipmentClass).where(EquipmentClass.tenant_id == p.tenant_id, EquipmentClass.code == need(line, "equipment_class_code")))
        if cls is None:
            raise DomainError("VALIDATION", f"Unknown equipment class {line.get('equipment_class_code')}")
        requirement = db.scalar(
            select(Requirement).where(
                Requirement.tenant_id == p.tenant_id,
                Requirement.project_id == project.id,
                Requirement.source_boq_key == source_key,
                Requirement.source_line_key == line_key,
            )
        )
        if requirement is None:
            requirement = Requirement(
                tenant_id=p.tenant_id,
                created_by=p.email,
                code=_auto_code(db, p, project, cls),
                title=line.get("title") or cls.name,
                project_id=project.id,
                equipment_class_id=cls.id,
                sourcing_route="NEW_PURCHASE",
                source_boq_key=source_key,
                source_line_key=line_key,
            )
            db.add(requirement)
            db.flush()
            revision = RequirementRevision(
                tenant_id=p.tenant_id,
                created_by=p.email,
                requirement_id=requirement.id,
                revision_no=1,
                quantity=dec(line.get("quantity"), "quantity", required=True),
                uom=line.get("uom") or "EA",
                duty=line.get("duty"),
                capacity=dec(line.get("capacity"), "capacity"),
                capacity_unit=line.get("capacity_unit"),
                cost_code=line.get("cost_code"),
                currency=line.get("currency") or "USD",
                required_site_date=optional_date(line.get("required_site_date")),
            )
            db.add(revision)
            db.flush()
        else:
            revision = latest_requirement_revision(db, requirement.id)
        db.add(
            BoqLine(
                tenant_id=p.tenant_id,
                created_by=p.email,
                boq_revision_id=boq.id,
                source_line_key=line_key,
                requirement_revision_id=revision.id,
                quantity=dec(line.get("quantity"), "quantity", required=True),
                uom=line.get("uom") or "EA",
                budget_amount=dec(line.get("budget_amount"), "budget_amount"),
                currency=line.get("currency") or "USD",
            )
        )
    audit(db, p, "BOQ_IMPORTED", "boq_revision", boq.id, after={"source_key": source_key, "revision_no": boq.revision_no, "lines": len(lines)})
    return _boq_out(db, boq), False


def _boq_out(db: Session, boq: BoqRevision) -> dict:
    project = db.get(Project, boq.project_id)
    lines = db.scalars(select(BoqLine).where(BoqLine.boq_revision_id == boq.id).order_by(BoqLine.source_line_key))
    return row(boq, project_code=project.code if project else None, lines=[row(line) for line in lines])


def list_boq_revisions(db: Session, p: Principal, project_id: str | None = None) -> list[dict]:
    q = select(BoqRevision).where(BoqRevision.tenant_id == p.tenant_id).order_by(BoqRevision.created_at.desc())
    if project_id:
        q = q.where(BoqRevision.project_id == project_id)
    return [_boq_out(db, b) for b in db.scalars(q)]


# ---------------------------------------------------------------- benchmarks


def list_benchmark_observations(db: Session, p: Principal, equipment_class_id: str | None = None) -> list[dict]:
    q = select(BenchmarkObservation).where(BenchmarkObservation.tenant_id == p.tenant_id).order_by(BenchmarkObservation.observed_at.desc())
    if equipment_class_id:
        q = q.where(BenchmarkObservation.equipment_class_id == equipment_class_id)
    return [row(o) for o in db.scalars(q)]


def _stats(values: list[Decimal]) -> dict:
    if not values:
        return {"min": None, "median": None, "max": None}
    ordered = sorted(values)
    return {"min": ordered[0], "median": Decimal(median(ordered)), "max": ordered[-1]}


def create_benchmark_run(db: Session, p: Principal, body: dict) -> dict:
    revision = get_row(db, RequirementRevision, need(body, "requirement_revision_id"), p, "Requirement revision")
    requirement = requirement_of_revision(db, revision.id)
    revision = get_row(db, RequirementRevision, revision.id, p, "Requirement revision")
    cutoff = optional_dt(body.get("evidence_cutoff")) or utcnow()
    observations = list(
        db.scalars(select(BenchmarkObservation).where(BenchmarkObservation.tenant_id == p.tenant_id, BenchmarkObservation.equipment_class_id == requirement.equipment_class_id))
    )
    cohort: list[BenchmarkObservation] = []
    excluded: list[dict] = []
    for obs in observations:
        reason = None
        if obs.observed_at and datetime.combine(obs.observed_at, datetime.min.time()) > cutoff:
            reason = "After evidence cutoff"
        elif revision.duty and obs.duty and obs.duty != revision.duty:
            reason = f"Duty mismatch: {obs.duty} vs {revision.duty}"
        elif revision.capacity and obs.capacity and obs.capacity != revision.capacity:
            reason = f"Capacity mismatch: {dstr(obs.capacity)} vs {dstr(revision.capacity)} {revision.capacity_unit or ''}".strip()
        if reason:
            excluded.append({"observation_id": obs.id, "source_project_code": obs.source_project_code, "reason": reason})
        else:
            cohort.append(obs)

    purchases = [o.purchase_cost for o in cohort if o.purchase_cost is not None]
    installed = [o.installed_cost for o in cohort if o.installed_cost is not None]
    opex_values = [Decimal(str(o.annual_opex[0]["amount"])) for o in cohort if o.annual_opex]
    metrics = [
        ("PURCHASE_COST", purchases, "Supply price per unit"),
        ("INSTALLED_COST", installed, "Delivered and installed cost per unit"),
        ("ANNUAL_OPEX_Y1", opex_values, "First-year operating cost per unit"),
    ]
    missing_scope = sorted({scope for o in cohort for scope in ("INSTALLATION", "COMMISSIONING") if scope not in (o.scope_included or [])})
    quality = {
        "sample_count": len(cohort),
        "coverage": {
            "purchase_cost": f"{len(purchases)}/{len(cohort)}" if cohort else "0/0",
            "installed_cost": f"{len(installed)}/{len(cohort)}" if cohort else "0/0",
            "annual_opex_y1": f"{len(opex_values)}/{len(cohort)}" if cohort else "0/0",
        },
        "missing_scope": missing_scope,
        "basis": "per_unit",
        "currency": cohort[0].currency if cohort else None,
        "evidence_cutoff": cutoff.isoformat(),
    }
    manifest_hash = sha256(
        {
            "requirement_revision_id": revision.id,
            "observations": sorted(o.id for o in cohort),
            "normalization_version": "norm-v1",
            "cutoff": cutoff.isoformat(),
        }
    )
    sufficient = len(cohort) >= get_settings().benchmark_min_sample
    run = BenchmarkRun(
        tenant_id=p.tenant_id,
        created_by=p.email,
        requirement_revision_id=revision.id,
        cohort_json={"equipment_class_id": requirement.equipment_class_id, "duty": revision.duty, "capacity": dstr(revision.capacity), "count": len(cohort)},
        normalization_version="norm-v1",
        evidence_cutoff=cutoff,
        input_manifest_hash=manifest_hash,
        observation_ids=[o.id for o in cohort],
        excluded_json=excluded,
        quality_json=quality,
        sample_count=len(cohort),
        state="PUBLISHED" if sufficient else "INSUFFICIENT_EVIDENCE",
    )
    db.add(run)
    db.flush()
    results = []
    for code, values, label in metrics:
        stats = _stats(values)
        result = BenchmarkResult(
            tenant_id=p.tenant_id,
            created_by=p.email,
            benchmark_run_id=run.id,
            metric_code=code,
            basis=f"per_unit|{cohort[0].currency if cohort else 'USD'}|2026",
            value_min=stats["min"],
            value_median=stats["median"],
            value_max=stats["max"],
            unit="currency",
            sample_count=len(values),
            coverage_note=label + ("" if values else " (no evidence)"),
        )
        db.add(result)
        results.append(result)
    db.flush()
    if sufficient:
        publish_event(db, p.tenant_id, "BenchmarkPublished", "benchmark_run", run.id, {"benchmark_run_id": run.id, "sample_count": len(cohort)}, version=1)
    audit(db, p, "BENCHMARK_RUN_CREATED", "benchmark_run", run.id, after={"state": run.state, "sample_count": len(cohort)})
    return {"run": row(run), "results": [row(r) for r in results], "excluded": excluded, "quality": quality}


def get_benchmark_run(db: Session, p: Principal, run_id: str) -> dict:
    run = get_row(db, BenchmarkRun, run_id, p, "Benchmark run")
    results = db.scalars(select(BenchmarkResult).where(BenchmarkResult.benchmark_run_id == run.id))
    return {"run": row(run), "results": [row(r) for r in results], "excluded": run.excluded_json or [], "quality": run.quality_json or {}}


# ---------------------------------------------------------------- reuse & reservation


def _unit_purchase_cost(db: Session, unit: PhysicalUnit) -> Decimal | None:
    if not unit.po_line_id:
        return None
    line = db.get(PoLine, unit.po_line_id)
    return line.unit_price if line else None


def reuse_candidates(db: Session, p: Principal, revision_id: str) -> list[dict]:
    revision = get_row(db, RequirementRevision, revision_id, p, "Requirement revision")
    requirement = requirement_of_revision(db, revision.id)
    model_ids = [m.id for m in db.scalars(select(ItemModel).where(ItemModel.tenant_id == p.tenant_id, ItemModel.equipment_class_id == requirement.equipment_class_id))]
    units = db.scalars(
        select(PhysicalUnit).where(
            PhysicalUnit.tenant_id == p.tenant_id,
            PhysicalUnit.item_model_id.in_(model_ids),
            PhysicalUnit.state.in_(("RECEIVED", "IN_TRANSIT", "INSTALLED", "RETURNED", "IN_REPAIR")),
            PhysicalUnit.condition.in_(("NEW", "GOOD", "REPAIRABLE")),
        )
    )
    out = []
    for unit in units:
        if not p.can_see_project(unit.assigned_project_id):
            continue
        active = db.scalar(select(Reservation).where(Reservation.tenant_id == p.tenant_id, Reservation.unit_id == unit.id, Reservation.state == "ACTIVE"))
        if active:
            continue
        project = db.get(Project, unit.assigned_project_id) if unit.assigned_project_id else None
        from app.models import Location

        custody = db.get(Location, unit.custody_location_id) if unit.custody_location_id else None
        out.append(
            {
                "unit": row(unit, item_code=unit.item_model.item_code if unit.item_model else None),
                "project_code": project.code if project else None,
                "custody_code": custody.code if custody else None,
                "condition": unit.condition,
                "available_from": (date.today() + timedelta(days=30)).isoformat(),
                "active_reservation": None,
                "purchase_cost": dstr(_unit_purchase_cost(db, unit)) if p.can_see_commercial else None,
            }
        )
    return out


def assess_reuse(db: Session, p: Principal, body: dict) -> dict:
    revision = get_row(db, RequirementRevision, need(body, "requirement_revision_id"), p, "Requirement revision")
    unit = get_row(db, PhysicalUnit, need(body, "unit_id"), p, "Unit")
    transfer = dec(body.get("transfer_cost"), "transfer_cost", required=True)
    refurb = dec(body.get("refurbishment_cost"), "refurbishment_cost", required=True)
    retest = dec(body.get("retest_cost"), "retest_cost", required=True)
    new_cost = dec(body.get("forward_new_cost"), "forward_new_cost", required=True)
    sunk = _unit_purchase_cost(db, unit) or Decimal(0)
    assessment = ReuseAssessment(
        tenant_id=p.tenant_id,
        created_by=p.email,
        requirement_revision_id=revision.id,
        unit_id=unit.id,
        state="ASSESSED",
        suitability_json={"sunk_cost_excluded": True, "basis": "forward-looking only"},
        available_from=optional_date(body.get("available_from")) or date.today(),
        currency=body.get("currency") or "USD",
        transfer_cost=transfer,
        refurbishment_cost=refurb,
        retest_cost=retest,
        forward_reuse_cost=(transfer + refurb + retest).quantize(MONEY_Q),
        forward_new_cost=new_cost,
        sunk_cost_excluded=sunk,
    )
    db.add(assessment)
    db.flush()
    audit(db, p, "REUSE_ASSESSED", "reuse_assessment", assessment.id, after={"forward_reuse_cost": dstr(assessment.forward_reuse_cost)})
    return row(assessment)


def decide_reuse(db: Session, p: Principal, assessment_id: str, approve: bool, body: dict) -> dict:
    assessment = get_row(db, ReuseAssessment, assessment_id, p, "Reuse assessment")
    if assessment.state not in ("ASSESSED", "CANDIDATE"):
        raise Conflict("INVALID_STATE", f"Assessment is {assessment.state}")
    if not approve:
        assessment.state = "REJECTED"
        assessment.decision_reason = body.get("reason")
        assessment.approved_by = p.email
        audit(db, p, "REUSE_REJECTED", "reuse_assessment", assessment.id, reason=body.get("reason"))
        return row(assessment)
    revision = db.get(RequirementRevision, assessment.requirement_revision_id)
    requirement = db.get(Requirement, revision.requirement_id)
    reservation = _create_reservation(db, p, assessment.unit_id, requirement.project_id, requirement.id, authority="HUB")
    assessment.state = "APPROVED"
    assessment.reservation_id = reservation.id
    assessment.approved_by = p.email
    assessment.decision_reason = body.get("reason")
    audit(db, p, "REUSE_APPROVED", "reuse_assessment", assessment.id, after={"reservation_id": reservation.id})
    return row(assessment, reservation=row(reservation))


def _create_reservation(db: Session, p: Principal, unit_id: str, project_id: str, requirement_id: str | None, authority: str = "HUB") -> Reservation:
    unit = get_row(db, PhysicalUnit, unit_id, p, "Unit")
    existing = db.scalar(select(Reservation).where(Reservation.tenant_id == p.tenant_id, Reservation.unit_id == unit.id, Reservation.state == "ACTIVE"))
    if existing:
        raise Conflict("UNIT_ALREADY_RESERVED", f"Unit {unit.asset_code} already has an active reservation")
    reservation = Reservation(
        tenant_id=p.tenant_id,
        created_by=p.email,
        unit_id=unit.id,
        requirement_id=requirement_id,
        project_id=project_id,
        authority=authority,
        approved_by=p.email,
    )
    db.add(reservation)
    try:
        db.flush()
    except IntegrityError as exc:
        db.rollback()
        raise Conflict("UNIT_ALREADY_RESERVED", "Unit was reserved concurrently") from exc
    audit(db, p, "RESERVATION_CREATED", "reservation", reservation.id, after={"unit_id": unit.id, "project_id": project_id})
    return reservation


def create_reservation(db: Session, p: Principal, body: dict) -> dict:
    reservation = _create_reservation(db, p, need(body, "unit_id"), need(body, "project_id"), body.get("requirement_id"))
    return row(reservation)


def release_reservation(db: Session, p: Principal, reservation_id: str) -> dict:
    reservation = get_row(db, Reservation, reservation_id, p, "Reservation")
    if reservation.state != "ACTIVE":
        raise Conflict("INVALID_STATE", f"Reservation is {reservation.state}")
    reservation.state = "RELEASED"
    bump(reservation)
    audit(db, p, "RESERVATION_RELEASED", "reservation", reservation.id)
    return row(reservation)


def list_reservations(db: Session, p: Principal, unit_id: str | None = None) -> list[dict]:
    q = select(Reservation).where(Reservation.tenant_id == p.tenant_id).order_by(Reservation.created_at.desc())
    if unit_id:
        q = q.where(Reservation.unit_id == unit_id)
    return [row(r) for r in db.scalars(q)]
