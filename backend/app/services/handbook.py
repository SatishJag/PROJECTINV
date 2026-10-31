"""Handbook packages: evidence, criteria validation, waiver, approval, immutable publication,
FM acceptance and recipient export (FR15, FR16, T22-T25)."""

from __future__ import annotations

from datetime import date

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.api.common import row
from app.core.auth import Principal
from app.core.commands import bump, check_if_match
from app.core.errors import Conflict, DomainError, Forbidden
from app.core.outbox import enqueue, publish_event
from app.models import (
    BomLine,
    EvidenceDocument,
    HandbookCriterion,
    HandbookEntry,
    HandbookPackage,
    HandbookTemplate,
    ItemModel,
    PhysicalUnit,
    TestRecord,
    UnitComponent,
    utcnow,
)
from app.services.delivery import unit_scoped
from app.services.helpers import audit, get_row, need, optional_date, sha256

DECISIONS = ("ACCEPTED", "CONDITIONAL", "REJECTED")


def _template_criteria(db: Session, template_id: str) -> list[HandbookCriterion]:
    return list(
        db.scalars(
            select(HandbookCriterion).where(HandbookCriterion.template_id == template_id).order_by(HandbookCriterion.section, HandbookCriterion.criterion_code)
        )
    )


def _evidence_out(doc: EvidenceDocument) -> dict:
    return row(doc, content_hash=doc.content_hash)


def list_templates(db: Session, p: Principal) -> list[dict]:
    out = []
    for template in db.scalars(
        select(HandbookTemplate).where(HandbookTemplate.tenant_id == p.tenant_id).order_by(HandbookTemplate.template_code, HandbookTemplate.revision_no.desc())
    ):
        criteria = [
            row(c)
            for c in _template_criteria(db, template.id)
            if p.can_see_commercial or not c.commercial
        ]
        out.append(row(template, criteria=criteria))
    return out


def create_evidence(db: Session, p: Principal, body: dict) -> dict:
    unit = unit_scoped(db, p, need(body, "unit_id"))
    commercial = bool(body.get("commercial"))
    if commercial and not p.can_see_commercial:
        raise Forbidden("Commercial evidence requires a commercial role")
    doc = EvidenceDocument(
        tenant_id=p.tenant_id,
        created_by=p.email,
        unit_id=unit.id,
        doc_type=str(need(body, "doc_type")).upper(),
        title=str(need(body, "title")),
        revision=str(body.get("revision") or "A"),
        model_ref=body.get("model_ref"),
        serial_ref=body.get("serial_ref"),
        expires_at=optional_date(body.get("expires_at")),
        storage_ref=body.get("storage_ref"),
        commercial=commercial,
        content_hash=sha256(
            {
                "unit": unit.id,
                "doc_type": body.get("doc_type"),
                "title": body.get("title"),
                "revision": body.get("revision") or "A",
                "model_ref": body.get("model_ref"),
                "serial_ref": body.get("serial_ref"),
                "storage_ref": body.get("storage_ref"),
            }
        ),
    )
    db.add(doc)
    db.flush()
    audit(db, p, "EVIDENCE_ADDED", "evidence_document", doc.id, after={"unit": unit.asset_code, "doc_type": doc.doc_type})
    return _evidence_out(doc)


def approve_evidence(db: Session, p: Principal, evidence_id: str) -> dict:
    if not p.has("ENGINEERING", "PROCUREMENT", "OWNER"):
        raise Forbidden("Requires ENGINEERING, PROCUREMENT or OWNER")
    doc = get_row(db, EvidenceDocument, evidence_id, p, "Evidence document")
    if doc.commercial and not p.can_see_commercial:
        raise Forbidden("Commercial evidence requires a commercial role")
    doc.approved = True
    doc.approved_by = p.email
    audit(db, p, "EVIDENCE_APPROVED", "evidence_document", doc.id)
    return _evidence_out(doc)


