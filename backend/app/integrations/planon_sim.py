"""Simulated Planon (maintenance / installed asset register) handover.

A published handbook hands the asset to FM: Planon receives the asset identity and the handbook
package reference. The same acknowledgement modes as Oracle apply.
"""

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.outbox import HandlerResult, register_handler
from app.integrations import sim_state
from app.models import ExternalObjectLink, HandbookPackage, PhysicalUnit, utcnow

TARGET = "PLANON"


def _mode() -> str:
    return sim_state.get_mode(TARGET)


@register_handler(TARGET, "asset.handover")
def asset_handover(db: Session, msg) -> HandlerResult:
    unit = db.get(PhysicalUnit, msg.payload.get("unit_id"))
    if unit is None:
        return HandlerResult("REJECTED", message="Unit not found")
    package = db.get(HandbookPackage, msg.payload.get("package_id")) if msg.payload.get("package_id") else None
    mode = _mode()
    if mode == "REJECT":
        return HandlerResult("REJECTED", message="Simulated Planon rejection: asset classification is not configured")
    if mode == "TIMEOUT":
        return HandlerResult("TIMEOUT_UNKNOWN", message="Simulated Planon timeout after handover; reconcile before replay")
    if mode == "TRANSIENT":
        return HandlerResult("TRANSIENT_FAILURE", message="Simulated Planon transient failure")
    planon_id = unit.planon_asset_id or f"PLN-{unit.asset_code}"
    unit.planon_asset_id = planon_id
    link = db.scalar(
        select(ExternalObjectLink).where(
            ExternalObjectLink.tenant_id == unit.tenant_id,
            ExternalObjectLink.platform == "PLANON",
            ExternalObjectLink.object_type == "asset",
            ExternalObjectLink.object_key == planon_id,
            ExternalObjectLink.link_role == "PRIMARY",
        )
    )
    if link is None:
        link = ExternalObjectLink(
            tenant_id=unit.tenant_id,
            created_by="planon-sim",
            platform="PLANON",
            company_key="",
            object_type="asset",
            object_key=planon_id,
            domain_type="physical_unit",
            domain_id=unit.id,
            link_role="PRIMARY",
            source_revision=str(package.version_no) if package else None,
        )
        db.add(link)
    link.sync_state = "APPLIED"
    link.last_synced_at = utcnow()
    return HandlerResult("ACKNOWLEDGED", external_ref=planon_id)
