"""PROCORE outbox handlers (contract: purchase_order.upsert, equipment.upsert, handbook.publish).

Every handler is replay-safe: it resolves the Procore object by crosswalk link first, then by business
key (commitment number / equipment identification number), and only creates when neither exists. A
replay after a lost acknowledgement (TIMEOUT_UNKNOWN reconciled as NOT_APPLIED) therefore updates the
object created by the first attempt instead of creating a duplicate (T27).

Result mapping (spec §35):
    success                 -> ACKNOWLEDGED, external_ref written, link sync_state APPLIED
    Procore 4xx validation  -> REJECTED (outbox raises an IntegrationException), link REJECTED
    timeout after a write   -> TIMEOUT_UNKNOWN (outbox state UNKNOWN; reconcile before replay)
    429 / 5xx / connect     -> TRANSIENT_FAILURE (bounded retries with backoff, then DEAD)
    auth failure            -> REJECTED and the connection is marked ERROR (re-authorize)

Write payload field names for commitment_contracts / equipment_register are a DRAFT mapping that
must be validated against the tenant's sandbox before PCX_PROCORE_WRITEBACK_ENABLED is set in LIVE
mode; in LIVE mode with write-back disabled every handler rejects without calling Procore.
"""

import logging
from dataclasses import dataclass, field

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.outbox import HandlerResult, register_handler
from app.integrations.procore import settings as ps
from app.integrations.procore.client import ProcoreClient
from app.integrations.procore.links import links_for_domain, open_exception, project_key_for, upsert_link
from app.integrations.procore.transport import ProcoreAuthError, ProcoreError, ProcoreRejected, ProcoreTimeout, ProcoreUnavailable
from app.models import (
    ExternalObjectLink,
    HandbookPackage,
    OutboxMessage,
    PhysicalUnit,
    PoDistribution,
    PoLine,
    ProcoreConnection,
    Project,
    PurchaseOrder,
    Supplier,
)
from app.services.integrations import register_reconciler

log = logging.getLogger("pcx.procore.handlers")
TARGET = "PROCORE"


@dataclass
class Ctx:
    db: Session
    conn: ProcoreConnection
    client: ProcoreClient
    wrote: bool = False
    touched: list[ExternalObjectLink] = field(default_factory=list)


class Skip(Exception):
    """Business precondition not met: REJECTED with an actionable message (no Procore call made)."""


def _active(db: Session, tenant_id: str) -> ProcoreConnection | None:
    from app.integrations.procore.service import active_connection

    return active_connection(db, tenant_id)


def writeback_allowed(conn: ProcoreConnection) -> bool:
    return conn.environment == ps.SIMULATED or ps.procore_settings().writeback_enabled


def _guarded(event_type: str):
    def deco(fn):
        @register_handler(TARGET, event_type)
        def handler(db: Session, msg: OutboxMessage) -> HandlerResult:
            conn = _active(db, msg.tenant_id)
            if conn is None:
                return HandlerResult("REJECTED", message="Procore connection is not active; connect Procore, then retry")
            if not writeback_allowed(conn):
                return HandlerResult("REJECTED", message="Procore write-back is disabled in LIVE mode (PCX_PROCORE_WRITEBACK_ENABLED=false)")
            ctx = Ctx(db, conn, ProcoreClient(db, conn))
            try:
                return fn(ctx, msg)
            except Skip as exc:
                return HandlerResult("REJECTED", message=str(exc))
            except ProcoreTimeout as exc:
                if not ctx.wrote:  # a read timed out: nothing was applied
                    return HandlerResult("TRANSIENT_FAILURE", message=exc.message)
                for ln in ctx.touched:
                    ln.sync_state = "PENDING"
                    ln.version += 1
                return HandlerResult("TIMEOUT_UNKNOWN", message=f"{exc.message}; reconcile against Procore before replay")
            except ProcoreAuthError as exc:
                conn.state = "ERROR"
                conn.last_error = exc.message[:500]
                conn.version += 1
                return HandlerResult("REJECTED", message=exc.message)
            except ProcoreRejected as exc:
                for ln in ctx.touched:
                    ln.sync_state = "REJECTED"
                    ln.version += 1
                return HandlerResult("REJECTED", message=exc.message[:1000])
            except ProcoreUnavailable as exc:
                return HandlerResult("TRANSIENT_FAILURE", message=exc.message)
            except ProcoreError as exc:  # defensive: unclassified
                return HandlerResult("TRANSIENT_FAILURE", message=exc.message)

        return handler

    return deco


def _v2_items(ctx: Ctx, path: str) -> list[dict]:
    items, _ = ctx.client.get_all(path, v2=True)
    return items