def list_evidence(db: Session, p: Principal, unit_id: str | None = None) -> list[dict]:
    query = select(EvidenceDocument).where(EvidenceDocument.tenant_id == p.tenant_id).order_by(EvidenceDocument.created_at.desc())
    if unit_id:
        unit = unit_scoped(db, p, unit_id)
        query = query.where(EvidenceDocument.unit_id == unit.id)
    return [_evidence_out(doc) for doc in db.scalars(query) if p.can_see_commercial or not doc.commercial]


def _pick_template(db: Session, p: Principal, unit: PhysicalUnit, template_id: str | None) -> HandbookTemplate:
    if template_id:
        template = get_row(db, HandbookTemplate, template_id, p, "Handbook template")
        if template.state != "APPROVED":
            raise Conflict("TEMPLATE_NOT_APPROVED", f"Template {template.template_code} is {template.state}")
        return template
    if unit.item_model is None:
        raise Conflict("MODEL_MISSING", "The unit has no item model")
    template = db.scalar(
        select(HandbookTemplate)
        .where(
            HandbookTemplate.tenant_id == p.tenant_id,
            HandbookTemplate.equipment_class_id == unit.item_model.equipment_class_id,
            HandbookTemplate.state == "APPROVED",
        )
        .order_by(HandbookTemplate.revision_no.desc())
    )
    if template is None:
        raise DomainError("TEMPLATE_NOT_FOUND", "No approved handbook template for this equipment class", status=404)
    return template


def create_package(db: Session, p: Principal, body: dict) -> dict:
    unit = unit_scoped(db, p, need(body, "unit_id"))
    existing = db.scalar(select(HandbookPackage).where(HandbookPackage.tenant_id == p.tenant_id, HandbookPackage.unit_id == unit.id))
    if existing:
        raise Conflict("HANDBOOK_EXISTS", f"A handbook package already exists for {unit.asset_code}; use new-version")
    template = _pick_template(db, p, unit, body.get("template_id"))
    package = HandbookPackage(
        tenant_id=p.tenant_id,
        created_by=p.email,
        unit_id=unit.id,
        template_id=template.id,
        version_no=1,
        state="DRAFT",
        evidence_cutoff=utcnow(),
    )
    db.add(package)
    db.flush()
    for criterion in _template_criteria(db, template.id):
        db.add(HandbookEntry(tenant_id=p.tenant_id, created_by=p.email, package_id=package.id, criterion_id=criterion.id, validation="PENDING", owner_role=criterion.responsible_role))
    db.flush()
    audit(db, p, "HANDBOOK_CREATED", "handbook_package", package.id, after={"unit": unit.asset_code, "template": template.template_code})
    return get_package(db, p, package.id)


def _package_row(db: Session, p: Principal, package: HandbookPackage) -> dict:
    unit = db.get(PhysicalUnit, package.unit_id)
    template = db.get(HandbookTemplate, package.template_id)
    return row(package, manifest_json=package.manifest_json, unit=row(unit, item_code=unit.item_model.item_code if unit and unit.item_model else None), template=row(template))


def _entry_rows(db: Session, p: Principal, package_id: str) -> list[dict]:
    out = []
    entries = db.scalars(select(HandbookEntry).where(HandbookEntry.package_id == package_id))
    for entry in entries:
        criterion = db.get(HandbookCriterion, entry.criterion_id)
        if criterion is None:
            continue
        if criterion.commercial and not p.can_see_commercial:
            continue
        out.append(row(entry) | {"criterion": row(criterion)})
    return sorted(out, key=lambda e: (e["criterion"]["section"], e["criterion"]["criterion_code"]))


