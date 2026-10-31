"""Scenario C: SIMULATED Procore connection, reference sync (projects, vendors, cost codes,
commitments) and replay of the write-back messages that were queued while Procore was disconnected."""

from __future__ import annotations

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.auth import Principal
from app.core.outbox import process_message
from app.integrations.procore.service import connect_service_account, run_sync
from app.integrations.procore.simulated import COMPANY_ID
from app.models import OutboxMessage, Tenant, utcnow


def _actor(tenant: Tenant) -> Principal:
    return Principal(user_id="seed-integration", tenant_id=tenant.id, email="integration@demo.pcx", name="Isla Integration", roles=frozenset({"INTEGRATION", "ADMIN"}))


def run(db: Session, tenant: Tenant) -> None:
    p = _actor(tenant)
    connect_service_account(db, tenant.id, p, "SIMULATED", COMPANY_ID)
    run_sync(db, p, tenant.id, ["projects", "vendors", "cost_codes", "commitments"])

    # Replay the Procore write-backs that were rejected because no connection existed yet.
    queued = list(
        db.scalars(
            select(OutboxMessage).where(
                OutboxMessage.tenant_id == tenant.id,
                OutboxMessage.target == "PROCORE",
                OutboxMessage.state.in_(("PENDING", "REJECTED", "DEAD")),
            )
        )
    )
    for msg in queued:
        msg.state = "PENDING"
        msg.attempts = 0
        msg.next_attempt_at = utcnow()
        msg.last_error = None
        process_message(db, msg)
    db.commit()
    print(f"procore: connected SIMULATED company {COMPANY_ID}, replayed {len(queued)} write-backs")
