import os
import tempfile
from pathlib import Path

_tmp = Path(tempfile.mkdtemp(prefix="pcx-test-"))
os.environ["PCX_DATABASE_URL"] = f"sqlite:///{(_tmp / 'test.db').as_posix()}"
os.environ["PCX_RUN_OUTBOX_WORKER"] = "false"
os.environ["PCX_PROCORE_MODE"] = "SIMULATED"

import pytest  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from app import db as dbm  # noqa: E402
from app.main import app  # noqa: E402
from app.seed.reference import seed_reference  # noqa: E402

PASSWORD = "Demo!2026"


@pytest.fixture(autouse=True)
def _reset_simulators():
    from app.integrations import sim_state
    from app.integrations.procore.simulated import FAKE

    sim_state.reset()
    FAKE.reset()
    yield
    sim_state.reset()


@pytest.fixture
def db():
    """Fresh schema + reference data per test."""
    dbm.drop_all()
    dbm.create_all()
    session = dbm.SessionLocal()
    seed_reference(session)
    session.commit()
    try:
        yield session
    finally:
        session.close()


@pytest.fixture
def client(db):
    with TestClient(app) as c:
        yield c


def _run_scenario(name: str, db) -> None:
    import importlib

    from sqlalchemy import select

    from app.models import Tenant

    tenant = db.scalar(select(Tenant).where(Tenant.code == "DEMO"))
    importlib.import_module(name).run(db, tenant)
    db.commit()


@pytest.fixture
def scenario_a(db):
    """Reference data + workstream A (requirements through POs and units)."""
    _run_scenario("app.seed.scenario_planning", db)
    return db


@pytest.fixture
def scenario_ab(db):
    """Workstreams A + B (delivery, handbook, costs, FM, arrival)."""
    _run_scenario("app.seed.scenario_planning", db)
    _run_scenario("app.seed.scenario_delivery", db)
    return db


@pytest.fixture
def scenario_all(db):
    """Workstreams A + B + the SIMULATED Procore connection."""
    _run_scenario("app.seed.scenario_planning", db)
    _run_scenario("app.seed.scenario_delivery", db)
    _run_scenario("app.seed.scenario_procore", db)
    return db


@pytest.fixture
def login(client):
    """login("procurement@demo.pcx") -> auth headers."""
    cache: dict[str, dict] = {}

    def _login(email: str, tenant_code: str = "DEMO") -> dict:
        if email not in cache:
            r = client.post("/api/auth/login", json={"email": email, "password": PASSWORD, "tenant_code": tenant_code})
            assert r.status_code == 200, r.text
            cache[email] = {"Authorization": f"Bearer {r.json()['token']}"}
        return cache[email]

    return _login
