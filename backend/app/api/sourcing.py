from fastapi import APIRouter, Depends, Header
from sqlalchemy.orm import Session

from app.core.auth import Principal, current_principal, require_internal
from app.db import get_db
from app.services import sourcing
from app.services.helpers import command

router = APIRouter(prefix="/api/sourcing", tags=["sourcing"])


@router.get("/packages")
def list_packages(db: Session = Depends(get_db), p: Principal = Depends(current_principal)):
    return sourcing.list_packages(db, p)


@router.post("/packages")
def create_package(body: dict, db: Session = Depends(get_db), p: Principal = Depends(require_internal)):
    data, _ = command(db, p, "sourcing.packages.create", None, body, lambda: sourcing.create_package(db, p, body), 201)
    return data


@router.get("/packages/{package_id}")
def get_package(package_id: str, db: Session = Depends(get_db), p: Principal = Depends(current_principal)):
    return sourcing.get_package(db, p, package_id)


@router.post("/packages/{package_id}/issue")
def issue_package(package_id: str, body: dict | None = None, db: Session = Depends(get_db), p: Principal = Depends(require_internal)):
    data, _ = command(db, p, f"sourcing.packages.{package_id}.issue", None, body or {}, lambda: sourcing.issue_package(db, p, package_id, body or {}))
    return data


@router.post("/packages/{package_id}/offers")
def submit_offer(package_id: str, body: dict, db: Session = Depends(get_db), p: Principal = Depends(current_principal)):
    data, _ = command(db, p, f"sourcing.packages.{package_id}.offers", None, body, lambda: sourcing.submit_offer(db, p, package_id, body), 201)
    return data


@router.get("/offers/{offer_id}")
def get_offer(offer_id: str, db: Session = Depends(get_db), p: Principal = Depends(current_principal)):
    return sourcing.get_offer(db, p, offer_id)


@router.post("/offer-lines/{offer_line_id}/adjustments")
def add_adjustment(offer_line_id: str, body: dict, db: Session = Depends(get_db), p: Principal = Depends(require_internal)):
    data, _ = command(db, p, f"sourcing.offer-lines.{offer_line_id}.adjustments", None, body, lambda: sourcing.add_adjustment(db, p, offer_line_id, body), 201)
    return data


@router.post("/adjustments/{adjustment_id}/approve")
def approve_adjustment(adjustment_id: str, body: dict | None = None, db: Session = Depends(get_db), p: Principal = Depends(require_internal)):
    data, _ = command(db, p, f"sourcing.adjustments.{adjustment_id}.approve", None, body or {}, lambda: sourcing.decide_adjustment(db, p, adjustment_id, body or {}, True))
    return data


@router.post("/adjustments/{adjustment_id}/reject")
def reject_adjustment(adjustment_id: str, body: dict | None = None, db: Session = Depends(get_db), p: Principal = Depends(require_internal)):
    data, _ = command(db, p, f"sourcing.adjustments.{adjustment_id}.reject", None, body or {}, lambda: sourcing.decide_adjustment(db, p, adjustment_id, body or {}, False))
    return data


@router.post("/offer-lines/{offer_line_id}/deviations")
def add_deviation(offer_line_id: str, body: dict, db: Session = Depends(get_db), p: Principal = Depends(require_internal)):
    data, _ = command(db, p, f"sourcing.offer-lines.{offer_line_id}.deviations", None, body, lambda: sourcing.add_deviation(db, p, offer_line_id, body), 201)
    return data


@router.post("/deviations/{deviation_id}/disposition")
def disposition_deviation(deviation_id: str, body: dict, db: Session = Depends(get_db), p: Principal = Depends(require_internal)):
    data, _ = command(db, p, f"sourcing.deviations.{deviation_id}.disposition", None, body, lambda: sourcing.disposition_deviation(db, p, deviation_id, body))
    return data


@router.post("/packages/{package_id}/evaluations")
def create_evaluation(package_id: str, body: dict, db: Session = Depends(get_db), p: Principal = Depends(require_internal)):
    data, _ = command(db, p, f"sourcing.packages.{package_id}.evaluations", None, body, lambda: sourcing.create_evaluation(db, p, package_id, body), 201)
    return data


@router.get("/evaluations/{evaluation_id}")
def get_evaluation(evaluation_id: str, db: Session = Depends(get_db), p: Principal = Depends(require_internal)):
    return sourcing.get_evaluation(db, p, evaluation_id)


@router.post("/evaluations/{evaluation_id}/submit")
def submit_evaluation(evaluation_id: str, db: Session = Depends(get_db), p: Principal = Depends(require_internal)):
    data, _ = command(db, p, f"sourcing.evaluations.{evaluation_id}.submit", None, {}, lambda: sourcing.submit_evaluation(db, p, evaluation_id))
    return data


@router.post("/evaluations/{evaluation_id}/approve")
def approve_evaluation(
    evaluation_id: str,
    db: Session = Depends(get_db),
    p: Principal = Depends(require_internal),
    if_match: str | None = Header(default=None, alias="If-Match"),
):
    data, _ = command(db, p, f"sourcing.evaluations.{evaluation_id}.approve", None, {}, lambda: sourcing.approve_evaluation(db, p, evaluation_id, if_match))
    return data


@router.post("/evaluations/{evaluation_id}/awards")
def create_award(evaluation_id: str, body: dict, db: Session = Depends(get_db), p: Principal = Depends(require_internal)):
    data, _ = command(db, p, f"sourcing.evaluations.{evaluation_id}.awards", None, body, lambda: sourcing.create_award(db, p, evaluation_id, body), 201)
    return data


@router.post("/awards/{award_id}/submit")
def submit_award(award_id: str, db: Session = Depends(get_db), p: Principal = Depends(require_internal)):
    data, _ = command(db, p, f"sourcing.awards.{award_id}.submit", None, {}, lambda: sourcing.submit_award(db, p, award_id))
    return data


@router.post("/awards/{award_id}/approve")
def approve_award(
    award_id: str,
    body: dict | None = None,
    db: Session = Depends(get_db),
    p: Principal = Depends(require_internal),
    if_match: str | None = Header(default=None, alias="If-Match"),
):
    data, _ = command(db, p, f"sourcing.awards.{award_id}.approve", None, body or {}, lambda: sourcing.approve_award(db, p, award_id, if_match, body or {}))
    return data


@router.get("/awards/{award_id}")
def get_award(award_id: str, db: Session = Depends(get_db), p: Principal = Depends(require_internal)):
    return sourcing.get_award(db, p, award_id)
