"""Step 1 -> PCX feed: pull the Step 1 register and turn classified long-lead records into DRAFT requirements.

The whole run is one DB transaction owned by the caller (this module never commits). All HTTP fetching happens
before the first write, so an unreachable Step 1 leaves nothing behind but a FAILED run row.
"""

from __future__ import annotations

import hashlib
import json
from decimal import Decimal, InvalidOperation
from typing import Any

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.core.auth import Principal
from app.core.errors import DomainError
from app.integrations.exceptions import auto_resolve, open_exception
from app.integrations.step1.client import Step1Client, Step1Unavailable
from app.models import (
    EquipmentClass,
    ExternalObjectLink,
    IntegrationException,
    Project,
    Requirement,
    Step1ItemClass,
    Step1SyncRun,
    WbsElement,
    utcnow,
)
from app.services import planning
from app.services.helpers import approved_revision, audit, latest_requirement_revision
from app.services.step1_items import see_item

SOURCE = "STEP1"
SOURCE_BOQ_KEY = "STEP1"
OBJECT_TYPE = "inventory_record"  # ExternalObjectLink.object_type only
EXC_SUBJECT = "step1_record"  # subject_type of every record-level exception (subject_id = inventory_record_id)
OWNER_ROLE = "ESTIMATOR"
TITLE_MAX = 300
COUNT_KEYS = ("created", "revised", "unchanged", "queued", "ignored", "exceptions", "skipped_projects")
STEP1_REVISION_FIELDS = ("quantity", "uom", "cost_code", "specification_json")  # the revision fields Step 1 owns
REPLACED_REASON = "Replaced by Step 1 sync"
RESOLVED_IN_STEP1 = "Resolved in Step 1"
OPEN_REVISION_STATES = ("DRAFT", "IN_REVIEW")


# ---------------------------------------------------------------- pure helpers


def _parse_quantity(value: Any) -> Decimal | None:
    """Exact decimal from a register quantity; None when missing or not a finite number. Never goes through float."""
    if value is None or isinstance(value, bool):
        return None
    try:
        qty = Decimal(str(value).strip())
    except (InvalidOperation, ValueError):
        return None
    return qty if qty.is_finite() else None


def _canonical_quantity(qty: Decimal) -> str:
    """'6.000000', '6' and '6.0' all become '6'; '600' stays '600' (no exponent)."""
    text = format(qty.normalize(), "f")
    return "0" if text in ("-0", "") else text


def _trimmed(value: Any) -> str | None:
    return value.strip() if isinstance(value, str) else value


def change_hash(reg: dict) -> str:
    """sha256 of the canonical JSON of the Step 1 fields PCX consumes (spec §6.2)."""
    qty = _parse_quantity(reg.get("boq_quantity"))
    payload = {
        "quantity": _canonical_quantity(qty) if qty is not None else reg.get("boq_quantity"),
        "uom": reg.get("normalized_uom"),
        "cost_code": reg.get("cost_code"),
        "work_package_code": reg.get("work_package_code"),
        "budget_code": reg.get("budget_code"),
        "item_description": _trimmed(reg.get("item_description")),
        "specification": _trimmed(reg.get("specification")),
    }
    canonical = json.dumps(payload, sort_keys=True, separators=(",", ":"), ensure_ascii=False, default=str)
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def _validate_row(reg: Any) -> str | None:
    """Structural problems that make a record unusable; None when the record can be processed."""
    if not isinstance(reg, dict):
        return "Step 1 register row is not an object"
    label = reg.get("record_number") or reg.get("inventory_record_id") or "a register record"
    for key in ("item_id", "inventory_record_id", "record_number"):
        value = reg.get(key)
        if value is None or (isinstance(value, str) and not value.strip()):
            return f"Step 1 record {label} has no {key}"
    raw = reg.get("boq_quantity")
    if raw is None:
        return f"Step 1 record {label} has no quantity"
    if _parse_quantity(raw) is None:
        return f"Step 1 record {label} quantity {raw!r} is not a decimal number"
    return None


