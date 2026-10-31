"""Sourcing chain: packages, offer revisions, normalization, deviations, evaluation and award."""

from __future__ import annotations

from datetime import date
from decimal import Decimal
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.api.common import row
from app.core.auth import Principal
from app.core.commands import bump, check_if_match
from app.core.decimal import MONEY_Q, RATE_Q, dstr
from app.core.errors import Conflict, DomainError, Forbidden
from app.core.outbox import publish_event
from app.models import (
    AwardDecision,
    AwardLine,
    EquipmentOption,
    Evaluation,
    EvaluationScore,
    NormalizationAdjustment,
    OfferLine,
    PackageLine,
    Project,
    PurchaseOrder,
    Requirement,
    RequirementRevision,
    SourcingPackage,
    Supplier,
    SupplierOffer,
    TechnicalDeviation,
    utcnow,
)
from app.services.helpers import audit, dec, get_row, need, optional_date, optional_dt, sha256

DEFAULT_POLICY = {
    "weights": {"INSTALLED_COST": "0.4", "TCO": "0.3", "DELIVERY": "0.2", "TECHNICAL": "0.1"},
    "horizon_years": 5,
    "discount_rate": "0.08",
}


def _package_or_none(db: Session, p: Principal, package_id: str) -> SourcingPackage:
    package = get_row(db, SourcingPackage, package_id, p, "Sourcing package")
    if p.is_supplier:
        if package.state != "ISSUED" or p.supplier_id not in (package.invited_supplier_ids or []):
            raise Forbidden("This package is not issued to your supplier account")
    return package


def _supplier_visible(db: Session, p: Principal, offer: SupplierOffer) -> bool:
    return (not p.is_supplier) or offer.supplier_id == p.supplier_id


def _package_out(db: Session, p: Principal, package: SourcingPackage) -> dict:
    lines = db.scalars(select(PackageLine).where(PackageLine.package_id == package.id).order_by(PackageLine.line_key))
    line_out = []
    for line in lines:
        revision = db.get(RequirementRevision, line.requirement_revision_id)
        requirement = db.get(Requirement, revision.requirement_id) if revision else None
        line_out.append(row(line, requirement_code=requirement.code if requirement else None, revision_no=revision.revision_no if revision else None))
    offers = _latest_offers(db, package.id)
    return row(
        package,
        lines=line_out,
        offers=[_offer_out(db, o, with_lines=False) for o in offers if _supplier_visible(db, p, o)],
        evaluations=[row(e) for e in db.scalars(select(Evaluation).where(Evaluation.package_id == package.id).order_by(Evaluation.revision_no.desc()))],
        awards=[
            row(a)
            for a in db.scalars(
                select(AwardDecision).where(AwardDecision.evaluation_id.in_([e.id for e in db.scalars(select(Evaluation).where(Evaluation.package_id == package.id))]))
            )
        ],
    )


def list_packages(db: Session, p: Principal) -> list[dict]:
    packages = list(db.scalars(select(SourcingPackage).where(SourcingPackage.tenant_id == p.tenant_id).order_by(SourcingPackage.created_at.desc())))
    if p.is_supplier:
        packages = [x for x in packages if x.state == "ISSUED" and p.supplier_id in (x.invited_supplier_ids or [])]
    return [_package_out(db, p, x) for x in packages]


def create_package(db: Session, p: Principal, body: dict) -> dict:
    code = need(body, "code")
    if db.scalar(select(SourcingPackage.id).where(SourcingPackage.tenant_id == p.tenant_id, SourcingPackage.code == code)):
        raise Conflict("DUPLICATE_PACKAGE_CODE", f"Package {code} already exists")
    package = SourcingPackage(
        tenant_id=p.tenant_id,
        created_by=p.email,
        code=code,
        title=need(body, "title"),
        programme_id=need(body, "programme_id"),
        currency=body.get("currency") or "USD",
        bid_due_at=optional_dt(body.get("bid_due_at")),
        evaluation_policy_json=body.get("evaluation_policy_json") or DEFAULT_POLICY,
        invited_supplier_ids=body.get("invited_supplier_ids") or [],
        state="DRAFT",
    )
    db.add(package)
    db.flush()
    for line in body.get("lines") or []:
        revision = db.get(RequirementRevision, need(line, "requirement_revision_id"))
        if revision is None or revision.tenant_id != p.tenant_id:
            raise DomainError("NOT_FOUND", "Requirement revision not found", status=404)
        if revision.state != "APPROVED":
            raise DomainError("REQUIREMENT_NOT_APPROVED", f"Revision {revision.revision_no} is not approved")
        db.add(
            PackageLine(
                tenant_id=p.tenant_id,
                created_by=p.email,
                package_id=package.id,
                line_key=need(line, "line_key"),
                requirement_revision_id=revision.id,
                quantity=dec(line.get("quantity"), "quantity", required=True),
                uom=line.get("uom") or "EA",
                scope_json=line.get("scope_json") or {},
            )
        )
    db.flush()
    audit(db, p, "PACKAGE_CREATED", "sourcing_package", package.id, after={"code": package.code})
    return _package_out(db, p, package)


