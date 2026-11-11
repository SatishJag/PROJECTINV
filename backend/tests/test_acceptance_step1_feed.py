"""Step 1 -> PCX feed: the sync turns classified long-lead register records into DRAFT requirements."""

from decimal import Decimal

from sqlalchemy import func, select

from app.models import (
    EquipmentClass,
    ExternalObjectLink,
    IntegrationException,
    Requirement,
    RequirementRevision,
    Step1ItemClass,
    Step1SyncRun,
    WbsElement,
)
from app.services.step1_sync import change_hash
from tests.step1_support import reg_row


def _open_exceptions(s1, kind: str) -> list[IntegrationException]:
    return list(
        s1.db.scalars(
            select(IntegrationException).where(
                IntegrationException.tenant_id == s1.admin.tenant_id,
                IntegrationException.source == "STEP1",
                IntegrationException.kind == kind,
                IntegrationException.state == "OPEN",
            )
        )
    )


def _count(s1, model) -> int:
    return s1.db.scalar(select(func.count()).select_from(model).where(model.tenant_id == s1.admin.tenant_id))


def test_unclassified_item_is_queued_and_creates_nothing(s1):
    report = s1.sync()
    assert report["counts"]["queued"] == 1
    assert report["counts"]["created"] == 0
    assert s1.requirements() == []
    item = s1.db.scalar(select(Step1ItemClass).where(Step1ItemClass.step1_item_id == "item-gen"))
    assert item is not None and item.decision == "PENDING"


def test_lle_item_creates_requirement_and_draft(s1):
    s1.classify()
    report = s1.sync()
    assert report["state"] == "SUCCEEDED"
    assert report["counts"]["created"] == 1
    [req] = s1.requirements()
    assert req.source_boq_key == "STEP1"
    assert req.source_line_key == "INV-00001"
    assert req.step1_item_id == "item-gen"
    assert req.wbs_id == s1.wbs.id
    assert req.equipment_class_id == s1.gen.id
    [rev] = s1.revisions(req)
    assert rev.revision_no == 1
    assert rev.state == "DRAFT"
    assert rev.quantity == Decimal("6")
    assert rev.uom == "EA"
    assert rev.cost_code == "26-100"
    assert rev.specification_json["boq"]["record_number"] == "INV-00001"
    reg = s1.client.registers["S1-P1"][0]
    link = s1.db.scalar(
        select(ExternalObjectLink).where(
            ExternalObjectLink.platform == "STEP1",
            ExternalObjectLink.object_type == "inventory_record",
            ExternalObjectLink.object_key == reg["inventory_record_id"],
        )
    )
    assert link is not None
    assert link.domain_type == "requirement"
    assert link.domain_id == req.id
    assert link.source_revision == change_hash(reg)
    assert link.project_key == "S1-P1"
    assert link.sync_state == "LINKED"


def test_second_sync_is_a_no_op(s1):
    s1.classify()
    s1.sync()
    report = s1.sync()
    assert report["counts"]["unchanged"] == 1
    assert report["counts"]["created"] == 0
    [req] = s1.requirements()
    assert len(s1.revisions(req)) == 1


def test_not_lle_item_is_ignored(s1):
    s1.classify(decision="NOT_LLE", reason="cable")
    report = s1.sync()
    assert report["counts"]["ignored"] == 1
    assert report["counts"]["created"] == 0
    assert s1.requirements() == []


def test_non_each_unit_is_blocked(s1):
    reg = reg_row(normalized_uom="lot")
    s1.rows(reg)
    s1.classify()
    report = s1.sync()
    assert report["counts"]["exceptions"] == 1
    assert report["state"] == "PARTIAL"
    assert s1.requirements() == []
    [exc] = _open_exceptions(s1, "VALIDATION")
    assert "lot" in exc.message
    assert exc.subject_type == "step1_record"
    assert exc.subject_id == reg["inventory_record_id"]


