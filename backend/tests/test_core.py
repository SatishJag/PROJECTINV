from decimal import Decimal

from app.core.decimal import allocate_exact


def test_login_and_me(client, login):
    h = login("admin@demo.pcx")
    r = client.get("/api/auth/me", headers=h)
    assert r.status_code == 200
    assert "ADMIN" in r.json()["roles"]


def test_bad_password_is_problem_json(client):
    r = client.post("/api/auth/login", json={"email": "admin@demo.pcx", "password": "nope"})
    assert r.status_code == 401
    assert r.headers["content-type"].startswith("application/problem+json")
    assert r.json()["title"] == "INVALID_CREDENTIALS"


def test_reference_catalogue(client, login):
    h = login("engineering@demo.pcx")
    classes = client.get("/api/equipment-classes", headers=h).json()
    assert len(classes) == 55
    models = client.get("/api/item-models", headers=h).json()
    gen = next(x for x in models if x["item_code"] == "GEN-MER-2500S")
    detail = client.get(f"/api/item-models/{gen['id']}", headers=h).json()
    engine = next(b for b in detail["bom"] if b["slot_code"] == "ENGINE")
    assert {c["slot_code"] for c in engine["children"]} == {"TURBO", "FUEL_PUMP"}
    assert detail["rated_capacity"] == "2500"


def test_supplier_cannot_see_internal_reference(client, login):
    h = login("supplier.meridian@demo.pcx")
    assert client.get("/api/projects", headers=h).status_code == 403
    sups = client.get("/api/suppliers", headers=h).json()
    assert [s["key"] for s in sups] == ["MERIDIAN"]


def test_project_scope_hides_other_projects(client, login):
    projects = client.get("/api/projects", headers=login("bkk2.site@demo.pcx")).json()
    assert [p["code"] for p in projects] == ["BKK2"]


def test_frame_ancestors_header(client):
    r = client.get("/api/health")
    assert "frame-ancestors" in r.headers["content-security-policy"]


def test_allocate_exact_sums():
    parts = allocate_exact(Decimal("100.0000"), [Decimal(1), Decimal(1), Decimal(1)], Decimal("0.0001"))
    assert sum(parts) == Decimal("100.0000")