def get_package(db: Session, p: Principal, package_id: str) -> dict:
    return _package_out(db, p, _package_or_none(db, p, package_id))


def issue_package(db: Session, p: Principal, package_id: str, body: dict) -> dict:
    package = get_row(db, SourcingPackage, package_id, p, "Sourcing package")
    if package.state != "DRAFT":
        raise Conflict("INVALID_STATE", f"Package is {package.state}")
    package.state = "ISSUED"
    package.bid_due_at = optional_dt(body.get("bid_due_at")) or package.bid_due_at
    if body.get("invited_supplier_ids") is not None:
        package.invited_supplier_ids = body["invited_supplier_ids"]
    bump(package)
    audit(db, p, "PACKAGE_ISSUED", "sourcing_package", package.id)
    return _package_out(db, p, package)


# ---------------------------------------------------------------- offers


def _latest_offers(db: Session, package_id: str) -> list[SupplierOffer]:
    offers = list(
        db.scalars(
            select(SupplierOffer)
            .where(SupplierOffer.package_id == package_id, SupplierOffer.state.notin_(("SUPERSEDED", "WITHDRAWN")))
            .order_by(SupplierOffer.supplier_id, SupplierOffer.revision_no.desc())
        )
    )
    latest: dict[str, SupplierOffer] = {}
    for offer in offers:
        latest.setdefault(offer.supplier_id, offer)
    return list(latest.values())


def _offer_out(db: Session, offer: SupplierOffer, with_lines: bool = True) -> dict:
    supplier = db.get(Supplier, offer.supplier_id)
    out = row(offer, supplier_key=supplier.key if supplier else None, supplier_name=supplier.name if supplier else None)
    if with_lines:
        lines = []
        for line in db.scalars(select(OfferLine).where(OfferLine.offer_id == offer.id)):
            option = db.get(EquipmentOption, line.option_id)
            adjustments = db.scalars(select(NormalizationAdjustment).where(NormalizationAdjustment.offer_line_id == line.id))
            deviations = db.scalars(select(TechnicalDeviation).where(TechnicalDeviation.offer_line_id == line.id))
            lines.append(
                row(
                    line,
                    option_code=option.option_code if option else None,
                    item_code=option.item_model.item_code if option and option.item_model else None,
                    adjustments=[row(a) for a in adjustments],
                    deviations=[row(d) for d in deviations],
                )
            )
        out["lines"] = lines
    return out


