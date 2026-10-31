"""Domain schema for the Procore Equipment Intelligence extension (pcx).

Conventions (spec §28): UUID text keys, tenant_id on every row, UTC timestamps,
exact decimals (money 4dp, quantity 6dp), JSON for structured rules only.
Assignment (destination project), custody (physical location) and installed
position are always separate fields.
"""

import uuid
from datetime import UTC, date, datetime
from decimal import Decimal

from sqlalchemy import JSON, Boolean, Date, DateTime, ForeignKey, Index, Integer, String, Text, UniqueConstraint, text
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.core.decimal import Money, Qty, Rate
from app.db import Base


def new_id() -> str:
    return str(uuid.uuid4())


def utcnow() -> datetime:
    return datetime.now(UTC).replace(tzinfo=None)


class TenantScoped:
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    tenant_id: Mapped[str] = mapped_column(String(36), ForeignKey("tenant.id"), index=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)
    created_by: Mapped[str | None] = mapped_column(String(120))


class Versioned:
    """Optimistic concurrency: version feeds the ETag; bump on every mutation."""

    version: Mapped[int] = mapped_column(Integer, default=1)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow, onupdate=utcnow)


# ---------------------------------------------------------------- tenancy, people, places


class Tenant(Base):
    __tablename__ = "tenant"
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    code: Mapped[str] = mapped_column(String(40), unique=True)
    name: Mapped[str] = mapped_column(String(200))
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)


class User(TenantScoped, Base):
    __tablename__ = "app_user"
    __table_args__ = (UniqueConstraint("tenant_id", "email"),)
    email: Mapped[str] = mapped_column(String(200))
    name: Mapped[str] = mapped_column(String(200))
    # Comma-separated role codes, see app.core.auth.ROLES
    roles: Mapped[str] = mapped_column(String(400))
    supplier_id: Mapped[str | None] = mapped_column(String(36), ForeignKey("supplier.id"))
    # Comma-separated project ids; empty means all projects in tenant.
    project_scope: Mapped[str] = mapped_column(Text, default="")
    password_hash: Mapped[str | None] = mapped_column(String(300))
    procore_user_id: Mapped[str | None] = mapped_column(String(64))
    active: Mapped[bool] = mapped_column(Boolean, default=True)


class Programme(TenantScoped, Base):
    """Programme / region, e.g. BKK covering BKK1 and BKK2."""

    __tablename__ = "programme"
    __table_args__ = (UniqueConstraint("tenant_id", "code"),)
    code: Mapped[str] = mapped_column(String(40))
    name: Mapped[str] = mapped_column(String(200))
    region: Mapped[str | None] = mapped_column(String(100))
    currency: Mapped[str] = mapped_column(String(3), default="USD")


class Project(TenantScoped, Base):
    """Destination project / data centre, mapped to a Procore project."""

    __tablename__ = "project"
    __table_args__ = (UniqueConstraint("tenant_id", "code"),)
    programme_id: Mapped[str] = mapped_column(String(36), ForeignKey("programme.id"))
    code: Mapped[str] = mapped_column(String(40))
    name: Mapped[str] = mapped_column(String(200))
    site_timezone: Mapped[str] = mapped_column(String(64), default="Asia/Bangkok")
    status: Mapped[str] = mapped_column(String(20), default="ACTIVE")
    procore_company_id: Mapped[str | None] = mapped_column(String(64))
    procore_project_id: Mapped[str | None] = mapped_column(String(64))
    programme: Mapped[Programme] = relationship()


class WbsElement(TenantScoped, Base):
    __tablename__ = "wbs_element"
    __table_args__ = (UniqueConstraint("tenant_id", "project_id", "code"),)
    project_id: Mapped[str] = mapped_column(String(36), ForeignKey("project.id"))
    code: Mapped[str] = mapped_column(String(60))
    name: Mapped[str] = mapped_column(String(200))
    cost_code: Mapped[str | None] = mapped_column(String(60))
    procore_cost_code_id: Mapped[str | None] = mapped_column(String(64))


class Location(TenantScoped, Base):
    """Physical custody location. kind: SUPPLIER, IN_TRANSIT, CENTRAL_WAREHOUSE, SITE_STORE, INSTALLED."""

    __tablename__ = "location"
    __table_args__ = (UniqueConstraint("tenant_id", "code"),)
    code: Mapped[str] = mapped_column(String(60))
    name: Mapped[str] = mapped_column(String(200))
    kind: Mapped[str] = mapped_column(String(30))
    programme_id: Mapped[str | None] = mapped_column(String(36), ForeignKey("programme.id"))
    project_id: Mapped[str | None] = mapped_column(String(36), ForeignKey("project.id"))
    oracle_subinventory: Mapped[str | None] = mapped_column(String(60))


class Supplier(TenantScoped, Base):
    __tablename__ = "supplier"
    __table_args__ = (UniqueConstraint("tenant_id", "key"),)
    key: Mapped[str] = mapped_column(String(60))
    name: Mapped[str] = mapped_column(String(200))
    country: Mapped[str | None] = mapped_column(String(60))
    procore_vendor_id: Mapped[str | None] = mapped_column(String(64))
    oracle_supplier_id: Mapped[str | None] = mapped_column(String(64))


# ---------------------------------------------------------------- catalogue / PIM (FR03)


class EquipmentClass(TenantScoped, Base):
    """Functional equipment class from the LLE master list (e.g. Diesel generator sets)."""

    __tablename__ = "equipment_class"
    __table_args__ = (UniqueConstraint("tenant_id", "code"),)
    code: Mapped[str] = mapped_column(String(40))
    category: Mapped[str] = mapped_column(String(100))
    name: Mapped[str] = mapped_column(String(200))
    lle_status: Mapped[str] = mapped_column(String(60))
    tracking: Mapped[str] = mapped_column(String(20), default="SERIALIZED")  # SERIALIZED | BULK
    typical_lead_time_days: Mapped[int | None] = mapped_column(Integer)
    is_component_class: Mapped[bool] = mapped_column(Boolean, default=False)


class ItemModel(TenantScoped, Base):
    """Manufacturer model / internal item code. Components (engine, compressor) are item models too."""

    __tablename__ = "item_model"
    __table_args__ = (UniqueConstraint("tenant_id", "item_code"),)
    item_code: Mapped[str] = mapped_column(String(60))
    equipment_class_id: Mapped[str] = mapped_column(String(36), ForeignKey("equipment_class.id"))
    manufacturer: Mapped[str | None] = mapped_column(String(120))
    model: Mapped[str | None] = mapped_column(String(120))
    description: Mapped[str] = mapped_column(String(300))
    rated_capacity: Mapped[Decimal | None] = mapped_column(Qty())
    capacity_unit: Mapped[str | None] = mapped_column(String(20))
    rating_standard: Mapped[str | None] = mapped_column(String(60))
    duty_modes: Mapped[str | None] = mapped_column(String(120))  # e.g. "STANDBY,PRIME"
    serial_controlled: Mapped[bool] = mapped_column(Boolean, default=True)
    specs_json: Mapped[dict] = mapped_column(JSON, default=dict)
    state: Mapped[str] = mapped_column(String(20), default="APPROVED")
    oracle_item_id: Mapped[str | None] = mapped_column(String(64))
    equipment_class: Mapped[EquipmentClass] = relationship()


class BomLine(TenantScoped, Base):
    """Product structure: which child components a parent model requires, per slot."""

    __tablename__ = "bom_line"
    __table_args__ = (UniqueConstraint("tenant_id", "parent_model_id", "slot_code"),)
    parent_model_id: Mapped[str] = mapped_column(String(36), ForeignKey("item_model.id"))
    child_model_id: Mapped[str | None] = mapped_column(String(36), ForeignKey("item_model.id"))
    slot_code: Mapped[str] = mapped_column(String(60))
    description: Mapped[str] = mapped_column(String(200))
    quantity: Mapped[Decimal] = mapped_column(Qty(), default=Decimal(1))
    individually_tracked: Mapped[bool] = mapped_column(Boolean, default=True)
    parent_slot_code: Mapped[str | None] = mapped_column(String(60))  # nested slots e.g. ENGINE/TURBO


class CompatibleSpare(TenantScoped, Base):
    __tablename__ = "compatible_spare"
    __table_args__ = (UniqueConstraint("tenant_id", "spare_model_id", "parent_model_id", "slot_code"),)
    spare_model_id: Mapped[str] = mapped_column(String(36), ForeignKey("item_model.id"))
    parent_model_id: Mapped[str] = mapped_column(String(36), ForeignKey("item_model.id"))
    slot_code: Mapped[str] = mapped_column(String(60))
    approved_by: Mapped[str | None] = mapped_column(String(120))