def get_package(db: Session, p: Principal, package_id: str) -> dict:
    package = get_row(db, HandbookPackage, package_id, p, "Handbook package")
    unit = unit_scoped(db, p, package.unit_id)
    entries = _entry_rows(db, p, package.id)
    blockers = [
        {
            "entry_id": e["id"],
            "criterion_code": e["criterion"]["criterion_code"],
            "title": e["criterion"]["title"],
            "validation": e["validation"],
            "message": e["message"],
            "critical": e["criterion"]["critical"],
            "owner_role": e["criterion"]["responsible_role"],
        }
        for e in entries
        if e["validation"] in ("FAIL", "MISSING") and (e["criterion"]["mandatory"] or e["criterion"]["critical"])
    ]
    return _package_row(db, p, package) | {"unit": row(unit), "entries": entries, "blockers": blockers}


def list_packages(db: Session, p: Principal, unit_id: str | None = None, state: str | None = None) -> list[dict]:
    query = select(HandbookPackage).where(HandbookPackage.tenant_id == p.tenant_id).order_by(HandbookPackage.created_at.desc())
    if unit_id:
        query = query.where(HandbookPackage.unit_id == unit_id)
    if state:
        query = query.where(HandbookPackage.state == state)
    out = []
    for package in db.scalars(query):
        unit = db.get(PhysicalUnit, package.unit_id)
        if unit and not p.can_see_project(unit.assigned_project_id):
            continue
        out.append(_package_row(db, p, package))
    return out


def _field_rule(db: Session, unit: PhysicalUnit, field: str) -> tuple[str, str | None]:
    value = None
    if field == "serial_number":
        value = unit.serial_number
    elif field in ("barcode", "asset_tag"):
        value = unit.barcode or unit.asset_code
    elif field == "installed_position":
        value = unit.installed_position
    elif field == "warranty_end":
        value = unit.warranty_end
    elif field == "purchase_cost":
        from app.services import costs

        summary = costs.unit_summary(db, Principal(user_id="system", tenant_id=unit.tenant_id, email="system", name="system", roles=frozenset({"ADMIN"})), unit.id)
        value = summary["recognized_total"] or summary["provisional_total"]
    if value in (None, ""):
        return "MISSING", f"{field} is not recorded"
    return "PASS", None


def _document_rule(db: Session, unit: PhysicalUnit, rule: dict) -> tuple[str, str | None, str | None]:
    doc_type = rule.get("doc_type")
    docs = list(
        db.scalars(
            select(EvidenceDocument).where(EvidenceDocument.tenant_id == unit.tenant_id, EvidenceDocument.unit_id == unit.id, EvidenceDocument.doc_type == doc_type)
        )
    )
    if not docs:
        return "MISSING", f"No {doc_type} document is attached", None
    match = rule.get("match")
    relevant = []
    for doc in docs:
        if match == "MODEL" and unit.item_model and doc.model_ref != unit.item_model.item_code:
            continue
        if match == "SERIAL" and doc.serial_ref != unit.serial_number:
            continue
        relevant.append(doc)
    if not relevant:
        target = unit.item_model.item_code if match == "MODEL" else unit.serial_number
        return "FAIL", f"Attached {doc_type} does not match {target}", None
    for doc in sorted(relevant, key=lambda d: d.created_at, reverse=True):
        if rule.get("require_approved") and not doc.approved:
            continue
        if rule.get("not_expired") and doc.expires_at and doc.expires_at < date.today():
            continue
        return "PASS", None, doc.storage_ref or doc.id
    return "FAIL", f"{doc_type} is present but not approved or has expired", relevant[0].storage_ref or relevant[0].id


def _test_rule(db: Session, unit: PhysicalUnit, rule: dict) -> tuple[str, str | None, str | None]:
    tests = list(
        db.scalars(
            select(TestRecord).where(TestRecord.tenant_id == unit.tenant_id, TestRecord.unit_id == unit.id, TestRecord.test_type == rule.get("test_type"))
        )
    )
    if not tests:
        return "MISSING", f"No {rule.get('test_type')} record", None
    passed = [t for t in tests if t.result == "PASS"]
    if passed:
        return "PASS", None, passed[-1].test_ref
    return "FAIL", f"Latest {rule.get('test_type')} result is {tests[-1].result}", tests[-1].test_ref