def submit_offer(db: Session, p: Principal, package_id: str, body: dict) -> dict:
    package = _package_or_none(db, p, package_id)
    supplier_id = p.supplier_id if p.is_supplier else body.get("supplier_id")
    if not supplier_id:
        raise DomainError("VALIDATION", "supplier_id is required for internal submissions")
    supplier = get_row(db, Supplier, supplier_id, p, "Supplier")
    if p.is_supplier and supplier.id != p.supplier_id:
        raise Forbidden("A supplier may only submit its own offer")
    if package.state == "CLOSED":
        raise Conflict("PACKAGE_CLOSED", "Package is closed for offers")
    line_bodies = body.get("lines") or []
    if not line_bodies:
        raise DomainError("VALIDATION", "lines must not be empty")
    content_hash = sha256({"lines": line_bodies, "currency": body.get("currency"), "valid_until": body.get("valid_until"), "incoterms": body.get("incoterms")})
    previous = db.scalar(
        select(SupplierOffer)
        .where(SupplierOffer.package_id == package.id, SupplierOffer.supplier_id == supplier.id)
        .order_by(SupplierOffer.revision_no.desc())
    )
    if previous and previous.content_hash == content_hash:
        return _offer_out(db, previous)
    if previous:
        previous.state = "SUPERSEDED"
    offer = SupplierOffer(
        tenant_id=p.tenant_id,
        created_by=p.email,
        package_id=package.id,
        supplier_id=supplier.id,
        source_offer_key=need(body, "source_offer_key"),
        revision_no=(previous.revision_no if previous else 0) + 1,
        predecessor_id=previous.id if previous else None,
        currency=body.get("currency") or package.currency,
        fx_rate_to_package=dec(body.get("fx_rate_to_package"), "fx_rate_to_package"),
        valid_until=optional_date(body.get("valid_until")),
        incoterms=body.get("incoterms"),
        state="RECEIVED",
        content_hash=content_hash,
    )
    db.add(offer)
    db.flush()
    line_by_key = {line.line_key: line for line in db.scalars(select(PackageLine).where(PackageLine.package_id == package.id))}
    for item in line_bodies:
        package_line = line_by_key.get(item.get("line_key"))
        if package_line is None:
            raise DomainError("VALIDATION", f"Unknown package line {item.get('line_key')}")
        option = db.scalar(
            select(EquipmentOption).where(
                EquipmentOption.tenant_id == p.tenant_id,
                EquipmentOption.option_code == need(item, "option_code"),
                EquipmentOption.state == "APPROVED",
            ).order_by(EquipmentOption.revision_no.desc())
        )
        if option is None:
            raise DomainError("VALIDATION", f"Unknown or unapproved option {item.get('option_code')}")
        quantity = dec(item.get("quantity"), "quantity", required=True)
        unit_price = dec(item.get("unit_price"), "unit_price", required=True)
        if quantity <= 0 or unit_price < 0:
            raise DomainError("VALIDATION", "quantity must be positive and unit_price non-negative")
        db.add(
            OfferLine(
                tenant_id=p.tenant_id,
                created_by=p.email,
                offer_id=offer.id,
                package_line_id=package_line.id,
                option_id=option.id,
                quantity=quantity,
                unit_price=unit_price,
                base_amount=(quantity * unit_price).quantize(MONEY_Q),
                promised_delivery_date=optional_date(item.get("promised_delivery_date")),
                lead_time_days=item.get("lead_time_days"),
                scope_json=item.get("scope_json") or {"included": [], "excluded": []},
                annual_om_estimate=dec(item.get("annual_om_estimate"), "annual_om_estimate"),
                warranty_months=item.get("warranty_months"),
            )
        )
    db.flush()
    _invalidate_evaluations(db, p, package.id, f"Offer {supplier.key} revision {offer.revision_no} received")
    audit(db, p, "OFFER_SUBMITTED", "supplier_offer", offer.id, after={"revision_no": offer.revision_no})
    return _offer_out(db, offer)


def get_offer(db: Session, p: Principal, offer_id: str) -> dict:
    offer = get_row(db, SupplierOffer, offer_id, p, "Offer")
    if p.is_supplier and offer.supplier_id != p.supplier_id:
        raise DomainError("NOT_FOUND", "Offer not found", status=404)
    return _offer_out(db, offer)


def _invalidate_evaluations(db: Session, p: Principal, package_id: str, reason: str) -> None:
    for evaluation in db.scalars(select(Evaluation).where(Evaluation.package_id == package_id, Evaluation.state != "SUPERSEDED")):
        if evaluation.state == "STALE" and evaluation.stale_reason == reason:
            continue
        evaluation.state = "STALE"
        evaluation.stale_reason = reason
        publish_event(db, p.tenant_id, "EvaluationInvalidated", "evaluation", evaluation.id, {"evaluation_id": evaluation.id, "reason": reason}, version=evaluation.version)


def add_adjustment(db: Session, p: Principal, offer_line_id: str, body: dict) -> dict:
    line = get_row(db, OfferLine, offer_line_id, p, "Offer line")
    category = str(need(body, "category")).upper()
    scope = line.scope_json or {}
    if category in [x.upper() for x in scope.get("included", [])]:
        raise Conflict("DUPLICATE_SCOPE_ADJUSTMENT", f"{category} is already included in the offer price")
    existing = db.scalar(
        select(NormalizationAdjustment).where(NormalizationAdjustment.offer_line_id == line.id, NormalizationAdjustment.category == category)
    )
    if existing:
        raise Conflict("ADJUSTMENT_EXISTS", f"A {category} adjustment already exists for this line")
    amount = dec(body.get("amount"), "amount")
    adjustment = NormalizationAdjustment(
        tenant_id=p.tenant_id,
        created_by=p.email,
        offer_line_id=line.id,
        category=category,
        amount=amount,
        currency=body.get("currency") or "USD",
        rationale=need(body, "rationale"),
        evidence_ref=body.get("evidence_ref"),
        state="PROPOSED",
    )
    db.add(adjustment)
    db.flush()
    offer = db.get(SupplierOffer, line.offer_id)
    _invalidate_evaluations(db, p, offer.package_id, f"Normalization adjustment {category} proposed")
    audit(db, p, "ADJUSTMENT_PROPOSED", "normalization_adjustment", adjustment.id, after={"category": category, "amount": dstr(amount)})
    return row(adjustment)