class EquipmentOption(TenantScoped, Base):
    """Versioned selectable configuration of a model used in evaluation."""

    __tablename__ = "equipment_option"
    __table_args__ = (UniqueConstraint("tenant_id", "option_code", "revision_no"),)
    item_model_id: Mapped[str] = mapped_column(String(36), ForeignKey("item_model.id"))
    option_code: Mapped[str] = mapped_column(String(60))
    revision_no: Mapped[int] = mapped_column(Integer, default=1)
    name: Mapped[str] = mapped_column(String(200))
    configuration_json: Mapped[dict] = mapped_column(JSON, default=dict)
    technical_basis: Mapped[str | None] = mapped_column(Text)
    state: Mapped[str] = mapped_column(String(20), default="APPROVED")
    item_model: Mapped[ItemModel] = relationship()


# ---------------------------------------------------------------- requirements & BOQ (FR01, FR02)


class Requirement(TenantScoped, Versioned, Base):
    """Stable functional need. current_revision_id is the approved procurement-facing projection."""

    __tablename__ = "requirement"
    __table_args__ = (UniqueConstraint("tenant_id", "code"),)
    code: Mapped[str] = mapped_column(String(60))
    title: Mapped[str] = mapped_column(String(300))
    project_id: Mapped[str] = mapped_column(String(36), ForeignKey("project.id"))
    wbs_id: Mapped[str | None] = mapped_column(String(36), ForeignKey("wbs_element.id"))
    equipment_class_id: Mapped[str] = mapped_column(String(36), ForeignKey("equipment_class.id"))
    current_revision_id: Mapped[str | None] = mapped_column(String(36))
    sourcing_route: Mapped[str | None] = mapped_column(String(30))  # NEW_PURCHASE|REUSE|REFURBISH|REDESIGN
    state: Mapped[str] = mapped_column(String(20), default="ACTIVE")  # ACTIVE|CANCELLED
    source_boq_key: Mapped[str | None] = mapped_column(String(120))
    source_line_key: Mapped[str | None] = mapped_column(String(120))


class RequirementRevision(TenantScoped, Base):
    """Immutable once approved. state: DRAFT|IN_REVIEW|APPROVED|SUPERSEDED|CANCELLED."""

    __tablename__ = "requirement_revision"
    __table_args__ = (UniqueConstraint("tenant_id", "requirement_id", "revision_no"),)
    requirement_id: Mapped[str] = mapped_column(String(36), ForeignKey("requirement.id"), index=True)
    revision_no: Mapped[int] = mapped_column(Integer)
    state: Mapped[str] = mapped_column(String(20), default="DRAFT")
    quantity: Mapped[Decimal] = mapped_column(Qty())
    uom: Mapped[str] = mapped_column(String(20), default="EA")
    duty: Mapped[str | None] = mapped_column(String(40))  # STANDBY|PRIME|CONTINUOUS
    capacity: Mapped[Decimal | None] = mapped_column(Qty())
    capacity_unit: Mapped[str | None] = mapped_column(String(20))
    redundancy: Mapped[str | None] = mapped_column(String(40))  # e.g. N+1
    install_location: Mapped[str | None] = mapped_column(String(200))
    specification_json: Mapped[dict] = mapped_column(JSON, default=dict)
    cost_code: Mapped[str | None] = mapped_column(String(60))
    budget_amount: Mapped[Decimal | None] = mapped_column(Money())
    currency: Mapped[str | None] = mapped_column(String(3))
    required_site_date: Mapped[date | None] = mapped_column(Date)
    required_install_date: Mapped[date | None] = mapped_column(Date)
    required_operational_date: Mapped[date | None] = mapped_column(Date)
    predecessor_id: Mapped[str | None] = mapped_column(String(36), ForeignKey("requirement_revision.id"))
    changed_fields: Mapped[list] = mapped_column(JSON, default=list)
    change_reason: Mapped[str | None] = mapped_column(Text)
    submitted_at: Mapped[datetime | None] = mapped_column(DateTime)
    approved_at: Mapped[datetime | None] = mapped_column(DateTime)
    approved_by: Mapped[str | None] = mapped_column(String(120))


class BoqRevision(TenantScoped, Base):
    __tablename__ = "boq_revision"
    __table_args__ = (UniqueConstraint("tenant_id", "project_id", "source_key", "revision_no"),)
    project_id: Mapped[str] = mapped_column(String(36), ForeignKey("project.id"))
    source_key: Mapped[str] = mapped_column(String(120))
    revision_no: Mapped[int] = mapped_column(Integer)
    state: Mapped[str] = mapped_column(String(20), default="DRAFT")
    source_hash: Mapped[str] = mapped_column(String(64))
    approved_at: Mapped[datetime | None] = mapped_column(DateTime)


class BoqLine(TenantScoped, Base):
    __tablename__ = "boq_line"
    __table_args__ = (UniqueConstraint("tenant_id", "boq_revision_id", "source_line_key"),)
    boq_revision_id: Mapped[str] = mapped_column(String(36), ForeignKey("boq_revision.id"), index=True)
    source_line_key: Mapped[str] = mapped_column(String(120))
    requirement_revision_id: Mapped[str] = mapped_column(String(36), ForeignKey("requirement_revision.id"))
    quantity: Mapped[Decimal] = mapped_column(Qty())
    uom: Mapped[str] = mapped_column(String(20))
    budget_amount: Mapped[Decimal | None] = mapped_column(Money())
    currency: Mapped[str | None] = mapped_column(String(3))


class ImpactAction(TenantScoped, Versioned, Base):
    """Opened when an approved change affects downstream evaluation, award, PO or reservation."""

    __tablename__ = "impact_action"
    requirement_id: Mapped[str] = mapped_column(String(36), ForeignKey("requirement.id"), index=True)
    revision_id: Mapped[str | None] = mapped_column(String(36), ForeignKey("requirement_revision.id"))
    subject_type: Mapped[str] = mapped_column(String(40))
    subject_id: Mapped[str] = mapped_column(String(36))
    reason: Mapped[str] = mapped_column(Text)
    owner_role: Mapped[str] = mapped_column(String(40))
    state: Mapped[str] = mapped_column(String(20), default="OPEN")
    resolution: Mapped[str | None] = mapped_column(Text)


# ---------------------------------------------------------------- benchmarking (FR04, FR18)


class BenchmarkObservation(TenantScoped, Base):
    """Observed actual outcome of a past asset, the evidence base for benchmarks."""

    __tablename__ = "benchmark_observation"
    equipment_class_id: Mapped[str] = mapped_column(String(36), ForeignKey("equipment_class.id"), index=True)
    item_model_id: Mapped[str | None] = mapped_column(String(36), ForeignKey("item_model.id"))
    unit_id: Mapped[str | None] = mapped_column(String(36), ForeignKey("physical_unit.id"))
    source_project_code: Mapped[str] = mapped_column(String(60))
    duty: Mapped[str | None] = mapped_column(String(40))
    capacity: Mapped[Decimal | None] = mapped_column(Qty())
    capacity_unit: Mapped[str | None] = mapped_column(String(20))
    region: Mapped[str | None] = mapped_column(String(60))
    currency: Mapped[str] = mapped_column(String(3))
    purchase_cost: Mapped[Decimal | None] = mapped_column(Money())
    installed_cost: Mapped[Decimal | None] = mapped_column(Money())
    annual_opex: Mapped[list] = mapped_column(JSON, default=list)  # [{"year":1,"amount":"120"}]
    operating_years_observed: Mapped[int] = mapped_column(Integer, default=0)
    scope_included: Mapped[list] = mapped_column(JSON, default=list)
    commissioning_failures: Mapped[int] = mapped_column(Integer, default=0)
    delivery_delay_days: Mapped[int | None] = mapped_column(Integer)
    observed_at: Mapped[date] = mapped_column(Date)
    source_ref: Mapped[str] = mapped_column(String(200))


class BenchmarkRun(TenantScoped, Base):
    """Immutable published benchmark input set. state: CALCULATED|PUBLISHED|INSUFFICIENT_EVIDENCE."""

    __tablename__ = "benchmark_run"
    requirement_revision_id: Mapped[str] = mapped_column(String(36), ForeignKey("requirement_revision.id"), index=True)
    cohort_json: Mapped[dict] = mapped_column(JSON, default=dict)
    normalization_version: Mapped[str] = mapped_column(String(40), default="norm-v1")
    evidence_cutoff: Mapped[datetime] = mapped_column(DateTime)
    input_manifest_hash: Mapped[str] = mapped_column(String(64))
    observation_ids: Mapped[list] = mapped_column(JSON, default=list)
    excluded_json: Mapped[list] = mapped_column(JSON, default=list)
    quality_json: Mapped[dict] = mapped_column(JSON, default=dict)
    sample_count: Mapped[int] = mapped_column(Integer, default=0)
    state: Mapped[str] = mapped_column(String(30))


