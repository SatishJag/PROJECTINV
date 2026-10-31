"""Permanent asset-code allocation. Codes and UUIDs are never recycled, even for cancelled units."""

import re

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models import EquipmentClass, ItemModel, PhysicalUnit

ASSET_PREFIX = {
    "GEN": "GEN",
    "CHL-AC": "CH",
    "CHL-WC": "CHW",
    "CMP-ENGINE": "ENG",
    "CMP-ALT": "ALT",
    "CMP-CTRL": "CTL",
    "CMP-RAD": "RAD",
    "CMP-BATT": "BAT",
    "CMP-BRK": "BRK",
    "CMP-FIP": "FIP",
    "CMP-TURBO": "TUR",
    "CMP-COMP": "CMP",
    "CMP-DRIVE": "DRV",
    "CMP-EVAP": "EVP",
    "CMP-COND": "CND",
    "CMP-EXV": "EXV",
    "CMP-FAN": "FAN",
}


def prefix_for_model(db: Session, item_model: ItemModel) -> str:
    cls = db.get(EquipmentClass, item_model.equipment_class_id)
    return ASSET_PREFIX.get(cls.code, cls.code)


def next_asset_codes(db: Session, tenant_id: str, prefix: str, count: int, start: int = 1, width: int = 3) -> list[str]:
    """Next `count` codes PREFIX-NNN after the highest code ever issued for the prefix (including cancelled)."""
    pattern = re.compile(rf"^{re.escape(prefix)}-(\d+)$")
    existing = db.scalars(select(PhysicalUnit.asset_code).where(PhysicalUnit.tenant_id == tenant_id, PhysicalUnit.asset_code.like(f"{prefix}-%")))
    highest = max((int(m.group(1)) for c in existing if (m := pattern.match(c))), default=start - 1)
    return [f"{prefix}-{n:0{width}d}" for n in range(highest + 1, highest + 1 + count)]
