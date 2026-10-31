"""Temporal physical structure (FR13): parent/slot links with effective intervals.

Rules enforced on every fit (T15):
- the slot exists in the parent's BOM, is individually tracked and the child model is the BOM
  model or an approved compatible spare for that slot;
- no other link occupies the parent slot at any time inside the new interval (full interval
  check against historical rows, not only open ones);
- the child is not fitted anywhere else at any time inside the interval;
- no cycles (the child may not be an ancestor of the parent during the interval).
Writers lock both units first, and partial unique indexes on open links back this up.
"""

import hashlib
import json
from datetime import datetime

from sqlalchemy import or_, select
from sqlalchemy.orm import Session

from app.core import audit
from app.core.auth import Principal
from app.core.errors import Conflict, DomainError
from app.models import BomLine, CompatibleSpare, ItemModel, PhysicalUnit, TransferManifest, UnitComponent, utcnow
from app.services.inventory_common import TERMINAL_UNIT_STATES, lock, unit_brief

MAX_DEPTH = 8
ACTIVE_MANIFEST_STATES = ("DRAFT", "APPROVED")


def bom_lines(db: Session, tenant_id: str, model_id: str) -> list[BomLine]:
    return list(
        db.scalars(select(BomLine).where(BomLine.tenant_id == tenant_id, BomLine.parent_model_id == model_id).order_by(BomLine.slot_code))
    )


def slot_line(db: Session, tenant_id: str, model_id: str, slot_code: str) -> BomLine | None:
    return db.scalar(select(BomLine).where(BomLine.tenant_id == tenant_id, BomLine.parent_model_id == model_id, BomLine.slot_code == slot_code))


def _active_at(q, at: datetime | None):
    if at is None:
        return q.where(UnitComponent.valid_to.is_(None))
    return q.where(UnitComponent.valid_from <= at, or_(UnitComponent.valid_to.is_(None), UnitComponent.valid_to > at))


def _overlapping(q, start: datetime, end: datetime | None):
    q = q.where(or_(UnitComponent.valid_to.is_(None), UnitComponent.valid_to > start))
    if end is not None:
        q = q.where(UnitComponent.valid_from < end)
    return q


def children_links(db: Session, tenant_id: str, parent_id: str, at: datetime | None = None) -> list[UnitComponent]:
    q = select(UnitComponent).where(UnitComponent.tenant_id == tenant_id, UnitComponent.parent_unit_id == parent_id)
    return list(db.scalars(_active_at(q, at).order_by(UnitComponent.slot_code)))


def parent_link(db: Session, tenant_id: str, child_id: str, at: datetime | None = None) -> UnitComponent | None:
    q = select(UnitComponent).where(UnitComponent.tenant_id == tenant_id, UnitComponent.child_unit_id == child_id)
    return db.scalars(_active_at(q, at).order_by(UnitComponent.valid_from.desc())).first()


def top_root(db: Session, unit: PhysicalUnit, at: datetime | None = None) -> PhysicalUnit:
    current = unit
    for _ in range(MAX_DEPTH):
        link = parent_link(db, unit.tenant_id, current.id, at)
        if link is None:
            return current
        current = db.get(PhysicalUnit, link.parent_unit_id)
    return current


def descendants(db: Session, tenant_id: str, unit_id: str, at: datetime | None = None) -> list[str]:
    out: list[str] = []
    frontier = [(unit_id, 0)]
    while frontier:
        uid, depth = frontier.pop()
        if depth >= MAX_DEPTH:
            continue
        for link in children_links(db, tenant_id, uid, at):
            if link.child_unit_id not in out:
                out.append(link.child_unit_id)
                frontier.append((link.child_unit_id, depth + 1))
    return out


def ancestors_during(db: Session, tenant_id: str, unit_id: str, start: datetime, end: datetime | None) -> set[str]:
    seen: set[str] = set()
    frontier = [unit_id]
    while frontier:
        uid = frontier.pop()
        q = select(UnitComponent).where(UnitComponent.tenant_id == tenant_id, UnitComponent.child_unit_id == uid)
        for link in db.scalars(_overlapping(q, start, end)):
            if link.parent_unit_id not in seen:
                seen.add(link.parent_unit_id)
                frontier.append(link.parent_unit_id)
    return seen