def test_fractional_quantity_on_serialized_class_is_blocked(s1):
    assert s1.gen.tracking == "SERIALIZED"
    s1.rows(reg_row(boq_quantity="2.5"))
    s1.classify()
    report = s1.sync()
    assert report["counts"]["exceptions"] == 1
    assert s1.requirements() == []
    assert len(_open_exceptions(s1, "VALIDATION")) == 1


def test_missing_or_ambiguous_wbs_creates_requirement_with_exception(s1):
    s1.db.delete(s1.wbs)
    s1.db.commit()
    s1.classify()
    s1.sync()
    [req] = s1.requirements()
    assert req.wbs_id is None
    first_id = s1.client.registers["S1-P1"][0]["inventory_record_id"]
    assert [(e.subject_type, e.subject_id) for e in _open_exceptions(s1, "MAPPING")] == [("step1_record", first_id)]

    for code in ("BKK1-S1-A", "BKK1-S1-B"):
        s1.db.add(WbsElement(tenant_id=s1.admin.tenant_id, project_id=s1.project.id, code=code, name=code, cost_code="26-100"))
    s1.db.commit()
    second_reg = reg_row(record_number="INV-00002")
    s1.rows(*s1.client.registers["S1-P1"], second_reg)
    report = s1.sync()
    assert report["counts"]["created"] == 1
    second = next(r for r in s1.requirements() if r.source_line_key == "INV-00002")
    assert second.wbs_id is None
    mapping = {(e.subject_type, e.subject_id) for e in _open_exceptions(s1, "MAPPING")}
    assert ("step1_record", second_reg["inventory_record_id"]) in mapping


def test_project_without_match_is_skipped(s1):
    s1.client.project_rows.append({"project_id": "S1-P2", "project_name": "Elsewhere", "procore_project_id": "1234", "procore_company_id": "C1"})
    report = s1.sync()
    assert report["counts"]["skipped_projects"] == 1
    [entry] = [e for e in report["projects"] if e["step1_project_id"] == "S1-P2"]
    assert entry["status"] == "skipped"
    assert entry["pcx_project_id"] is None
    [matched] = [e for e in report["projects"] if e["step1_project_id"] == "S1-P1"]
    assert matched["status"] == "synced"
    assert matched["pcx_project_id"] == s1.project.id


def test_step1_down_records_a_failed_run_and_writes_nothing(s1):
    s1.client.fail = True
    report = s1.sync()
    assert report["state"] == "FAILED"
    assert report["error"]
    run = s1.db.get(Step1SyncRun, report["run_id"])
    assert run is not None and run.state == "FAILED"
    assert s1.requirements() == []
    assert _count(s1, ExternalObjectLink) == 0
    assert _count(s1, Step1ItemClass) == 0
    assert _count(s1, IntegrationException) == 0


def test_equivalent_decimal_strings_do_not_create_revisions(s1):
    base = reg_row(boq_quantity="6.000000")
    s1.rows(base)
    s1.classify()
    assert s1.sync()["counts"]["created"] == 1
    for quantity in ("6", "6.0"):
        s1.rows({**base, "boq_quantity": quantity})
        report = s1.sync()
        assert report["counts"]["unchanged"] == 1, quantity
        assert report["counts"]["created"] == 0, quantity
    [req] = s1.requirements()
    assert len(s1.revisions(req)) == 1


def test_long_and_padded_description_becomes_a_clean_title(s1):
    s1.rows(reg_row(item_description="  " + "x" * 400 + "  "))
    s1.classify()
    s1.sync()
    [req] = s1.requirements()
    assert len(req.title) == 300
    assert req.title == req.title.strip()