class BenchmarkResult(TenantScoped, Base):
    __tablename__ = "benchmark_result"
    __table_args__ = (UniqueConstraint("tenant_id", "benchmark_run_id", "metric_code", "basis"),)
    benchmark_run_id: Mapped[str] = mapped_column(String(36), ForeignKey("benchmark_run.id"), index=True)
    metric_code: Mapped[str] = mapped_column(String(60))  # PURCHASE_COST, INSTALLED_COST, ANNUAL_OPEX_Y1...
    basis: Mapped[str] = mapped_column(String(60))  # e.g. "per_unit|USD|2026"
    value_min: Mapped[Decimal | None] = mapped_column(Money())
    value_median: Mapped[Decimal | None] = mapped_column(Money())
    value_max: Mapped[Decimal | None] = mapped_column(Money())
    unit: Mapped[str | None] = mapped_column(String(20))
    sample_count: Mapped[int] = mapped_column(Integer, default=0)
    coverage_note: Mapped[str | None] = mapped_column(Text)


# ---------------------------------------------------------------- reuse & reservation (FR05)


class Reservation(TenantScoped, Versioned, Base):
    """Authoritative reservation of an existing unit. At most one ACTIVE per unit (T05)."""

    __tablename__ = "reservation"
    __table_args__ = (
        Index(
            "uq_reservation_active_unit",
            "unit_id",
            unique=True,
            sqlite_where=text("state = 'ACTIVE'"),
            mssql_where=text("state = 'ACTIVE'"),
            postgresql_where=text("state = 'ACTIVE'"),
        ),
    )
    unit_id: Mapped[str] = mapped_column(String(36), ForeignKey("physical_unit.id"))
    requirement_id: Mapped[str | None] = mapped_column(String(36), ForeignKey("requirement.id"))
    project_id: Mapped[str] = mapped_column(String(36), ForeignKey("project.id"))
    state: Mapped[str] = mapped_column(String(20), default="ACTIVE")  # ACTIVE|RELEASED|EXPIRED|CONSUMED
    authority: Mapped[str] = mapped_column(String(40), default="HUB")  # HUB|ORACLE
    oracle_reservation_ref: Mapped[str | None] = mapped_column(String(64))
    expires_at: Mapped[datetime | None] = mapped_column(DateTime)
    approved_by: Mapped[str | None] = mapped_column(String(120))


class ReuseAssessment(TenantScoped, Versioned, Base):
    """state: CANDIDATE|ASSESSED|APPROVED|REJECTED|INVALIDATED."""

    __tablename__ = "reuse_assessment"
    requirement_revision_id: Mapped[str] = mapped_column(String(36), ForeignKey("requirement_revision.id"), index=True)
    unit_id: Mapped[str] = mapped_column(String(36), ForeignKey("physical_unit.id"))
    state: Mapped[str] = mapped_column(String(20), default="ASSESSED")
    suitability_json: Mapped[dict] = mapped_column(JSON, default=dict)
    available_from: Mapped[date | None] = mapped_column(Date)
    currency: Mapped[str] = mapped_column(String(3))
    transfer_cost: Mapped[Decimal | None] = mapped_column(Money())
    refurbishment_cost: Mapped[Decimal | None] = mapped_column(Money())
    retest_cost: Mapped[Decimal | None] = mapped_column(Money())
    forward_reuse_cost: Mapped[Decimal | None] = mapped_column(Money())
    forward_new_cost: Mapped[Decimal | None] = mapped_column(Money())
    sunk_cost_excluded: Mapped[Decimal | None] = mapped_column(Money())
    reservation_id: Mapped[str | None] = mapped_column(String(36), ForeignKey("reservation.id"))
    decision_reason: Mapped[str | None] = mapped_column(Text)
    approved_by: Mapped[str | None] = mapped_column(String(120))


# ---------------------------------------------------------------- sourcing & evaluation (FR06-FR10)


class SourcingPackage(TenantScoped, Versioned, Base):
    """Consolidated sourcing package. May span several DCs of one programme. state: DRAFT|ISSUED|CLOSED|AWARDED."""

    __tablename__ = "sourcing_package"
    __table_args__ = (UniqueConstraint("tenant_id", "code", "revision_no"),)
    code: Mapped[str] = mapped_column(String(60))
    title: Mapped[str] = mapped_column(String(300))
    programme_id: Mapped[str] = mapped_column(String(36), ForeignKey("programme.id"))
    revision_no: Mapped[int] = mapped_column(Integer, default=1)
    state: Mapped[str] = mapped_column(String(20), default="DRAFT")
    source_system: Mapped[str] = mapped_column(String(20), default="PCX")  # GEP|PROCORE|PCX
    source_key: Mapped[str | None] = mapped_column(String(120))
    currency: Mapped[str] = mapped_column(String(3))
    bid_due_at: Mapped[datetime | None] = mapped_column(DateTime)
    evaluation_policy_json: Mapped[dict] = mapped_column(JSON, default=dict)
    # Supplier ids invited to bid; a supplier principal sees the package only once issued to it.
    invited_supplier_ids: Mapped[list] = mapped_column(JSON, default=list)


class PackageLine(TenantScoped, Base):
    __tablename__ = "package_line"
    __table_args__ = (UniqueConstraint("tenant_id", "package_id", "line_key"),)
    package_id: Mapped[str] = mapped_column(String(36), ForeignKey("sourcing_package.id"), index=True)
    line_key: Mapped[str] = mapped_column(String(40))
    requirement_revision_id: Mapped[str] = mapped_column(String(36), ForeignKey("requirement_revision.id"))
    quantity: Mapped[Decimal] = mapped_column(Qty())
    uom: Mapped[str] = mapped_column(String(20))
    scope_json: Mapped[dict] = mapped_column(JSON, default=dict)  # required scope categories


class SupplierOffer(TenantScoped, Base):
    """Offer revision; prior versions preserved. state: RECEIVED|VALIDATED|SUPERSEDED|WITHDRAWN."""

    __tablename__ = "supplier_offer"
    __table_args__ = (UniqueConstraint("tenant_id", "package_id", "supplier_id", "revision_no"),)
    package_id: Mapped[str] = mapped_column(String(36), ForeignKey("sourcing_package.id"), index=True)
    supplier_id: Mapped[str] = mapped_column(String(36), ForeignKey("supplier.id"))
    source_offer_key: Mapped[str] = mapped_column(String(120))
    revision_no: Mapped[int] = mapped_column(Integer, default=1)
    predecessor_id: Mapped[str | None] = mapped_column(String(36), ForeignKey("supplier_offer.id"))
    currency: Mapped[str] = mapped_column(String(3))
    fx_rate_to_package: Mapped[Decimal | None] = mapped_column(Rate())
    valid_until: Mapped[date | None] = mapped_column(Date)
    incoterms: Mapped[str | None] = mapped_column(String(20))
    state: Mapped[str] = mapped_column(String(20), default="RECEIVED")
    content_hash: Mapped[str | None] = mapped_column(String(64))
    supplier: Mapped[Supplier] = relationship()


class OfferLine(TenantScoped, Base):
    __tablename__ = "offer_line"
    __table_args__ = (UniqueConstraint("tenant_id", "offer_id", "package_line_id"),)
    offer_id: Mapped[str] = mapped_column(String(36), ForeignKey("supplier_offer.id"), index=True)
    package_line_id: Mapped[str] = mapped_column(String(36), ForeignKey("package_line.id"))
    option_id: Mapped[str] = mapped_column(String(36), ForeignKey("equipment_option.id"))
    quantity: Mapped[Decimal] = mapped_column(Qty())
    unit_price: Mapped[Decimal] = mapped_column(Money())
    base_amount: Mapped[Decimal] = mapped_column(Money())
    promised_delivery_date: Mapped[date | None] = mapped_column(Date)
    lead_time_days: Mapped[int | None] = mapped_column(Integer)
    # {"included": ["FREIGHT", ...], "excluded": ["INSTALLATION", ...]}
    scope_json: Mapped[dict] = mapped_column(JSON, default=dict)
    annual_om_estimate: Mapped[Decimal | None] = mapped_column(Money())
    warranty_months: Mapped[int | None] = mapped_column(Integer)


