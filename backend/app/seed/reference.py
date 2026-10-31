"""Reference/master data: tenant, users, programme BKK, places, suppliers, LLE catalogue, BOMs,
handbook templates and historical benchmark evidence. Fictional suppliers and figures."""

from datetime import date
from decimal import Decimal as D
from functools import lru_cache

from sqlalchemy.orm import Session

from app.config import get_settings
from app.core.auth import hash_password
from app.models import (
    BenchmarkObservation,
    BomLine,
    CompatibleSpare,
    EquipmentClass,
    EquipmentOption,
    HandbookCriterion,
    HandbookTemplate,
    ItemModel,
    Location,
    Programme,
    Project,
    Supplier,
    Tenant,
    User,
    WbsElement,
)

SEED_ACTOR = "seed"

# (category, name, typical LLE status, typical lead time days). Codes are explicit where scenarios reference them.
LLE_MASTER = [
    ("Utility and substations", "HV power transformers", "Core LLE where in scope", 420, "TRX-HV"),
    ("Utility and substations", "MV distribution transformers", "Core LLE", 300, "TRX-MV"),
    ("Utility and substations", "HV switchgear / gas-insulated switchgear (GIS)", "Core LLE where in scope", 400, "SWG-HV"),
    ("Utility and substations", "MV switchgear and ring main units (RMUs)", "Core LLE", 280, "SWG-MV"),
    ("Utility and substations", "Packaged substations / electrical houses", "Core LLE", 360, "SUB-PKG"),
    ("Standby generation", "Diesel generator sets", "Core LLE", 365, "GEN"),
    ("Standby generation", "Gas generator sets / alternative generation packages", "Design-dependent", 400, "GEN-GAS"),
    ("Standby generation", "Generator paralleling and synchronisation switchgear", "Core LLE", 300, "GEN-PAR"),
    ("Standby generation", "Remote radiator / generator cooling packages", "Package-dependent", 220, "GEN-RAD"),
    ("Standby generation", "Bulk fuel tanks, transfer and polishing skids", "Project-dependent", 180, "FUEL"),
    ("Standby generation", "Exhaust and emissions treatment packages", "Project-dependent", 200, "EXH"),
    ("Critical power", "Static UPS systems", "Core LLE", 240, "UPS"),
    ("Critical power", "Rotary UPS / diesel rotary UPS", "Design-dependent", 420, "UPS-ROT"),
    ("Critical power", "UPS battery banks, cabinets and racks", "Core LLE", 200, "UPS-BAT"),
    ("Critical power", "Battery energy storage systems (BESS)", "Design-dependent", 300, "BESS"),
    ("Critical power", "Automatic transfer switches (ATS)", "Project-dependent", 150, "ATS"),
    ("Critical power", "Static transfer switches (STS)", "Project-dependent", 150, "STS"),
    ("Electrical distribution", "LV main switchboards / switchgear", "Core LLE", 220, "SWG-LV"),
    ("Electrical distribution", "Power distribution units (PDUs)", "Project-dependent", 120, "PDU"),
    ("Electrical distribution", "Remote power panels (RPPs)", "Project-dependent", 100, "RPP"),
    ("Electrical distribution", "Busduct / busway systems and tap-off units", "Project-dependent", 140, "BUS"),
    ("Electrical distribution", "Motor control centres (MCCs)", "Project-dependent", 160, "MCC"),
    ("Electrical distribution", "Large variable-frequency drive (VFD) panels", "Project-dependent", 140, "VFD"),
    ("Electrical distribution", "Harmonic filters / power-factor correction systems", "Design-dependent", 120, "HFP"),
    ("Electrical distribution", "Specialised MV/LV cable packages", "Project-dependent", 120, "CBL"),
    ("Central cooling plant", "Air-cooled chillers", "Core LLE", 300, "CHL-AC"),
    ("Central cooling plant", "Water-cooled chillers", "Core LLE", 320, "CHL-WC"),
    ("Central cooling plant", "Cooling towers", "Core LLE where applicable", 240, "CT"),
    ("Central cooling plant", "Dry coolers / adiabatic coolers", "Design-dependent", 200, "DRY"),
    ("Central cooling plant", "Large chilled-water / condenser-water pump skids", "Project-dependent", 160, "PMP"),
    ("Central cooling plant", "Heat exchanger packages", "Project-dependent", 150, "HEX"),
    ("Central cooling plant", "Thermal energy storage tanks", "Design-dependent", 220, "TES"),
    ("Data hall cooling", "Computer room air handling units (CRAHs)", "Core LLE", 180, "CRAH"),
    ("Data hall cooling", "Computer room air conditioning units (CRACs)", "Core LLE", 180, "CRAC"),
    ("Data hall cooling", "Fan wall / air handling unit packages", "Design-dependent", 200, "FWL"),
    ("Data hall cooling", "In-row cooling units", "Design-dependent", 120, "IRC"),
    ("Data hall cooling", "Packaged indirect evaporative / free-cooling units", "Design-dependent", 240, "IEC"),
    ("Liquid cooling", "Coolant distribution units (CDUs)", "Core LLE where applicable", 160, "CDU"),
    ("Liquid cooling", "Liquid-to-liquid / liquid-to-air cooling packages", "Design-dependent", 160, "LLC"),
    ("Liquid cooling", "Rear-door heat exchangers", "Design-dependent", 120, "RDHX"),
    ("Liquid cooling", "Rack manifolds and coolant distribution assemblies", "Project-dependent", 100, "MAN"),
    ("Water and mechanical support", "Water treatment / filtration skids", "Project-dependent", 120, "WTR"),
    ("Water and mechanical support", "Pressurisation and expansion packages", "Project-dependent", 90, "PRS"),
    ("Water and mechanical support", "Large water storage tanks", "Project-dependent", 120, "TNK"),
    ("Water and mechanical support", "Specialised valve and actuator packages", "Project-dependent", 120, "VLV"),
    ("Fire and life safety", "Fire pump packages", "Project-dependent", 150, "FPP"),
    ("Fire and life safety", "Clean-agent / inert-gas suppression packages", "Project-dependent", 120, "SUP"),
    ("Fire and life safety", "Pre-action sprinkler valve skids", "Project-dependent", 100, "PAV"),
    ("Controls and monitoring", "Building management system (BMS) control panels", "Project-dependent", 100, "BMS"),
    ("Controls and monitoring", "Electrical power monitoring system (EPMS) panels", "Project-dependent", 100, "EPMS"),
    ("Controls and monitoring", "PLC / SCADA control packages", "Project-dependent", 120, "PLC"),
    ("Modular infrastructure", "Prefabricated power modules / electrical skids", "Core LLE where applicable", 300, "MOD-PWR"),
    ("Modular infrastructure", "Prefabricated cooling modules", "Core LLE where applicable", 300, "MOD-COOL"),
    ("Modular infrastructure", "Integrated modular data halls / containerised DCs", "Core LLE where applicable", 360, "MOD-DH"),
    ("White-space infrastructure", "Custom racks, containment and integrated rack packages", "Project-dependent", 90, "RACK"),
]

