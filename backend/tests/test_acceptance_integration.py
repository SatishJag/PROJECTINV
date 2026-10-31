"""Acceptance tests T26-T28: tenant/supplier isolation, replay safety and restore/reconnect."""

from sqlalchemy import select

from app.core.auth import hash_password
from app.integrations.procore.links import upsert_link
from app.integrations.procore.simulated import COMPANY_ID, FAKE
from app.integrations.procore.webhooks import webhook_secret
from app.models import (
    ExternalObjectLink,
    HandbookPackage,
    HandbookTemplate,
    InboxMessage,
    OutboxMessage,
    ProcoreConnection,
    Requirement,
    StockTransaction,
    SupplierOffer,
    Tenant,
    User,
)
from tests import support


def _admin(login):
    return login("admin@demo.pcx")


def _connection(db) -> ProcoreConnection:
    conn = db.scalar(select(ProcoreConnection).where(ProcoreConnection.state == "CONNECTED"))
    assert conn is not None
    return conn


def _links(db, conn, object_type: str, domain_id: str) -> list[ExternalObjectLink]:
    return list(
        db.scalars(
            select(ExternalObjectLink).where(
                ExternalObjectLink.tenant_id == conn.tenant_id,
                ExternalObjectLink.platform == "PROCORE",
                ExternalObjectLink.company_key == str(conn.company_id),
                ExternalObjectLink.object_type == object_type,
                ExternalObjectLink.domain_id == domain_id,
            )
        )
    )


# ------------------------------------------------------------------ T26


def test_t26_cross_tenant_and_supplier_isolation(client, login, scenario_ab):
    h = _admin(login)
    gen1 = support.unit(scenario_ab, "GEN-001")
    bkk1 = support.project(scenario_ab, "BKK1")
    cls = support.equipment_class(scenario_ab, "GEN")

    other = Tenant(code="OTHER", name="Other data-centre owner")
    scenario_ab.add(other)
    scenario_ab.flush()
    scenario_ab.add(
        User(
            tenant_id=other.id,
            email="admin@other.pcx",
            name="Other Admin",
            roles="ADMIN",
            project_scope="",
            password_hash=hash_password("Demo!2026"),
        )
    )
    scenario_ab.commit()
    other_headers = login("admin@other.pcx", tenant_code="OTHER")

    # cross-tenant reads never reveal existence
    assert client.get(f"/api/assets/units/{gen1.id}", headers=other_headers).status_code == 404
    assert client.get(f"/api/planning/requirements/{support.requirement(scenario_ab, 'REQ-BKK1-GEN').id}", headers=other_headers).status_code == 404
    assert client.get("/api/inventory/stock", headers=other_headers).json()["units"] == []

    # cross-tenant references are rejected the same way, before any write
    foreign_allocation = client.post(
        "/api/inventory/allocations",
        json={"kind": "PLANNING_INTENT", "to_project_id": bkk1.id, "unit_ids": [gen1.id]},
        headers=other_headers,
    )
    assert foreign_allocation.status_code == 404
    foreign_requirement = client.post(
        "/api/planning/requirements",
        json={
            "title": "Foreign project reference",
            "project_id": bkk1.id,
            "equipment_class_id": cls.id,
            "revision": {"quantity": "1", "uom": "EA", "currency": "USD"},
        },
        headers=other_headers,
    )
    assert foreign_requirement.status_code == 404

    # supplier sees only its own offer, never a competing bid or internal cost evidence
    supplier = login("supplier.meridian@demo.pcx")
    packages = client.get("/api/sourcing/packages", headers=supplier).json()
    assert len(packages) == 1
    assert {offer["supplier_key"] for offer in packages[0]["offers"]} == {"MERIDIAN"}
    northwind_offer = scenario_ab.scalar(select(SupplierOffer).where(SupplierOffer.source_offer_key == "NWP-BKK-2026-1"))
    assert client.get(f"/api/sourcing/offers/{northwind_offer.id}", headers=supplier).status_code == 404
    assert client.get("/api/costs/events", headers=supplier).status_code == 403
    assert client.get("/api/costs/tco-scenarios", headers=supplier).status_code == 403
    assert client.get("/api/integrations/outbox", headers=supplier).status_code == 403


# ------------------------------------------------------------------ T27