class NormalizationAdjustment(TenantScoped, Versioned, Base):
    """Signed scope adjustment. amount NULL = unpriced exclusion (visible unknown, never zero)."""

    __tablename__ = "normalization_adjustment"
    __table_args__ = (UniqueConstraint("tenant_id", "offer_line_id", "category"),)
    offer_line_id: Mapped[str] = mapped_column(String(36), ForeignKey("offer_line.id"), index=True)
    category: Mapped[str] = mapped_column(String(40))  # FREIGHT|INSTALLATION|COMMISSIONING|SPARES|...
    amount: Mapped[Decimal | None] = mapped_column(Money())
    currency: Mapped[str] = mapped_column(String(3))
    rationale: Mapped[str] = mapped_column(Text)
    evidence_ref: Mapped[str | None] = mapped_column(String(200))
    state: Mapped[str] = mapped_column(String(20), default="PROPOSED")  # PROPOSED|APPROVED|REJECTED
    approved_by: Mapped[str | None] = mapped_column(String(120))


class TechnicalDeviation(TenantScoped, Versioned, Base):
    """Mandatory deviation disposition is an eligibility gate (FR08). disposition: OPEN|ACCEPTED|REJECTED."""

    __tablename__ = "technical_deviation"
    offer_line_id: Mapped[str] = mapped_column(String(36), ForeignKey("offer_line.id"), index=True)
    criterion_ref: Mapped[str] = mapped_column(String(80))
    mandatory: Mapped[bool] = mapped_column(Boolean, default=True)
    severity: Mapped[str] = mapped_column(String(20), default="MAJOR")
    description: Mapped[str] = mapped_column(Text)
    proposed_alternative: Mapped[str | None] = mapped_column(Text)
    disposition: Mapped[str] = mapped_column(String(20), default="OPEN")
    approver: Mapped[str | None] = mapped_column(String(120))
    evidence_ref: Mapped[str | None] = mapped_column(String(200))


class Evaluation(TenantScoped, Versioned, Base):
    """state: DRAFT|CALCULATED|IN_REVIEW|APPROVED|STALE."""

    __tablename__ = "evaluation"
    __table_args__ = (UniqueConstraint("tenant_id", "package_id", "revision_no"),)
    package_id: Mapped[str] = mapped_column(String(36), ForeignKey("sourcing_package.id"), index=True)
    revision_no: Mapped[int] = mapped_column(Integer)
    state: Mapped[str] = mapped_column(String(20), default="DRAFT")
    # {"weights": {"INSTALLED_COST": "0.4", ...}, "horizon_years": 5, "discount_rate": "0.08"}
    criteria_policy_json: Mapped[dict] = mapped_column(JSON, default=dict)
    input_fingerprint: Mapped[str | None] = mapped_column(String(64))
    input_manifest_json: Mapped[dict] = mapped_column(JSON, default=dict)
    evidence_cutoff: Mapped[datetime | None] = mapped_column(DateTime)
    results_json: Mapped[dict] = mapped_column(JSON, default=dict)
    stale_reason: Mapped[str | None] = mapped_column(Text)


class EvaluationScore(TenantScoped, Base):
    __tablename__ = "evaluation_score"
    __table_args__ = (UniqueConstraint("tenant_id", "evaluation_id", "offer_line_id", "criterion_code"),)
    evaluation_id: Mapped[str] = mapped_column(String(36), ForeignKey("evaluation.id"), index=True)
    offer_line_id: Mapped[str] = mapped_column(String(36), ForeignKey("offer_line.id"))
    criterion_code: Mapped[str] = mapped_column(String(60))
    raw_value: Mapped[str | None] = mapped_column(String(60))
    score: Mapped[Decimal | None] = mapped_column(Rate())
    weight: Mapped[Decimal | None] = mapped_column(Rate())
    eligible: Mapped[bool] = mapped_column(Boolean, default=True)
    note: Mapped[str | None] = mapped_column(Text)


class AwardDecision(TenantScoped, Versioned, Base):
    """state: DRAFT|IN_REVIEW|APPROVED|SENT_TO_PROCUREMENT|RECONCILED|REJECTED."""

    __tablename__ = "award_decision"
    evaluation_id: Mapped[str] = mapped_column(String(36), ForeignKey("evaluation.id"), index=True)
    decision_version: Mapped[int] = mapped_column(Integer, default=1)
    state: Mapped[str] = mapped_column(String(30), default="DRAFT")
    rationale: Mapped[str | None] = mapped_column(Text)
    input_fingerprint: Mapped[str] = mapped_column(String(64))
    frozen_json: Mapped[dict] = mapped_column(JSON, default=dict)
    approved_by: Mapped[str | None] = mapped_column(String(120))
    approved_at: Mapped[datetime | None] = mapped_column(DateTime)
    source_award_ref: Mapped[str | None] = mapped_column(String(120))


class AwardLine(TenantScoped, Base):
    __tablename__ = "award_line"
    award_id: Mapped[str] = mapped_column(String(36), ForeignKey("award_decision.id"), index=True)
    package_line_id: Mapped[str] = mapped_column(String(36), ForeignKey("package_line.id"))
    offer_line_id: Mapped[str] = mapped_column(String(36), ForeignKey("offer_line.id"))
    option_id: Mapped[str] = mapped_column(String(36), ForeignKey("equipment_option.id"))
    supplier_id: Mapped[str] = mapped_column(String(36), ForeignKey("supplier.id"))
    selected_quantity: Mapped[Decimal] = mapped_column(Qty())


# ---------------------------------------------------------------- PO & permanent identity (FR11)


class PurchaseOrder(TenantScoped, Versioned, Base):
    """Canonical PO; GEP/Oracle/Procore numbers are aliases. state: ISSUED|AMENDED|CLOSED|CANCELLED."""

    __tablename__ = "purchase_order"
    __table_args__ = (UniqueConstraint("tenant_id", "canonical_number"),)
    canonical_number: Mapped[str] = mapped_column(String(60))
    supplier_id: Mapped[str] = mapped_column(String(36), ForeignKey("supplier.id"))
    programme_id: Mapped[str] = mapped_column(String(36), ForeignKey("programme.id"))
    award_id: Mapped[str | None] = mapped_column(String(36), ForeignKey("award_decision.id"))
    currency: Mapped[str] = mapped_column(String(3))
    state: Mapped[str] = mapped_column(String(20), default="ISSUED")
    issued_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)
    incoterms: Mapped[str | None] = mapped_column(String(20))
    supplier: Mapped[Supplier] = relationship()


class PoAlias(TenantScoped, Base):
    __tablename__ = "po_alias"
    __table_args__ = (UniqueConstraint("tenant_id", "source_system", "source_number"),)
    po_id: Mapped[str] = mapped_column(String(36), ForeignKey("purchase_order.id"), index=True)
    source_system: Mapped[str] = mapped_column(String(20))  # GEP|ORACLE|PROCORE
    source_number: Mapped[str] = mapped_column(String(80))


class PoLine(TenantScoped, Base):
    __tablename__ = "po_line"
    __table_args__ = (UniqueConstraint("tenant_id", "po_id", "line_no"),)
    po_id: Mapped[str] = mapped_column(String(36), ForeignKey("purchase_order.id"), index=True)
    line_no: Mapped[int] = mapped_column(Integer)
    item_model_id: Mapped[str] = mapped_column(String(36), ForeignKey("item_model.id"))
    option_id: Mapped[str | None] = mapped_column(String(36), ForeignKey("equipment_option.id"))
    quantity: Mapped[Decimal] = mapped_column(Qty())
    cancelled_quantity: Mapped[Decimal] = mapped_column(Qty(), default=Decimal(0))
    uom: Mapped[str] = mapped_column(String(20), default="EA")
    unit_price: Mapped[Decimal] = mapped_column(Money())
    need_by: Mapped[date | None] = mapped_column(Date)
    item_model: Mapped[ItemModel] = relationship()


class PoDistribution(TenantScoped, Base):
    """Retains the underlying DC demand inside a consolidated PO line (BKK1: 6, BKK2: 4)."""

    __tablename__ = "po_distribution"
    po_line_id: Mapped[str] = mapped_column(String(36), ForeignKey("po_line.id"), index=True)
    project_id: Mapped[str | None] = mapped_column(String(36), ForeignKey("project.id"))  # None = programme stock
    wbs_id: Mapped[str | None] = mapped_column(String(36), ForeignKey("wbs_element.id"))
    requirement_id: Mapped[str | None] = mapped_column(String(36), ForeignKey("requirement.id"))
    quantity: Mapped[Decimal] = mapped_column(Qty())


class RequirementPoAllocation(TenantScoped, Base):
    __tablename__ = "requirement_po_allocation"
    __table_args__ = (UniqueConstraint("tenant_id", "award_line_id", "po_line_id"),)
    award_line_id: Mapped[str] = mapped_column(String(36), ForeignKey("award_line.id"))
    po_line_id: Mapped[str] = mapped_column(String(36), ForeignKey("po_line.id"))
    allocated_quantity: Mapped[Decimal] = mapped_column(Qty())
    uom: Mapped[str] = mapped_column(String(20), default="EA")
    state: Mapped[str] = mapped_column(String(20), default="RECONCILED")


