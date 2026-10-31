"""ExternalObjectLink + IntegrationException helpers for the Procore connector (spec §27, §31)."""

from datetime import datetime

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.commands import bump
from app.models import ExternalObjectLink, IntegrationException, ProcoreConnection, utcnow

PLATFORM = "PROCORE"
SOURCE = "PROCORE"


def parse_ts(value) -> datetime | None:
    if not value:
        return None
    try:
        return datetime.fromisoformat(str(value).replace("Z", "+00:00")).replace(tzinfo=None)
    except ValueError:
        return None


def find_link(db: Session, conn: ProcoreConnection, object_type: str, object_key: str, link_role: str = "PRIMARY") -> ExternalObjectLink | None:
    return db.scalar(
        select(ExternalObjectLink).where(
            ExternalObjectLink.tenant_id == conn.tenant_id,
            ExternalObjectLink.platform == PLATFORM,
            ExternalObjectLink.company_key == str(conn.company_id),
            ExternalObjectLink.object_type == object_type,
            ExternalObjectLink.object_key == str(object_key),
            ExternalObjectLink.link_role == link_role,
        )
    )


def links_for_domain(db: Session, conn: ProcoreConnection, object_type: str, domain_type: str, domain_id: str) -> list[ExternalObjectLink]:
    return list(
        db.scalars(
            select(ExternalObjectLink).where(
                ExternalObjectLink.tenant_id == conn.tenant_id,
                ExternalObjectLink.platform == PLATFORM,
                ExternalObjectLink.company_key == str(conn.company_id),
                ExternalObjectLink.object_type == object_type,
                ExternalObjectLink.domain_type == domain_type,
                ExternalObjectLink.domain_id == domain_id,
            )
        )
    )


def project_key_for(db: Session, conn: ProcoreConnection, project_id: str | None) -> str | None:
    """Procore project id linked to a pcx project, or None."""
    if not project_id:
        return None
    links = links_for_domain(db, conn, "project", "Project", project_id)
    return links[0].object_key if links else None


def upsert_link(
    db: Session,
    conn: ProcoreConnection,
    *,
    object_type: str,
    object_key: str,
    domain_type: str,
    domain_id: str,
    project_key: str | None = None,
    source_revision: str | None = None,
    sync_state: str = "LINKED",
    link_role: str = "PRIMARY",
    actor: str = "procore-sync",
) -> tuple[ExternalObjectLink | None, str]:
    """Idempotent link write. Returns (link, outcome) with outcome in
    created | updated | unchanged | stale | conflict.

    * same external object, same domain row: revision moves forward only (an older revision from a
      restore/backfill never overwrites newer source state - T28);
    * same external object mapped to a different domain row: conflict, link untouched.
    """
    object_key = str(object_key)
    link = find_link(db, conn, object_type, object_key, link_role)
    now = utcnow()
    if link is None:
        link = ExternalObjectLink(
            tenant_id=conn.tenant_id,
            created_by=actor,
            platform=PLATFORM,
            company_key=str(conn.company_id),
            project_key=str(project_key) if project_key else None,
            object_type=object_type,
            object_key=object_key,
            domain_type=domain_type,
            domain_id=domain_id,
            link_role=link_role,
            source_revision=source_revision,
            sync_state=sync_state,
            last_synced_at=now,
        )
        db.add(link)
        db.flush()
        return link, "created"
    if link.domain_type != domain_type or link.domain_id != domain_id:
        return link, "conflict"
    incoming, current = parse_ts(source_revision), parse_ts(link.source_revision)
    if source_revision and current and incoming and incoming < current:
        return link, "stale"
    changed = False
    if source_revision and source_revision != link.source_revision:
        link.source_revision = source_revision
        changed = True
    if project_key and link.project_key != str(project_key):
        link.project_key = str(project_key)
        changed = True
    if sync_state and link.sync_state != sync_state and not (sync_state == "LINKED" and link.sync_state == "APPLIED"):
        link.sync_state = sync_state
        changed = True
    link.last_synced_at = now
    if changed:
        bump(link)
    db.flush()
    return link, "updated" if changed else "unchanged"


def open_exception(db: Session, tenant_id: str, *, kind: str, subject_type: str, subject_id: str, message: str, owner_role: str = "INTEGRATION") -> IntegrationException:
    """One OPEN exception per (kind, subject); re-raising refreshes the message instead of duplicating."""
    exc = db.scalar(
        select(IntegrationException).where(
            IntegrationException.tenant_id == tenant_id,
            IntegrationException.source == SOURCE,
            IntegrationException.kind == kind,
            IntegrationException.subject_type == subject_type,
            IntegrationException.subject_id == subject_id,
            IntegrationException.state == "OPEN",
        )
    )
    if exc:
        if exc.message != message:
            exc.message = message
            bump(exc)
        return exc
    exc = IntegrationException(
        tenant_id=tenant_id, created_by="procore-sync", source=SOURCE, kind=kind, subject_type=subject_type, subject_id=subject_id, message=message, owner_role=owner_role
    )
    db.add(exc)
    db.flush()
    return exc


def auto_resolve(db: Session, tenant_id: str, *, kind: str, subject_type: str, subject_id: str, resolution: str) -> int:
    n = 0
    for exc in db.scalars(
        select(IntegrationException).where(
            IntegrationException.tenant_id == tenant_id,
            IntegrationException.source == SOURCE,
            IntegrationException.kind == kind,
            IntegrationException.subject_type == subject_type,
            IntegrationException.subject_id == subject_id,
            IntegrationException.state == "OPEN",
        )
    ):
        exc.state = "RESOLVED"
        exc.resolution = resolution
        bump(exc)
        n += 1
    return n
