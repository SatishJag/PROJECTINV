from fastapi import APIRouter, Depends, Header
from fastapi.responses import JSONResponse
from sqlalchemy.orm import Session

from app.core.auth import Principal, current_principal, require_internal
from app.core.commands import remember, replay
from app.db import get_db
from app.services import planning
from app.services.helpers import command

router = APIRouter(prefix="/api/planning", tags=["planning"])


@router.get("/requirements")
def list_requirements(project_id: str | None = None, db: Session = Depends(get_db), p: Principal = Depends(require_internal)):
    return planning.list_requirements(db, p, project_id)


@router.post("/requirements")
def create_requirement(
    body: dict,
    db: Session = Depends(get_db),
    p: Principal = Depends(require_internal),
    idem: str | None = Header(default=None, alias="Idempotency-Key"),
):
    cached = replay(db, p, "planning.requirements.create", idem, body)
    if cached is not None:
        return cached
    data, duplicate = planning.create_requirement(db, p, body)
    remember(db, p, "planning.requirements.create", idem, body, data, 200 if duplicate else 201)
    db.commit()
    return JSONResponse(status_code=200 if duplicate else 201, content=data)


@router.get("/requirements/{requirement_id}")
def get_requirement(requirement_id: str, db: Session = Depends(get_db), p: Principal = Depends(require_internal)):
    return planning.get_requirement(db, p, requirement_id)


@router.post("/requirements/{requirement_id}/revisions")
def add_revision(requirement_id: str, body: dict, db: Session = Depends(get_db), p: Principal = Depends(require_internal)):
    data, _ = command(db, p, f"planning.requirements.{requirement_id}.revisions", None, body, lambda: planning.add_revision(db, p, requirement_id, body), 201)
    return data


@router.post("/revisions/{revision_id}/submit")
def submit_revision(revision_id: str, db: Session = Depends(get_db), p: Principal = Depends(require_internal)):
    data, _ = command(db, p, f"planning.revisions.{revision_id}.submit", None, {}, lambda: planning.submit_revision(db, p, revision_id))
    return data


@router.post("/revisions/{revision_id}/approve")
def approve_revision(
    revision_id: str,
    db: Session = Depends(get_db),
    p: Principal = Depends(require_internal),
    if_match: str | None = Header(default=None, alias="If-Match"),
):
    data, _ = command(db, p, f"planning.revisions.{revision_id}.approve", None, {}, lambda: planning.approve_revision(db, p, revision_id, if_match))
    return data


@router.post("/revisions/{revision_id}/cancel")
def cancel_revision(revision_id: str, db: Session = Depends(get_db), p: Principal = Depends(require_internal)):
    data, _ = command(db, p, f"planning.revisions.{revision_id}.cancel", None, {}, lambda: planning.cancel_revision(db, p, revision_id))
    return data


@router.get("/impact-actions")
def list_impact_actions(state: str | None = None, db: Session = Depends(get_db), p: Principal = Depends(require_internal)):
    return planning.list_impact_actions(db, p, state)


@router.post("/impact-actions/{action_id}/resolve")
def resolve_impact_action(action_id: str, body: dict, db: Session = Depends(get_db), p: Principal = Depends(require_internal)):
    data, _ = command(db, p, f"planning.impact-actions.{action_id}.resolve", None, body, lambda: planning.resolve_impact_action(db, p, action_id, body))
    return data


@router.post("/boq-imports")
def import_boq(
    body: dict,
    db: Session = Depends(get_db),
    p: Principal = Depends(require_internal),
    idem: str | None = Header(default=None, alias="Idempotency-Key"),
):
    cached = replay(db, p, "planning.boq.import", idem, body)
    if cached is not None:
        return cached
    data, duplicate = planning.import_boq(db, p, body)
    remember(db, p, "planning.boq.import", idem, body, data, 200 if duplicate else 201)
    db.commit()
    return JSONResponse(status_code=200 if duplicate else 201, content=data)


@router.get("/boq-revisions")
def list_boq_revisions(project_id: str | None = None, db: Session = Depends(get_db), p: Principal = Depends(require_internal)):
    return planning.list_boq_revisions(db, p, project_id)


@router.get("/benchmark-observations")
def list_observations(equipment_class_id: str | None = None, db: Session = Depends(get_db), p: Principal = Depends(require_internal)):
    return planning.list_benchmark_observations(db, p, equipment_class_id)


@router.post("/benchmark-runs")
def create_benchmark_run(body: dict, db: Session = Depends(get_db), p: Principal = Depends(require_internal)):
    data, _ = command(db, p, "planning.benchmark-runs.create", None, body, lambda: planning.create_benchmark_run(db, p, body), 201)
    return data


@router.get("/benchmark-runs/{run_id}")
def get_benchmark_run(run_id: str, db: Session = Depends(get_db), p: Principal = Depends(require_internal)):
    return planning.get_benchmark_run(db, p, run_id)


@router.get("/reuse-candidates")
def reuse_candidates(requirement_revision_id: str, db: Session = Depends(get_db), p: Principal = Depends(require_internal)):
    return planning.reuse_candidates(db, p, requirement_revision_id)


@router.post("/reuse-assessments")
def assess_reuse(body: dict, db: Session = Depends(get_db), p: Principal = Depends(require_internal)):
    data, _ = command(db, p, "planning.reuse-assessments.create", None, body, lambda: planning.assess_reuse(db, p, body), 201)
    return data


@router.post("/reuse-assessments/{assessment_id}/approve")
def approve_reuse(assessment_id: str, body: dict | None = None, db: Session = Depends(get_db), p: Principal = Depends(require_internal)):
    data, _ = command(db, p, f"planning.reuse-assessments.{assessment_id}.approve", None, body or {}, lambda: planning.decide_reuse(db, p, assessment_id, True, body or {}))
    return data


@router.post("/reuse-assessments/{assessment_id}/reject")
def reject_reuse(assessment_id: str, body: dict | None = None, db: Session = Depends(get_db), p: Principal = Depends(require_internal)):
    data, _ = command(db, p, f"planning.reuse-assessments.{assessment_id}.reject", None, body or {}, lambda: planning.decide_reuse(db, p, assessment_id, False, body or {}))
    return data


@router.post("/reservations")
def create_reservation(body: dict, db: Session = Depends(get_db), p: Principal = Depends(require_internal)):
    data, _ = command(db, p, "planning.reservations.create", None, body, lambda: planning.create_reservation(db, p, body), 201)
    return data


@router.post("/reservations/{reservation_id}/release")
def release_reservation(reservation_id: str, db: Session = Depends(get_db), p: Principal = Depends(require_internal)):
    data, _ = command(db, p, f"planning.reservations.{reservation_id}.release", None, {}, lambda: planning.release_reservation(db, p, reservation_id))
    return data


@router.get("/reservations")
def list_reservations(unit_id: str | None = None, db: Session = Depends(get_db), p: Principal = Depends(current_principal)):
    return planning.list_reservations(db, p, unit_id)