class PhysicalUnit(TenantScoped, Versioned, Base):
    """Permanent identity of one serialized unit (parent equipment or tracked component).

    Created at PO issue (state PLANNED); UUID never recycled. A physical replacement
    gets a new UUID linked through replaces_unit_id; a repaired serial keeps its UUID.
    """

    __tablename__ = "physical_unit"
    __table_args__ = (UniqueConstraint("tenant_id", "asset_code"),)
    asset_code: Mapped[str] = mapped_column(String(60))
    item_model_id: Mapped[str] = mapped_column(String(36), ForeignKey("item_model.id"))
    programme_id: Mapped[str | None] = mapped_column(String(36), ForeignKey("programme.id"))
    po_line_id: Mapped[str | None] = mapped_column(String(36), ForeignKey("po_line.id"), index=True)
    requirement_id: Mapped[str | None] = mapped_column(String(36), ForeignKey("requirement.id"))
    serial_number: Mapped[str | None] = mapped_column(String(80))
    barcode: Mapped[str | None] = mapped_column(String(80))
    # PLANNED|IN_TRANSIT|RECEIVED|ISSUED|INSTALLED|IN_REPAIR|RETURNED|SCRAPPED|CANCELLED|RETIRED
    state: Mapped[str] = mapped_column(String(20), default="PLANNED")
    # Physical custody (where it is) — separate from assignment (who it is for).
    custody_location_id: Mapped[str | None] = mapped_column(String(36), ForeignKey("location.id"))
    # Destination project / DC. NULL = programme stock (unallocated).
    assigned_project_id: Mapped[str | None] = mapped_column(String(36), ForeignKey("project.id"), index=True)
    assigned_wbs_id: Mapped[str | None] = mapped_column(String(36), ForeignKey("wbs_element.id"))
    # UNALLOCATED|ALLOCATED|RESERVED|ISSUED  (planning intent vs Oracle reservation vs issue)
    allocation_status: Mapped[str] = mapped_column(String(20), default="UNALLOCATED")
    installed_position: Mapped[str | None] = mapped_column(String(200))  # e.g. "Generator yard / Bay 3"
    condition: Mapped[str] = mapped_column(String(20), default="NEW")  # NEW|GOOD|REPAIRABLE|FAILED
    quality_status: Mapped[str] = mapped_column(String(20), default="NOT_TESTED")  # NOT_TESTED|ON_HOLD|PASSED|FAILED|RELEASED
    replaces_unit_id: Mapped[str | None] = mapped_column(String(36), ForeignKey("physical_unit.id"))
    is_spare: Mapped[bool] = mapped_column(Boolean, default=False)
    warranty_start: Mapped[date | None] = mapped_column(Date)
    warranty_end: Mapped[date | None] = mapped_column(Date)
    in_service_date: Mapped[date | None] = mapped_column(Date)
    oracle_serial_ref: Mapped[str | None] = mapped_column(String(80))
    planon_asset_id: Mapped[str | None] = mapped_column(String(80))
    procore_equipment_id: Mapped[str | None] = mapped_column(String(64))
    item_model: Mapped[ItemModel] = relationship()


# ---------------------------------------------------------------- inventory, allocation, receipts


class Receipt(TenantScoped, Base):
    __tablename__ = "receipt"
    __table_args__ = (UniqueConstraint("tenant_id", "receipt_ref"),)
    receipt_ref: Mapped[str] = mapped_column(String(80))
    po_id: Mapped[str] = mapped_column(String(36), ForeignKey("purchase_order.id"))
    location_id: Mapped[str] = mapped_column(String(36), ForeignKey("location.id"))
    received_at: Mapped[datetime] = mapped_column(DateTime)
    oracle_receipt_ref: Mapped[str | None] = mapped_column(String(80))
    state: Mapped[str] = mapped_column(String(20), default="PENDING")  # PENDING|CONFIRMED|REJECTED|UNKNOWN


class ReceiptLine(TenantScoped, Base):
    __tablename__ = "receipt_line"
    __table_args__ = (UniqueConstraint("tenant_id", "unit_id"),)  # a unit is received once (T12)
    receipt_id: Mapped[str] = mapped_column(String(36), ForeignKey("receipt.id"), index=True)
    po_line_id: Mapped[str] = mapped_column(String(36), ForeignKey("po_line.id"))
    unit_id: Mapped[str] = mapped_column(String(36), ForeignKey("physical_unit.id"))
    serial_number: Mapped[str] = mapped_column(String(80))
    condition: Mapped[str] = mapped_column(String(20), default="GOOD")


class AllocationRecord(TenantScoped, Versioned, Base):
    """Allocation history. kind separates the three distinct actions (spec: hub intent ≠ Oracle
    reservation ≠ Oracle project transfer). state: PENDING|CONFIRMED|RELEASED|REJECTED|SUPERSEDED."""

    __tablename__ = "allocation_record"
    __table_args__ = (
        # A unit has at most one live allocation; reallocation supersedes the prior record first.
        Index(
            "uq_allocation_active_unit",
            "unit_id",
            unique=True,
            sqlite_where=text("state IN ('PENDING', 'CONFIRMED')"),
            mssql_where=text("state IN ('PENDING', 'CONFIRMED')"),
            postgresql_where=text("state IN ('PENDING', 'CONFIRMED')"),
        ),
    )
    unit_id: Mapped[str] = mapped_column(String(36), ForeignKey("physical_unit.id"), index=True)
    kind: Mapped[str] = mapped_column(String(30))  # PLANNING_INTENT|ORACLE_RESERVATION|PROJECT_TRANSFER
    from_project_id: Mapped[str | None] = mapped_column(String(36), ForeignKey("project.id"))
    to_project_id: Mapped[str | None] = mapped_column(String(36), ForeignKey("project.id"))
    to_wbs_id: Mapped[str | None] = mapped_column(String(36), ForeignKey("wbs_element.id"))
    state: Mapped[str] = mapped_column(String(20), default="PENDING")
    reason: Mapped[str | None] = mapped_column(Text)
    requested_by: Mapped[str | None] = mapped_column(String(120))
    approved_by: Mapped[str | None] = mapped_column(String(120))
    effective_from: Mapped[datetime | None] = mapped_column(DateTime)
    effective_to: Mapped[datetime | None] = mapped_column(DateTime)
    oracle_ref: Mapped[str | None] = mapped_column(String(80))
    generates_project_charge: Mapped[bool] = mapped_column(Boolean, default=False)


class StockTransaction(TenantScoped, Base):
    """Inventory movement confirmed by the stock authority (Oracle). state: PENDING|CONFIRMED|REJECTED|UNKNOWN."""

    __tablename__ = "stock_transaction"
    __table_args__ = (UniqueConstraint("tenant_id", "request_ref"),)
    request_ref: Mapped[str] = mapped_column(String(80))
    unit_id: Mapped[str] = mapped_column(String(36), ForeignKey("physical_unit.id"), index=True)
    txn_type: Mapped[str] = mapped_column(String(30))  # RECEIPT|ISSUE|SUBINVENTORY_TRANSFER|PROJECT_TRANSFER|RETURN_TO_SUPPLIER|COMPONENT_REMOVAL
    from_location_id: Mapped[str | None] = mapped_column(String(36), ForeignKey("location.id"))
    to_location_id: Mapped[str | None] = mapped_column(String(36), ForeignKey("location.id"))
    from_project_id: Mapped[str | None] = mapped_column(String(36), ForeignKey("project.id"))
    to_project_id: Mapped[str | None] = mapped_column(String(36), ForeignKey("project.id"))
    quantity: Mapped[Decimal] = mapped_column(Qty(), default=Decimal(1))
    state: Mapped[str] = mapped_column(String(20), default="PENDING")
    oracle_txn_id: Mapped[str | None] = mapped_column(String(80))
    message: Mapped[str | None] = mapped_column(Text)
    confirmed_at: Mapped[datetime | None] = mapped_column(DateTime)


class TransferManifest(TenantScoped, Versioned, Base):
    """Frozen group transfer (FR14). state: DRAFT|APPROVED|IN_TRANSIT|PARTIALLY_RECEIVED|RECEIVED|INVALIDATED."""

    __tablename__ = "transfer_manifest"
    code: Mapped[str] = mapped_column(String(60))
    from_location_id: Mapped[str] = mapped_column(String(36), ForeignKey("location.id"))
    to_location_id: Mapped[str] = mapped_column(String(36), ForeignKey("location.id"))
    to_project_id: Mapped[str | None] = mapped_column(String(36), ForeignKey("project.id"))
    state: Mapped[str] = mapped_column(String(30), default="DRAFT")
    unit_ids: Mapped[list] = mapped_column(JSON, default=list)  # deduplicated frozen members incl. descendants
    structure_hash: Mapped[str | None] = mapped_column(String(64))
    received_unit_ids: Mapped[list] = mapped_column(JSON, default=list)
    approved_by: Mapped[str | None] = mapped_column(String(120))