def compatible_slots_for_model(db: Session, tenant_id: str, model_id: str) -> list[dict]:
    """Every (parent model, slot) a component model may be fitted into."""
    out = []
    for bl in db.scalars(select(BomLine).where(BomLine.tenant_id == tenant_id, BomLine.child_model_id == model_id, BomLine.individually_tracked.is_(True))):
        out.append({"parent_item_code": db.get(ItemModel, bl.parent_model_id).item_code, "slot_code": bl.slot_code, "basis": "BOM"})
    for cs in db.scalars(select(CompatibleSpare).where(CompatibleSpare.tenant_id == tenant_id, CompatibleSpare.spare_model_id == model_id)):
        entry = {"parent_item_code": db.get(ItemModel, cs.parent_model_id).item_code, "slot_code": cs.slot_code, "basis": "APPROVED_SPARE"}
        if not any(e["parent_item_code"] == entry["parent_item_code"] and e["slot_code"] == entry["slot_code"] for e in out):
            out.append(entry)
    return out


def check_compatible(db: Session, parent: PhysicalUnit, child_model_id: str, slot_code: str) -> BomLine:
    line = slot_line(db, parent.tenant_id, parent.item_model_id, slot_code)
    if line is None:
        raise DomainError("UNKNOWN_SLOT", f"Slot {slot_code} is not in the BOM of {parent.item_model.item_code}")
    if not line.individually_tracked or line.child_model_id is None:
        raise DomainError("SLOT_NOT_TRACKED", f"Slot {slot_code} holds quantity-based parts that are not individually tracked")
    if child_model_id == line.child_model_id:
        return line
    approved = db.scalar(
        select(CompatibleSpare).where(
            CompatibleSpare.tenant_id == parent.tenant_id,
            CompatibleSpare.spare_model_id == child_model_id,
            CompatibleSpare.parent_model_id == parent.item_model_id,
            CompatibleSpare.slot_code == slot_code,
        )
    )
    if approved is None:
        child_model = db.get(ItemModel, child_model_id)
        raise DomainError(
            "INCOMPATIBLE_COMPONENT",
            f"{child_model.item_code if child_model else child_model_id} is not approved for slot {slot_code} of {parent.item_model.item_code}",
        )
    return line


def _clash_code(link: UnitComponent, open_code: str) -> str:
    return open_code if link.valid_to is None else "HISTORICAL_OVERLAP"


def fit(
    db: Session,
    p: Principal | None,
    parent: PhysicalUnit,
    child: PhysicalUnit,
    slot_code: str,
    valid_from: datetime,
    *,
    valid_to: datetime | None = None,
    install_reason: str | None = None,
    recovery_case_id: str | None = None,
    work_order_ref: str | None = None,
    enforce_custody: bool = True,
) -> UnitComponent:
    if parent.id == child.id:
        raise DomainError("COMPONENT_CYCLE", "A unit cannot be fitted into itself")
    if valid_to is not None and valid_to <= valid_from:
        raise DomainError("INVALID_INTERVAL", "valid_to must be after valid_from")
    check_compatible(db, parent, child.item_model_id, slot_code)
    if child.state in TERMINAL_UNIT_STATES or child.state == "PLANNED":
        raise DomainError("UNIT_NOT_FITTABLE", f"{child.asset_code} is {child.state} and cannot be fitted")
    if enforce_custody and child.custody_location_id != parent.custody_location_id:
        raise DomainError("CUSTODY_MISMATCH", f"{child.asset_code} must be in the same custody location as {parent.asset_code} before fitting")

    lock(db, parent, child)
    t = parent.tenant_id
    slot_q = select(UnitComponent).where(UnitComponent.tenant_id == t, UnitComponent.parent_unit_id == parent.id, UnitComponent.slot_code == slot_code)
    clash = db.scalars(_overlapping(slot_q, valid_from, valid_to)).first()
    if clash is not None:
        raise Conflict(
            _clash_code(clash, "SLOT_OCCUPIED"),
            f"Slot {slot_code} of {parent.asset_code} is occupied between {clash.valid_from.isoformat()} and "
            f"{clash.valid_to.isoformat() if clash.valid_to else 'now'}",
        )
    child_q = select(UnitComponent).where(UnitComponent.tenant_id == t, UnitComponent.child_unit_id == child.id)
    clash = db.scalars(_overlapping(child_q, valid_from, valid_to)).first()
    if clash is not None:
        other = db.get(PhysicalUnit, clash.parent_unit_id)
        raise Conflict(
            _clash_code(clash, "COMPONENT_ALREADY_FITTED"),
            f"{child.asset_code} is fitted to {other.asset_code} between {clash.valid_from.isoformat()} and "
            f"{clash.valid_to.isoformat() if clash.valid_to else 'now'}",
        )
    if child.id in ancestors_during(db, t, parent.id, valid_from, valid_to):
        raise DomainError("COMPONENT_CYCLE", f"{child.asset_code} is an ancestor of {parent.asset_code}; fitting would create a cycle")

    link = UnitComponent(
        tenant_id=t,
        created_by=p.email if p else "system",
        parent_unit_id=parent.id,
        child_unit_id=child.id,
        slot_code=slot_code,
        valid_from=valid_from,
        valid_to=valid_to,
        install_reason=install_reason,
        recovery_case_id=recovery_case_id,
        work_order_ref=work_order_ref,
    )
    db.add(link)
    db.flush()
    if valid_to is None:
        root = top_root(db, parent)
        propagate(db, root)
        invalidate_manifests(db, p, t, [root.id, child.id], f"{child.asset_code} fitted to {parent.asset_code}/{slot_code}")
    audit.record(
        db, p, "component.fit", "PhysicalUnit", parent.id, tenant_id=t,
        after={"link_id": link.id, "child_unit_id": child.id, "child_asset_code": child.asset_code, "slot_code": slot_code,
               "valid_from": valid_from, "valid_to": valid_to, "install_reason": install_reason},
    )
    return link


