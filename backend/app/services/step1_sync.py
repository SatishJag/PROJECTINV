"""Step 1 -> PCX feed: pull the Step 1 register and turn classified long-lead records into DRAFT requirements.

The whole run is one DB transaction owned by the caller (this module never commits). All HTTP fetching happens
before the first write, so an unreachable Step 1 leaves nothing behind but a FAILED run row.
"""

from __future__ import annotations

import hashlib
import json
from decimal import Decimal, InvalidOperation
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.auth import Principal
from app.core.errors import DomainError
from app.integrations.exceptions import open_exception
from app.integrations.step1.client import Step1Client, Step1Unavailable
from app.models import (
    EquipmentClass,
    ExternalObjectLink,
    Project,
    Requirement,
    Step1SyncRun,
    WbsElement,
    utcnow,
)
from app.services import planning
from app.services.helpers import audit
from app.services.step1_items import see_item

SOURCE = "STEP1"
SOURCE_BOQ_KEY = "STEP1"
OBJECT_TYPE = "inventory_record"
OWNER_ROLE = "ESTIMATOR"
TITLE_MAX = 300
COUNT_KEYS = ("created", "revised", "unchanged", "queued", "ignored", "exceptions", "skipped_projects")


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


def _apply_record(run: _Run, project: Project, step1_project_id: str, reg: dict, index: int) -> None:
    db, p = run.db, run.p
    problem = _validate_row(reg)
    if problem:
        subject = (reg.get("inventory_record_id") if isinstance(reg, dict) else None) or f"{step1_project_id}#{index}"
        run.exception("VALIDATION", OBJECT_TYPE, str(subject), problem)
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
        run.exception("VALIDATION", OBJECT_TYPE, record_id, f"Step 1 item {item.step1_item_id} is LLE but has no equipment class")
        return
    uom = (reg.get("normalized_uom") or "").strip()
    if uom.lower() != "each":
        run.exception(
            "VALIDATION",
            OBJECT_TYPE,
            record_id,
            f"Step 1 record {record_number} uses unit '{uom or 'none'}'; only 'each' can become a requirement",
        )
        return
    qty = _parse_quantity(reg["boq_quantity"])
    if qty <= 0:
        run.exception("VALIDATION", OBJECT_TYPE, record_id, f"Step 1 record {record_number} quantity {_canonical_quantity(qty)} must be greater than zero")
        return
    if cls.tracking == "SERIALIZED" and qty != qty.to_integral_value():
        run.exception(
            "VALIDATION",
            OBJECT_TYPE,
            record_id,
            f"Step 1 record {record_number} quantity {_canonical_quantity(qty)} is fractional, but {cls.name} is tracked by serial number",
        )
        return

    digest = change_hash(reg)
    link = _link_for(db, p.tenant_id, record_id)
    if link is not None:
        if link.source_revision == digest:
            run.counts["unchanged"] += 1
        # A changed hash is handled by the change rules (revise / replace), not by creation.
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
            "step1_record",
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
                OBJECT_TYPE,
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
    run.counts["unchanged" if existed else "created"] += 1
    if wbs_problem and not existed:
        run.exception("MAPPING", "requirement", requirement.id, f"Requirement {requirement.code} (Step 1 {record_number}): {wbs_problem}")


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
        for index, reg in enumerate(rows):
            # Dropped records (source_line_count 0) are treated as absent by the change rules, never validated here.
            if isinstance(reg, dict) and _source_line_count(reg) == 0:
                continue
            _apply_record(tally, project, step1_project_id, reg, index)
        projects.append({"step1_project_id": step1_project_id, "pcx_project_id": project.id, "status": "synced"})

    state = "PARTIAL" if tally.counts["exceptions"] else "SUCCEEDED"
    run = _finish(db, p, started_at, state, projects, tally.counts)
    audit(db, p, "STEP1_SYNC_RUN", "step1_sync_run", run.id, after={"state": state, "counts": tally.counts})
    return _report(run)
