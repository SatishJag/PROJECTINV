"""Lookup helpers for acceptance tests (not collected by pytest)."""

from sqlalchemy import select

from app.models import (
    EquipmentClass,
    HandbookPackage,
    Location,
    PhysicalUnit,
    Project,
    Requirement,
    SourcingPackage,
    Supplier,
    Tenant,
)


def tenant_id(db) -> str:
    return db.scalar(select(Tenant.id).where(Tenant.code == "DEMO"))


def unit(db, code: str) -> PhysicalUnit:
    found = db.scalar(select(PhysicalUnit).where(PhysicalUnit.tenant_id == tenant_id(db), PhysicalUnit.asset_code == code))
    assert found is not None, f"unit {code} not seeded"
    return found


def project(db, code: str) -> Project:
    found = db.scalar(select(Project).where(Project.tenant_id == tenant_id(db), Project.code == code))
    assert found is not None, f"project {code} not seeded"
    return found


def location(db, code: str) -> Location:
    found = db.scalar(select(Location).where(Location.tenant_id == tenant_id(db), Location.code == code))
    assert found is not None, f"location {code} not seeded"
    return found


def requirement(db, code: str) -> Requirement:
    found = db.scalar(select(Requirement).where(Requirement.tenant_id == tenant_id(db), Requirement.code == code))
    assert found is not None, f"requirement {code} not seeded"
    return found


def equipment_class(db, code: str) -> EquipmentClass:
    found = db.scalar(select(EquipmentClass).where(EquipmentClass.tenant_id == tenant_id(db), EquipmentClass.code == code))
    assert found is not None, f"equipment class {code} not seeded"
    return found


def sourcing_package(db, code: str) -> SourcingPackage:
    found = db.scalar(select(SourcingPackage).where(SourcingPackage.tenant_id == tenant_id(db), SourcingPackage.code == code))
    assert found is not None, f"package {code} not seeded"
    return found


def supplier(db, key: str) -> Supplier:
    found = db.scalar(select(Supplier).where(Supplier.tenant_id == tenant_id(db), Supplier.key == key))
    assert found is not None, f"supplier {key} not seeded"
    return found


def handbook_package(db, unit_id: str) -> HandbookPackage:
    found = db.scalar(
        select(HandbookPackage)
        .where(HandbookPackage.tenant_id == tenant_id(db), HandbookPackage.unit_id == unit_id)
        .order_by(HandbookPackage.version_no.desc())
    )
    assert found is not None, f"no handbook package for unit {unit_id}"
    return found
