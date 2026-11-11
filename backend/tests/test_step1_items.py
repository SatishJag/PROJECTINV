"""Step 1 item crosswalk: suggestion, classification queue, validation, in-use guard."""

import uuid

from sqlalchemy import select

from app.models import EquipmentClass, IntegrationException, Requirement
from app.services.step1_items import see_item, suggest_class
from tests import support
from tests.step1_support import reg_row

BASE = "/api/integrations/step1/items"


def _seed_item(db, **overrides):
    item = see_item(db, support.tenant_id(db), reg_row(**overrides))
    db.commit()
    return item


def _classify(client, h, item_id, body, **extra_headers):
    return client.post(f"{BASE}/{item_id}/classify", json=body, headers={**h, **extra_headers})


def test_queue_lists_pending_item_with_suggestion(client, login, scenario_a):
    gen = support.equipment_class(scenario_a, "GEN")
    item = _seed_item(scenario_a)
    r = client.get(f"{BASE}?decision=PENDING", headers=login("estimator@demo.pcx"))
    assert r.status_code == 200, r.text
    found = [i for i in r.json() if i["id"] == item.id]
    assert len(found) == 1
    assert found[0]["decision"] == "PENDING"
    assert found[0]["requirement_count"] == 0
    assert found[0]["suggested_class_id"] == gen.id
    assert found[0]["suggested_class_name"] == gen.name


def test_estimator_classifies_lle_and_it_is_audited(client, login, scenario_a):
    gen = support.equipment_class(scenario_a, "GEN")
    item = _seed_item(scenario_a)
    h = login("estimator@demo.pcx")
    r = _classify(client, h, item.id, {"decision": "LLE", "equipment_class_id": gen.id})
    assert r.status_code == 200, r.text
    assert r.json()["decision"] == "LLE"
    assert r.json()["equipment_class_id"] == gen.id
    assert r.json()["decided_by"] == "estimator@demo.pcx"
    events = client.get("/api/audit?subject_type=step1_item_class", headers=h).json()
    assert any(e["subject_id"] == item.id and e["action"] == "STEP1_ITEM_CLASSIFIED" for e in events)


def test_finance_and_supplier_cannot_classify(client, login, scenario_a):
    gen = support.equipment_class(scenario_a, "GEN")
    item = _seed_item(scenario_a)
    for email in ("finance@demo.pcx", "supplier.meridian@demo.pcx"):
        r = _classify(client, login(email), item.id, {"decision": "LLE", "equipment_class_id": gen.id})
        assert r.status_code == 403, (email, r.text)


def test_lle_rejects_component_or_unknown_class(client, login, scenario_a):
    component = scenario_a.scalar(select(EquipmentClass).where(EquipmentClass.is_component_class.is_(True)))
    item = _seed_item(scenario_a)
    h = login("estimator@demo.pcx")
    for class_id in (component.id, str(uuid.uuid4())):
        r = _classify(client, h, item.id, {"decision": "LLE", "equipment_class_id": class_id})
        assert r.status_code == 422, r.text
        assert r.json()["title"] == "VALIDATION"
    r = client.get(f"{BASE}?decision=PENDING", headers=h)
    assert [i["decision"] for i in r.json() if i["id"] == item.id] == ["PENDING"]


def test_not_lle_requires_a_reason(client, login, scenario_a):
    item = _seed_item(scenario_a)
    h = login("estimator@demo.pcx")
    assert _classify(client, h, item.id, {"decision": "NOT_LLE"}).status_code == 422
    r = _classify(client, h, item.id, {"decision": "NOT_LLE", "reason": "Consumable cabling"})
    assert r.status_code == 200, r.text
    assert r.json()["decision"] == "NOT_LLE"
    assert r.json()["decision_reason"] == "Consumable cabling"


def test_invalid_decision_is_422_and_stale_if_match_is_412(client, login, scenario_a):
    gen = support.equipment_class(scenario_a, "GEN")
    item = _seed_item(scenario_a)
    h = login("estimator@demo.pcx")
    assert _classify(client, h, item.id, {"decision": "MAYBE"}).status_code == 422
    stale = _classify(client, h, item.id, {"decision": "LLE", "equipment_class_id": gen.id}, **{"If-Match": 'W/"99"'})
    assert stale.status_code == 412


def test_class_in_use_is_refused_but_not_lle_raises_cancel_requests(client, login, scenario_a):
    gen = support.equipment_class(scenario_a, "GEN")
    other = support.equipment_class(scenario_a, "CHL-AC")
    project = support.project(scenario_a, "BKK1")
    item = _seed_item(scenario_a)
    h = login("estimator@demo.pcx")
    assert _classify(client, h, item.id, {"decision": "LLE", "equipment_class_id": gen.id}).status_code == 200

    created = client.post(
        "/api/planning/requirements",
        json={"title": "Generator from Step 1", "project_id": project.id, "equipment_class_id": gen.id, "revision": {"quantity": "2", "uom": "EA", "currency": "USD"}},
        headers=login("admin@demo.pcx"),
    )
    assert created.status_code == 201, created.text
    req_id = created.json()["requirement"]["id"]
    requirement = scenario_a.get(Requirement, req_id)
    requirement.step1_item_id = item.step1_item_id
    scenario_a.commit()

    listed = client.get(f"{BASE}?decision=LLE", headers=h).json()
    assert [i["requirement_count"] for i in listed if i["id"] == item.id] == [1]

    r = _classify(client, h, item.id, {"decision": "LLE", "equipment_class_id": other.id})
    assert r.status_code == 409
    assert r.json()["title"] == "CLASS_IN_USE"

    r = _classify(client, h, item.id, {"decision": "NOT_LLE", "reason": "Reclassified"})
    assert r.status_code == 200, r.text
    scenario_a.expire_all()
    exceptions = scenario_a.scalars(
        select(IntegrationException).where(IntegrationException.source == "STEP1", IntegrationException.kind == "RECONCILIATION")
    ).all()
    assert [(e.subject_type, e.subject_id, e.state) for e in exceptions] == [("requirement", req_id, "OPEN")]
    assert scenario_a.get(Requirement, req_id).state == "ACTIVE"


def test_unknown_item_is_404(client, login, scenario_a):
    r = _classify(client, login("estimator@demo.pcx"), str(uuid.uuid4()), {"decision": "NOT_LLE", "reason": "x"})
    assert r.status_code == 404


def test_suggestion_needs_a_unique_best_overlap(db):
    tid = support.tenant_id(db)
    assert suggest_class(db, tid, reg_row(work_package_name="Zzz", item_description="Qqq widget")) is None
    assert suggest_class(db, tid, reg_row()) == support.equipment_class(db, "GEN").id
    chillers = suggest_class(db, tid, reg_row(work_package_name="Chillers", item_description="Air-cooled chiller"))
    assert chillers == support.equipment_class(db, "CHL-AC").id


def test_see_item_upserts_and_refreshes(db):
    tid = support.tenant_id(db)
    first = see_item(db, tid, reg_row())
    second = see_item(db, tid, reg_row(item_description="Renamed genset", internal_item_code="ITM-9"))
    assert first.id == second.id
    assert second.description == "Renamed genset" and second.internal_item_code == "ITM-9"
    assert second.suggested_class_id == first.suggested_class_id