def remove(
    db: Session,
    p: Principal | None,
    link: UnitComponent,
    valid_to: datetime,
    removal_reason: str | None,
    *,
    recovery_case_id: str | None = None,
) -> UnitComponent:
    if link.valid_to is not None:
        raise Conflict("LINK_ALREADY_CLOSED", "This component link was already removed")
    if valid_to <= link.valid_from:
        raise DomainError("INVALID_INTERVAL", "Removal time must be after the fit time")
    parent = db.get(PhysicalUnit, link.parent_unit_id)
    child = db.get(PhysicalUnit, link.child_unit_id)
    lock(db, parent, child)
    db.refresh(link)
    if link.valid_to is not None:
        raise Conflict("LINK_ALREADY_CLOSED", "This component link was already removed")
    link.valid_to = valid_to
    link.removal_reason = removal_reason
    if recovery_case_id:
        link.recovery_case_id = link.recovery_case_id or recovery_case_id
    db.flush()
    root = top_root(db, parent)
    invalidate_manifests(db, p, link.tenant_id, [root.id, child.id], f"{child.asset_code} removed from {parent.asset_code}/{link.slot_code}")
    audit.record(
        db, p, "component.remove", "PhysicalUnit", parent.id, tenant_id=link.tenant_id,
        after={"link_id": link.id, "child_unit_id": child.id, "child_asset_code": child.asset_code, "slot_code": link.slot_code,
               "valid_to": valid_to, "removal_reason": removal_reason},
    )
    return link


def propagate(db: Session, root: PhysicalUnit) -> None:
    """Fitted components follow their top-level parent's custody and assignment."""
    for uid in descendants(db, root.tenant_id, root.id):
        u = db.get(PhysicalUnit, uid)
        u.custody_location_id = root.custody_location_id
        u.assigned_project_id = root.assigned_project_id
        u.assigned_wbs_id = root.assigned_wbs_id
        u.allocation_status = root.allocation_status


def tree(db: Session, unit: PhysicalUnit, at: datetime | None = None, depth: int = 0) -> dict:
    node = {"unit": unit_brief(db, unit), "children": [], "vacant_slots": [], "untracked_parts": []}
    if depth >= MAX_DEPTH:
        return node
    links = children_links(db, unit.tenant_id, unit.id, at)
    occupied = {ln.slot_code for ln in links}
    for bl in bom_lines(db, unit.tenant_id, unit.item_model_id):
        if not bl.individually_tracked or bl.child_model_id is None:
            node["untracked_parts"].append({"slot_code": bl.slot_code, "description": bl.description, "quantity": format(bl.quantity.normalize(), "f")})
        elif bl.slot_code not in occupied:
            node["vacant_slots"].append({"slot_code": bl.slot_code, "description": bl.description})
    for ln in links:
        child = db.get(PhysicalUnit, ln.child_unit_id)
        sub = tree(db, child, at, depth + 1)
        node["children"].append(
            {
                "slot_code": ln.slot_code,
                "link_id": ln.id,
                "valid_from": ln.valid_from.isoformat(timespec="seconds") + "Z",
                "valid_to": ln.valid_to.isoformat(timespec="seconds") + "Z" if ln.valid_to else None,
                "install_reason": ln.install_reason,
                **sub,
            }
        )
    return node