def decide_adjustment(db: Session, p: Principal, adjustment_id: str, body: dict, approve: bool) -> dict:
    adjustment = get_row(db, NormalizationAdjustment, adjustment_id, p, "Adjustment")
    if adjustment.state != "PROPOSED":
        raise Conflict("INVALID_STATE", f"Adjustment is {adjustment.state}")
    adjustment.state = "APPROVED" if approve else "REJECTED"
    adjustment.approved_by = p.email
    bump(adjustment)
    line = db.get(OfferLine, adjustment.offer_line_id)
    offer = db.get(SupplierOffer, line.offer_id)
    _invalidate_evaluations(db, p, offer.package_id, f"Normalization adjustment {adjustment.category} {adjustment.state.lower()}")
    audit(db, p, f"ADJUSTMENT_{adjustment.state}", "normalization_adjustment", adjustment.id)
    return row(adjustment)


def add_deviation(db: Session, p: Principal, offer_line_id: str, body: dict) -> dict:
    line = get_row(db, OfferLine, offer_line_id, p, "Offer line")
    deviation = TechnicalDeviation(
        tenant_id=p.tenant_id,
        created_by=p.email,
        offer_line_id=line.id,
        criterion_ref=need(body, "criterion_ref"),
        mandatory=bool(body.get("mandatory", True)),
        severity=body.get("severity") or "MAJOR",
        description=need(body, "description"),
        proposed_alternative=body.get("proposed_alternative"),
        disposition="OPEN",
    )
    db.add(deviation)
    db.flush()
    offer = db.get(SupplierOffer, line.offer_id)
    _invalidate_evaluations(db, p, offer.package_id, f"Technical deviation {deviation.criterion_ref} recorded")
    audit(db, p, "DEVIATION_RAISED", "technical_deviation", deviation.id, after={"criterion_ref": deviation.criterion_ref})
    return row(deviation)


def disposition_deviation(db: Session, p: Principal, deviation_id: str, body: dict) -> dict:
    if not p.has("ENGINEERING"):
        raise Forbidden("Only ENGINEERING may disposition a technical deviation")
    deviation = get_row(db, TechnicalDeviation, deviation_id, p, "Technical deviation")
    disposition = need(body, "disposition")
    if disposition not in ("ACCEPTED", "REJECTED"):
        raise DomainError("VALIDATION", "disposition must be ACCEPTED or REJECTED")
    deviation.disposition = disposition
    deviation.approver = p.email
    deviation.evidence_ref = body.get("evidence_ref") or deviation.evidence_ref
    bump(deviation)
    line = db.get(OfferLine, deviation.offer_line_id)
    offer = db.get(SupplierOffer, line.offer_id)
    _invalidate_evaluations(db, p, offer.package_id, f"Deviation {deviation.criterion_ref} {disposition.lower()}")
    audit(db, p, f"DEVIATION_{disposition}", "technical_deviation", deviation.id)
    return row(deviation)


# ---------------------------------------------------------------- evaluation


def _policy(package: SourcingPackage, body: dict) -> dict:
    policy = dict(DEFAULT_POLICY)
    policy.update(package.evaluation_policy_json or {})
    for key, value in (body.get("criteria_policy_json") or {}).items():
        if key == "weights":
            policy.setdefault("weights", {}).update(value)
        else:
            policy[key] = value
    return policy