# ---------------------------------------------------------------- physical structure (FR13)


class UnitComponent(TenantScoped, Base):
    """Temporal parent/slot link. valid_to NULL = currently fitted. No overlaps per child or per slot."""

    __tablename__ = "unit_component"
    __table_args__ = (
        # Backstop for concurrent fits; historical overlaps are checked in app.services.structure.
        Index(
            "uq_unit_component_open_child",
            "child_unit_id",
            unique=True,
            sqlite_where=text("valid_to IS NULL"),
            mssql_where=text("valid_to IS NULL"),
            postgresql_where=text("valid_to IS NULL"),
        ),
        Index(
            "uq_unit_component_open_slot",
            "parent_unit_id",
            "slot_code",
            unique=True,
            sqlite_where=text("valid_to IS NULL"),
            mssql_where=text("valid_to IS NULL"),
            postgresql_where=text("valid_to IS NULL"),
        ),
    )
    parent_unit_id: Mapped[str] = mapped_column(String(36), ForeignKey("physical_unit.id"), index=True)
    child_unit_id: Mapped[str] = mapped_column(String(36), ForeignKey("physical_unit.id"), index=True)
    slot_code: Mapped[str] = mapped_column(String(60))
    valid_from: Mapped[datetime] = mapped_column(DateTime)
    valid_to: Mapped[datetime | None] = mapped_column(DateTime)
    install_reason: Mapped[str | None] = mapped_column(String(200))
    removal_reason: Mapped[str | None] = mapped_column(String(200))
    work_order_ref: Mapped[str | None] = mapped_column(String(80))
    recovery_case_id: Mapped[str | None] = mapped_column(String(36), ForeignKey("recovery_case.id"))


# ---------------------------------------------------------------- quality: FAT / NCR / recovery


class TestRecord(TenantScoped, Base):
    __tablename__ = "test_record"
    __test__ = False  # keep pytest from collecting this model
    unit_id: Mapped[str] = mapped_column(String(36), ForeignKey("physical_unit.id"), index=True)
    component_unit_id: Mapped[str | None] = mapped_column(String(36), ForeignKey("physical_unit.id"))
    test_type: Mapped[str] = mapped_column(String(20))  # FAT|SAT|COMMISSIONING|RETEST
    test_ref: Mapped[str] = mapped_column(String(80))
    procedure_ref: Mapped[str | None] = mapped_column(String(80))
    result: Mapped[str] = mapped_column(String(10))  # PASS|FAIL
    measurement: Mapped[str | None] = mapped_column(Text)
    stage: Mapped[str] = mapped_column(String(30), default="SUPPLIER_FACTORY")  # SUPPLIER_FACTORY|POST_RECEIPT|SITE
    performed_at: Mapped[datetime] = mapped_column(DateTime)
    witnessed_by: Mapped[str | None] = mapped_column(String(120))
    approved_by: Mapped[str | None] = mapped_column(String(120))
    evidence_ref: Mapped[str | None] = mapped_column(String(200))
    recovery_case_id: Mapped[str | None] = mapped_column(String(36), ForeignKey("recovery_case.id"))


class RecoveryCase(TenantScoped, Versioned, Base):
    """NCR + disposition + recovery. route: REPAIR_AND_WAIT|REPLACE_FROM_SPARE|TAKE_FROM_DONOR.
    state: OPEN|DISPOSITIONED|COMPONENT_REMOVED|REPLACEMENT_FITTED|RETEST_REQUIRED|RELEASED|CLOSED."""

    __tablename__ = "recovery_case"
    __table_args__ = (UniqueConstraint("tenant_id", "ncr_number"),)
    ncr_number: Mapped[str] = mapped_column(String(60))
    parent_unit_id: Mapped[str] = mapped_column(String(36), ForeignKey("physical_unit.id"), index=True)
    failed_component_id: Mapped[str | None] = mapped_column(String(36), ForeignKey("physical_unit.id"))
    slot_code: Mapped[str | None] = mapped_column(String(60))
    failed_test_id: Mapped[str | None] = mapped_column(String(36))
    failure_stage: Mapped[str] = mapped_column(String(30))  # SUPPLIER_FACTORY|POST_RECEIPT|SITE
    description: Mapped[str] = mapped_column(Text)
    state: Mapped[str] = mapped_column(String(30), default="OPEN")
    route: Mapped[str | None] = mapped_column(String(30))
    donor_unit_id: Mapped[str | None] = mapped_column(String(36), ForeignKey("physical_unit.id"))
    replacement_unit_id: Mapped[str | None] = mapped_column(String(36), ForeignKey("physical_unit.id"))
    supplier_return_ref: Mapped[str | None] = mapped_column(String(80))
    responsible_party: Mapped[str | None] = mapped_column(String(120))
    expected_completion: Mapped[date | None] = mapped_column(Date)
    replacement_eta: Mapped[date | None] = mapped_column(Date)
    impacts_json: Mapped[list] = mapped_column(JSON, default=list)  # [{project_id, unit_id, impact, eta}]
    recovery_cost: Mapped[Decimal | None] = mapped_column(Money())
    currency: Mapped[str | None] = mapped_column(String(3))
    disposition_by: Mapped[str | None] = mapped_column(String(120))
    released_by: Mapped[str | None] = mapped_column(String(120))
    released_at: Mapped[datetime | None] = mapped_column(DateTime)


# ---------------------------------------------------------------- logistics & arrival (FR12)


class Shipment(TenantScoped, Versioned, Base):
    __tablename__ = "shipment"
    __table_args__ = (UniqueConstraint("tenant_id", "code"),)
    code: Mapped[str] = mapped_column(String(60))
    po_id: Mapped[str] = mapped_column(String(36), ForeignKey("purchase_order.id"), index=True)
    carrier: Mapped[str | None] = mapped_column(String(120))
    mode: Mapped[str] = mapped_column(String(10), default="SEA")  # SEA|AIR|ROAD
    container_ref: Mapped[str | None] = mapped_column(String(60))
    bol_awb: Mapped[str | None] = mapped_column(String(60))
    origin: Mapped[str | None] = mapped_column(String(120))
    destination_location_id: Mapped[str | None] = mapped_column(String(36), ForeignKey("location.id"))
    unit_ids: Mapped[list] = mapped_column(JSON, default=list)
    state: Mapped[str] = mapped_column(String(20), default="PLANNED")  # PLANNED|IN_TRANSIT|DELIVERED
    last_tracked_at: Mapped[datetime | None] = mapped_column(DateTime)


class ShipmentMilestone(TenantScoped, Base):
    """Source milestone with bitemporal stamps: event_time (when it happened) vs recorded_at (when we knew)."""

    __tablename__ = "shipment_milestone"
    shipment_id: Mapped[str] = mapped_column(String(36), ForeignKey("shipment.id"), index=True)
    code: Mapped[str] = mapped_column(String(30))  # DISPATCHED|DEPARTED_PORT|ARRIVED_PORT|CUSTOMS_CLEARED|SITE_DELIVERED
    planned_at: Mapped[datetime | None] = mapped_column(DateTime)
    estimated_at: Mapped[datetime | None] = mapped_column(DateTime)
    actual_at: Mapped[datetime | None] = mapped_column(DateTime)
    recorded_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)
    source: Mapped[str] = mapped_column(String(40), default="MANUAL")
    source_event_id: Mapped[str | None] = mapped_column(String(80))


class ArrivalSnapshot(TenantScoped, Base):
    """Immutable as-known-at forecast of site delivery per unit."""

    __tablename__ = "arrival_snapshot"
    unit_id: Mapped[str] = mapped_column(String(36), ForeignKey("physical_unit.id"), index=True)
    shipment_id: Mapped[str | None] = mapped_column(String(36), ForeignKey("shipment.id"))
    recorded_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)
    evidence_cutoff: Mapped[datetime] = mapped_column(DateTime)
    model_version: Mapped[str] = mapped_column(String(40), default="arrival-tri-v1")
    eta_p50: Mapped[date | None] = mapped_column(Date)
    earliest: Mapped[date | None] = mapped_column(Date)
    latest: Mapped[date | None] = mapped_column(Date)
    quality: Mapped[str] = mapped_column(String(20))  # GOOD|SPARSE|UNKNOWN
    unknown_reason: Mapped[str | None] = mapped_column(Text)


# ---------------------------------------------------------------- handbook (FR15, FR16)


