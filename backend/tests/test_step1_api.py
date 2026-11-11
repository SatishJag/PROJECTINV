"""Step 1 feed: sync, status and run-history routes."""

import pytest
from sqlalchemy import func, select

from app.api.step1 import get_step1_client
from app.main import app
from app.models import Project, Step1SyncRun, Tenant

BASE = "/api/integrations/step1"


@pytest.fixture
def fake(s1):
    """The Step 1 client dependency replaced by the fake from the s1 harness; cleared afterwards."""
    app.dependency_overrides[get_step1_client] = lambda: s1.client
    try:
        yield s1.client
    finally:
        app.dependency_overrides.pop(get_step1_client, None)


def _runs(db) -> int:
    return db.scalar(select(func.count()).select_from(Step1SyncRun))


def test_sync_is_limited_to_integration_and_admin(client, login, s1, fake):
    assert client.post(f"{BASE}/sync", json={}, headers=login("estimator@demo.pcx")).status_code == 403
    assert client.post(f"{BASE}/sync", json={}, headers=login("supplier.meridian@demo.pcx")).status_code == 403
    r = client.post(f"{BASE}/sync", json={}, headers=login("integration@demo.pcx"))
    assert r.status_code == 200, r.text
    assert "counts" in r.json()
    assert r.json()["counts"]["queued"] == 1


def test_not_configured_returns_409(client, login, s1):
    app.dependency_overrides[get_step1_client] = lambda: None
    try:
        h = login("integration@demo.pcx")
        r = client.post(f"{BASE}/sync", json={}, headers=h)
        assert r.status_code == 409
        assert r.json()["title"] == "STEP1_NOT_CONFIGURED"
        status = client.get(f"{BASE}/status", headers=h)
        assert status.status_code == 200
        assert status.json()["configured"] is False
    finally:
        app.dependency_overrides.pop(get_step1_client, None)


def test_idempotency_key_replays_without_a_second_run(client, login, s1, fake):
    h = {**login("integration@demo.pcx"), "Idempotency-Key": "sync-1"}
    first = client.post(f"{BASE}/sync", json={}, headers=h)
    second = client.post(f"{BASE}/sync", json={}, headers=h)
    assert first.status_code == second.status_code == 200
    assert first.json() == second.json()
    s1.db.expire_all()
    assert _runs(s1.db) == 1


def test_status_and_runs_reflect_the_last_sync(client, login, s1, fake):
    h = login("integration@demo.pcx")
    empty = client.get(f"{BASE}/status", headers=h).json()
    assert empty["configured"] is True
    assert empty["last_run"] is None
    assert empty["pending_items"] == 0

    first = client.post(f"{BASE}/sync", json={}, headers=h).json()
    second = client.post(f"{BASE}/sync", json={}, headers=h).json()

    status = client.get(f"{BASE}/status", headers=login("estimator@demo.pcx")).json()
    assert status["last_run"]["id"] == second["run_id"]
    assert status["last_run"]["state"] == "SUCCEEDED"
    assert status["pending_items"] == 1
    assert status["open_exceptions"] == 0
    assert set(status) == {"configured", "last_run", "pending_items", "open_exceptions"}

    runs = client.get(f"{BASE}/runs", headers=h).json()
    assert [r["id"] for r in runs] == [second["run_id"], first["run_id"]]
    assert runs[0]["counts_json"]["queued"] == 1
    assert client.get(f"{BASE}/runs?limit=1", headers=h).json()[0]["id"] == second["run_id"]


def test_failed_step1_returns_200_with_failed_state(client, login, s1, fake):
    h = login("integration@demo.pcx")
    fake.fail = True
    r = client.post(f"{BASE}/sync", json={}, headers=h)
    assert r.status_code == 200, r.text
    assert r.json()["state"] == "FAILED"
    s1.db.expire_all()
    assert _runs(s1.db) == 1  # the FAILED run is committed
    assert client.get(f"{BASE}/status", headers=h).json()["last_run"]["state"] == "FAILED"


def test_unknown_or_foreign_project_id_is_404_before_any_fetch(client, login, s1, fake):
    h = login("integration@demo.pcx")
    calls = []
    original = fake.projects
    fake.projects = lambda: (calls.append(1), original())[1]

    r = client.post(f"{BASE}/sync", json={"project_ids": ["no-such-project"]}, headers=h)
    assert r.status_code == 404
    assert r.json()["title"] == "NOT_FOUND"

    other = Tenant(code="OTHER", name="Other data-centre owner")
    s1.db.add(other)
    s1.db.flush()
    foreign = Project(tenant_id=other.id, programme_id=s1.project.programme_id, code="X1", name="Foreign project")
    s1.db.add(foreign)
    s1.db.commit()
    r = client.post(f"{BASE}/sync", json={"project_ids": [s1.project.id, foreign.id]}, headers=h)
    assert r.status_code == 404

    assert calls == []
    s1.db.expire_all()
    assert _runs(s1.db) == 0

    ok = client.post(f"{BASE}/sync", json={"project_ids": [s1.project.id]}, headers=h)
    assert ok.status_code == 200, ok.text
    assert len(calls) == 1


def test_unexpected_error_records_one_generic_failed_run(client, login, s1, fake, monkeypatch, caplog):
    from app.services import step1_sync

    def explode(db, p, step1, project_ids=None):
        db.add(Project(tenant_id=p.tenant_id, programme_id=s1.project.programme_id, code="HALF", name="Half-written"))
        db.flush()
        raise RuntimeError("boom with detail s3cret")

    monkeypatch.setattr(step1_sync, "sync", explode)
    h = login("integration@demo.pcx")

    r = client.post(f"{BASE}/sync", json={}, headers=h)

    assert r.status_code == 200, r.text
    body = r.json()
    assert body["state"] == "FAILED"
    assert body["error"] == "Unexpected error during sync; see server log"
    assert "s3cret" not in r.text
    s1.db.expire_all()
    runs = list(s1.db.scalars(select(Step1SyncRun)))
    assert len(runs) == 1
    assert runs[0].state == "FAILED"
    assert runs[0].error == "Unexpected error during sync; see server log"
    assert s1.db.scalar(select(func.count()).select_from(Project).where(Project.code == "HALF")) == 0  # rolled back
    assert "Step 1 sync failed unexpectedly" in caplog.text
    assert client.get(f"{BASE}/status", headers=h).json()["last_run"]["state"] == "FAILED"


def test_domain_errors_from_the_sync_still_propagate(client, login, s1, fake, monkeypatch):
    from app.core.errors import DomainError
    from app.services import step1_sync

    def refuse(db, p, step1, project_ids=None):
        raise DomainError("NOT_FOUND", "Project not found: x", status=404)

    monkeypatch.setattr(step1_sync, "sync", refuse)
    r = client.post(f"{BASE}/sync", json={}, headers=login("integration@demo.pcx"))
    assert r.status_code == 404
    assert r.json()["title"] == "NOT_FOUND"
    s1.db.expire_all()
    assert _runs(s1.db) == 0