def _evaluate(db: Session, package: SourcingPackage, policy: dict) -> dict:
    lines_by_pkg = {line.id: line for line in db.scalars(select(PackageLine).where(PackageLine.package_id == package.id))}
    weights = {k: dec(v, f"weight.{k}") or Decimal(0) for k, v in (policy.get("weights") or DEFAULT_POLICY["weights"]).items()}
    horizon = int(policy.get("horizon_years") or 5)
    rate = dec(policy.get("discount_rate") or "0.08") or Decimal(0)
    offers = _latest_offers(db, package.id)
    raw_lines: list[dict] = []
    for offer in offers:
        offer_lines = list(db.scalars(select(OfferLine).where(OfferLine.offer_id == offer.id)))
        ineligible: list[str] = []
        unknowns: list[str] = []
        covered = {line.package_line_id for line in offer_lines}
        if set(lines_by_pkg) - covered:
            ineligible.append("Missing lines: " + ", ".join(sorted(lines_by_pkg[x].line_key for x in set(lines_by_pkg) - covered)))
        line_ids = [line.id for line in offer_lines]
        adjustments = list(
            db.scalars(
                select(NormalizationAdjustment).where(
                    NormalizationAdjustment.offer_line_id.in_(line_ids), NormalizationAdjustment.state != "REJECTED"
                )
            )
        ) if line_ids else []
        deviations = list(
            db.scalars(select(TechnicalDeviation).where(TechnicalDeviation.offer_line_id.in_(line_ids)))
        ) if line_ids else []
        for adjustment in adjustments:
            if adjustment.amount is None:
                unknowns.append(f"UNPRICED_{adjustment.category}")
        adjusted_categories = {a.category.upper() for a in adjustments}
        for line in offer_lines:
            for excluded in (line.scope_json or {}).get("excluded", []):
                if excluded.upper() not in adjusted_categories and f"UNPRICED_{excluded.upper()}" not in unknowns:
                    unknowns.append(f"EXCLUDED_{excluded.upper()}")
        for deviation in deviations:
            if deviation.mandatory and deviation.disposition != "ACCEPTED":
                ineligible.append(f"Mandatory deviation {deviation.criterion_ref} is {deviation.disposition}")
        unknowns = list(dict.fromkeys(unknowns))
        fx = offer.fx_rate_to_package or Decimal(1)
        base = sum((line.base_amount for line in offer_lines), Decimal(0))
        adjustment_total = sum((a.amount for a in adjustments if a.amount is not None), Decimal(0))
        normalized = (base * fx + adjustment_total).quantize(MONEY_Q) if not unknowns else None
        annual_om = sum((line.annual_om_estimate or Decimal(0) for line in offer_lines), Decimal(0)) * fx
        tco = None
        if normalized is not None:
            tco = normalized
            for year in range(1, horizon + 1):
                tco += annual_om / ((Decimal(1) + rate) ** year)
            tco = tco.quantize(MONEY_Q)
        lead = max((line.lead_time_days for line in offer_lines if line.lead_time_days is not None), default=None)
        supplier = db.get(Supplier, offer.supplier_id)
        raw_lines.append(
            {
                "offer_id": offer.id,
                "offer_revision_no": offer.revision_no,
                "supplier_id": supplier.id if supplier else None,
                "supplier_key": supplier.key if supplier else None,
                "supplier_name": supplier.name if supplier else None,
                "option_id": offer_lines[0].option_id if offer_lines else None,
                "package_line_id": offer_lines[0].package_line_id if offer_lines else None,
                "offer_line_ids": [line.id for line in offer_lines],
                "offer_lines": {line.package_line_id: line.id for line in offer_lines},
                "offer_line_id": offer_lines[0].id if offer_lines else None,
                "normalized_installed_cost": dstr(normalized),
                "tco_pv": dstr(tco),
                "annual_om": dstr(annual_om),
                "lead_time_days": lead,
                "promised_delivery_date": offer_lines[0].promised_delivery_date.isoformat() if offer_lines and offer_lines[0].promised_delivery_date else None,
                "eligible": not ineligible,
                "ineligible_reasons": ineligible,
                "unknowns": unknowns,
                "currency": package.currency,
                "scores": {"TECHNICAL": Decimal(1) if not ineligible else Decimal(0)},
                "weighted_score": None,
                "rank": None,
            }
        )
    costs = [Decimal(x["normalized_installed_cost"]) for x in raw_lines if x["normalized_installed_cost"] is not None]
    tcos = [Decimal(x["tco_pv"]) for x in raw_lines if x["tco_pv"] is not None]
    leads = [Decimal(x["lead_time_days"]) for x in raw_lines if x["lead_time_days"]]
    min_cost = min(costs) if costs else None
    min_tco = min(tcos) if tcos else None
    min_lead = min(leads) if leads else None
    for item in raw_lines:
        scores = dict(item["scores"])
        if item["normalized_installed_cost"] is not None and min_cost:
            scores["INSTALLED_COST"] = (min_cost / Decimal(item["normalized_installed_cost"])).quantize(RATE_Q)
        if item["tco_pv"] is not None and min_tco:
            scores["TCO"] = (min_tco / Decimal(item["tco_pv"])).quantize(RATE_Q)
        if item["lead_time_days"] and min_lead:
            scores["DELIVERY"] = (min_lead / Decimal(item["lead_time_days"])).quantize(RATE_Q)
        item["scores"] = {k: dstr(v) for k, v in scores.items()}
        used = {k: v for k, v in scores.items() if k in weights and v is not None}
        total_weight = sum(weights[k] for k in used)
        if used and total_weight:
            weighted = sum(v * weights[k] for k, v in used.items()) / total_weight
            item["weighted_score"] = dstr(weighted.quantize(RATE_Q)) if item["eligible"] else None
            item["basis_complete"] = set(used) >= {"INSTALLED_COST", "TCO", "TECHNICAL"}
        else:
            item["basis_complete"] = False
    ranked = sorted(
        [x for x in raw_lines if x["weighted_score"] is not None and x["eligible"]],
        key=lambda x: Decimal(x["weighted_score"]),
        reverse=True,
    )
    for position, item in enumerate(ranked, start=1):
        item["rank"] = position
        item["recommended"] = position == 1
    fingerprint = sha256(
        {
            "package": package.id,
            "lines": sorted([[k, v.requirement_revision_id, dstr(v.quantity)] for k, v in lines_by_pkg.items()]),
            "offers": sorted([[o.id, o.revision_no, o.content_hash] for o in offers]),
            "weights": {k: dstr(v) for k, v in weights.items()},
            "horizon": horizon,
            "rate": dstr(rate),
        }
    )
    return {
        "lines": raw_lines,
        "weights": {k: dstr(v) for k, v in weights.items()},
        "horizon_years": horizon,
        "discount_rate": dstr(rate),
        "currency": package.currency,
        "unknown_policy": "Lines with unpriced exclusions are not ranked and show an explicit unknown.",
        "fingerprint": fingerprint,
    }


