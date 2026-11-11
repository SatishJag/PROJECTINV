"""Test helpers for the Step 1 feed: an in-memory Step 1 client, register-row builder and the S1Env harness."""

from __future__ import annotations

import copy
import uuid
from dataclasses import dataclass

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.auth import Principal
from app.integrations.step1.client import Step1Unavailable
from app.models import (
    EquipmentClass,
    Project,
    Requirement,
    RequirementRevision,
    Step1ItemClass,
    Tenant,
    WbsElement,
)
from app.services.step1_items import classify_item, see_item


class FakeStep1Client:
    """Implements the Step1Client protocol without HTTP. Set ``fail = True`` to simulate an outage."""

    def __init__(self, project_rows: list[dict], registers: dict[str, list[dict]]) -> None:
        self.project_rows = project_rows
        self.registers = registers
        self.fail = False

    def projects(self) -> list[dict]:
        if self.fail:
            raise Step1Unavailable("Step 1 unavailable")
        return copy.deepcopy(self.project_rows)

    def register(self, step1_project_id: str) -> list[dict]:
        if self.fail:
            raise Step1Unavailable("Step 1 unavailable")
        return copy.deepcopy(self.registers.get(step1_project_id, []))


def reg_row(**overrides) -> dict:
    row = {
        "inventory_record_id": str(uuid.uuid4()),
        "record_number": "INV-00001",
        "project_id": "S1-P1",
        "procore_project_id": "9001",
        "procore_company_id": "C1",
        "work_package_code": "26-100",
        "work_package_name": "Generators",
        "cost_code": "26-100",
        "budget_code": "26-100.M",
        "item_id": "item-gen",
        "internal_item_code": "ITM-00001",
        "item_description": "Diesel generator set 2500 kVA standby",
        "specification": "2500 kVA, 400 V",
        "normalized_uom": "each",
        "boq_quantity": "6.000000",
        "ordered_quantity": None,
        "source_line_count": 1,
    }
    row.update(overrides)
    return row


S1_PROJECT = {"project_id": "S1-P1", "project_name": "Bangkok 1 (Step 1)", "procore_project_id": "9001", "procore_company_id": "C1"}


@dataclass
class S1Env:
    """A PCX tenant (scenario A) wired to a fake Step 1 with one matching project, S1-P1 -> BKK1."""

    db: Session
    client: FakeStep1Client
    project: Project
    gen: EquipmentClass
    wbs: WbsElement
    admin: Principal

    def classify(self, step1_item_id: str = "item-gen", decision: str = "LLE", cls: EquipmentClass | None = None, reason: str | None = None) -> dict:
        tenant = self.admin.tenant_id
        item = self.db.scalar(select(Step1ItemClass).where(Step1ItemClass.tenant_id == tenant, Step1ItemClass.step1_item_id == step1_item_id))
        if item is None:
            reg = next(r for rows in self.client.registers.values() for r in rows if r.get("item_id") == step1_item_id)
            item = see_item(self.db, tenant, reg)
        body: dict = {"decision": decision, "reason": reason}
        if decision == "LLE":
            body["equipment_class_id"] = (cls or self.gen).id
        out = classify_item(self.db, self.admin, item.id, body)
        self.db.commit()
        return out

    def sync(self, project_ids: list[str] | None = None) -> dict:
        from app.services import step1_sync

        report = step1_sync.sync(self.db, self.admin, self.client, project_ids)
        self.db.commit()
        return report

    def rows(self, *rows: dict) -> None:
        self.client.registers["S1-P1"] = list(rows)

    def requirements(self) -> list[Requirement]:
        return list(
            self.db.scalars(
                select(Requirement).where(Requirement.tenant_id == self.admin.tenant_id, Requirement.source_boq_key == "STEP1").order_by(Requirement.source_line_key)
            )
        )

    def revisions(self, req: Requirement) -> list[RequirementRevision]:
        return list(self.db.scalars(select(RequirementRevision).where(RequirementRevision.requirement_id == req.id).order_by(RequirementRevision.revision_no)))


def make_s1_env(db: Session) -> S1Env:
    tenant = db.scalar(select(Tenant.id).where(Tenant.code == "DEMO"))
    project = db.scalar(select(Project).where(Project.tenant_id == tenant, Project.code == "BKK1"))
    project.procore_project_id = "9001"
    project.procore_company_id = "C1"
    gen = db.scalar(select(EquipmentClass).where(EquipmentClass.tenant_id == tenant, EquipmentClass.code == "GEN"))
    wbs = WbsElement(tenant_id=tenant, project_id=project.id, code="BKK1-S1-GEN", name="Step 1 generators", cost_code="26-100")
    db.add(wbs)
    db.commit()
    admin = Principal(user_id="s1-test", tenant_id=tenant, email="admin@demo.pcx", name="Test admin", roles=frozenset({"ADMIN"}))
    client = FakeStep1Client([dict(S1_PROJECT)], {"S1-P1": [reg_row()]})
    return S1Env(db=db, client=client, project=project, gen=gen, wbs=wbs, admin=admin)
