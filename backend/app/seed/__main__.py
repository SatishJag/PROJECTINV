"""Seed orchestrator: `py -m app.seed [--keep]` from backend/.

Reference data first, then each workstream's scenario module if present. Scenario modules
expose `run(db: Session, tenant: Tenant) -> None` and must be deterministic.
"""

import importlib
import sys

from app import db as dbm
from app.integrations import load_handlers
from app.seed.reference import seed_reference

SCENARIOS = ("app.seed.scenario_planning", "app.seed.scenario_delivery", "app.seed.scenario_procore")



def seed_all(scenarios: bool = True) -> None:
    load_handlers()
    dbm.drop_all()
    dbm.create_all()
    with dbm.SessionLocal() as db:
        tenant = seed_reference(db)
        db.commit()
        if scenarios:
            for name in SCENARIOS:
                try:
                    mod = importlib.import_module(name)
                except ModuleNotFoundError as exc:
                    if exc.name == name:
                        continue
                    raise
                mod.run(db, tenant)
                db.commit()
                print(f"seeded {name.rsplit('.', 1)[-1]}")
    print("seed complete")


if __name__ == "__main__":
    seed_all(scenarios="--reference-only" not in sys.argv)