def _structure_rule(db: Session, unit: PhysicalUnit, rule: dict) -> tuple[str, str | None]:
    if not rule.get("require_all_tracked_slots"):
        return "PASS", None
    if unit.item_model is None:
        return "FAIL", "The unit has no item model"
    slots = [
        line.slot_code
        for line in db.scalars(
            select(BomLine).where(BomLine.parent_model_id == unit.item_model_id, BomLine.individually_tracked.is_(True))
        )
    ]
    if not slots:
        return "PASS", "No individually tracked BOM slots"
    fitted = set(
        db.scalars(
            select(UnitComponent.slot_code).where(UnitComponent.parent_unit_id == unit.id, UnitComponent.valid_to.is_(None))
        )
    )
    missing = sorted(set(slots) - fitted)
    if missing:
        return ("MISSING" if len(missing) == len(slots) else "FAIL"), f"Slots not fitted: {', '.join(missing)}"
    return "PASS", None


def _evaluate_entry(db: Session, unit: PhysicalUnit, criterion: HandbookCriterion) -> tuple[str, str | None, str | None]:
    rule = criterion.rule_json or {}
    if criterion.kind == "FIELD":
        validation, message = _field_rule(db, unit, rule.get("field", ""))
        return validation, message, None
    if criterion.kind == "DOCUMENT":
        return _document_rule(db, unit, rule)
    if criterion.kind == "TEST":
        return _test_rule(db, unit, rule)
    if criterion.kind == "STRUCTURE":
        validation, message = _structure_rule(db, unit, rule)
        return validation, message, None
    return "FAIL", f"Unknown criterion kind {criterion.kind}", None


def _recompute_state(db: Session, package: HandbookPackage) -> None:
    blocked = False
    entries = []
    for entry in db.scalars(select(HandbookEntry).where(HandbookEntry.package_id == package.id)):
        criterion = db.get(HandbookCriterion, entry.criterion_id)
        if criterion is None:
            continue
        if entry.validation in ("FAIL", "MISSING") and (criterion.mandatory or criterion.critical):
            blocked = True
        entries.append(
            {
                "criterion_code": criterion.criterion_code,
                "critical": criterion.critical,
                "mandatory": criterion.mandatory,
                "commercial": criterion.commercial,
                "validation": entry.validation,
                "source_ref": entry.source_ref,
                "source_revision": entry.source_revision,
                "content_hash": entry.content_hash,
            }
        )
    package.state = "BLOCKED" if blocked else "READY"
    package.manifest_json = {
        "unit_id": package.unit_id,
        "template_id": package.template_id,
        "version_no": package.version_no,
        "evidence_cutoff": package.evidence_cutoff.isoformat() if package.evidence_cutoff else None,
        "entries": sorted(entries, key=lambda e: e["criterion_code"]),
    }
    bump(package)


def validate_package(db: Session, p: Principal, package_id: str) -> dict:
    package = get_row(db, HandbookPackage, package_id, p, "Handbook package")
    if package.state == "PUBLISHED":
        raise Conflict("IMMUTABLE", "A published handbook cannot be revalidated; create a new version")
    unit = unit_scoped(db, p, package.unit_id)
    package.evidence_cutoff = utcnow()
    for entry in db.scalars(select(HandbookEntry).where(HandbookEntry.package_id == package.id)):
        criterion = db.get(HandbookCriterion, entry.criterion_id)
        if criterion is None:
            continue
        if entry.validation == "WAIVED" and (entry.waiver_expires_at is None or entry.waiver_expires_at >= date.today()):
            continue
        validation, message, source_ref = _evaluate_entry(db, unit, criterion)
        entry.validation = validation
        entry.message = message
        entry.source_ref = source_ref
        entry.owner_role = criterion.responsible_role
        if validation != "PASS" and criterion.responsible_role:
            entry.due_date = entry.due_date or date.today()
        bump(entry)
    _recompute_state(db, package)
    publish_event(db, p.tenant_id, "HandbookValidated", "handbook_package", package.id, {"unit_id": unit.id, "state": package.state})
    audit(db, p, "HANDBOOK_VALIDATED", "handbook_package", package.id, after={"state": package.state})
    return get_package(db, p, package.id)