def _source_line_count(reg: dict) -> int | None:
    """``int(source_line_count or 0)``; None (treated as present) when Step 1 sends something that is not a number."""
    try:
        return int(reg.get("source_line_count") or 0)
    except (TypeError, ValueError):
        return None


def _title(reg: dict) -> str:
    description = (reg.get("item_description") or "").strip()
    return description[:TITLE_MAX].rstrip() or str(reg["record_number"])


def _boq_spec(reg: dict) -> dict:
    return {
        "record_number": reg.get("record_number"),
        "item_description": _trimmed(reg.get("item_description")),
        "specification": _trimmed(reg.get("specification")),
        "work_package_code": reg.get("work_package_code"),
        "budget_code": reg.get("budget_code"),
    }


# ---------------------------------------------------------------- lookups


def _match_projects(db: Session, tenant_id: str, s1_project: dict) -> list[Project]:
    """PCX projects whose Procore project id matches (and company id too, when both sides have one)."""
    procore_project_id = s1_project.get("procore_project_id")
    if procore_project_id in (None, ""):
        return []
    candidates = db.scalars(select(Project).where(Project.tenant_id == tenant_id, Project.procore_project_id == str(procore_project_id)))
    company = s1_project.get("procore_company_id")
    return [
        prj for prj in candidates if company in (None, "") or not prj.procore_company_id or prj.procore_company_id == str(company)
    ]


def _wbs_for(db: Session, tenant_id: str, project_id: str, cost_code: str | None) -> tuple[WbsElement | None, str | None]:
    """The one WBS element in the project with this cost code, else (None, reason)."""
    if not cost_code:
        return None, "Step 1 record has no cost code, so no WBS element can be matched"
    found = list(
        db.scalars(select(WbsElement).where(WbsElement.tenant_id == tenant_id, WbsElement.project_id == project_id, WbsElement.cost_code == cost_code))
    )
    if len(found) == 1:
        return found[0], None
    if not found:
        return None, f"No WBS element in this project has cost code {cost_code}"
    return None, f"{len(found)} WBS elements in this project share cost code {cost_code}; choose one by hand"


def _link_for(db: Session, tenant_id: str, inventory_record_id: str) -> ExternalObjectLink | None:
    return db.scalar(
        select(ExternalObjectLink).where(
            ExternalObjectLink.tenant_id == tenant_id,
            ExternalObjectLink.platform == SOURCE,
            ExternalObjectLink.company_key == "",
            ExternalObjectLink.object_type == OBJECT_TYPE,
            ExternalObjectLink.object_key == inventory_record_id,
            ExternalObjectLink.link_role == "PRIMARY",
        )
    )


# ---------------------------------------------------------------- the run


class _Run:
    """Per-run tallies; every exception the sync raises goes through ``exception`` so it is counted once."""

    def __init__(self, db: Session, p: Principal) -> None:
        self.db = db
        self.p = p
        self.counts = dict.fromkeys(COUNT_KEYS, 0)
        self.reconciliation = 0  # RECONCILIATION notes: counted in "exceptions" but they do not make the run PARTIAL

    @property
    def state(self) -> str:
        return "PARTIAL" if self.counts["exceptions"] > self.reconciliation else "SUCCEEDED"

    def exception(self, kind: str, subject_type: str, subject_id: str, message: str) -> None:
        open_exception(
            self.db,
            self.p.tenant_id,
            source=SOURCE,
            kind=kind,
            subject_type=subject_type,
            subject_id=subject_id,
            message=message,
            owner_role=OWNER_ROLE,
            actor=self.p.email,
        )
        self.counts["exceptions"] += 1
        if kind == "RECONCILIATION":
            self.reconciliation += 1

    def resolve(self, kind: str, subject_type: str, subject_id: str, resolution: str = RESOLVED_IN_STEP1) -> None:
        auto_resolve(self.db, self.p.tenant_id, source=SOURCE, kind=kind, subject_type=subject_type, subject_id=subject_id, resolution=resolution)

    def record_clean(self, record_id: str, requirement: Requirement) -> None:
        """The record synced without a new exception: close what Step 1 has since fixed (R6).

        MAPPING is closed only once the requirement actually has a WBS element; the sync never re-matches WBS for an
        existing requirement, so an unchanged record whose WBS is still missing keeps its MAPPING exception open.
        """
        self.resolve("VALIDATION", EXC_SUBJECT, record_id)
        if requirement.wbs_id:
            self.resolve("MAPPING", EXC_SUBJECT, record_id)


