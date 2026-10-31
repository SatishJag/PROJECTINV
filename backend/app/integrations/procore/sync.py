"""Procore -> pcx reference sync: projects, vendors, cost codes and PO commitments become
ExternalObjectLink rows. Matching is exact and deterministic; anything ambiguous or unmatched that
matters is raised as an IntegrationException (kind MAPPING, NEEDS_REVIEW) instead of guessed.

Direction and writer per fact (spec §27): Procore owns these source records; pcx owns only the
crosswalk (links) and the denormalised Procore reference columns (`Project.procore_project_id`,
`Supplier.procore_vendor_id`, `WbsElement.procore_cost_code_id`).
"""

import re

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.integrations.procore.client import ProcoreClient
from app.integrations.procore.links import auto_resolve, links_for_domain, open_exception, upsert_link
from app.models import PoAlias, PoDistribution, PoLine, ProcoreConnection, Project, PurchaseOrder, Supplier, WbsElement, utcnow

RESOURCES = ("projects", "vendors", "cost_codes", "commitments")
KIND = "MAPPING"


def _norm(s) -> str:
    return re.sub(r"\s+", " ", str(s or "")).strip().casefold()


def _empty() -> dict:
    return {"fetched": 0, "created": 0, "updated": 0, "unchanged": 0, "stale_skipped": 0, "unmatched": 0, "conflicts": 0, "pages": 0, "review": []}


