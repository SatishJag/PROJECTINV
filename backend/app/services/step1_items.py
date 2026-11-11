"""Step 1 item crosswalk: which register items are long-lead equipment (LLE), and of which PCX class."""

from __future__ import annotations

import re

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.api.common import row
from app.core.auth import Principal
from app.core.commands import bump, check_if_match
from app.core.errors import Conflict, DomainError, Forbidden
from app.integrations.exceptions import open_exception
from app.models import EquipmentClass, Requirement, Step1ItemClass, utcnow
from app.services.helpers import audit, get_row, need

DECISIONS = ("PENDING", "LLE", "NOT_LLE")


def _tokens(text: str) -> set[str]:
    """Lower-case alphanumeric tokens with one trailing 's' stripped (so 'Generators' matches 'generator')."""
    out = set()
    for token in re.findall(r"[a-z0-9]+", text.lower()):
        token = token[:-1] if token.endswith("s") else token
        if token:
            out.add(token)
    return out


def suggest_class(db: Session, tenant_id: str, row: dict) -> str | None:
    """Class whose name+category overlaps the work package and description most; None unless there is a unique best of >= 1."""
    item_tokens = _tokens(f"{row.get('work_package_name') or ''} {row.get('item_description') or ''}")
    scores: dict[str, int] = {}
    for cls in db.scalars(select(EquipmentClass).where(EquipmentClass.tenant_id == tenant_id, EquipmentClass.is_component_class.is_(False))):
        scores[cls.id] = len(item_tokens & _tokens(f"{cls.name} {cls.category}"))
    if not scores:
        return None
    best = max(scores.values())
    winners = [cid for cid, score in scores.items() if score == best]
    return winners[0] if best >= 1 and len(winners) == 1 else None


def see_item(db: Session, tenant_id: str, row: dict) -> Step1ItemClass:
    """Upsert the crosswalk row for a register item; the caller owns the transaction."""
    step1_item_id = row["item_id"]
    item = db.scalar(select(Step1ItemClass).where(Step1ItemClass.tenant_id == tenant_id, Step1ItemClass.step1_item_id == step1_item_id))
    if item is None:
        item = Step1ItemClass(
            tenant_id=tenant_id,
            created_by="step1-sync",
            step1_item_id=step1_item_id,
            description=row.get("item_description") or step1_item_id,
            internal_item_code=row.get("internal_item_code"),
            suggested_class_id=suggest_class(db, tenant_id, row),
            last_seen_at=utcnow(),
        )
        db.add(item)
    else:
        item.description = row.get("item_description") or item.description
        item.internal_item_code = row.get("internal_item_code")
        item.last_seen_at = utcnow()
    db.flush()
    return item


def _requirements_of(db: Session, tenant_id: str, step1_item_id: str) -> list[Requirement]:
    """Requirements fed from this item that are still live (cancelled ones no longer pin the class)."""
    return list(
        db.scalars(
            select(Requirement).where(
                Requirement.tenant_id == tenant_id,
                Requirement.step1_item_id == step1_item_id,
                Requirement.state != "CANCELLED",
            )
        )
    )


def _out(item: Step1ItemClass, requirement_count: int, class_names: dict[str, str]) -> dict:
    return row(
        item,
        requirement_count=requirement_count,
        suggested_class_name=class_names.get(item.suggested_class_id) if item.suggested_class_id else None,
    )


def _class_names(db: Session, tenant_id: str) -> dict[str, str]:
    return {cid: name for cid, name in db.execute(select(EquipmentClass.id, EquipmentClass.name).where(EquipmentClass.tenant_id == tenant_id))}


def list_items(db: Session, p: Principal, decision: str | None = None) -> list[dict]:
    if decision is not None and decision not in DECISIONS:
        raise DomainError("VALIDATION", f"decision must be one of {', '.join(DECISIONS)}")
    q = select(Step1ItemClass).where(Step1ItemClass.tenant_id == p.tenant_id)
    if decision:
        q = q.where(Step1ItemClass.decision == decision)
    items = list(db.scalars(q.order_by(Step1ItemClass.description, Step1ItemClass.step1_item_id)))
    counts = dict(
        db.execute(
            select(Requirement.step1_item_id, func.count())
            .where(Requirement.tenant_id == p.tenant_id, Requirement.step1_item_id.is_not(None), Requirement.state != "CANCELLED")
            .group_by(Requirement.step1_item_id)
        ).all()
    )
    names = _class_names(db, p.tenant_id)
    return [_out(i, counts.get(i.step1_item_id, 0), names) for i in items]


def classify_item(db: Session, p: Principal, item_id: str, body: dict, if_match: str | None = None) -> dict:
    """Record the LLE / not-LLE decision. ``item_id`` is the crosswalk row's primary key."""
    if not p.has("ESTIMATOR", "ENGINEERING"):
        raise Forbidden("Only estimators and engineers can classify Step 1 items")
    item = get_row(db, Step1ItemClass, item_id, p, "Step 1 item")
    check_if_match(item, if_match)

    decision = body.get("decision")
    if decision not in ("LLE", "NOT_LLE"):
        raise DomainError("VALIDATION", "decision must be LLE or NOT_LLE")
    requirements = _requirements_of(db, p.tenant_id, item.step1_item_id)
    before = {"decision": item.decision, "equipment_class_id": item.equipment_class_id}

    if decision == "LLE":
        class_id = need(body, "equipment_class_id")
        cls = db.get(EquipmentClass, class_id)
        if cls is None or cls.tenant_id != p.tenant_id or cls.is_component_class:
            raise DomainError("VALIDATION", "equipment_class_id must be an existing, non-component equipment class")
        if requirements and item.equipment_class_id and item.equipment_class_id != class_id:
            raise Conflict("CLASS_IN_USE", f"{len(requirements)} requirement(s) already use this item's class; cancel or move them first")
        item.equipment_class_id = class_id
        item.decision_reason = body.get("reason") or None
    else:
        reason = need(body, "reason")
        item.decision_reason = reason
        if not requirements:
            item.equipment_class_id = None
        for requirement in requirements:
            open_exception(
                db,
                p.tenant_id,
                source="STEP1",
                kind="RECONCILIATION",
                subject_type="requirement",
                subject_id=requirement.id,
                message=f"Step 1 item {item.step1_item_id} is now classified NOT_LLE: {reason}. Review whether to cancel requirement {requirement.code}.",
                owner_role="ESTIMATOR",
                actor=p.email,
            )

    item.decision = decision
    item.decided_by = p.email
    item.decided_at = utcnow()
    bump(item)
    audit(
        db,
        p,
        "STEP1_ITEM_CLASSIFIED",
        "step1_item_class",
        item.id,
        before=before,
        after={"decision": decision, "equipment_class_id": item.equipment_class_id},
        reason=item.decision_reason,
    )
    db.flush()
    return _out(item, len(requirements), _class_names(db, p.tenant_id))