# ---------------------------------------------------------------- changes to linked records


def _quantity_text(value: Decimal | None) -> str:
    return _canonical_quantity(value) if value is not None else "unknown"


def _apply_change(db: Session, p: Principal, requirement: Requirement, link: ExternalObjectLink, reg: dict) -> str:
    """Bring a linked requirement in line with a changed Step 1 record as a new DRAFT revision (spec §6.3).

    Approved and superseded revisions are never touched. An open DRAFT/IN_REVIEW revision is replaced: it is cancelled
    with "Replaced by Step 1 sync" and its PCX-entered fields are carried into the new draft, with the Step 1 fields on
    top. ``add_revision`` copies from the approved revision and computes ``changed_fields`` against it.
    """
    latest = latest_requirement_revision(db, requirement.id)
    carry: dict[str, Any] = {}
    if latest is not None and latest.state in OPEN_REVISION_STATES:
        carry = {field: getattr(latest, field) for field in planning.REVISION_FIELDS}
        planning.cancel_revision(db, p, latest.id)
        latest.change_reason = REPLACED_REASON
    base = approved_revision(db, requirement) or latest
    old_quantity = latest.quantity if latest is not None else None
    new_quantity = _parse_quantity(reg["boq_quantity"])
    base_spec = (carry.get("specification_json") if carry else (base.specification_json if base is not None else None)) or {}
    changes = {
        **carry,
        "quantity": new_quantity,
        "uom": "EA",
        "cost_code": reg.get("cost_code"),
        "specification_json": {**base_spec, "boq": _boq_spec(reg)},
    }
    record_number = str(reg["record_number"])
    if old_quantity is not None and old_quantity == new_quantity:
        reason = f"Step 1 BOQ change: {record_number} details changed (quantity {_quantity_text(new_quantity)} unchanged)"
    else:
        reason = f"Step 1 BOQ change: {record_number} quantity {_quantity_text(old_quantity)} → {_quantity_text(new_quantity)}"
    planning.add_revision(db, p, requirement.id, {"changes": changes, "change_reason": reason})
    link.source_revision = change_hash(reg)
    link.last_synced_at = utcnow()
    db.flush()
    return "revised"


def _reconcile_dropped(db: Session, p: Principal, step1_project_id: str, seen_record_ids: set[str]) -> int:
    """RECONCILIATION exception for each linked record no longer in this Step 1 project's register; returns how many.

    A record counts as present only when the run processed it (``source_line_count > 0``). Present records get any
    earlier "dropped" exception resolved. The requirement is never cancelled. A cancelled requirement needs no note.
    """
    dropped = 0
    links = db.scalars(
        select(ExternalObjectLink).where(
            ExternalObjectLink.tenant_id == p.tenant_id,
            ExternalObjectLink.platform == SOURCE,
            ExternalObjectLink.company_key == "",
            ExternalObjectLink.project_key == step1_project_id,
            ExternalObjectLink.object_type == OBJECT_TYPE,
            ExternalObjectLink.link_role == "PRIMARY",
        )
    )
    for link in links:
        requirement = db.get(Requirement, link.domain_id) if link.domain_type == "requirement" else None
        present = link.object_key in seen_record_ids
        if present or requirement is None or requirement.tenant_id != p.tenant_id or requirement.state != "ACTIVE":
            auto_resolve(
                db,
                p.tenant_id,
                source=SOURCE,
                kind="RECONCILIATION",
                subject_type=EXC_SUBJECT,
                subject_id=link.object_key,
                resolution=RESOLVED_IN_STEP1 if present else "Requirement is no longer active",
            )
            continue
        open_exception(
            db,
            p.tenant_id,
            source=SOURCE,
            kind="RECONCILIATION",
            subject_type=EXC_SUBJECT,
            subject_id=link.object_key,
            message=f"Source BOQ no longer contains {requirement.source_line_key}; requirement {requirement.code} is unchanged. Review whether it is still needed.",
            owner_role=OWNER_ROLE,
            actor=p.email,
        )
        dropped += 1
    return dropped