COMPONENT_CLASSES = [
    ("CMP-ENGINE", "Generator component", "Diesel engine"),
    ("CMP-ALT", "Generator component", "Alternator"),
    ("CMP-CTRL", "Control component", "Controller / control panel"),
    ("CMP-RAD", "Generator component", "Cooling system / radiator"),
    ("CMP-BATT", "Generator component", "Starting system and batteries"),
    ("CMP-BRK", "Electrical component", "Output / air circuit breaker"),
    ("CMP-FIP", "Generator component", "Fuel injection pump"),
    ("CMP-TURBO", "Generator component", "Turbocharger"),
    ("CMP-COMP", "Chiller component", "Compressor assembly"),
    ("CMP-DRIVE", "Chiller component", "Compressor motor / drive"),
    ("CMP-EVAP", "Chiller component", "Evaporator"),
    ("CMP-COND", "Chiller component", "Condenser"),
    ("CMP-EXV", "Chiller component", "Expansion valve"),
    ("CMP-FAN", "Chiller component", "Condenser fans and fan motors"),
]

SUPPLIERS = [
    ("MERIDIAN", "Meridian Gensets Ltd", "United Kingdom"),
    ("NORTHWIND", "Northwind Power Systems", "United States"),
    ("POLAR", "Polar Cooling Co", "Germany"),
    ("ATLAS", "Atlas Electrical Pte Ltd", "Singapore"),
]