def test_t27_duplicate_requests_events_and_unknown_ack_select_once(client, login, scenario_all):
    h = _admin(login)
    bkk1 = support.project(scenario_all, "BKK1")
    cls = support.equipment_class(scenario_all, "GEN")

    # 1. a duplicate HTTP request with one Idempotency-Key produces one requirement
    body = {
        "title": "T27 duplicate request",
        "project_id": bkk1.id,
        "equipment_class_id": cls.id,
        "source_boq_key": "BOQ-T27",
        "source_line_key": "L-001",
        "revision": {"quantity": "1", "uom": "EA", "currency": "USD"},
    }
    idem = {**h, "Idempotency-Key": "t27-requirement"}
    first = client.post("/api/planning/requirements", json=body, headers=idem)
    second = client.post("/api/planning/requirements", json=body, headers=idem)
    assert first.status_code in (200, 201), first.text
    assert second.status_code in (200, 201), second.text
    assert second.json()["requirement"]["id"] == first.json()["requirement"]["id"]
    assert len(list(scenario_all.scalars(select(Requirement).where(Requirement.source_boq_key == "BOQ-T27")))) == 1

    # 2. a redelivered source event is stored once
    conn = _connection(scenario_all)
    event = {
        "company_id": COMPANY_ID,
        "ulid": "01J-T27-ULID-0001",
        "resource_name": "vendors",
        "resource_id": "7740011",
        "event_type": "update",
    }
    auth = {"Authorization": f"Bearer {webhook_secret(conn)}"}
    accepted = client.post("/api/integrations/procore/webhooks", json=event, headers=auth)
    redelivered = client.post("/api/integrations/procore/webhooks", json=event, headers=auth)
    assert accepted.json()["status"] == "accepted"
    assert redelivered.json()["status"] == "duplicate"
    assert redelivered.json()["inbox_id"] == accepted.json()["inbox_id"]
    inbox = list(scenario_all.scalars(select(InboxMessage).where(InboxMessage.source_event_id == "01J-T27-ULID-0001")))
    assert len(inbox) == 1

    # 3. an unknown acknowledgement is reconciled before replay, and replay is idempotent
    gen5 = support.unit(scenario_all, "GEN-005")
    bkk1_yard = support.location(scenario_all, "BKK1-GY")
    issued = client.post(
        "/api/inventory/issues",
        json={"unit_id": gen5.id, "to_location_id": bkk1_yard.id, "installed_position": "BKK1 generator yard / Bay 5"},
        headers=h,
    )
    assert issued.status_code in (200, 201), issued.text
    message = scenario_all.scalar(
        select(OutboxMessage).where(
            OutboxMessage.aggregate_id == gen5.id,
            OutboxMessage.event_type == "equipment.upsert",
            OutboxMessage.state == "PENDING",
        )
    )
    assert message is not None

    assert client.post("/api/integrations/simulators/PROCORE/mode", json={"mode": "TIMEOUT"}, headers=h).status_code == 200
    assert client.post("/api/integrations/outbox/process", json={"limit": 500}, headers=h).status_code == 200
    scenario_all.expire_all()
    assert scenario_all.get(OutboxMessage, message.id).state == "UNKNOWN"

    blocked = client.post(f"/api/integrations/outbox/{message.id}/retry", headers=h)
    assert blocked.status_code == 409
    assert blocked.json()["title"] == "ACK_UNKNOWN_RECONCILE_FIRST"

    assert client.post("/api/integrations/simulators/PROCORE/mode", json={"mode": "ACK"}, headers=h).status_code == 200
    reconciled = client.post(
        f"/api/integrations/outbox/{message.id}/reconcile",
        json={"outcome": "NOT_APPLIED", "note": "Timeout after the write was applied; replay finds it by identification number"},
        headers=h,
    )
    assert reconciled.status_code == 200, reconciled.text
    assert reconciled.json()["state"] == "PENDING"

    replayed = client.post(f"/api/integrations/outbox/{message.id}/retry", headers=h)
    assert replayed.status_code == 200, replayed.text
    assert replayed.json()["state"] == "ACKNOWLEDGED"
    assert replayed.json()["external_ref"]

    once_again = client.post(f"/api/integrations/outbox/{message.id}/retry", headers=h)
    assert once_again.status_code == 409
    assert once_again.json()["title"] == "ALREADY_ACKNOWLEDGED"

    links = _links(scenario_all, conn, "equipment", gen5.id)
    assert len(links) == 1
    created = [e for e in FAKE.data["equipment"] if e.get("identification_number") == "GEN-005"]
    assert len(created) == 1
    scenario_all.expire_all()
    assert scenario_all.get(type(gen5), gen5.id).procore_equipment_id == links[0].object_key


# ------------------------------------------------------------------ T28