def _cancelled_note(run: _Run, requirement: Requirement, record_number: str) -> None:
    run.exception(
        "RECONCILIATION",
        "requirement",
        requirement.id,
        f"Requirement {requirement.code} is cancelled, but Step 1 still lists {record_number}; Step 1 changes are not applied to it.",
    )


def _apply_record(run: _Run, project: Project, step1_project_id: str, reg: dict, index: int) -> None:
    db, p = run.db, run.p
    problem = _validate_row(reg)
    if problem:
        subject = (reg.get("inventory_record_id") if isinstance(reg, dict) else None) or f"{step1_project_id}#{index}"
        run.exception("VALIDATION", EXC_SUBJECT, str(subject), problem)
        return

    record_id = str(reg["inventory_record_id"])
    record_number = str(reg["record_number"])
    item = see_item(db, p.tenant_id, reg)
    if item.decision == "PENDING":
        run.counts["queued"] += 1
        return
    if item.decision == "NOT_LLE":
        run.counts["ignored"] += 1
        return

    cls = db.get(EquipmentClass, item.equipment_class_id) if item.equipment_class_id else None
    if cls is None:
        run.exception("VALIDATION", EXC_SUBJECT, record_id, f"Step 1 item {item.step1_item_id} is LLE but has no equipment class")
        return
    uom = (reg.get("normalized_uom") or "").strip()
    if uom.lower() != "each":
        run.exception(
            "VALIDATION",
            EXC_SUBJECT,
            record_id,
            f"Step 1 record {record_number} uses unit '{uom or 'none'}'; only 'each' can become a requirement",
        )
        return
    qty = _parse_quantity(reg["boq_quantity"])
    if qty <= 0:
        run.exception("VALIDATION", EXC_SUBJECT, record_id, f"Step 1 record {record_number} quantity {_canonical_quantity(qty)} must be greater than zero")
        return
    if cls.tracking == "SERIALIZED" and qty != qty.to_integral_value():
        run.exception(
            "VALIDATION",
            EXC_SUBJECT,
            record_id,
            f"Step 1 record {record_number} quantity {_canonical_quantity(qty)} is fractional, but {cls.name} is tracked by serial number",
        )
        return

    digest = change_hash(reg)
    link = _link_for(db, p.tenant_id, record_id)
    if link is not None:
        requirement = db.get(Requirement, link.domain_id) if link.domain_type == "requirement" else None
        if requirement is None or requirement.tenant_id != p.tenant_id:
            run.exception("VALIDATION", EXC_SUBJECT, record_id, f"Step 1 record {record_number} is linked to a requirement that no longer exists")
            return
        if requirement.project_id != project.id:
            run.exception(
                "VALIDATION",
                EXC_SUBJECT,
                record_id,
                f"Step 1 record {record_number} is linked to requirement {requirement.code} in another PCX project; Step 1 changes are not applied",
            )
            return
        if requirement.state != "ACTIVE":
            _cancelled_note(run, requirement, record_number)
            return
        if link.source_revision == digest:
            run.counts["unchanged"] += 1
        else:
            run.counts[_apply_change(db, p, requirement, link, reg)] += 1
        run.record_clean(record_id, requirement)
        return

    wbs, wbs_problem = _wbs_for(db, p.tenant_id, project.id, reg.get("cost_code"))
    body = {
        "project_id": project.id,
        "equipment_class_id": cls.id,
        "title": _title(reg),
        "wbs_id": wbs.id if wbs else None,
        "source_boq_key": SOURCE_BOQ_KEY,
        "source_line_key": record_number,
        "revision": {
            "quantity": _canonical_quantity(qty),
            "uom": "EA",
            "cost_code": reg.get("cost_code"),
            "specification_json": {"boq": _boq_spec(reg)},
        },
    }
    # No savepoint needed: title, quantity (> 0) and class are validated above, so create_requirement can only fail
    # before its first db.add (DUPLICATE_REQUIREMENT_CODE is raised before it). A caught error leaves no partial rows.
    try:
        result, existed = planning.create_requirement(db, p, body)
    except DomainError as exc:
        run.exception(
            "VALIDATION",
            EXC_SUBJECT,
            record_id,
            f"Step 1 record {record_number} could not become a requirement: {exc.code}: {exc.detail}",
        )
        return
    requirement = db.get(Requirement, result["requirement"]["id"])
    if existed:
        other = db.scalar(
            select(ExternalObjectLink).where(
                ExternalObjectLink.tenant_id == p.tenant_id,
                ExternalObjectLink.platform == SOURCE,
                ExternalObjectLink.domain_type == "requirement",
                ExternalObjectLink.domain_id == requirement.id,
            )
        )
        if other is not None:
            run.exception(
                "VALIDATION",
                EXC_SUBJECT,
                record_id,
                f"Step 1 record number {record_number} is already linked to another Step 1 record in this project",
            )
            return
    requirement.step1_item_id = item.step1_item_id
    db.add(
        ExternalObjectLink(
            tenant_id=p.tenant_id,
            created_by=p.email,
            platform=SOURCE,
            company_key="",
            project_key=step1_project_id,
            object_type=OBJECT_TYPE,
            object_key=record_id,
            domain_type="requirement",
            domain_id=requirement.id,
            source_revision=digest,
            sync_state="LINKED",
            last_synced_at=utcnow(),
        )
    )
    db.flush()
    if existed and requirement.state != "ACTIVE":
        _cancelled_note(run, requirement, record_number)
        return
    run.counts["unchanged" if existed else "created"] += 1
    if wbs_problem and not existed:
        run.exception("MAPPING", EXC_SUBJECT, record_id, f"Requirement {requirement.code} (Step 1 {record_number}): {wbs_problem}")
        run.resolve("VALIDATION", EXC_SUBJECT, record_id)
    else:
        run.record_clean(record_id, requirement)