class HandbookTemplate(TenantScoped, Base):
    __tablename__ = "handbook_template"
    __table_args__ = (UniqueConstraint("tenant_id", "template_code", "revision_no", "recipient_role"),)
    equipment_class_id: Mapped[str] = mapped_column(String(36), ForeignKey("equipment_class.id"))
    template_code: Mapped[str] = mapped_column(String(60))
    revision_no: Mapped[int] = mapped_column(Integer, default=1)
    name: Mapped[str] = mapped_column(String(200))
    recipient_role: Mapped[str] = mapped_column(String(40), default="FM")
    state: Mapped[str] = mapped_column(String(20), default="APPROVED")


class HandbookCriterion(TenantScoped, Base):
    """kind: FIELD|DOCUMENT|TEST|STRUCTURE. rule_json e.g. {"doc_type":"OM_MANUAL","require_approved":true}."""

    __tablename__ = "handbook_criterion"
    __table_args__ = (UniqueConstraint("tenant_id", "template_id", "criterion_code"),)
    template_id: Mapped[str] = mapped_column(String(36), ForeignKey("handbook_template.id"), index=True)
    criterion_code: Mapped[str] = mapped_column(String(60))
    title: Mapped[str] = mapped_column(String(200))
    section: Mapped[str] = mapped_column(String(60))
    kind: Mapped[str] = mapped_column(String(20))
    mandatory: Mapped[bool] = mapped_column(Boolean, default=True)
    critical: Mapped[bool] = mapped_column(Boolean, default=False)
    rule_json: Mapped[dict] = mapped_column(JSON, default=dict)
    responsible_role: Mapped[str] = mapped_column(String(40))
    commercial: Mapped[bool] = mapped_column(Boolean, default=False)  # restricted annex


class EvidenceDocument(TenantScoped, Base):
    __tablename__ = "evidence_document"
    unit_id: Mapped[str] = mapped_column(String(36), ForeignKey("physical_unit.id"), index=True)
    doc_type: Mapped[str] = mapped_column(String(40))  # OM_MANUAL|FAT_REPORT|WARRANTY|CERTIFICATE|DRAWING
    title: Mapped[str] = mapped_column(String(300))
    revision: Mapped[str] = mapped_column(String(20), default="A")
    model_ref: Mapped[str | None] = mapped_column(String(120))
    serial_ref: Mapped[str | None] = mapped_column(String(80))
    approved: Mapped[bool] = mapped_column(Boolean, default=False)
    approved_by: Mapped[str | None] = mapped_column(String(120))
    expires_at: Mapped[date | None] = mapped_column(Date)
    content_hash: Mapped[str] = mapped_column(String(64))
    storage_ref: Mapped[str | None] = mapped_column(String(300))
    procore_document_id: Mapped[str | None] = mapped_column(String(64))
    commercial: Mapped[bool] = mapped_column(Boolean, default=False)


class HandbookPackage(TenantScoped, Versioned, Base):
    """state: DRAFT|VALIDATING|READY|BLOCKED|APPROVED|PUBLISHED. Published = immutable (package_hash)."""

    __tablename__ = "handbook_package"
    __table_args__ = (UniqueConstraint("tenant_id", "unit_id", "version_no"),)
    unit_id: Mapped[str] = mapped_column(String(36), ForeignKey("physical_unit.id"), index=True)
    template_id: Mapped[str] = mapped_column(String(36), ForeignKey("handbook_template.id"))
    version_no: Mapped[int] = mapped_column(Integer, default=1)
    state: Mapped[str] = mapped_column(String(20), default="DRAFT")
    evidence_cutoff: Mapped[datetime | None] = mapped_column(DateTime)
    manifest_json: Mapped[dict] = mapped_column(JSON, default=dict)
    package_hash: Mapped[str | None] = mapped_column(String(64))
    approved_by: Mapped[str | None] = mapped_column(String(120))
    published_at: Mapped[datetime | None] = mapped_column(DateTime)
    acceptance_state: Mapped[str] = mapped_column(String(20), default="NOT_SUBMITTED")  # NOT_SUBMITTED|PENDING|ACCEPTED|CONDITIONAL|REJECTED
    acceptance_notes: Mapped[str | None] = mapped_column(Text)
    accepted_by: Mapped[str | None] = mapped_column(String(120))


class HandbookEntry(TenantScoped, Versioned, Base):
    """validation: PASS|FAIL|MISSING|WAIVED|PENDING."""

    __tablename__ = "handbook_entry"
    __table_args__ = (UniqueConstraint("tenant_id", "package_id", "criterion_id"),)
    package_id: Mapped[str] = mapped_column(String(36), ForeignKey("handbook_package.id"), index=True)
    criterion_id: Mapped[str] = mapped_column(String(36), ForeignKey("handbook_criterion.id"))
    source_ref: Mapped[str | None] = mapped_column(String(200))
    source_revision: Mapped[str | None] = mapped_column(String(40))
    content_hash: Mapped[str | None] = mapped_column(String(64))
    validation: Mapped[str] = mapped_column(String(20), default="PENDING")
    message: Mapped[str | None] = mapped_column(Text)
    owner_role: Mapped[str | None] = mapped_column(String(40))
    due_date: Mapped[date | None] = mapped_column(Date)
    waiver_reason: Mapped[str | None] = mapped_column(Text)
    waiver_by: Mapped[str | None] = mapped_column(String(120))
    waiver_expires_at: Mapped[date | None] = mapped_column(Date)


# ---------------------------------------------------------------- cost, TCO, FM (FR17, §22)


class CostEvent(TenantScoped, Base):
    """Economic cost revision. Provisional receipt cost is superseded by final invoice (T18).
    status: PROVISIONAL|ACTUAL|SUPERSEDED|REVERSED."""

    __tablename__ = "cost_event"
    economic_key: Mapped[str] = mapped_column(String(120), index=True)  # stable across revisions
    revision_no: Mapped[int] = mapped_column(Integer, default=1)
    supersedes_id: Mapped[str | None] = mapped_column(String(36), ForeignKey("cost_event.id"))
    unit_id: Mapped[str | None] = mapped_column(String(36), ForeignKey("physical_unit.id"), index=True)
    po_line_id: Mapped[str | None] = mapped_column(String(36), ForeignKey("po_line.id"))
    posting_project_id: Mapped[str | None] = mapped_column(String(36), ForeignKey("project.id"))
    # PURCHASE|ANCILLARY|INSTALLATION|CONSULTANT|COMMISSIONING|SERVICE|REPLACEMENT|DISPOSAL|RECOVERY|TRANSFER|REPAIR
    category: Mapped[str] = mapped_column(String(30))
    status: Mapped[str] = mapped_column(String(20))
    amount: Mapped[Decimal] = mapped_column(Money())
    currency: Mapped[str] = mapped_column(String(3))
    source_system: Mapped[str] = mapped_column(String(20))  # ORACLE|PLANON|PROCORE|MANUAL
    source_ref: Mapped[str] = mapped_column(String(120))
    occurred_on: Mapped[date] = mapped_column(Date)
    service_from: Mapped[date | None] = mapped_column(Date)
    service_to: Mapped[date | None] = mapped_column(Date)


class CostAllocation(TenantScoped, Base):
    """Exactly-summing partition of a cost event. unit_id NULL + unallocated=True = explicit unallocated leaf."""

    __tablename__ = "cost_allocation"
    cost_event_id: Mapped[str] = mapped_column(String(36), ForeignKey("cost_event.id"), index=True)
    unit_id: Mapped[str | None] = mapped_column(String(36), ForeignKey("physical_unit.id"), index=True)
    attributed_project_id: Mapped[str | None] = mapped_column(String(36), ForeignKey("project.id"))
    amount: Mapped[Decimal] = mapped_column(Money())
    basis: Mapped[str] = mapped_column(String(60))
    unallocated: Mapped[bool] = mapped_column(Boolean, default=False)
    reason: Mapped[str | None] = mapped_column(Text)
    period_from: Mapped[date | None] = mapped_column(Date)
    period_to: Mapped[date | None] = mapped_column(Date)


class TcoScenario(TenantScoped, Base):
    """Deterministic lifecycle scenario. lines: [{"year":0,"category":"PURCHASE","amount":"1000","kind":"ACTUAL|FORECAST|ASSUMPTION"}]."""

    __tablename__ = "tco_scenario"
    name: Mapped[str] = mapped_column(String(200))
    subject_type: Mapped[str] = mapped_column(String(40))  # OFFER_LINE|UNIT|REUSE|OPTION
    subject_id: Mapped[str | None] = mapped_column(String(36))
    currency: Mapped[str] = mapped_column(String(3))
    horizon_years: Mapped[int] = mapped_column(Integer)
    discount_rate: Mapped[Decimal] = mapped_column(Rate())
    timing: Mapped[str] = mapped_column(String(20), default="END_OF_YEAR")
    lines: Mapped[list] = mapped_column(JSON, default=list)
    undiscounted_total: Mapped[Decimal] = mapped_column(Money())
    present_value: Mapped[Decimal] = mapped_column(Money())
    is_illustrative: Mapped[bool] = mapped_column(Boolean, default=False)