# email, name, roles, supplier key, project scope codes
USERS = [
    ("admin@demo.pcx", "Alex Admin", "ADMIN", None, []),
    ("owner@demo.pcx", "Olivia Owner", "OWNER", None, []),
    ("estimator@demo.pcx", "Ethan Estimator", "ESTIMATOR", None, []),
    ("engineering@demo.pcx", "Erin Engineer", "ENGINEERING", None, []),
    ("procurement@demo.pcx", "Priya Procurement", "PROCUREMENT", None, []),
    ("inventory@demo.pcx", "Ivan Inventory", "INVENTORY", None, []),
    ("bkk2.site@demo.pcx", "Somchai Site Lead BKK2", "INVENTORY", None, ["BKK2"]),
    ("finance@demo.pcx", "Fiona Finance", "FINANCE", None, []),
    ("fm@demo.pcx", "Felix Facilities", "FM", None, []),
    ("integration@demo.pcx", "Isla Integration", "INTEGRATION", None, []),
    ("supplier.meridian@demo.pcx", "Meridian Bid Desk", "SUPPLIER", "MERIDIAN", []),
    ("supplier.northwind@demo.pcx", "Northwind Bid Desk", "SUPPLIER", "NORTHWIND", []),
    ("supplier.polar@demo.pcx", "Polar Bid Desk", "SUPPLIER", "POLAR", []),
]


@lru_cache(maxsize=4)
def _password_hash(password: str) -> str:
    return hash_password(password)