def create_evaluation(db: Session, p: Principal, package_id: str, body: dict) -> dict:
    package = get_row(db, SourcingPackage, package_id, p, "Sourcing package")
    if package.state == "DRAFT":
        raise Conflict("PACKAGE_NOT_ISSUED", "Issue the package before evaluating offers")
    policy = _policy(package, body)
    result = _evaluate(db, package, policy)
    previous_no = db.scalar(select(Evaluation.revision_no).where(Evaluation.package_id == package.id).order_by(Evaluation.revision_no.desc()))
    evaluation = Evaluation(
        tenant_id=p.tenant_id,
        created_by=p.email,
        package_id=package.id,
        revision_no=(previous_no or 0) + 1,
        state="CALCULATED",
        criteria_policy_json=policy,
        input_fingerprint=result["fingerprint"],
        input_manifest_json={
            "offer_ids": [x["offer_id"] for x in result["lines"]],
            "evidence_cutoff": utcnow().isoformat(),
            "weights": result["weights"],
        },
        evidence_cutoff=utcnow(),
        results_json=result,
    )
    db.add(evaluation)
    db.flush()
    weight_map = {k: dec(v) for k, v in result["weights"].items()}
    for item in result["lines"]:
        for criterion, value in (item.get("scores") or {}).items():
            db.add(
                EvaluationScore(
                    tenant_id=p.tenant_id,
                    created_by=p.email,
                    evaluation_id=evaluation.id,
                    offer_line_id=item["offer_line_id"],
                    criterion_code=criterion,
                    raw_value={
                        "INSTALLED_COST": item["normalized_installed_cost"],
                        "TCO": item["tco_pv"],
                        "DELIVERY": str(item["lead_time_days"]) if item["lead_time_days"] else None,
                        "TECHNICAL": "eligible" if item["eligible"] else "ineligible",
                    }.get(criterion),
                    score=dec(value),
                    weight=weight_map.get(criterion),
                    eligible=item["eligible"],
                    note="; ".join(item["ineligible_reasons"] + item["unknowns"]) or None,
                )
            )
    db.flush()
    audit(db, p, "EVALUATION_CALCULATED", "evaluation", evaluation.id, after={"revision_no": evaluation.revision_no})
    return _evaluation_out(db, p, evaluation)


def _evaluation_out(db: Session, p: Principal, evaluation: Evaluation) -> dict:
    package = db.get(SourcingPackage, evaluation.package_id)
    current = _evaluate(db, package, evaluation.criteria_policy_json or DEFAULT_POLICY)
    is_stale = current["fingerprint"] != evaluation.input_fingerprint or evaluation.state == "STALE"
    stale_reason = evaluation.stale_reason if evaluation.state == "STALE" else ("Inputs changed since this evaluation was calculated" if is_stale else None)
    scores = db.scalars(select(EvaluationScore).where(EvaluationScore.evaluation_id == evaluation.id))
    return {
        "evaluation": row(evaluation),
        "package_code": package.code if package else None,
        "results": evaluation.results_json or {},
        "scores": [row(s) for s in scores],
        "is_stale": is_stale,
        "stale_reason": stale_reason,
        "current_fingerprint": current["fingerprint"],
    }