def _finish(db: Session, p: Principal, started_at, state: str, projects: list[dict], counts: dict, error: str | None = None) -> Step1SyncRun:
    run = Step1SyncRun(
        tenant_id=p.tenant_id,
        created_by=p.email,
        started_at=started_at,
        finished_at=utcnow(),
        actor=p.email,
        state=state,
        projects_json=projects,
        counts_json=counts,
        error=error,
    )
    db.add(run)
    db.flush()
    return run


def _report(run: Step1SyncRun) -> dict:
    out = {"run_id": run.id, "state": run.state, "counts": dict(run.counts_json), "projects": list(run.projects_json)}
    if run.error:
        out["error"] = run.error
    return out


def sync(db: Session, p: Principal, client: Step1Client, project_ids: list[str] | None = None) -> dict:
    """Pull the Step 1 register into PCX. ``project_ids`` restricts the run to those PCX project ids. Never commits."""
    started_at = utcnow()
    wanted = set(project_ids) if project_ids is not None else None

    # Fetch phase: every HTTP call, before any write.
    plan: list[tuple[dict, Project | None, str | None, list]] = []
    try:
        for s1_project in client.projects():
            if not isinstance(s1_project, dict) or not s1_project.get("project_id"):
                continue
            matches = _match_projects(db, p.tenant_id, s1_project)
            if wanted is not None and not any(prj.id in wanted for prj in matches):
                continue
            if not matches:
                plan.append((s1_project, None, "No PCX project has this Procore project", []))
            elif len(matches) > 1:
                plan.append((s1_project, None, f"{len(matches)} PCX projects share this Procore project", []))
            elif not p.can_see_project(matches[0].id):
                plan.append((s1_project, None, "PCX project is outside your project scope", []))
            else:
                plan.append((s1_project, matches[0], None, client.register(str(s1_project["project_id"]))))
    except Step1Unavailable as exc:
        run = _finish(db, p, started_at, "FAILED", [], dict.fromkeys(COUNT_KEYS, 0), error=str(exc) or "Step 1 unavailable")
        return _report(run)

    # Apply phase.
    tally = _Run(db, p)
    projects: list[dict] = []
    for s1_project, project, reason, rows in plan:
        step1_project_id = str(s1_project["project_id"])
        if project is None:
            tally.counts["skipped_projects"] += 1
            projects.append({"step1_project_id": step1_project_id, "pcx_project_id": None, "status": "skipped", "reason": reason})
            continue
        seen_record_ids: set[str] = set()
        for index, reg in enumerate(rows):
            # Dropped records (source_line_count 0) are treated as absent by the change rules, never validated here.
            if isinstance(reg, dict) and _source_line_count(reg) == 0:
                continue
            if isinstance(reg, dict) and reg.get("inventory_record_id"):
                seen_record_ids.add(str(reg["inventory_record_id"]))
            _apply_record(tally, project, step1_project_id, reg, index)
        dropped = _reconcile_dropped(db, p, step1_project_id, seen_record_ids)
        tally.counts["exceptions"] += dropped
        tally.reconciliation += dropped
        projects.append({"step1_project_id": step1_project_id, "pcx_project_id": project.id, "status": "synced"})

    state = tally.state
    run = _finish(db, p, started_at, state, projects, tally.counts)
    audit(db, p, "STEP1_SYNC_RUN", "step1_sync_run", run.id, after={"state": state, "counts": tally.counts})
    return _report(run)