def seed_reference(db: Session, tenant_code: str = "DEMO", tenant_name: str = "Demo Data Centre Owner") -> Tenant:
    tenant = Tenant(code=tenant_code, name=tenant_name)
    db.add(tenant)
    db.flush()
    t = tenant.id

    def add(obj):
        obj.tenant_id = t
        obj.created_by = SEED_ACTOR
        db.add(obj)
        return obj

    # organization
    bkk = add(Programme(code="BKK", name="Bangkok programme", region="APAC", currency="USD"))
    sgp = add(Programme(code="SGP", name="Singapore programme (historical)", region="APAC", currency="USD"))
    db.flush()
    projects = {
        "BKK1": add(Project(programme_id=bkk.id, code="BKK1", name="Bangkok DC1", site_timezone="Asia/Bangkok")),
        "BKK2": add(Project(programme_id=bkk.id, code="BKK2", name="Bangkok DC2", site_timezone="Asia/Bangkok")),
        "SGP1": add(Project(programme_id=sgp.id, code="SGP1", name="Singapore DC1", site_timezone="Asia/Singapore", status="CLOSED")),
    }
    db.flush()
    for code, prj in projects.items():
        add(WbsElement(project_id=prj.id, code=f"{code}-E-GEN", name="Standby generation", cost_code="26-3213"))
        add(WbsElement(project_id=prj.id, code=f"{code}-M-CHW", name="Central cooling plant", cost_code="23-6400"))

    # custody locations
    loc_specs = [
        ("SUP-MERIDIAN", "Meridian factory, Peterborough", "SUPPLIER", None, None, None),
        ("SUP-NORTHWIND", "Northwind factory, Indiana", "SUPPLIER", None, None, None),
        ("SUP-POLAR", "Polar Cooling factory, Bremen", "SUPPLIER", None, None, None),
        ("IN-TRANSIT", "In transit", "IN_TRANSIT", None, None, None),
        ("BKK-CW", "BKK central warehouse, Lat Krabang", "CENTRAL_WAREHOUSE", bkk.id, None, "BKK-CW-01"),
        ("BKK1-SS", "BKK1 site store", "SITE_STORE", bkk.id, projects["BKK1"].id, "BKK1-SS-01"),
        ("BKK2-SS", "BKK2 site store", "SITE_STORE", bkk.id, projects["BKK2"].id, "BKK2-SS-01"),
        ("BKK1-GY", "BKK1 generator yard", "INSTALLED", bkk.id, projects["BKK1"].id, None),
        ("BKK2-GY", "BKK2 generator yard", "INSTALLED", bkk.id, projects["BKK2"].id, None),
        ("BKK1-CP", "BKK1 chiller plant", "INSTALLED", bkk.id, projects["BKK1"].id, None),
        ("SGP1-SS", "SGP1 site store", "SITE_STORE", sgp.id, projects["SGP1"].id, "SGP1-SS-01"),
    ]
    for code, name, kind, prog, prj, subinv in loc_specs:
        add(Location(code=code, name=name, kind=kind, programme_id=prog, project_id=prj, oracle_subinventory=subinv))

    suppliers = {}
    for i, (key, name, country) in enumerate(SUPPLIERS, start=1):
        suppliers[key] = add(Supplier(key=key, name=name, country=country, oracle_supplier_id=f"ORA-SUP-{1000 + i}"))
    db.flush()

    pw = _password_hash(get_settings().demo_password)
    for email, name, roles, sup, scope in USERS:
        add(
            User(
                email=email,
                name=name,
                roles=roles,
                supplier_id=suppliers[sup].id if sup else None,
                project_scope=",".join(projects[c].id for c in scope),
                password_hash=pw,
            )
        )

    # catalogue
    classes = {}
    for category, name, status, lead, code in LLE_MASTER:
        classes[code] = add(EquipmentClass(code=code, category=category, name=name, lle_status=status, typical_lead_time_days=lead))
    for code, category, name in COMPONENT_CLASSES:
        classes[code] = add(EquipmentClass(code=code, category=category, name=name, lle_status="Component", is_component_class=True))
    db.flush()

    def model(code, cls, manufacturer, mdl, desc, cap=None, unit=None, duty=None, specs=None, serial=True, std=None):
        return add(
            ItemModel(
                item_code=code,
                equipment_class_id=classes[cls].id,
                manufacturer=manufacturer,
                model=mdl,
                description=desc,
                rated_capacity=D(cap) if cap else None,
                capacity_unit=unit,
                rating_standard=std,
                duty_modes=duty,
                serial_controlled=serial,
                specs_json=specs or {},
                oracle_item_id=f"ORA-ITM-{code}",
            )
        )

    m = {}
    m["GEN-MER-2500S"] = model("GEN-MER-2500S", "GEN", "Meridian", "MG-2500S", "Diesel genset 2500 kVA standby, 11 kV", "2500", "kVA", "STANDBY,PRIME",
                               {"voltage_kv": "11", "fuel": "Diesel", "emissions": "TA-Luft 2g", "enclosure": "Containerised"}, std="ISO 8528-1")
    m["GEN-NWP-2500X"] = model("GEN-NWP-2500X", "GEN", "Northwind", "NP-2500X", "Diesel genset 2500 kVA standby, 11 kV", "2500", "kVA", "STANDBY",
                               {"voltage_kv": "11", "fuel": "Diesel", "emissions": "TA-Luft 4g", "enclosure": "Containerised"}, std="ISO 8528-1")
    m["ENG-MER-V16"] = model("ENG-MER-V16", "CMP-ENGINE", "Meridian", "V16-TD", "V16 turbo-diesel engine 2200 kWm")
    m["ENG-NWP-Q60"] = model("ENG-NWP-Q60", "CMP-ENGINE", "Northwind", "Q60", "60 L diesel engine 2250 kWm")
    m["ALT-MER-2500"] = model("ALT-MER-2500", "CMP-ALT", "Meridian", "MA-2500", "Alternator 2500 kVA 11 kV")
    m["ALT-NWP-2500"] = model("ALT-NWP-2500", "CMP-ALT", "Northwind", "NA-2500", "Alternator 2500 kVA 11 kV")
    m["CTL-MER-PC3"] = model("CTL-MER-PC3", "CMP-CTRL", "Meridian", "PowerCommand 3", "Genset controller")
    m["CTL-NWP-D7"] = model("CTL-NWP-D7", "CMP-CTRL", "Northwind", "D7", "Genset controller")
    m["RAD-MER-R25"] = model("RAD-MER-R25", "CMP-RAD", "Meridian", "R25", "Set-mounted radiator 50 C ambient")
    m["RAD-NWP-R25"] = model("RAD-NWP-R25", "CMP-RAD", "Northwind", "NR-25", "Set-mounted radiator 50 C ambient")
    m["BAT-24V-STD"] = model("BAT-24V-STD", "CMP-BATT", "Atlas", "SB-24", "24 V starting battery system with charger")
    m["ACB-4000"] = model("ACB-4000", "CMP-BRK", "Atlas", "ACB-4000", "Output air circuit breaker 4000 A")
    m["FIP-MER-V16"] = model("FIP-MER-V16", "CMP-FIP", "Meridian", "FIP-V16", "Fuel injection pump for V16-TD")
    m["TUR-MER-V16"] = model("TUR-MER-V16", "CMP-TURBO", "Meridian", "TB-V16", "Turbocharger for V16-TD")
    m["TUR-NWP-Q60"] = model("TUR-NWP-Q60", "CMP-TURBO", "Northwind", "TB-Q60", "Turbocharger for Q60")
    m["CH-POL-1500A"] = model("CH-POL-1500A", "CHL-AC", "Polar", "AC-1500", "Air-cooled screw chiller 1500 kWr", "1500", "kW", None,
                              {"refrigerant": "R1234ze", "ambient_c": "46", "free_cooling": True}, std="AHRI 550/590")
    m["CMP-POL-SC750"] = model("CMP-POL-SC750", "CMP-COMP", "Polar", "SC-750", "Screw compressor 750 kWr")
    m["DRV-POL-750"] = model("DRV-POL-750", "CMP-DRIVE", "Polar", "VD-750", "Compressor motor / VFD drive")
    m["EVP-POL-1500"] = model("EVP-POL-1500", "CMP-EVAP", "Polar", "EV-1500", "Flooded evaporator")
    m["CND-POL-1500"] = model("CND-POL-1500", "CMP-COND", "Polar", "CD-1500", "Microchannel condenser coil bank")
    m["CTL-POL-UC"] = model("CTL-POL-UC", "CMP-CTRL", "Polar", "UC-800", "Chiller control panel")
    m["EXV-POL-80"] = model("EXV-POL-80", "CMP-EXV", "Polar", "EXV-80", "Electronic expansion valve")
    m["FAN-POL-EC"] = model("FAN-POL-EC", "CMP-FAN", "Polar", "EC-910", "EC condenser fan and motor", serial=False)
    db.flush()

    def bom(parent, slot, desc, child=None, qty="1", tracked=True, parent_slot=None):
        add(BomLine(parent_model_id=m[parent].id, child_model_id=m[child].id if child else None, slot_code=slot, description=desc,
                    quantity=D(qty), individually_tracked=tracked, parent_slot_code=parent_slot))

    for gen, eng, alt, ctl, rad, tur in (
        ("GEN-MER-2500S", "ENG-MER-V16", "ALT-MER-2500", "CTL-MER-PC3", "RAD-MER-R25", "TUR-MER-V16"),
        ("GEN-NWP-2500X", "ENG-NWP-Q60", "ALT-NWP-2500", "CTL-NWP-D7", "RAD-NWP-R25", "TUR-NWP-Q60"),
    ):
        bom(gen, "ENGINE", "Engine", eng)
        bom(gen, "ALTERNATOR", "Alternator", alt)
        bom(gen, "CONTROLLER", "Controller", ctl)
        bom(gen, "RADIATOR", "Cooling system / radiator", rad)
        bom(gen, "STARTING_BATTERY", "Starting system and batteries", "BAT-24V-STD")
        bom(gen, "OUTPUT_BREAKER", "Output circuit breaker", "ACB-4000")
        bom(gen, "LUBE_FILTERS", "Lubrication filters and seals (quantity-based)", None, "6", False)
        bom(eng, "TURBO", "Turbocharger", tur, parent_slot="ENGINE")
    bom("ENG-MER-V16", "FUEL_PUMP", "Fuel injection pump", "FIP-MER-V16", parent_slot="ENGINE")

    bom("CH-POL-1500A", "COMPRESSOR_1", "Compressor assembly circuit 1", "CMP-POL-SC750")
    bom("CH-POL-1500A", "COMPRESSOR_2", "Compressor assembly circuit 2", "CMP-POL-SC750")
    bom("CH-POL-1500A", "DRIVE_1", "Compressor motor/drive circuit 1", "DRV-POL-750")
    bom("CH-POL-1500A", "DRIVE_2", "Compressor motor/drive circuit 2", "DRV-POL-750")
    bom("CH-POL-1500A", "EVAPORATOR", "Evaporator", "EVP-POL-1500")
    bom("CH-POL-1500A", "CONDENSER", "Condenser", "CND-POL-1500")
    bom("CH-POL-1500A", "CONTROL_PANEL", "Control panel", "CTL-POL-UC")
    bom("CH-POL-1500A", "EXPANSION_VALVE", "Expansion valve", "EXV-POL-80")
    bom("CH-POL-1500A", "CONDENSER_FANS", "Condenser fans and fan motors (quantity-based)", "FAN-POL-EC", "10", False)

    for spare, parent, slot in (
        ("ALT-MER-2500", "GEN-MER-2500S", "ALTERNATOR"),
        ("ACB-4000", "GEN-MER-2500S", "OUTPUT_BREAKER"),
        ("ACB-4000", "GEN-NWP-2500X", "OUTPUT_BREAKER"),
        ("BAT-24V-STD", "GEN-MER-2500S", "STARTING_BATTERY"),
        ("BAT-24V-STD", "GEN-NWP-2500X", "STARTING_BATTERY"),
        ("TUR-MER-V16", "ENG-MER-V16", "TURBO"),
        ("CMP-POL-SC750", "CH-POL-1500A", "COMPRESSOR_1"),
        ("CMP-POL-SC750", "CH-POL-1500A", "COMPRESSOR_2"),
    ):
        add(CompatibleSpare(spare_model_id=m[spare].id, parent_model_id=m[parent].id, slot_code=slot, approved_by="engineering@demo.pcx"))

    add(EquipmentOption(item_model_id=m["GEN-MER-2500S"].id, option_code="OPT-GEN-A", name="Option A - Meridian MG-2500S standby",
                        configuration_json={"duty": "STANDBY", "capacity_kva": "2500", "enclosure": "Containerised", "fuel_autonomy_h": "24"},
                        technical_basis="ISO 8528-1 standby rating at 46 C site ambient"))
    add(EquipmentOption(item_model_id=m["GEN-NWP-2500X"].id, option_code="OPT-GEN-B", name="Option B - Northwind NP-2500X standby",
                        configuration_json={"duty": "STANDBY", "capacity_kva": "2500", "enclosure": "Containerised", "fuel_autonomy_h": "24"},
                        technical_basis="ISO 8528-1 standby rating at 40 C ambient; derating at 46 C to be confirmed"))
    add(EquipmentOption(item_model_id=m["CH-POL-1500A"].id, option_code="OPT-CHL-A", name="Polar AC-1500 air-cooled with free cooling",
                        configuration_json={"capacity_kw": "1500", "refrigerant": "R1234ze", "free_cooling": True},
                        technical_basis="AHRI 550/590 certified at 46 C ambient"))

    _seed_handbooks(add, db, classes)
    _seed_benchmarks(add, classes, m)
    db.flush()
    return tenant


