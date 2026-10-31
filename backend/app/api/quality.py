from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from app.core.auth import Principal, require_internal
from app.db import get_db
from app.services import delivery
from app.services.helpers import command

router = APIRouter(prefix="/api/quality", tags=["quality"])


@router.post("/tests")
def record_test(body: dict, db: Session = Depends(get_db), p: Principal = Depends(require_internal)):
    data, _ = command(db, p, "quality.tests.create", None, body, lambda: delivery.record_test(db, p, body), 201)
    return data


@router.get("/recovery-cases")
def list_recovery_cases(state: str | None = None, db: Session = Depends(get_db), p: Principal = Depends(require_internal)):
    return delivery.list_recovery_cases(db, p, state)


@router.get("/recovery-cases/{case_id}")
def get_recovery_case(case_id: str, db: Session = Depends(get_db), p: Principal = Depends(require_internal)):
    return delivery.get_recovery_case(db, p, case_id)


@router.post("/recovery-cases")
def create_recovery_case(body: dict, db: Session = Depends(get_db), p: Principal = Depends(require_internal)):
    data, _ = command(db, p, "quality.recovery-cases.create", None, body, lambda: delivery.create_recovery_case(db, p, body), 201)
    return data


@router.post("/recovery-cases/{case_id}/disposition")
def disposition_case(case_id: str, body: dict, db: Session = Depends(get_db), p: Principal = Depends(require_internal)):
    data, _ = command(db, p, f"quality.recovery-cases.{case_id}.disposition", None, body, lambda: delivery.disposition_case(db, p, case_id, body))
    return data


@router.post("/recovery-cases/{case_id}/remove-component")
def remove_case_component(case_id: str, body: dict, db: Session = Depends(get_db), p: Principal = Depends(require_internal)):
    data, _ = command(db, p, f"quality.recovery-cases.{case_id}.remove-component", None, body, lambda: delivery.remove_case_component(db, p, case_id, body))
    return data


@router.post("/recovery-cases/{case_id}/fit-replacement")
def fit_replacement(case_id: str, body: dict, db: Session = Depends(get_db), p: Principal = Depends(require_internal)):
    data, _ = command(db, p, f"quality.recovery-cases.{case_id}.fit-replacement", None, body, lambda: delivery.fit_replacement(db, p, case_id, body))
    return data


@router.post("/recovery-cases/{case_id}/release")
def release_case(case_id: str, body: dict, db: Session = Depends(get_db), p: Principal = Depends(require_internal)):
    data, _ = command(db, p, f"quality.recovery-cases.{case_id}.release", None, body, lambda: delivery.release_case(db, p, case_id, body))
    return data


@router.post("/recovery-cases/{case_id}/close")
def close_case(case_id: str, body: dict | None = None, db: Session = Depends(get_db), p: Principal = Depends(require_internal)):
    data, _ = command(db, p, f"quality.recovery-cases.{case_id}.close", None, body or {}, lambda: delivery.close_case(db, p, case_id, body or {}))
    return data