def _run_dict(run: Step1SyncRun) -> dict:
    return {
        "id": run.id,
        "started_at": run.started_at.isoformat() if run.started_at else None,
        "finished_at": run.finished_at.isoformat() if run.finished_at else None,
        "actor": run.actor,
        "state": run.state,
        "projects_json": list(run.projects_json or []),
        "counts_json": dict(run.counts_json or {}),
        "error": run.error,
    }


def list_runs(db: Session, p: Principal, limit: int = 20) -> list[dict]:
    """Sync runs for the caller's tenant, newest first."""
    stmt = select(Step1SyncRun).where(Step1SyncRun.tenant_id == p.tenant_id).order_by(Step1SyncRun.started_at.desc(), Step1SyncRun.id.desc()).limit(limit)
    return [_run_dict(r) for r in db.scalars(stmt)]


def status(db: Session, p: Principal, configured: bool) -> dict:
    """Feed health for the Administration page: last run, items awaiting a decision, open STEP1 exceptions."""
    last = list_runs(db, p, limit=1)
    pending = db.scalar(select(func.count()).select_from(Step1ItemClass).where(Step1ItemClass.tenant_id == p.tenant_id, Step1ItemClass.decision == "PENDING"))
    open_exceptions = db.scalar(
        select(func.count()).select_from(IntegrationException).where(IntegrationException.tenant_id == p.tenant_id, IntegrationException.source == SOURCE, IntegrationException.state == "OPEN")
    )
    return {"configured": configured, "last_run": last[0] if last else None, "pending_items": pending or 0, "open_exceptions": open_exceptions or 0}