def vacant_tracked_slots(db: Session, unit: PhysicalUnit, at: datetime | None = None, prefix: str = "", depth: int = 0) -> list[str]:
    """Slot paths (e.g. ENGINE/TURBO) of tracked BOM slots that are empty anywhere in the tree."""
    if depth >= MAX_DEPTH:
        return []
    links = {ln.slot_code: ln for ln in children_links(db, unit.tenant_id, unit.id, at)}
    out = []
    for bl in bom_lines(db, unit.tenant_id, unit.item_model_id):
        if not bl.individually_tracked or bl.child_model_id is None:
            continue
        path = f"{prefix}{bl.slot_code}"
        ln = links.get(bl.slot_code)
        if ln is None:
            out.append(path)
        else:
            out.extend(vacant_tracked_slots(db, db.get(PhysicalUnit, ln.child_unit_id), at, path + "/", depth + 1))
    return out


def resolve_slot_path(db: Session, tenant_id: str, root_model_id: str, slot: str) -> list[str]:
    """Return the slot path from the root model, e.g. "TURBO" → ["ENGINE", "TURBO"]. 422 if unknown/ambiguous."""
    if "/" in slot:
        parts = [s.strip() for s in slot.split("/") if s.strip()]
        model_id = root_model_id
        for part in parts:
            line = slot_line(db, tenant_id, model_id, part)
            if line is None or line.child_model_id is None:
                raise DomainError("UNKNOWN_SLOT", f"Slot path {slot} does not match the BOM")
            model_id = line.child_model_id
        return parts
    matches: list[list[str]] = []
    frontier = [(root_model_id, [])]
    while frontier:
        model_id, path = frontier.pop()
        if len(path) >= MAX_DEPTH:
            continue
        for bl in bom_lines(db, tenant_id, model_id):
            if bl.slot_code == slot:
                matches.append(path + [bl.slot_code])
            if bl.child_model_id:
                frontier.append((bl.child_model_id, path + [bl.slot_code]))
    if not matches:
        raise DomainError("UNKNOWN_SLOT", f"Slot {slot} is not in the BOM")
    if len(matches) > 1:
        raise DomainError("AMBIGUOUS_SLOT", f"Slot {slot} appears more than once in the BOM; use a path such as {'/'.join(matches[0])}")
    return matches[0]


def find_link_in_tree(db: Session, root: PhysicalUnit, slot: str, at: datetime | None = None) -> UnitComponent | None:
    """Link occupying a slot (code or path) anywhere in root's tree at a time."""
    try:
        path = resolve_slot_path(db, root.tenant_id, root.item_model_id, slot)
    except DomainError:
        return None
    current = root
    link = None
    for part in path:
        link = next((ln for ln in children_links(db, root.tenant_id, current.id, at) if ln.slot_code == part), None)
        if link is None:
            return None
        current = db.get(PhysicalUnit, link.child_unit_id)
    return link


def structure_hash(db: Session, tenant_id: str, unit_ids: list[str]) -> str:
    members = set(unit_ids)
    triples = []
    for uid in sorted(members):
        for ln in children_links(db, tenant_id, uid):
            triples.append([uid, ln.slot_code, ln.child_unit_id])
    payload = {"members": sorted(members), "links": sorted(triples)}
    return hashlib.sha256(json.dumps(payload, separators=(",", ":")).encode()).hexdigest()


def manifest_members(db: Session, tenant_id: str, root_ids: list[str]) -> list[str]:
    """Selected units plus their current descendants, deduplicated in stable order."""
    out: list[str] = []
    for uid in root_ids:
        for member in [uid, *descendants(db, tenant_id, uid)]:
            if member not in out:
                out.append(member)
    return out


def invalidate_manifests(db: Session, p: Principal | None, tenant_id: str, unit_ids: list[str], reason: str) -> list[TransferManifest]:
    """A structure change on a member invalidates an approved, not yet dispatched manifest (FR14)."""
    touched = set(unit_ids)
    out = []
    for m in db.scalars(select(TransferManifest).where(TransferManifest.tenant_id == tenant_id, TransferManifest.state == "APPROVED")):
        if not touched.intersection(m.unit_ids or []):
            continue
        if structure_hash(db, tenant_id, m.unit_ids) != m.structure_hash:
            m.state = "INVALIDATED"
            m.version = (m.version or 0) + 1
            m.updated_at = utcnow()
            audit.record(db, p, "transfer.invalidated", "TransferManifest", m.id, tenant_id=tenant_id, reason=reason)
            out.append(m)
    return out
