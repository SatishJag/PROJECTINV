"""Foundation for the Step 1 feed: settings, crosswalk/run tables, shared exception helpers."""

import pytest
from sqlalchemy.exc import IntegrityError

from app.config import get_settings
from app.integrations.exceptions import auto_resolve, open_exception
from app.models import IntegrationException, Requirement, Step1ItemClass
from tests.support import tenant_id


def test_exception_helpers_are_scoped_by_source(db):
    tid = tenant_id(db)
    kw = dict(kind="MAPPING", subject_type="Step1Item", subject_id="item-1", message="unmapped")
    step1 = open_exception(db, tid, source="STEP1", actor="step1-sync", **kw)
    procore = open_exception(db, tid, source="PROCORE", **kw)
    db.flush()
    assert step1.id != procore.id
    assert step1.source == "STEP1" and procore.source == "PROCORE"

    n = auto_resolve(db, tid, source="STEP1", kind="MAPPING", subject_type="Step1Item", subject_id="item-1", resolution="fixed")
    db.flush()
    assert n == 1
    db.refresh(step1)
    db.refresh(procore)
    assert step1.state == "RESOLVED"
    assert procore.state == "OPEN"
    assert db.query(IntegrationException).count() == 2


def test_crosswalk_item_defaults_and_uniqueness(db):
    tid = tenant_id(db)
    first = Step1ItemClass(tenant_id=tid, step1_item_id="S1-1", description="Generator")
    db.add(first)
    db.flush()
    assert first.decision == "PENDING"

    db.add(Step1ItemClass(tenant_id=tid, step1_item_id="S1-1", description="Duplicate"))
    with pytest.raises(IntegrityError):
        db.flush()
    db.rollback()


def test_requirement_has_step1_item_id_and_settings_default_empty():
    assert hasattr(Requirement, "step1_item_id")
    settings = get_settings()
    assert settings.step1_base_url == ""
    assert settings.step1_app_password == ""