def waive_entry(db: Session, p: Principal, package_id: str, entry_id: str, body: dict) -> dict:
    package = get_row(db, HandbookPackage, package_id, p, "Handbook package")
    if package.state == "PUBLISHED":
        raise Conflict("IMMUTABLE", "A published handbook cannot be changed; create a new version")
    entry = get_row(db, HandbookEntry, entry_id, p, "Handbook entry")
    if entry.package_id != package.id:
        raise DomainError("VALIDATION", "Entry does not belong to this package", status=422)
    criterion = db.get(HandbookCriterion, entry.criterion_id)
    if criterion and criterion.commercial and not p.can_see_commercial:
        raise Forbidden("Commercial criteria require a commercial role")
    if not p.has("OWNER", "ENGINEERING"):
        raise Forbidden("Waivers require OWNER or ENGINEERING")
    if criterion and criterion.critical and not p.has("ENGINEERING"):
        raise Forbidden("A critical criterion can only be waived by ENGINEERING")
    reason = str(need(body, "reason")).strip()
    entry.validation = "WAIVED"
    entry.waiver_reason = reason
    entry.waiver_by = p.email
    entry.waiver_expires_at = optional_date(body.get("expires_at"))
    entry.message = None
    bump(entry)
    _recompute_state(db, package)
    audit(db, p, "HANDBOOK_ENTRY_WAIVED", "handbook_entry", entry.id, reason=reason, after={"criterion": criterion.criterion_code if criterion else None})
    return get_package(db, p, package.id)


def approve_package(db: Session, p: Principal, package_id: str, if_match: str | None) -> dict:
    package = get_row(db, HandbookPackage, package_id, p, "Handbook package")
    check_if_match(package, if_match, required=True)
    if package.state != "READY":
        raise Conflict("HANDBOOK_NOT_READY", f"Handbook is {package.state}; resolve blockers before approval")
    package.state = "APPROVED"
    package.approved_by = p.email
    bump(package)
    audit(db, p, "HANDBOOK_APPROVED", "handbook_package", package.id)
    return get_package(db, p, package.id)


def publish_package(db: Session, p: Principal, package_id: str, if_match: str | None) -> dict:
    package = get_row(db, HandbookPackage, package_id, p, "Handbook package")
    check_if_match(package, if_match, required=True)
    if package.state == "PUBLISHED":
        raise Conflict("IMMUTABLE", "Handbook was already published; create a new version")
    if package.state != "APPROVED":
        raise Conflict("HANDBOOK_NOT_APPROVED", f"Handbook is {package.state}; approve before publishing")
    package.package_hash = sha256(package.manifest_json or {})
    package.state = "PUBLISHED"
    package.published_at = utcnow()
    package.acceptance_state = "PENDING"
    bump(package)
    enqueue(db, p.tenant_id, "PROCORE", "handbook.publish", "handbook_package", package.id, {"package_id": package.id, "unit_id": package.unit_id})
    enqueue(db, p.tenant_id, "PLANON", "asset.handover", "physical_unit", package.unit_id, {"unit_id": package.unit_id, "package_id": package.id})
    publish_event(db, p.tenant_id, "HandbookPublished", "handbook_package", package.id, {"unit_id": package.unit_id, "package_hash": package.package_hash})
    audit(db, p, "HANDBOOK_PUBLISHED", "handbook_package", package.id, after={"package_hash": package.package_hash})
    return get_package(db, p, package.id)