def _waive_commissioning(client, package_id: str, headers: dict):
    detail = client.get(f"/api/handbooks/{package_id}", headers=headers).json()
    entry = next(item for item in detail["entries"] if item["criterion"]["criterion_code"] == "COMMISSIONING")
    waived = client.post(
        f"/api/handbooks/{package_id}/entries/{entry['id']}/waive",
        json={"reason": "Commissioning deferred to energisation", "expires_at": "2027-12-31"},
        headers=headers,
    )
    assert waived.status_code == 200, waived.text
    return waived.json()


def test_t28_restore_reconnect_and_backfill_preserve_identity_and_snapshots(client, login, scenario_all):
    h = _admin(login)
    conn = _connection(scenario_all)
    gen1 = support.unit(scenario_all, "GEN-001")
    links = _links(scenario_all, conn, "equipment", gen1.id)
    assert len(links) == 1
    link = links[0]
    identity = {
        "connection_id": conn.id,
        "unit_id": gen1.id,
        "asset_code": gen1.asset_code,
        "equipment_key": link.object_key,
        "source_revision": link.source_revision,
        "link_version": link.version,
    }

    # approved snapshot: publish the handbook before any restore/backfill work
    package = scenario_all.scalar(
        select(HandbookPackage).where(HandbookPackage.unit_id == gen1.id).order_by(HandbookPackage.version_no.desc())
    )
    _waive_commissioning(client, package.id, h)
    detail = client.get(f"/api/handbooks/{package.id}", headers=h).json()
    approved = client.post(f"/api/handbooks/{package.id}/approve", headers={**h, "If-Match": detail["etag"]})
    assert approved.status_code == 200, approved.text
    published = client.post(f"/api/handbooks/{package.id}/publish", headers={**h, "If-Match": approved.json()["etag"]})
    assert published.status_code == 200, published.text
    snapshot = {"hash": published.json()["package_hash"], "version_no": published.json()["version_no"]}

    # a newer source revision is adopted, an older restore/backfill copy is refused
    upgraded, outcome = upsert_link(
        scenario_all,
        conn,
        object_type="equipment",
        object_key=identity["equipment_key"],
        domain_type="PhysicalUnit",
        domain_id=gen1.id,
        source_revision="2030-01-01T00:00:00Z",
        sync_state="APPLIED",
    )
    assert outcome == "updated"
    newer_version = upgraded.version
    restored, outcome = upsert_link(
        scenario_all,
        conn,
        object_type="equipment",
        object_key=identity["equipment_key"],
        domain_type="PhysicalUnit",
        domain_id=gen1.id,
        source_revision="2020-01-01T00:00:00Z",
        sync_state="PENDING",
    )
    assert outcome == "stale"
    assert restored.source_revision == "2030-01-01T00:00:00Z"
    assert restored.sync_state == "APPLIED"
    assert restored.version == newer_version
    scenario_all.commit()

    # reconnect keeps the connection row and every crosswalk
    disconnected = client.post("/api/integrations/procore/disconnect", headers=h)
    assert disconnected.status_code == 200, disconnected.text
    connected = client.post("/api/integrations/procore/connect", json={"company_id": COMPANY_ID}, headers=h)
    assert connected.status_code in (200, 201), connected.text
    assert connected.json()["connection"]["id"] == identity["connection_id"]

    link_count = len(list(scenario_all.scalars(select(ExternalObjectLink).where(ExternalObjectLink.tenant_id == conn.tenant_id))))
    synced = client.post("/api/integrations/procore/sync", json={}, headers=h)
    assert synced.status_code == 200, synced.text
    after_sync = list(scenario_all.scalars(select(ExternalObjectLink).where(ExternalObjectLink.tenant_id == conn.tenant_id)))
    assert len(after_sync) == link_count
    assert len(_links(scenario_all, conn, "equipment", gen1.id)) == 1

    # identity and approved snapshot survive restore + reconnect + backfill
    scenario_all.expire_all()
    unit_now = scenario_all.get(type(gen1), identity["unit_id"])
    assert unit_now.asset_code == identity["asset_code"]
    assert unit_now.id == identity["unit_id"]
    current_link = _links(scenario_all, conn, "equipment", gen1.id)[0]
    assert current_link.object_key == identity["equipment_key"]
    handbook_now = client.get(f"/api/handbooks/{package.id}", headers=h).json()
    assert handbook_now["state"] == "PUBLISHED"
    assert handbook_now["package_hash"] == snapshot["hash"]
    assert handbook_now["version_no"] == snapshot["version_no"]
