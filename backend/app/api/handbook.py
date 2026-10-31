from fastapi import APIRouter, Depends, Header
from sqlalchemy.orm import Session

from app.core.auth import Principal, require_internal
from app.db import get_db
from app.services import handbook
from app.services.helpers import command

router = APIRouter(prefix="/api/handbooks", tags=["handbooks"])


@router.get("/templates")
def list_templates(db: Session = Depends(get_db), p: Principal = Depends(require_internal)):
    return handbook.list_templates(db, p)


@router.get("/evidence")
def list_evidence(unit_id: str | None = None, db: Session = Depends(get_db), p: Principal = Depends(require_internal)):
    return handbook.list_evidence(db, p, unit_id)


@router.post("/evidence")
def create_evidence(body: dict, db: Session = Depends(get_db), p: Principal = Depends(require_internal)):
    data, _ = command(db, p, "handbooks.evidence.create", None, body, lambda: handbook.create_evidence(db, p, body), 201)
    return data


@router.post("/evidence/{evidence_id}/approve")
def approve_evidence(evidence_id: str, db: Session = Depends(get_db), p: Principal = Depends(require_internal)):
    data, _ = command(db, p, f"handbooks.evidence.{evidence_id}.approve", None, {}, lambda: handbook.approve_evidence(db, p, evidence_id))
    return data


@router.get("")
def list_packages(unit_id: str | None = None, state: str | None = None, db: Session = Depends(get_db), p: Principal = Depends(require_internal)):
    return handbook.list_packages(db, p, unit_id, state)


@router.post("")
def create_package(body: dict, db: Session = Depends(get_db), p: Principal = Depends(require_internal)):
    data, _ = command(db, p, "handbooks.create", None, body, lambda: handbook.create_package(db, p, body), 201)
    return data


@router.get("/{package_id}")
def get_package(package_id: str, db: Session = Depends(get_db), p: Principal = Depends(require_internal)):
    return handbook.get_package(db, p, package_id)


@router.post("/{package_id}/validate")
def validate_package(package_id: str, db: Session = Depends(get_db), p: Principal = Depends(require_internal)):
    data, _ = command(db, p, f"handbooks.{package_id}.validate", None, {}, lambda: handbook.validate_package(db, p, package_id))
    return data


@router.post("/{package_id}/entries/{entry_id}/waive")
def waive_entry(package_id: str, entry_id: str, body: dict, db: Session = Depends(get_db), p: Principal = Depends(require_internal)):
    data, _ = command(db, p, f"handbooks.{package_id}.entries.{entry_id}.waive", None, body, lambda: handbook.waive_entry(db, p, package_id, entry_id, body))
    return data


@router.post("/{package_id}/approve")
def approve_package(
    package_id: str,
    db: Session = Depends(get_db),
    p: Principal = Depends(require_internal),
    if_match: str | None = Header(default=None, alias="If-Match"),
):
    data, _ = command(db, p, f"handbooks.{package_id}.approve", None, {}, lambda: handbook.approve_package(db, p, package_id, if_match))
    return data


@router.post("/{package_id}/publish")
def publish_package(
    package_id: str,
    db: Session = Depends(get_db),
    p: Principal = Depends(require_internal),
    if_match: str | None = Header(default=None, alias="If-Match"),
):
    data, _ = command(db, p, f"handbooks.{package_id}.publish", None, {}, lambda: handbook.publish_package(db, p, package_id, if_match))
    return data


@router.post("/{package_id}/acceptance")
def accept_package(package_id: str, body: dict, db: Session = Depends(get_db), p: Principal = Depends(require_internal)):
    data, _ = command(db, p, f"handbooks.{package_id}.acceptance", None, body, lambda: handbook.accept_package(db, p, package_id, body))
    return data


@router.post("/{package_id}/new-version")
def new_version(package_id: str, db: Session = Depends(get_db), p: Principal = Depends(require_internal)):
    data, _ = command(db, p, f"handbooks.{package_id}.new-version", None, {}, lambda: handbook.new_version(db, p, package_id), 201)
    return data


@router.get("/{package_id}/export")
def export_package(package_id: str, db: Session = Depends(get_db), p: Principal = Depends(require_internal)):
    return handbook.export_package(db, p, package_id)