def test_malformed_rows_raise_exceptions_for_that_record_only(s1):
    bad = [
        reg_row(record_number="INV-00002", item_id=None),
        reg_row(record_number="INV-00003", boq_quantity=None),
        reg_row(record_number="INV-00004", boq_quantity="abc"),
    ]
    s1.rows(reg_row(), *bad)
    s1.classify()
    report = s1.sync()
    assert report["counts"]["created"] == 1
    assert report["counts"]["exceptions"] == 3
    assert report["state"] == "PARTIAL"
    assert [r.source_line_key for r in s1.requirements()] == ["INV-00001"]
    assert s1.db.scalar(select(func.count()).select_from(Requirement).where(Requirement.source_boq_key == "STEP1")) == 1
    excs = _open_exceptions(s1, "VALIDATION")
    assert {e.subject_type for e in excs} == {"step1_record"}
    assert {e.subject_id for e in excs} == {r["inventory_record_id"] for r in bad}


def test_badly_typed_or_out_of_range_rows_cost_one_exception_each(s1):
    bad = [
        reg_row(record_number="INV-00002", item_description=12345),
        reg_row(record_number="INV-00003", normalized_uom=1),
        reg_row(record_number="INV-00004", item_id=["item-gen"]),
        reg_row(record_number="INV-00005", item_id={"id": "item-gen"}),
        reg_row(record_number="INV-00006", cost_code={"code": "26-100"}),
        reg_row(record_number="INV-00007", boq_quantity="1e400"),
        reg_row(record_number="INV-00008", boq_quantity="1000000000000000"),
        reg_row(record_number="INV-00009", boq_quantity="0.0000004"),
        reg_row(record_number="INV-00010", specification=["2500 kVA"]),
        reg_row(record_number="INV-00011", work_package_name=7),
        reg_row(record_number="INV-00012", item_id=True),
    ]
    s1.rows(reg_row(), *bad)
    s1.classify()

    report = s1.sync()

    assert report["counts"]["created"] == 1
    assert report["counts"]["exceptions"] == len(bad)
    assert report["state"] == "PARTIAL"
    assert [r.source_line_key for r in s1.requirements()] == ["INV-00001"]
    assert all(s1.revisions(r) for r in s1.requirements())
    no_revision = s1.db.scalar(
        select(func.count())
        .select_from(Requirement)
        .where(~select(RequirementRevision.id).where(RequirementRevision.requirement_id == Requirement.id).exists())
    )
    assert no_revision == 0
    excs = _open_exceptions(s1, "VALIDATION")
    assert {e.subject_type for e in excs} == {"step1_record"}
    assert {e.subject_id for e in excs} == {r["inventory_record_id"] for r in bad}
    messages = " | ".join(e.message for e in excs)
    assert "item_description is not text" in messages
    assert "cost_code is not text" in messages


def test_integer_ids_are_accepted_as_text(s1):
    s1.rows(reg_row(item_id=42, inventory_record_id=777, record_number=1001))
    assert s1.sync()["counts"]["queued"] == 1  # the crosswalk row is keyed by the text id "42"
    s1.classify("42")

    report = s1.sync()

    assert report["state"] == "SUCCEEDED", report
    [req] = s1.requirements()
    assert req.source_line_key == "1001"
    assert req.step1_item_id == "42"
    assert _link_of(s1, {"inventory_record_id": "777"}) is not None