def get_evaluation(db: Session, p: Principal, evaluation_id: str) -> dict:
    return _evaluation_out(db, p, get_row(db, Evaluation, evaluation_id, p, "Evaluation"))


def submit_evaluation(db: Session, p: Principal, evaluation_id: str) -> dict:
    evaluation = get_row(db, Evaluation, evaluation_id, p, "Evaluation")
    if evaluation.state != "CALCULATED":
        raise Conflict("INVALID_STATE", f"Evaluation is {evaluation.state}")
    evaluation.state = "IN_REVIEW"
    bump(evaluation)
    audit(db, p, "EVALUATION_SUBMITTED", "evaluation", evaluation.id)
    return _evaluation_out(db, p, evaluation)


def approve_evaluation(db: Session, p: Principal, evaluation_id: str, if_match: str | None) -> dict:
    evaluation = get_row(db, Evaluation, evaluation_id, p, "Evaluation")
    check_if_match(evaluation, if_match, required=True)
    current = _evaluate(db, db.get(SourcingPackage, evaluation.package_id), evaluation.criteria_policy_json or DEFAULT_POLICY)
    if current["fingerprint"] != evaluation.input_fingerprint:
        raise Conflict("EVALUATION_STALE", "Offer, adjustment or requirement inputs changed; recalculate the evaluation")
    if evaluation.state not in ("IN_REVIEW", "CALCULATED"):
        raise Conflict("INVALID_STATE", f"Evaluation is {evaluation.state}")
    evaluation.state = "APPROVED"
    bump(evaluation)
    audit(db, p, "EVALUATION_APPROVED", "evaluation", evaluation.id)
    return _evaluation_out(db, p, evaluation)


# ---------------------------------------------------------------- award


def create_award(db: Session, p: Principal, evaluation_id: str, body: dict) -> dict:
    evaluation = get_row(db, Evaluation, evaluation_id, p, "Evaluation")
    if evaluation.state != "APPROVED":
        raise Conflict("EVALUATION_NOT_APPROVED", "Only an approved evaluation can be awarded")
    current = _evaluate(db, db.get(SourcingPackage, evaluation.package_id), evaluation.criteria_policy_json or DEFAULT_POLICY)
    if current["fingerprint"] != evaluation.input_fingerprint:
        raise Conflict("EVALUATION_STALE", "Evaluation inputs changed; recalculate before award")
    fingerprint = need(body, "input_fingerprint")
    if fingerprint != evaluation.input_fingerprint:
        raise Conflict("FINGERPRINT_MISMATCH", "The supplied input fingerprint does not match the approved evaluation")
    evaluated = {
        offer_line_id: item
        for item in (evaluation.results_json or {}).get("lines", [])
        for offer_line_id in (item.get("offer_lines") or {item.get("offer_line_id"): item.get("offer_line_id")}).values()
        if offer_line_id
    }
    package = db.get(SourcingPackage, evaluation.package_id)
    lines: list[dict] = []
    totals: dict[str, Decimal] = {}
    for existing in db.scalars(
        select(AwardLine).where(
            AwardLine.award_id.in_(
                [a.id for a in db.scalars(select(AwardDecision).where(AwardDecision.state != "REJECTED"))]
            )
        )
    ):
        totals[existing.package_line_id] = totals.get(existing.package_line_id, Decimal(0)) + existing.selected_quantity
    award = AwardDecision(
        tenant_id=p.tenant_id,
        created_by=p.email,
        evaluation_id=evaluation.id,
        state="DRAFT",
        rationale=need(body, "rationale"),
        input_fingerprint=fingerprint,
        frozen_json={"evaluation_revision": evaluation.revision_no, "lines": []},
    )
    db.add(award)
    db.flush()
    for item in body.get("lines") or []:
        offer_line_id = need(item, "offer_line_id")
        package_line_id = need(item, "package_line_id")
        quantity = dec(item.get("selected_quantity"), "selected_quantity", required=True)
        evaluated_line = evaluated.get(offer_line_id)
        if evaluated_line is None:
            raise DomainError("VALIDATION", "Offer line is not part of the approved evaluation")
        if not evaluated_line.get("eligible"):
            raise DomainError("OFFER_INELIGIBLE", "Offer has unresolved mandatory deviations")
        package_line = db.get(PackageLine, package_line_id)
        if package_line is None or package_line.package_id != package.id:
            raise DomainError("VALIDATION", "Package line does not belong to this package")
        if totals.get(package_line_id, Decimal(0)) + quantity > package_line.quantity:
            raise Conflict("OVER_AWARD", f"Award exceeds package line {package_line.line_key} quantity {dstr(package_line.quantity)}")
        totals[package_line_id] = totals.get(package_line_id, Decimal(0)) + quantity
        offer_line = db.get(OfferLine, offer_line_id)
        offer = db.get(SupplierOffer, offer_line.offer_id)
        db.add(
            AwardLine(
                tenant_id=p.tenant_id,
                created_by=p.email,
                award_id=award.id,
                package_line_id=package_line_id,
                offer_line_id=offer_line_id,
                option_id=offer_line.option_id,
                supplier_id=offer.supplier_id,
                selected_quantity=quantity,
            )
        )
        lines.append({"package_line_id": package_line_id, "offer_line_id": offer_line_id, "selected_quantity": dstr(quantity)})
    award.frozen_json = {"evaluation_revision": evaluation.revision_no, "input_fingerprint": fingerprint, "lines": lines}
    db.flush()
    audit(db, p, "AWARD_DRAFTED", "award_decision", award.id, after={"lines": len(lines)})
    return _award_out(db, p, award)