class FmWorkOrder(TenantScoped, Base):
    """Imported FM/EAM (Planon) service record with invoice distribution. state: RESOLVED|UNRESOLVED."""

    __tablename__ = "fm_work_order"
    __table_args__ = (UniqueConstraint("tenant_id", "source_system", "work_order_ref", "invoice_ref"),)
    source_system: Mapped[str] = mapped_column(String(20), default="PLANON")
    work_order_ref: Mapped[str] = mapped_column(String(80))
    invoice_ref: Mapped[str] = mapped_column(String(80))
    planon_asset_id: Mapped[str | None] = mapped_column(String(80))
    parent_unit_id: Mapped[str | None] = mapped_column(String(36), ForeignKey("physical_unit.id"))
    slot_code: Mapped[str | None] = mapped_column(String(60))
    service_from: Mapped[date] = mapped_column(Date)
    service_to: Mapped[date] = mapped_column(Date)
    description: Mapped[str] = mapped_column(Text)
    amount: Mapped[Decimal] = mapped_column(Money())
    currency: Mapped[str] = mapped_column(String(3))
    posting_project_id: Mapped[str | None] = mapped_column(String(36), ForeignKey("project.id"))
    resolved_unit_id: Mapped[str | None] = mapped_column(String(36), ForeignKey("physical_unit.id"))
    cost_event_id: Mapped[str | None] = mapped_column(String(36), ForeignKey("cost_event.id"))
    state: Mapped[str] = mapped_column(String(20), default="UNRESOLVED")
    resolution_note: Mapped[str | None] = mapped_column(Text)


# ---------------------------------------------------------------- integration platform (B08)


class ProcoreConnection(TenantScoped, Versioned, Base):
    """One Procore company connection per tenant. Tokens are encrypted at rest (app.core.crypto)."""

    __tablename__ = "procore_connection"
    __table_args__ = (UniqueConstraint("tenant_id", "company_id"),)
    environment: Mapped[str] = mapped_column(String(20))  # SIMULATED|SANDBOX|PRODUCTION
    company_id: Mapped[str] = mapped_column(String(64))
    company_name: Mapped[str | None] = mapped_column(String(200))
    auth_mode: Mapped[str] = mapped_column(String(30), default="AUTHORIZATION_CODE")  # AUTHORIZATION_CODE|CLIENT_CREDENTIALS
    access_token_enc: Mapped[str | None] = mapped_column(Text)
    refresh_token_enc: Mapped[str | None] = mapped_column(Text)
    token_expires_at: Mapped[datetime | None] = mapped_column(DateTime)
    state: Mapped[str] = mapped_column(String(20), default="DISCONNECTED")  # CONNECTED|DISCONNECTED|REVOKED|ERROR
    last_sync_at: Mapped[datetime | None] = mapped_column(DateTime)
    last_error: Mapped[str | None] = mapped_column(Text)
    webhook_hook_id: Mapped[str | None] = mapped_column(String(64))


class ExternalObjectLink(TenantScoped, Versioned, Base):
    """Crosswalk between a domain record and an external object (spec §27)."""

    __tablename__ = "external_object_link"
    __table_args__ = (
        UniqueConstraint("tenant_id", "platform", "company_key", "object_type", "object_key", "link_role"),
    )
    platform: Mapped[str] = mapped_column(String(20))  # PROCORE|ORACLE|GEP|PLANON
    company_key: Mapped[str] = mapped_column(String(64), default="")
    project_key: Mapped[str | None] = mapped_column(String(64))
    object_type: Mapped[str] = mapped_column(String(60))  # project|vendor|purchase_order_contract|cost_code|document|equipment
    object_key: Mapped[str] = mapped_column(String(80))
    domain_type: Mapped[str] = mapped_column(String(60))
    domain_id: Mapped[str] = mapped_column(String(36), index=True)
    link_role: Mapped[str] = mapped_column(String(30), default="PRIMARY")
    source_revision: Mapped[str | None] = mapped_column(String(80))
    sync_state: Mapped[str] = mapped_column(String(20), default="LINKED")  # LINKED|PENDING|APPLIED|REJECTED|NEEDS_REVIEW
    last_synced_at: Mapped[datetime | None] = mapped_column(DateTime)


class OutboxMessage(TenantScoped, Base):
    """Durable outbound message written in the same transaction as the domain change.
    state: PENDING|ACKNOWLEDGED|REJECTED|UNKNOWN|DEAD. UNKNOWN must be reconciled before replay (T27)."""

    __tablename__ = "outbox_message"
    __table_args__ = (UniqueConstraint("tenant_id", "dedup_key"),)
    target: Mapped[str] = mapped_column(String(20), index=True)  # ORACLE|PLANON|PROCORE|INTERNAL
    event_type: Mapped[str] = mapped_column(String(80))
    aggregate_type: Mapped[str] = mapped_column(String(60))
    aggregate_id: Mapped[str] = mapped_column(String(36))
    aggregate_version: Mapped[int | None] = mapped_column(Integer)
    dedup_key: Mapped[str] = mapped_column(String(160))
    payload: Mapped[dict] = mapped_column(JSON, default=dict)
    state: Mapped[str] = mapped_column(String(20), default="PENDING", index=True)
    attempts: Mapped[int] = mapped_column(Integer, default=0)
    next_attempt_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)
    last_error: Mapped[str | None] = mapped_column(Text)
    external_ref: Mapped[str | None] = mapped_column(String(120))
    correlation_id: Mapped[str | None] = mapped_column(String(64))
    processed_at: Mapped[datetime | None] = mapped_column(DateTime)


class InboxMessage(TenantScoped, Base):
    """Deduplicated inbound event (webhook or poll). Same source event processed once."""

    __tablename__ = "inbox_message"
    __table_args__ = (UniqueConstraint("tenant_id", "source", "source_event_id"),)
    source: Mapped[str] = mapped_column(String(20))
    source_event_id: Mapped[str] = mapped_column(String(120))
    event_type: Mapped[str] = mapped_column(String(80))
    payload_hash: Mapped[str] = mapped_column(String(64))
    payload: Mapped[dict] = mapped_column(JSON, default=dict)
    state: Mapped[str] = mapped_column(String(20), default="RECEIVED")  # RECEIVED|PROCESSED|FAILED|IGNORED
    error: Mapped[str | None] = mapped_column(Text)
    processed_at: Mapped[datetime | None] = mapped_column(DateTime)


class IntegrationException(TenantScoped, Versioned, Base):
    __tablename__ = "integration_exception"
    source: Mapped[str] = mapped_column(String(20))
    kind: Mapped[str] = mapped_column(String(60))  # MAPPING|REJECTED|UNKNOWN_ACK|RECONCILIATION|VALIDATION
    subject_type: Mapped[str | None] = mapped_column(String(60))
    subject_id: Mapped[str | None] = mapped_column(String(36))
    message: Mapped[str] = mapped_column(Text)
    owner_role: Mapped[str] = mapped_column(String(40), default="INTEGRATION")
    state: Mapped[str] = mapped_column(String(20), default="OPEN")
    resolution: Mapped[str | None] = mapped_column(Text)


class IdempotencyRecord(Base):
    __tablename__ = "idempotency_record"
    __table_args__ = (UniqueConstraint("tenant_id", "principal", "route", "key"),)
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    tenant_id: Mapped[str] = mapped_column(String(36))
    principal: Mapped[str] = mapped_column(String(120))
    route: Mapped[str] = mapped_column(String(200))
    key: Mapped[str] = mapped_column(String(120))
    request_hash: Mapped[str] = mapped_column(String(64))
    status_code: Mapped[int] = mapped_column(Integer)
    response: Mapped[dict | list | None] = mapped_column(JSON)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)


class AuditEvent(Base):
    """Append-only audit trail."""

    __tablename__ = "audit_event"
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    tenant_id: Mapped[str] = mapped_column(String(36), index=True)
    at: Mapped[datetime] = mapped_column(DateTime, default=utcnow, index=True)
    actor: Mapped[str] = mapped_column(String(120))
    actor_roles: Mapped[str | None] = mapped_column(String(400))
    action: Mapped[str] = mapped_column(String(80))
    subject_type: Mapped[str] = mapped_column(String(60))
    subject_id: Mapped[str] = mapped_column(String(36), index=True)
    before: Mapped[dict | None] = mapped_column(JSON)
    after: Mapped[dict | None] = mapped_column(JSON)
    reason: Mapped[str | None] = mapped_column(Text)
    correlation_id: Mapped[str | None] = mapped_column(String(64))