def test_requirement_code_collision_is_contained_to_that_record(s1):
    tenant = s1.admin.tenant_id
    chiller = s1.db.scalar(select(EquipmentClass).where(EquipmentClass.tenant_id == tenant, EquipmentClass.code == "CHL-AC"))
    # _auto_code counts codes LIKE 'REQ-BKK1-GEN%' and appends count + 1, so a gap in the numbering makes it collide.
    base = f"REQ-{s1.project.code}-{s1.gen.code}"
    taken = s1.db.scalar(select(func.count()).select_from(Requirement).where(Requirement.tenant_id == tenant, Requirement.code.like(f"{base}%")))
    s1.db.add(Requirement(tenant_id=tenant, code=f"{base}-{taken + 2}", title="Hand-made gap", project_id=s1.project.id, equipment_class_id=s1.gen.id))
    s1.db.commit()
    s1.rows(reg_row(), reg_row(record_number="INV-00002", item_id="item-chl", item_description="Air-cooled chiller 1500 kW"))
    s1.classify()
    s1.classify("item-chl", cls=chiller)

    report = s1.sync()

    assert report["counts"]["exceptions"] == 1
    assert report["counts"]["created"] == 1
    assert report["state"] == "PARTIAL"
    assert [r.source_line_key for r in s1.requirements()] == ["INV-00002"]
    assert all(s1.revisions(r) for r in s1.requirements())
    [exc] = _open_exceptions(s1, "VALIDATION")
    assert exc.subject_type == "step1_record"
    assert "DUPLICATE_REQUIREMENT_CODE" in exc.message


# ---------------------------------------------------------------- Task 5: changes, replacement, dropped, cancelled


def _approve(s1, req):
    """Mark revision 1 APPROVED and make it the requirement's current revision (test setup only)."""
    [rev1] = s1.revisions(req)
    rev1.state = "APPROVED"
    req.current_revision_id = rev1.id
    s1.db.commit()
    return rev1


def _set(s1, rev, **fields):
    """Edit PCX-entered fields on a revision (test setup only)."""
    for name, value in fields.items():
        setattr(rev, name, value)
    s1.db.commit()


def _link_of(s1, reg):
    return s1.db.scalar(
        select(ExternalObjectLink).where(
            ExternalObjectLink.platform == "STEP1",
            ExternalObjectLink.object_type == "inventory_record",
            ExternalObjectLink.object_key == reg["inventory_record_id"],
        )
    )


def _open_draft_in_review(s1, req, **changes):
    from app.services import planning

    out = planning.add_revision(s1.db, s1.admin, req.id, {"changes": changes})
    rev = s1.db.get(RequirementRevision, out["revision"]["id"])
    rev.state = "IN_REVIEW"
    s1.db.commit()
    return rev


def _synced_requirement(s1, **overrides):
    reg = reg_row(**overrides)
    s1.rows(reg)
    s1.classify()
    assert s1.sync()["counts"]["created"] == 1
    [req] = s1.requirements()
    return req, reg


def test_quantity_change_creates_a_new_draft_carrying_pcx_fields(s1):
    req, reg = _synced_requirement(s1)
    rev1 = _approve(s1, req)
    _set(s1, rev1, duty="STANDBY")
    changed = {**reg, "boq_quantity": "7.000000"}
    s1.rows(changed)

    report = s1.sync()

    assert report["counts"]["revised"] == 1
    assert report["counts"]["created"] == 0
    _, rev2 = s1.revisions(req)
    assert rev2.state == "DRAFT"
    assert rev2.predecessor_id == rev1.id
    assert rev2.quantity == Decimal("7")
    assert rev2.duty == "STANDBY"
    assert rev2.changed_fields == ["quantity"]
    assert "INV-00001" in rev2.change_reason
    assert "6" in rev2.change_reason and "7" in rev2.change_reason
    assert _link_of(s1, reg).source_revision == change_hash(changed)
    assert s1.sync()["counts"]["unchanged"] == 1
    assert len(s1.revisions(req)) == 2


def test_change_during_review_replaces_the_open_revision(s1):
    req, reg = _synced_requirement(s1)
    rev1 = _approve(s1, req)
    rev2 = _open_draft_in_review(s1, req, capacity="2500")
    s1.rows({**reg, "boq_quantity": "8"})

    report = s1.sync()

    assert report["counts"]["revised"] == 1
    revs = s1.revisions(req)
    assert [r.revision_no for r in revs] == [1, 2, 3]
    assert revs[1].id == rev2.id
    assert rev2.state == "CANCELLED"
    assert rev2.change_reason == "Replaced by Step 1 sync"
    rev3 = revs[2]
    assert rev3.state == "DRAFT"
    assert rev3.predecessor_id == rev1.id
    assert rev3.quantity == Decimal("8")
    assert rev3.capacity == Decimal("2500")
    assert set(rev3.changed_fields) == {"quantity", "capacity"}
    assert len([r for r in revs if r.state in ("DRAFT", "IN_REVIEW")]) == 1