def _seed_handbooks(add, db, classes):
    common = [
        ("SERIAL", "Serial number recorded", "Identity", "FIELD", True, True, {"field": "serial_number"}, "INVENTORY", False),
        ("ASSET_TAG", "Barcode / asset tag", "Identity", "FIELD", True, False, {"field": "barcode"}, "INVENTORY", False),
        ("POSITION", "Installed position", "Location", "FIELD", True, False, {"field": "installed_position"}, "INVENTORY", False),
        ("WARRANTY_END", "Warranty end date", "Warranty", "FIELD", True, False, {"field": "warranty_end"}, "PROCUREMENT", False),
        ("OM_MANUAL", "Approved O&M manual for model", "Documents", "DOCUMENT", True, False,
         {"doc_type": "OM_MANUAL", "require_approved": True, "match": "MODEL"}, "ENGINEERING", False),
        ("FAT_REPORT", "Approved FAT report for this serial", "Testing", "DOCUMENT", True, True,
         {"doc_type": "FAT_REPORT", "require_approved": True, "match": "SERIAL"}, "ENGINEERING", False),
        ("WARRANTY_CERT", "Warranty certificate", "Warranty", "DOCUMENT", True, False,
         {"doc_type": "WARRANTY", "require_approved": True, "match": "SERIAL", "not_expired": True}, "PROCUREMENT", False),
        ("FAT_PASS", "FAT passed and released", "Testing", "TEST", True, True, {"test_type": "FAT", "result": "PASS"}, "ENGINEERING", False),
        ("COMMISSIONING", "Site commissioning passed", "Testing", "TEST", True, True, {"test_type": "COMMISSIONING", "result": "PASS"}, "ENGINEERING", False),
        ("STRUCTURE", "All individually tracked BOM slots fitted", "Structure", "STRUCTURE", True, True,
         {"require_all_tracked_slots": True}, "ENGINEERING", False),
        ("PURCHASE_PRICE", "Purchase price and commercial terms (restricted annex)", "Commercial annex", "FIELD", False, False,
         {"field": "purchase_cost"}, "FINANCE", True),
    ]
    for cls_code, tmpl_code, name in (("GEN", "HB-GEN", "Diesel genset FM handbook"), ("CHL-AC", "HB-CHL", "Air-cooled chiller FM handbook")):
        tmpl = add(HandbookTemplate(equipment_class_id=classes[cls_code].id, template_code=tmpl_code, name=name, recipient_role="FM"))
        db.flush()
        for code, title, section, kind, mandatory, critical, rule, role, commercial in common:
            add(HandbookCriterion(template_id=tmpl.id, criterion_code=code, title=title, section=section, kind=kind, mandatory=mandatory,
                                  critical=critical, rule_json=rule, responsible_role=role, commercial=commercial))