def accept_package(db: Session, p: Principal, package_id: str, body: dict) -> dict:
    if not p.has("FM"):
        raise Forbidden("Acceptance is recorded by FM")
    package = get_row(db, HandbookPackage, package_id, p, "Handbook package")
    if package.state != "PUBLISHED":
        raise Conflict("NOT_PUBLISHED", "Only a published handbook can be accepted")
    decision = str(need(body, "decision")).upper()
    if decision not in DECISIONS:
        raise DomainError("VALIDATION", f"decision must be one of {DECISIONS}")
    package.acceptance_state = decision
    package.acceptance_notes = body.get("notes")
    package.accepted_by = p.email
    bump(package)
    audit(db, p, "HANDBOOK_ACCEPTANCE", "handbook_package", package.id, after={"decision": decision})
    return get_package(db, p, package.id)


def new_version(db: Session, p: Principal, package_id: str) -> dict:
    package = get_row(db, HandbookPackage, package_id, p, "Handbook package")
    if package.state != "PUBLISHED":
        raise Conflict("NOT_PUBLISHED", "A new version is only created from a published handbook")
    latest = db.scalar(
        select(HandbookPackage)
        .where(HandbookPackage.tenant_id == p.tenant_id, HandbookPackage.unit_id == package.unit_id)
        .order_by(HandbookPackage.version_no.desc())
    )
    next_no = (latest.version_no + 1) if latest else package.version_no + 1
    clone = HandbookPackage(
        tenant_id=p.tenant_id,
        created_by=p.email,
        unit_id=package.unit_id,
        template_id=package.template_id,
        version_no=next_no,
        state="DRAFT",
        evidence_cutoff=utcnow(),
    )
    db.add(clone)
    db.flush()
    for criterion in _template_criteria(db, package.template_id):
        db.add(
            HandbookEntry(
                tenant_id=p.tenant_id,
                created_by=p.email,
                package_id=clone.id,
                criterion_id=criterion.id,
                validation="PENDING",
                owner_role=criterion.responsible_role,
            )
        )
    db.flush()
    audit(db, p, "HANDBOOK_VERSION_CREATED", "handbook_package", clone.id, after={"version_no": next_no})
    return get_package(db, p, clone.id)


def export_package(db: Session, p: Principal, package_id: str) -> dict:
    """Recipient view: allowed structured fields only, never the commercial annex (T25)."""
    package = get_row(db, HandbookPackage, package_id, p, "Handbook package")
    unit = unit_scoped(db, p, package.unit_id)
    model = unit.item_model
    sections: dict[str, list[dict]] = {}
    for entry in db.scalars(select(HandbookEntry).where(HandbookEntry.package_id == package.id)):
        criterion = db.get(HandbookCriterion, entry.criterion_id)
        if criterion is None or criterion.commercial:
            continue
        sections.setdefault(criterion.section, []).append(
            {
                "criterion_code": criterion.criterion_code,
                "title": criterion.title,
                "validation": entry.validation,
                "source_ref": entry.source_ref,
                "source_revision": entry.source_revision,
            }
        )
    manifest = package.manifest_json or {}
    buyer_project = unit.assigned_project_id
    return {
        "package_id": package.id,
        "version_no": package.version_no,
        "state": package.state,
        "package_hash": package.package_hash,
        "published_at": package.published_at.isoformat() + "Z" if package.published_at else None,
        "acceptance_state": package.acceptance_state,
        "asset": {
            "asset_code": unit.asset_code,
            "serial_number": unit.serial_number,
            "manufacturer": model.manufacturer if model else None,
            "model": model.model if model else None,
            "item_code": model.item_code if model else None,
            "installed_position": unit.installed_position,
            "in_service_date": unit.in_service_date.isoformat() if unit.in_service_date else None,
            "warranty_end": unit.warranty_end.isoformat() if unit.warranty_end else None,
        },
        "sections": [{"section": name, "entries": items} for name, items in sorted(sections.items())],
        "evidence_cutoff": manifest.get("evidence_cutoff"),
        "commercial_annex": None,
        "scope": {"project_id": buyer_project} if buyer_project else {},
    }
