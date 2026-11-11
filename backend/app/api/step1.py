"""Step 1 feed: sync, status, run history, crosswalk queue and classification."""

import logging

from fastapi import APIRouter, Depends, Header, Query
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.auth import Principal, require_internal
from app.core.errors import DomainError, Forbidden
from app.db import get_db
from app.integrations.step1.client import Step1Client, client_from_settings
from app.models import Project, utcnow
from app.services import step1_items, step1_sync
from app.services.helpers import command

router = APIRouter(prefix="/api/integrations/step1", tags=["step1"])
log = logging.getLogger("pcx.step1")


def get_step1_client() -> Step1Client | None:
    """The configured Step 1 client, or None when the base URL or password is unset. Overridden in tests."""
    return client_from_settings()


@router.get("/status")
def sync_status(db: Session = Depends(get_db), p: Principal = Depends(require_internal), step1: Step1Client | None = Depends(get_step1_client)):
    return step1_sync.status(db, p, configured=step1 is not None)


@router.get("/runs")
def sync_runs(limit: int = Query(default=20, ge=1, le=100), db: Session = Depends(get_db), p: Principal = Depends(require_internal)):
    return step1_sync.list_runs(db, p, limit)


def _check_project_ids(db: Session, p: Principal, body: dict) -> list[str] | None:
    """Every requested project must be a PCX project in the caller's tenant and scope (404 otherwise), before any fetch."""
    ids = body.get("project_ids")
    if ids is None:
        return None
    if not isinstance(ids, list) or not all(isinstance(i, str) for i in ids):
        raise DomainError("VALIDATION", "project_ids must be a list of project ids")
    for project_id in ids:
        project = db.scalar(select(Project).where(Project.id == project_id, Project.tenant_id == p.tenant_id))
        if project is None or not p.can_see_project(project.id):
            raise DomainError("NOT_FOUND", f"Project not found: {project_id}", status=404)
    return ids


@router.post("/sync")
def run_sync(
    body: dict | None = None,
    db: Session = Depends(get_db),
    p: Principal = Depends(require_internal),
    step1: Step1Client | None = Depends(get_step1_client),
    idem: str | None = Header(default=None, alias="Idempotency-Key"),
):
    if not p.has("INTEGRATION"):
        raise Forbidden("Only the integration role can run the Step 1 sync")
    if step1 is None:
        raise DomainError("STEP1_NOT_CONFIGURED", "Step 1 is not configured: set the base URL and app password", status=409)
    body = body or {}
    client = step1

    def run() -> dict:
        project_ids = _check_project_ids(db, p, body)
        started_at = utcnow()
        try:
            return step1_sync.sync(db, p, client, project_ids)
        except DomainError:
            raise
        except Exception:
            # Safety net: a bug or an unforeseen register shape must not leave a bare 500 and no run row. The detail
            # goes to the server log only; the stored error is generic so no exception text (or credential) leaks.
            log.exception("Step 1 sync failed unexpectedly")
            db.rollback()
            return step1_sync.failed_run(db, p, started_at, step1_sync.UNEXPECTED_ERROR)

    data, _ = command(db, p, "step1.sync", idem, body, run)
    return data


@router.get("/items")
def list_items(decision: str | None = None, db: Session = Depends(get_db), p: Principal = Depends(require_internal)):
    return step1_items.list_items(db, p, decision)


@router.post("/items/{item_id}/classify")
def classify_item(
    item_id: str,
    body: dict,
    db: Session = Depends(get_db),
    p: Principal = Depends(require_internal),
    idem: str | None = Header(default=None, alias="Idempotency-Key"),
    if_match: str | None = Header(default=None, alias="If-Match"),
):
    data, _ = command(db, p, f"step1.items.{item_id}.classify", idem, body, lambda: step1_items.classify_item(db, p, item_id, body, if_match))
    return data