def _seed_benchmarks(add, classes, m):
    full_scope = ["SUPPLY", "FREIGHT", "INSTALLATION", "COMMISSIONING"]

    def obs(cls, model_code, prj, duty, cap, unit, purchase, installed, opex, years, failures, delay, observed, scope=None, src=None):
        add(BenchmarkObservation(
            equipment_class_id=classes[cls].id,
            item_model_id=m[model_code].id if model_code else None,
            source_project_code=prj, duty=duty, capacity=D(cap), capacity_unit=unit, region="APAC", currency="USD",
            purchase_cost=D(purchase), installed_cost=D(installed) if installed else None,
            annual_opex=[{"year": i + 1, "amount": a} for i, a in enumerate(opex)],
            operating_years_observed=years, scope_included=scope or full_scope, commissioning_failures=failures,
            delivery_delay_days=delay, observed_at=observed, source_ref=src or f"ORACLE-AP/{prj}/{cls}",
        ))

    obs("GEN", "GEN-MER-2500S", "HKG2", "STANDBY", "2500", "kVA", "410000", "468000", ["12500", "13100", "13900"], 3, 0, 12, date(2026, 6, 30))
    obs("GEN", "GEN-NWP-2500X", "SGP1", "STANDBY", "2500", "kVA", "425000", "481000", ["11800", "12400", "13000", "13600"], 4, 1, 25, date(2026, 6, 30))
    obs("GEN", "GEN-MER-2500S", "SYD3", "STANDBY", "2500", "kVA", "398000", "455500", ["12900", "13300"], 2, 0, -5, date(2026, 6, 30))
    obs("GEN", "GEN-NWP-2500X", "TYO1", "STANDBY", "2500", "kVA", "440000", "503000", ["13500", "14000", "14600", "15100", "15800"], 5, 2, 40, date(2026, 6, 30))
    obs("GEN", "GEN-MER-2500S", "KUL1", "STANDBY", "2500", "kVA", "405000", None, ["12200"], 1, 0, 8, date(2026, 6, 30),
        scope=["SUPPLY", "FREIGHT"], src="ORACLE-AP/KUL1/GEN (installation not captured)")
    # Not comparable: continuous duty and a smaller rating; benchmark cohort must exclude them with reasons.
    obs("GEN", None, "JKT1", "CONTINUOUS", "2500", "kVA", "520000", "590000", ["21000", "22400"], 2, 0, 30, date(2026, 6, 30))
    obs("GEN", None, "MNL1", "STANDBY", "1250", "kVA", "240000", "276000", ["7400"], 1, 0, 0, date(2026, 6, 30))
    # Sparse evidence for chillers (below minimum sample).
    obs("CHL-AC", "CH-POL-1500A", "SGP1", None, "1500", "kW", "610000", "702000", ["18200", "18900", "19700"], 3, 1, 15, date(2026, 6, 30))
    obs("CHL-AC", "CH-POL-1500A", "HKG2", None, "1500", "kW", "595000", "688000", ["17600", "18100"], 2, 0, 20, date(2026, 6, 30))