def _write(ctx: Ctx, method: str, path: str, body: dict) -> dict:
    ctx.wrote = True
    r = ctx.client.request(method, path, json={"data": body})
    data = r.body.get("data") if isinstance(r.body, dict) else None
    if not isinstance(data, dict) or not data.get("id"):
        raise ProcoreRejected(f"Procore {method} {path.split('?')[0]} returned no object id")
    return data


def _link_for_project(ctx: Ctx, object_type: str, domain_type: str, domain_id: str, pkey: str) -> ExternalObjectLink | None:
    return next((ln for ln in links_for_domain(ctx.db, ctx.conn, object_type, domain_type, domain_id) if ln.project_key == pkey), None)


# ---------------------------------------------------------------- purchase_order.upsert {po_id}


def _po_projects(ctx: Ctx, po: PurchaseOrder) -> tuple[list[tuple[str, Project]], list[str]]:
    ids = sorted(
        {
            pid
            for pid in ctx.db.scalars(
                select(PoDistribution.project_id).join(PoLine, PoLine.id == PoDistribution.po_line_id).where(PoLine.tenant_id == po.tenant_id, PoLine.po_id == po.id)
            )
            if pid
        }
    )
    linked, unlinked = [], []
    for pid in ids:
        prj = ctx.db.get(Project, pid)
        key = project_key_for(ctx.db, ctx.conn, pid)
        if key:
            linked.append((key, prj))
        else:
            unlinked.append(prj.code if prj else pid)
    return linked, unlinked


def _commitment_body(ctx: Ctx, po: PurchaseOrder) -> dict:
    """DRAFT mapping (validate in sandbox). Header only: no prices, no schedule of values."""
    lines = list(ctx.db.scalars(select(PoLine).where(PoLine.tenant_id == po.tenant_id, PoLine.po_id == po.id).order_by(PoLine.line_no)))
    summary = ", ".join(f"{ln.item_model.item_code} x{ln.quantity.normalize():f}" for ln in lines)[:200]
    body = {"number": po.canonical_number, "title": f"{po.canonical_number} {summary}".strip()[:255]}
    sup = ctx.db.get(Supplier, po.supplier_id)
    if sup and sup.procore_vendor_id:
        body["vendor_id"] = sup.procore_vendor_id
    return body


@_guarded("purchase_order.upsert")
def purchase_order_upsert(ctx: Ctx, msg: OutboxMessage) -> HandlerResult:
    po = ctx.db.get(PurchaseOrder, (msg.payload or {}).get("po_id") or msg.aggregate_id)
    if po is None or po.tenant_id != msg.tenant_id:
        raise Skip("Purchase order not found")
    targets, unlinked = _po_projects(ctx, po)
    if not targets:
        raise Skip(f"No distribution project of {po.canonical_number} is linked to Procore ({', '.join(unlinked) or 'programme stock only'}); sync projects first")
    body = _commitment_body(ctx, po)
    refs = []
    for pkey, prj in targets:
        path = ctx.client.commitment_contracts_path(pkey)
        link = _link_for_project(ctx, "purchase_order_contract", "PurchaseOrder", po.id, pkey)
        cid = link.object_key if link else None
        if cid is None:  # business-key lookup before create (replay safety)
            match = next((c for c in _v2_items(ctx, path) if str(c.get("number") or "") == po.canonical_number), None)
            cid = str(match["id"]) if match else None
        if link:
            ctx.touched.append(link)
        try:
            obj = _write(ctx, "PATCH", f"{path}/{cid}", body) if cid else _write(ctx, "POST", path, body)
        except ProcoreRejected as exc:
            if cid and exc.status == 404 and link:
                link.sync_state = "NEEDS_REVIEW"
                link.version += 1
                open_exception(
                    ctx.db, ctx.conn.tenant_id, kind="MAPPING", subject_type="procore.purchase_order_contract", subject_id=cid,
                    message=f"NEEDS_REVIEW: commitment {cid} for {po.canonical_number} in {prj.code} no longer exists in Procore",
                )
                ctx.touched.remove(link)
            raise
        new_link, _ = upsert_link(
            ctx.db, ctx.conn, object_type="purchase_order_contract", object_key=str(obj["id"]), project_key=pkey, domain_type="PurchaseOrder",
            domain_id=po.id, source_revision=obj.get("updated_at"), sync_state="APPLIED", actor="procore-outbox",
        )
        if new_link not in ctx.touched:
            ctx.touched.append(new_link)
        refs.append(f"{pkey}:{obj['id']}")
    note = f"; not linked: {', '.join(unlinked)}" if unlinked else ""
    return HandlerResult("ACKNOWLEDGED", external_ref=",".join(refs)[:120], message=(f"Upserted {len(refs)} commitment(s){note}" if note else None))


