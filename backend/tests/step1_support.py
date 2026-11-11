"""Test helpers for the Step 1 feed: an in-memory Step 1 client and register-row builder."""

from __future__ import annotations

import copy
import uuid

from app.integrations.step1.client import Step1Unavailable


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