def submit_award(db: Session, p: Principal, award_id: str) -> dict:
    award = get_row(db, AwardDecision, award_id, p, "Award")
    if award.state != "DRAFT":
        raise Conflict("INVALID_STATE", f"Award is {award.state}")
    award.state = "IN_REVIEW"
    bump(award)
    audit(db, p, "AWARD_SUBMITTED", "award_decision", award.id)
    return _award_out(db, p, award)


def approve_award(db: Session, p: Principal, award_id: str, if_match: str | None, body: dict) -> dict:
    award = get_row(db, AwardDecision, award_id, p, "Award")
    check_if_match(award, if_match, required=True)
    if award.state not in ("IN_REVIEW", "DRAFT"):
        raise Conflict("INVALID_STATE", f"Award is {award.state}")
    evaluation = db.get(Evaluation, award.evaluation_id)
    current = _evaluate(db, db.get(SourcingPackage, evaluation.package_id), evaluation.criteria_policy_json or DEFAULT_POLICY)
    if current["fingerprint"] != award.input_fingerprint or evaluation.input_fingerprint != award.input_fingerprint:
        raise Conflict("EVALUATION_STALE", "Evaluation inputs changed; the award cannot be approved against stale evidence")
    if body.get("input_fingerprint") and body["input_fingerprint"] != award.input_fingerprint:
        raise Conflict("FINGERPRINT_MISMATCH", "Supplied fingerprint does not match the frozen award inputs")
    award.state = "APPROVED"
    award.approved_by = p.email
    award.approved_at = utcnow()
    bump(award)
    publish_event(db, p.tenant_id, "AwardApproved", "award_decision", award.id, {"award_id": award.id, "evaluation_id": evaluation.id}, version=award.version)
    audit(db, p, "AWARD_APPROVED", "award_decision", award.id, after={"frozen": award.frozen_json})
    return _award_out(db, p, award)


def get_award(db: Session, p: Principal, award_id: str) -> dict:
    return _award_out(db, p, get_row(db, AwardDecision, award_id, p, "Award"))


def _award_out(db: Session, p: Principal, award: AwardDecision) -> dict:
    lines = []
    for line in db.scalars(select(AwardLine).where(AwardLine.award_id == award.id)):
        supplier = db.get(Supplier, line.supplier_id)
        package_line = db.get(PackageLine, line.package_line_id)
        lines.append(
            row(
                line,
                supplier_key=supplier.key if supplier else None,
                supplier_name=supplier.name if supplier else None,
                line_key=package_line.line_key if package_line else None,
            )
        )
    pos = db.scalars(select(PurchaseOrder).where(PurchaseOrder.award_id == award.id))
    evaluation = db.get(Evaluation, award.evaluation_id)
    return {
        "award": row(award),
        "evaluation_id": award.evaluation_id,
        "evaluation": row(evaluation) if evaluation else None,
        "lines": lines,
        "purchase_orders": [row(po, supplier_key=po.supplier.key if po.supplier else None) for po in pos],
        "reconciliation": "RECONCILED" if pos else "AWAITING_PO",
    }