@register_reconciler(TARGET, "purchase_order.upsert")
def reconcile_purchase_order(db: Session, msg: OutboxMessage, external_ref: str | None) -> None:
    """external_ref: `project_id:commitment_id[,...]`, or a bare commitment id when exactly one linked
    project is still unlinked. Without a ref, PENDING links become APPLIED and the next commitments
    sync links anything else by number."""
    conn = _active(db, msg.tenant_id)
    if conn is None:
        return
    po = db.get(PurchaseOrder, msg.aggregate_id)
    if po is None:
        return
    for ln in links_for_domain(db, conn, "purchase_order_contract", "PurchaseOrder", po.id):
        if ln.sync_state == "PENDING":
            ln.sync_state = "APPLIED"
            ln.version += 1
    if not external_ref:
        return
    ctx = Ctx(db, conn, ProcoreClient(db, conn))
    targets, _ = _po_projects(ctx, po)
    keys = {k for k, _ in targets}
    pairs: list[tuple[str, str]] = []
    for part in [x.strip() for x in external_ref.split(",") if x.strip()]:
        if ":" in part:
            pk, cid = part.split(":", 1)
            if pk in keys:
                pairs.append((pk, cid))
        else:
            open_keys = [k for k in keys if not _link_for_project(ctx, "purchase_order_contract", "PurchaseOrder", po.id, k)]
            if len(open_keys) == 1:
                pairs.append((open_keys[0], part))
    for pk, cid in pairs:
        upsert_link(db, conn, object_type="purchase_order_contract", object_key=cid, project_key=pk, domain_type="PurchaseOrder", domain_id=po.id, sync_state="APPLIED", actor="procore-reconcile")


# ---------------------------------------------------------------- equipment.upsert {unit_id}


def _equipment_body(unit: PhysicalUnit) -> dict:
    """DRAFT mapping (validate in sandbox). Identity only: no cost or commercial fields."""
    model = unit.item_model
    label = (model.description or model.model or model.item_code) if model else "Equipment"
    body = {"name": f"{label} {unit.asset_code}"[:255], "identification_number": unit.asset_code}
    if unit.serial_number:
        body["serial_number"] = unit.serial_number
    if unit.installed_position:
        body["description"] = unit.installed_position[:255]
    return body


@_guarded("equipment.upsert")
def equipment_upsert(ctx: Ctx, msg: OutboxMessage) -> HandlerResult:
    unit = ctx.db.get(PhysicalUnit, (msg.payload or {}).get("unit_id") or msg.aggregate_id)
    if unit is None or unit.tenant_id != msg.tenant_id:
        raise Skip("Physical unit not found")
    if not unit.assigned_project_id:
        return HandlerResult("ACKNOWLEDGED", message="Unit is programme stock (no assigned project); nothing to write to Procore")
    pkey = project_key_for(ctx.db, ctx.conn, unit.assigned_project_id)
    if not pkey:
        prj = ctx.db.get(Project, unit.assigned_project_id)
        raise Skip(f"Project {prj.code if prj else unit.assigned_project_id} is not linked to Procore; sync projects first")
    links = links_for_domain(ctx.db, ctx.conn, "equipment", "PhysicalUnit", unit.id)
    link = links[0] if links else None
    if link and link.project_key and link.project_key != pkey:
        link.sync_state = "NEEDS_REVIEW"
        link.version += 1
        open_exception(
            ctx.db, ctx.conn.tenant_id, kind="MAPPING", subject_type="procore.equipment", subject_id=link.object_key,
            message=f"NEEDS_REVIEW: {unit.asset_code} moved from Procore project {link.project_key} to {pkey}; equipment is not moved automatically",
        )
        raise Skip(f"{unit.asset_code} is linked to equipment in another Procore project; review the move")
    path = ctx.client.equipment_register_path(pkey)
    eid = link.object_key if link else unit.procore_equipment_id
    if eid is None:
        match = next((e for e in _v2_items(ctx, path) if str(e.get("identification_number") or "") == unit.asset_code), None)
        eid = str(match["id"]) if match else None
    if link:
        ctx.touched.append(link)
    body = _equipment_body(unit)
    try:
        obj = _write(ctx, "PATCH", f"{path}/{eid}", body) if eid else _write(ctx, "POST", path, body)
    except ProcoreRejected as exc:
        if eid and exc.status == 404:
            if link:
                link.sync_state = "NEEDS_REVIEW"
                link.version += 1
                ctx.touched.remove(link)
            open_exception(
                ctx.db, ctx.conn.tenant_id, kind="MAPPING", subject_type="procore.equipment", subject_id=str(eid),
                message=f"NEEDS_REVIEW: Procore equipment {eid} for {unit.asset_code} no longer exists",
            )
        raise
    eid = str(obj["id"])
    upsert_link(
        ctx.db, ctx.conn, object_type="equipment", object_key=eid, project_key=pkey, domain_type="PhysicalUnit", domain_id=unit.id,
        source_revision=obj.get("updated_at"), sync_state="APPLIED", actor="procore-outbox",
    )
    unit.procore_equipment_id = eid  # external reference only; no version bump (does not change user-editable state)
    return HandlerResult("ACKNOWLEDGED", external_ref=eid)