def test_approved_baseline_is_never_touched(s1):
    req, reg = _synced_requirement(s1)
    rev1 = _approve(s1, req)
    s1.rows({**reg, "boq_quantity": "7"})
    s1.sync()
    rev2 = s1.revisions(req)[1]
    rev2.state = "IN_REVIEW"
    s1.db.commit()
    s1.rows({**reg, "boq_quantity": "8"})
    s1.sync()

    s1.db.refresh(rev1)
    s1.db.refresh(req)
    assert rev1.state == "APPROVED"
    assert rev1.quantity == Decimal("6")
    assert req.current_revision_id == rev1.id
    assert [r.state for r in s1.revisions(req)] == ["APPROVED", "CANCELLED", "DRAFT"]


def test_dropped_record_raises_exception_and_keeps_requirement_active(s1):
    req, reg = _synced_requirement(s1)

    for dropped in ([], [{**reg, "source_line_count": 0}]):
        s1.rows(*dropped)
        report = s1.sync()
        assert report["counts"]["exceptions"] == 1
        [exc] = _open_exceptions(s1, "RECONCILIATION")
        assert exc.subject_type == "step1_record"
        assert exc.subject_id == reg["inventory_record_id"]
        assert "INV-00001" in exc.message
        s1.db.refresh(req)
        assert req.state == "ACTIVE"
        assert len(s1.revisions(req)) == 1

    s1.rows(reg)
    report = s1.sync()
    assert report["counts"]["unchanged"] == 1
    assert report["counts"]["exceptions"] == 0
    assert _open_exceptions(s1, "RECONCILIATION") == []
    s1.db.refresh(exc)
    assert exc.state == "RESOLVED"


def test_empty_register_reports_every_linked_record_dropped(s1):
    s1.rows(reg_row(), reg_row(record_number="INV-00002"))
    s1.classify()
    assert s1.sync()["counts"]["created"] == 2
    s1.rows()

    report = s1.sync()

    assert report["counts"]["exceptions"] == 2
    assert report["state"] == "SUCCEEDED"
    reqs = s1.requirements()
    assert len(reqs) == 2
    assert all(r.state == "ACTIVE" for r in reqs)
    assert len(_open_exceptions(s1, "RECONCILIATION")) == 2


def test_cancelled_requirement_is_skipped_with_a_note(s1):
    req, reg = _synced_requirement(s1)
    req.state = "CANCELLED"
    s1.db.commit()
    s1.rows({**reg, "boq_quantity": "9"})

    report = s1.sync()

    assert report["counts"]["revised"] == 0
    assert len(s1.revisions(req)) == 1
    [exc] = _open_exceptions(s1, "RECONCILIATION")
    assert exc.subject_type == "requirement"
    assert exc.subject_id == req.id
    s1.db.refresh(req)
    assert req.state == "CANCELLED"


def test_record_fixed_in_step1_resolves_its_validation_exception(s1):
    reg = reg_row(normalized_uom="lot")
    s1.rows(reg)
    s1.classify()
    s1.sync()
    [exc] = _open_exceptions(s1, "VALIDATION")
    assert exc.subject_id == reg["inventory_record_id"]
    s1.rows({**reg, "normalized_uom": "each"})

    report = s1.sync()

    assert report["counts"]["created"] == 1
    assert report["state"] == "SUCCEEDED"
    assert _open_exceptions(s1, "VALIDATION") == []
    s1.db.refresh(exc)
    assert exc.state == "RESOLVED"
    assert exc.resolution == "Resolved in Step 1"