class Sync:
    def __init__(self, db: Session, conn: ProcoreConnection, client: ProcoreClient | None = None):
        self.db = db
        self.conn = conn
        self.client = client or ProcoreClient(db, conn)
        self.t = conn.tenant_id

    # ------------------------------------------------------------------ common
    def _review(self, summary: dict, subject_type: str, subject_id, message: str, conflict: bool) -> None:
        summary["conflicts" if conflict else "unmatched"] += 1
        exc = open_exception(self.db, self.t, kind=KIND, subject_type=subject_type, subject_id=str(subject_id), message=f"NEEDS_REVIEW: {message}")
        summary["review"].append({"subject_type": subject_type, "subject_id": str(subject_id), "exception_id": exc.id, "message": message})

    def _resolved(self, subject_type: str, subject_id) -> None:
        auto_resolve(self.db, self.t, kind=KIND, subject_type=subject_type, subject_id=str(subject_id), resolution="Auto-resolved: sync found an exact match")

    def _apply(self, summary: dict, outcome: str) -> None:
        key = {"stale": "stale_skipped", "conflict": "conflicts"}.get(outcome, outcome)
        summary[key] += 1

    def _domain_taken(self, object_type: str, domain_type: str, domain_id: str, object_key: str, project_key: str | None = None) -> str | None:
        """Another external object already PRIMARY-linked to this domain row (one-to-one types)."""
        for ln in links_for_domain(self.db, self.conn, object_type, domain_type, domain_id):
            if ln.object_key != str(object_key) and (project_key is None or ln.project_key == str(project_key)):
                return ln.object_key
        return None

    # ------------------------------------------------------------------ projects
    def projects(self) -> dict:
        s = _empty()
        items, s["pages"] = self.client.projects()
        s["fetched"] = len(items)
        domain = list(self.db.scalars(select(Project).where(Project.tenant_id == self.t)))
        by_code = {d.code.upper(): d for d in domain}
        by_ref = {d.procore_project_id: d for d in domain if d.procore_project_id}
        for it in items:
            pid = str(it["id"])
            st = "procore.project"
            target = by_ref.get(pid) or by_code.get(str(it.get("project_number") or "").strip().upper())
            if target is None:
                self._review(s, st, pid, f"Procore project '{it.get('name')}' (number {it.get('project_number')!r}) has no pcx project with that code", False)
                continue
            if target.procore_project_id and target.procore_project_id != pid:
                self._review(s, st, pid, f"pcx project {target.code} is already mapped to Procore project {target.procore_project_id}", True)
                continue
            taken = self._domain_taken("project", "Project", target.id, pid)
            if taken:
                self._review(s, st, pid, f"pcx project {target.code} is already linked to Procore project {taken}", True)
                continue
            link, outcome = upsert_link(
                self.db, self.conn, object_type="project", object_key=pid, project_key=pid, domain_type="Project", domain_id=target.id, source_revision=it.get("updated_at")
            )
            if outcome == "conflict":
                self._review(s, st, pid, f"Procore project already linked to another pcx record ({link.domain_type} {link.domain_id})", True)
                continue
            self._apply(s, outcome)
            target.procore_company_id = str(self.conn.company_id)
            target.procore_project_id = pid
            self._resolved(st, pid)
        return s

    # ------------------------------------------------------------------ vendors
    def vendors(self) -> dict:
        """The Procore directory is a superset of LLE suppliers: unmatched vendors are counted, not
        raised; ambiguous or conflicting matches are raised."""
        s = _empty()
        items, s["pages"] = self.client.vendors()
        s["fetched"] = len(items)
        sups = list(self.db.scalars(select(Supplier).where(Supplier.tenant_id == self.t)))
        for it in items:
            vid = str(it["id"])
            st = "procore.vendor"
            target = next((x for x in sups if x.procore_vendor_id == vid), None)
            if target is None and it.get("abbreviated_name"):
                cands = [x for x in sups if x.key.upper() == str(it["abbreviated_name"]).strip().upper()]
                target = cands[0] if len(cands) == 1 else None
            if target is None:
                cands = [x for x in sups if _norm(x.name) == _norm(it.get("name"))]
                if len(cands) > 1:
                    self._review(s, st, vid, f"Procore vendor '{it.get('name')}' matches {len(cands)} pcx suppliers", True)
                    continue
                target = cands[0] if cands else None
            if target is None:
                s["unmatched"] += 1
                continue
            if target.procore_vendor_id and target.procore_vendor_id != vid:
                self._review(s, st, vid, f"pcx supplier {target.key} is already mapped to Procore vendor {target.procore_vendor_id}", True)
                continue
            link, outcome = upsert_link(self.db, self.conn, object_type="vendor", object_key=vid, domain_type="Supplier", domain_id=target.id, source_revision=it.get("updated_at"))
            if outcome == "conflict":
                self._review(s, st, vid, f"Procore vendor already linked to another pcx record ({link.domain_id})", True)
                continue
            self._apply(s, outcome)
            target.procore_vendor_id = vid
            self._resolved(st, vid)
        return s

    # ------------------------------------------------------------------ per linked project
    def _linked_projects(self, only: str | None = None) -> list[tuple[str, Project]]:
        out = []
        for prj in self.db.scalars(select(Project).where(Project.tenant_id == self.t).order_by(Project.code)):
            links = links_for_domain(self.db, self.conn, "project", "Project", prj.id)
            if links and (only is None or links[0].object_key == str(only)):
                out.append((links[0].object_key, prj))
        return out

    def cost_codes(self, only_project: str | None = None) -> dict:
        """Cost codes map to the WBS element carrying the same cost code; unmatched codes are counted."""
        s = _empty()
        for pkey, prj in self._linked_projects(only_project):
            items, pages = self.client.cost_codes(pkey)
            s["pages"] += pages
            s["fetched"] += len(items)
            wbs = list(self.db.scalars(select(WbsElement).where(WbsElement.tenant_id == self.t, WbsElement.project_id == prj.id)))
            for it in items:
                cid = str(it["id"])
                st = "procore.cost_code"
                codes = {str(it.get("full_code") or "").strip(), str(it.get("code") or "").strip()} - {""}
                cands = [w for w in wbs if (w.cost_code or "").strip() in codes]
                if not cands:
                    s["unmatched"] += 1
                    continue
                if len(cands) > 1:
                    self._review(s, st, cid, f"Cost code {it.get('full_code')} in {prj.code} matches {len(cands)} WBS elements", True)
                    continue
                w = cands[0]
                link, outcome = upsert_link(
                    self.db, self.conn, object_type="cost_code", object_key=cid, project_key=pkey, domain_type="WbsElement", domain_id=w.id, source_revision=it.get("updated_at")
                )
                if outcome == "conflict":
                    self._review(s, st, cid, f"Procore cost code already linked to another pcx record ({link.domain_id})", True)
                    continue
                self._apply(s, outcome)
                w.procore_cost_code_id = cid
                self._resolved(st, cid)
        return s

    def commitments(self, only_project: str | None = None) -> dict:
        """PO commitments map to the canonical PO by canonical number or a PROCORE alias. A PO may
        have one commitment per Procore project (consolidated programme PO)."""
        s = _empty()
        for pkey, prj in self._linked_projects(only_project):
            items, pages = self.client.purchase_order_contracts(pkey)
            s["pages"] += pages
            s["fetched"] += len(items)
            for it in items:
                cid = str(it["id"])
                st = "procore.purchase_order_contract"
                number = str(it.get("number") or "").strip()
                po = self._po_for_number(number)
                if po is None:
                    self._review(s, st, cid, f"Commitment {number!r} in {prj.code} has no canonical pcx PO or PROCORE alias", False)
                    continue
                problem = self._po_mismatch(po, prj, it)
                if problem:
                    self._review(s, st, cid, f"Commitment {number} in {prj.code}: {problem}", True)
                    continue
                taken = self._domain_taken("purchase_order_contract", "PurchaseOrder", po.id, cid, project_key=pkey)
                if taken:
                    self._review(s, st, cid, f"PO {po.canonical_number} already linked to commitment {taken} in {prj.code}", True)
                    continue
                link, outcome = upsert_link(
                    self.db,
                    self.conn,
                    object_type="purchase_order_contract",
                    object_key=cid,
                    project_key=pkey,
                    domain_type="PurchaseOrder",
                    domain_id=po.id,
                    source_revision=it.get("updated_at"),
                )
                if outcome == "conflict":
                    self._review(s, st, cid, f"Commitment already linked to another pcx record ({link.domain_id})", True)
                    continue
                self._apply(s, outcome)
                self._resolved(st, cid)
        return s

    def _po_for_number(self, number: str) -> PurchaseOrder | None:
        if not number:
            return None
        po = self.db.scalar(select(PurchaseOrder).where(PurchaseOrder.tenant_id == self.t, PurchaseOrder.canonical_number == number))
        if po:
            return po
        alias = self.db.scalar(select(PoAlias).where(PoAlias.tenant_id == self.t, PoAlias.source_system == "PROCORE", PoAlias.source_number == number))
        return self.db.get(PurchaseOrder, alias.po_id) if alias else None

    def _po_mismatch(self, po: PurchaseOrder, prj: Project, it: dict) -> str | None:
        vendor_id = str((it.get("vendor") or {}).get("id") or "")
        if vendor_id:
            sup = self.db.get(Supplier, po.supplier_id)
            if sup and sup.procore_vendor_id and sup.procore_vendor_id != vendor_id:
                return f"vendor {vendor_id} differs from PO supplier {sup.key} (Procore vendor {sup.procore_vendor_id})"
        dists = list(
            self.db.scalars(select(PoDistribution.project_id).join(PoLine, PoLine.id == PoDistribution.po_line_id).where(PoLine.tenant_id == self.t, PoLine.po_id == po.id))
        )
        if dists and prj.id not in dists and None not in dists:
            return f"PO {po.canonical_number} has no distribution to {prj.code}"
        return None

    # ------------------------------------------------------------------ orchestration
    def run(self, resources: list[str] | None = None, only_project: str | None = None) -> dict:
        wanted = [r for r in RESOURCES if r in (resources or RESOURCES)]
        result: dict = {"started_at": utcnow(), "resources": {}}
        for r in wanted:
            fn = getattr(self, r)
            result["resources"][r] = fn(only_project) if r in ("cost_codes", "commitments") else fn()
            self.db.flush()
        self.conn.last_sync_at = utcnow()
        self.conn.last_error = None
        result["finished_at"] = utcnow()
        result["rate_limit"] = dict(self.client.rate_limit)
        result["api_calls"] = self.client.calls
        return result