@register_reconciler(TARGET, "equipment.upsert")
def reconcile_equipment(db: Session, msg: OutboxMessage, external_ref: str | None) -> None:
    conn = _active(db, msg.tenant_id)
    unit = db.get(PhysicalUnit, msg.aggregate_id)
    if conn is None or unit is None:
        return
    for ln in links_for_domain(db, conn, "equipment", "PhysicalUnit", unit.id):
        if ln.sync_state == "PENDING":
            ln.sync_state = "APPLIED"
            ln.version += 1
    pkey = project_key_for(db, conn, unit.assigned_project_id)
    if external_ref and pkey:
        upsert_link(db, conn, object_type="equipment", object_key=external_ref, project_key=pkey, domain_type="PhysicalUnit", domain_id=unit.id, sync_state="APPLIED", actor="procore-reconcile")
        unit.procore_equipment_id = external_ref


# ---------------------------------------------------------------- handbook.publish {package_id}


@_guarded("handbook.publish")
def handbook_publish(ctx: Ctx, msg: OutboxMessage) -> HandlerResult:
    pkg = ctx.db.get(HandbookPackage, (msg.payload or {}).get("package_id") or msg.aggregate_id)
    if pkg is None or pkg.tenant_id != msg.tenant_id:
        raise Skip("Handbook package not found")
    if pkg.state != "PUBLISHED" or not pkg.package_hash:
        raise Skip(f"Handbook package is {pkg.state}; only PUBLISHED packages are filed in Procore")
    existing = next((ln for ln in links_for_domain(ctx.db, ctx.conn, "upload", "HandbookPackage", pkg.id) if ln.source_revision == pkg.package_hash), None)
    if existing:  # published packages are immutable: one filing per hash
        return HandlerResult("ACKNOWLEDGED", external_ref=existing.object_key, message="Already filed in Procore")
    unit = ctx.db.get(PhysicalUnit, pkg.unit_id)
    pkey = project_key_for(ctx.db, ctx.conn, unit.assigned_project_id if unit else None)
    if not pkey:
        raise Skip("The unit's project is not linked to Procore; sync projects first")
    if ctx.conn.environment != ps.SIMULATED:
        # The upload is only step one; binary PUT to the returned URL and filing into a Documents
        # folder need a validated folder target, so LIVE filing stays off until configured.
        raise Skip("LIVE handbook filing requires a validated Procore Documents folder target; not enabled")
    # Only the file name goes to Procore; the frozen manifest excludes the commercial annex.
    ctx.wrote = True
    r = ctx.client.request(
        "POST", ctx.client.uploads_path(pkey),
        json={"response_filename": f"handbook-{unit.asset_code}-v{pkg.version_no}-{pkg.package_hash[:12]}.pdf", "response_content_type": "application/pdf"},
    )
    uuid = str((r.body or {}).get("uuid") or "")
    if not uuid:
        raise ProcoreRejected("Procore upload returned no uuid")
    upsert_link(
        ctx.db, ctx.conn, object_type="upload", object_key=uuid, project_key=pkey, domain_type="HandbookPackage", domain_id=pkg.id,
        source_revision=pkg.package_hash, sync_state="APPLIED", actor="procore-outbox",
    )
    return HandlerResult("ACKNOWLEDGED", external_ref=uuid)


@register_reconciler(TARGET, "handbook.publish")
def reconcile_handbook(db: Session, msg: OutboxMessage, external_ref: str | None) -> None:
    conn = _active(db, msg.tenant_id)
    pkg = db.get(HandbookPackage, msg.aggregate_id)
    if conn is None or pkg is None or not external_ref:
        return
    unit = db.get(PhysicalUnit, pkg.unit_id)
    pkey = project_key_for(db, conn, unit.assigned_project_id if unit else None)
    upsert_link(
        db, conn, object_type="upload", object_key=external_ref, project_key=pkey, domain_type="HandbookPackage", domain_id=pkg.id,
        source_revision=pkg.package_hash, sync_state="APPLIED", actor="procore-reconcile",
    )
