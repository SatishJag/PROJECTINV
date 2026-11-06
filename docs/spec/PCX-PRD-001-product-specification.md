Version 1.0 \| 30 October 2026 \| PCX PRD 001

This product connects equipment decisions made during BOQ development with procurement, delivery, commissioning, handover and actual operating costs. It preserves the evidence behind each purchase and uses later outcomes to improve the next project. The document defines the proposed product, its functional requirements, integration boundaries, data model, user workspaces and acceptance criteria.

| **Document control**      | **Value**                                                                                                                                    |
|---------------------------|----------------------------------------------------------------------------------------------------------------------------------------------|
| Status                    | Proposed product baseline for business and engineering review                                                                                |
| Audience                  | Product owners, data centre delivery teams, procurement, engineering, FM, Finance, Procore administrators and software developers            |
| Primary scope             | Long lead equipment and serialized assets across projects and data centres                                                                   |
| Companion baseline        | Asset Lifecycle Product Implementation Specification version 1.0, dated 20 October 2026, and its developer pack                              |
| Product assessment status | Procore capabilities and tenant interfaces are unverified. Candidate extension opportunities must pass the discovery tests in this document. |
| Business approval         | Product owner and functional owners to be nominated; no production implementation or vendor endorsement is implied                           |

The pre-award requirement, benchmarking and offer-evaluation design is an addition to the earlier inventory specification. Existing asset identity, component history, transfer, cost allocation and TCO rules remain the foundation. This document proposes extensions; it does not replace the earlier SQL schema or claim that the application has been built.

# Contents

[1 Product purpose and intended outcomes](#product-purpose-and-intended-outcomes) 3

[2 Scope boundaries and evidence status](#scope-boundaries-and-evidence-status) 4

[3 Procore discovery matrix for planning and procurement](#procore-discovery-matrix-for-planning-and-procurement) 5

[4 Procore discovery matrix for delivery and asset life](#procore-discovery-matrix-for-delivery-and-asset-life) 6

[5 Users responsibilities and approval authority](#users-responsibilities-and-approval-authority) 7

[6 Capabilities for planning and benchmarking](#capabilities-for-planning-and-benchmarking) 8

[7 Capabilities for sourcing and arrival](#capabilities-for-sourcing-and-arrival) 9

[8 Capabilities for assets and cost](#capabilities-for-assets-and-cost) 10

[9 Capabilities for handover and governance](#capabilities-for-handover-and-governance) 11

[10 End to end procurement decision flow](#end-to-end-procurement-decision-flow) 12

[11 Requirement and BOQ revision requirements](#requirement-and-boq-revision-requirements) 13

[12 Equipment catalogue and reusable configurations](#equipment-catalogue-and-reusable-configurations) 14

[13 Benchmarking method and evidence quality](#benchmarking-method-and-evidence-quality) 15

[14 Available inventory and reuse assessment](#available-inventory-and-reuse-assessment) 16

[15 Sourcing packages and supplier offer normalization](#sourcing-packages-and-supplier-offer-normalization) 17

[16 Technical evaluation lifecycle scenarios and award](#technical-evaluation-lifecycle-scenarios-and-award) 18

[17 PO integration and permanent asset identity](#po-integration-and-permanent-asset-identity) 19

[18 Long lead schedules arrival probability and risk](#long-lead-schedules-arrival-probability-and-risk) 20

[19 Components groups transfers and recovery](#components-groups-transfers-and-recovery) 21

[20 Progressive asset handbook and acceptance](#progressive-asset-handbook-and-acceptance) 22

[21 FM costs actual outcomes and future BOQ feedback](#fm-costs-actual-outcomes-and-future-boq-feedback) 23

[22 Cost measures TCO and decision calculations](#cost-measures-tco-and-decision-calculations) 24

[23 User interface structure and interaction rules](#user-interface-structure-and-interaction-rules) 25

[24 BOQ and supplier evaluation workspace](#boq-and-supplier-evaluation-workspace) 26

[25 Asset passport handbook and operational screens](#asset-passport-handbook-and-operational-screens) 27

[26 Architecture integration boundaries and deployment](#architecture-integration-boundaries-and-deployment) 28

[27 Record ownership and integration mappings](#record-ownership-and-integration-mappings) 29

[28 Data model continuity and common schema rules](#data-model-continuity-and-common-schema-rules) 30

[29 Schema for requirements options and benchmarks](#schema-for-requirements-options-and-benchmarks) 31

[30 Schema for sourcing and evaluation](#schema-for-sourcing-and-evaluation) 32

[31 Schema for award handbooks and external links](#schema-for-award-handbooks-and-external-links) 33

[32 State transitions transactions and consistency](#state-transitions-transactions-and-consistency) 34

[33 Extension API events and background jobs](#extension-api-events-and-background-jobs) 35

[34 Security data quality and model governance](#security-data-quality-and-model-governance) 36

[35 Analytics operational targets and resilience](#analytics-operational-targets-and-resilience) 37

[36 Acceptance tests and capability traceability](#acceptance-tests-and-capability-traceability) 38

[37 Release roadmap and pilot design](#release-roadmap-and-pilot-design) 40

[38 Implementation decisions migration and open dependencies](#implementation-decisions-migration-and-open-dependencies) 41

[39 Reference basis glossary and review checklist](#reference-basis-glossary-and-review-checklist) 42

# 1 Product purpose and intended outcomes

The product should help an owner or delivery team choose suitable equipment before committing to a purchase, track its delivery and acceptance, and retain a useful asset record after the construction project closes. Its main value is the connection between procurement decisions and actual asset outcomes across projects.

## Business decisions supported

- During BOQ development, decide whether to buy new, reuse, refurbish or revise the equipment option using engineering constraints and comparable costs.

- During sourcing, evaluate equivalent supplier scopes, technical compliance, delivery suitability and lifecycle expenditure.

- During delivery, identify the equipment at risk, its forecast arrival and the site actions needed to receive and commission it.

- During handover, publish a validated asset handbook and structured operational data.

- During operation, attribute service costs and component events to the same physical asset and return observed results to future benchmarks.

## Measurable product outcomes

| **Outcome**                | **Measurement and baseline needed**                                                                                       |
|----------------------------|---------------------------------------------------------------------------------------------------------------------------|
| Better purchase evaluation | Share of equipment awards with approved scope normalization, lifecycle scenario and traceable decision evidence.          |
| Useful benchmarks          | Share of evaluated requirements supported by comparable observed assets, with disclosed coverage and cohort size.         |
| Controlled delivery risk   | Late-arrival exposure and time to resolve receiving blockers, compared with an agreed project baseline.                   |
| Reliable handover          | Mandatory handbook criteria accepted by the agreed date, with unresolved criteria separately visible.                     |
| Cost traceability          | Recognized cost attributable to a technical asset as a share of in-scope expenditure, with unallocated amounts disclosed. |

These are proposed measures, not demonstrated savings or contractual performance commitments. The pilot must establish baseline values, data availability and target thresholds before benefits are quantified.

# 2 Scope boundaries and evidence status

Procore is the proposed project-facing environment. The product should reuse enabled project tools and connected enterprise services wherever they satisfy a requirement. The extension owns the additional relationships and calculations that discovery proves are still needed. There is no requirement to duplicate all project management, procurement, accounting or maintenance functions.

| **Assessment code** | **Meaning and decision**                                                                                                |
|---------------------|-------------------------------------------------------------------------------------------------------------------------|
| U Unverified        | Current product, tenant configuration or licensed app has not been demonstrated. All Procore gap candidates start here. |
| N Native            | The enabled native capability meets the acceptance scenario. Reuse it and retain its authoritative record.              |
| C Configuration     | Supported fields, templates, permissions or reports can satisfy the need without new domain logic.                      |
| P Partner           | An installed or selected partner service satisfies the requirement; integrate after evidence and ownership review.      |
| I Integration       | The capability exists in an authoritative enterprise system; the work is mapping and reliable synchronization.          |
| E Extension         | A remaining domain requirement needs custom relationships, transactions, calculations or user workflow.                 |
| D Data limitation   | The required historical or operational evidence is missing; software alone cannot establish the answer.                 |

## Evidence limitation

Public Procore documentation retrieval was attempted on 30 October 2026 and was unsuccessful. No Procore tenant, enabled tool inventory, Marketplace installation list or API test environment was inspected. Procore tool names in this document identify discovery areas. They are not a verified catalogue of current capability or a finding that a named feature is absent.

## Included and excluded work

The proposed product includes requirement revisions, benchmarking, reuse assessments, normalized offers, award lineage, lifecycle identity, arrival projections, component and group tracking, progressive handbooks and cost feedback. General ledger functions, unrestricted engineering approval, universal carrier coverage, a new enterprise CMMS and automatic purchasing decisions are outside the scope. Existing ERP and FM/EAM responsibilities remain explicit integration boundaries.

# 3 Procore discovery matrix for planning and procurement

| **Candidate need**                  | **Area to inspect**                                          | **Evidence required before custom build**                                                                              |
|-------------------------------------|--------------------------------------------------------------|------------------------------------------------------------------------------------------------------------------------|
| Draft BOQ and requirement revisions | Estimating, specifications, models and configured workflows  | Demonstrate stable requirement lineage across quantity, specification and option revisions.                            |
| Historical equipment benchmarks     | Estimating catalogues, reporting and analytical integrations | Demonstrate equivalent-duty installed and operating cost comparison, including coverage and source evidence.           |
| Reuse before purchase               | Equipment records, assignments and inventory integrations    | Find available compatible units across permitted projects and prove availability, condition and reservation ownership. |
| Supplier bid comparison             | Bid management, estimating and procurement apps              | Compare identical technical scope, exclusions, tax/FX and service coverage with versioned adjustments.                 |
| Lifecycle option evaluation         | Existing analytics and cost-planning apps                    | Show actual-plus-forecast TCO, duty normalization, delivery suitability and approved scenario assumptions.             |
| Purchase and identity lineage       | Commitments, purchase order and ERP integrations             | Trace one approved requirement through an authoritative PO line to multiple stable serialized unit IDs.                |
| Procurement schedule                | Schedules, submittals and connected procurement tools        | Show technical approval, manufacture, FAT, transport, customs and commissioning dependencies.                          |

Working hypothesis: reuse native transaction and document features, integrate authoritative sourcing and finance records, and add only the missing lifecycle relationships and evaluation logic. Every row remains U until demonstrated. Record product edition, enabled tool, app/version, permissions, source URL or test evidence, date, owner and the resulting N/C/P/I/E/D classification.

# 4 Procore discovery matrix for delivery and asset life

| **Candidate need**               | **Area to inspect**                                  | **Evidence required before custom build**                                                                           |
|----------------------------------|------------------------------------------------------|---------------------------------------------------------------------------------------------------------------------|
| Shipment arrival intelligence    | Delivery/schedule views and logistics apps           | Trace carrier references to physical units; distinguish port ETA, site arrival and accepted availability.           |
| Component history                | Equipment records, models and connected EAM          | Identify the serial installed in a parent slot at a past service date, after several replacements.                  |
| Project and DC transfer          | Equipment assignment and inventory integrations      | Preserve one identity through approved issue, transit, partial receipt and ownership changes.                       |
| Commissioning failure and return | Inspections, observations, punch lists and documents | Trace failed serial, parent impact, RMA, return, replacement, retest and recovery cost.                             |
| Progressive asset handbook       | Documents, submittals, closeout and handover apps    | Publish asset-specific immutable evidence plus validated structured data and recipient acceptance.                  |
| FM cost attribution              | Financial and maintenance integrations               | Resolve invoice distributions to assets at service date, including transfers and component changes.                 |
| Future-project feedback          | Portfolio reporting and analytics                    | Use observed cost, failure and delivery outcomes in a subsequent BOQ evaluation without fabricating future actuals. |

## Discovery exit gate

Run the scenarios using representative records and the intended user roles. A configured demonstration must include exceptions and history, not just a successful screen. Choose a native feature, partner or integration where it passes; retain an extension backlog only for the unmet behaviour. A lack of data is classified separately from a product limitation.

# 5 Users responsibilities and approval authority

| **Role**                           | **Primary actions**                                                     | **Approval boundary**                                                                     |
|------------------------------------|-------------------------------------------------------------------------|-------------------------------------------------------------------------------------------|
| Owner and project controls         | Define needs, review options, monitor cost and programme exposure       | Approve requirement and evaluation baseline according to delegated authority.             |
| Estimator and quantity surveyor    | Develop BOQ, quantity revisions and comparable estimates                | Cannot approve technical deviations or commit a supplier without authorization.           |
| Engineering and commissioning      | Approve compatibility, duty assumptions, tests and release criteria     | Mandatory technical criteria remain gates; commercial scores cannot override a failure.   |
| Procurement and supplier           | Issue sourcing packages, submit offers and dispatch evidence            | Procurement controls awards; suppliers see their own authorized requests and submissions. |
| Inventory and site delivery        | Assign, reserve, receive, transfer and inspect physical units           | Source release and destination receipt responsibilities remain distinct.                  |
| Finance                            | Approve recognition, allocations, FX/tax treatment and financial links  | Own capitalization, books, period close and cross-entity accounting.                      |
| FM and asset owner                 | Accept operational data, record service and review lifetime performance | Own maintenance execution in the declared FM/EAM system.                                  |
| Product and integration operations | Maintain mappings, source contracts, access and exception handling      | Cannot silently edit approved awards, financial history or published handbooks.           |

Resolve actual approval groups, thresholds and segregation-of-duty rules during discovery. The document defines responsibility types, not named approvers. Protect commercial annexes separately from the technical handbook and supplier workspace.

# 6 Capabilities for planning and benchmarking

L1 domains group product outcomes. L2 capabilities define workflows. Each L2 has three numbered L3 capabilities that can become development stories and acceptance tests.

| **L1 domain**              | **L2 capability**            | **L3 capabilities**                                                                                                                                         |
|----------------------------|------------------------------|-------------------------------------------------------------------------------------------------------------------------------------------------------------|
| B01 Requirement planning   | B01.1 Functional need        | B01.1.1 Stable requirement identity; B01.1.2 Duty capacity and site constraints; B01.1.3 Need dates and redundancy criteria                                 |
| B01 Requirement planning   | B01.2 BOQ revision control   | B01.2.1 Draft and approved line revisions; B01.2.2 Quantity specification and substitution history; B01.2.3 Change impact on awards and commitments         |
| B01 Requirement planning   | B01.3 Option definition      | B01.3.1 Generic equipment class and model options; B01.3.2 Compatible configurations and accessories; B01.3.3 Requirement to position and project cost code |
| B02 Benchmarking and reuse | B02.1 Comparable actuals     | B02.1.1 Cost and performance evidence; B02.1.2 Cohort and duty normalization; B02.1.3 Coverage outliers and provenance                                      |
| B02 Benchmarking and reuse | B02.2 Available asset search | B02.2.1 Cross project candidate inventory; B02.2.2 Condition compatibility and availability; B02.2.3 Controlled reservation and conflict handling           |
| B02 Benchmarking and reuse | B02.3 Reuse decision         | B02.3.1 Transfer refurbishment and retest costs; B02.3.2 New purchase versus reuse scenario; B02.3.3 Approved sourcing route and evidence                   |

The full product catalogue has eight L1 domains, 24 L2 capabilities and 72 L3 capabilities. These identifiers belong to this extension specification and do not renumber the earlier inventory catalogue.

# 7 Capabilities for sourcing and arrival

L1 domains group product outcomes. L2 capabilities define workflows. Each L2 has three numbered L3 capabilities that can become development stories and acceptance tests.

| **L1 domain**               | **L2 capability**                         | **L3 capabilities**                                                                                                                                |
|-----------------------------|-------------------------------------------|----------------------------------------------------------------------------------------------------------------------------------------------------|
| B03 Sourcing and evaluation | B03.1 Supplier offer control              | B03.1.1 Versioned packages and offer lines; B03.1.2 Exclusions quantities and delivery promises; B03.1.3 Source currency tax and Incoterms         |
| B03 Sourcing and evaluation | B03.2 Technical and commercial comparison | B03.2.1 Mandatory technical criteria and deviations; B03.2.2 Normalized installed cost and TCO; B03.2.3 Evidence based weighted evaluation         |
| B03 Sourcing and evaluation | B03.3 Award decision                      | B03.3.1 Approved selection and split quantities; B03.3.2 Frozen assumptions and approval history; B03.3.3 Award to authoritative PO reconciliation |
| B04 Procurement and arrival | B04.1 Persistent physical identity        | B04.1.1 PO alias deduplication and unit UUID; B04.1.2 Serial barcode and shipment linkage; B04.1.3 Receipt and project cost provenance             |
| B04 Procurement and arrival | B04.2 Logistics visibility                | B04.2.1 Supplier dispatch and carrier references; B04.2.2 Daily provider reconciliation; B04.2.3 Item and shipment quantity conservation           |
| B04 Procurement and arrival | B04.3 Arrival planning                    | B04.3.1 Dated probability and evidence cutoff; B04.3.2 Receiving and acceptance readiness; B04.3.3 Risk actions and dependency impact              |

The full product catalogue has eight L1 domains, 24 L2 capabilities and 72 L3 capabilities. These identifiers belong to this extension specification and do not renumber the earlier inventory catalogue.

# 8 Capabilities for assets and cost

L1 domains group product outcomes. L2 capabilities define workflows. Each L2 has three numbered L3 capabilities that can become development stories and acceptance tests.

| **L1 domain**                    | **L2 capability**                     | **L3 capabilities**                                                                                                                                 |
|----------------------------------|---------------------------------------|-----------------------------------------------------------------------------------------------------------------------------------------------------|
| B05 Asset structure and movement | B05.1 Physical structure              | B05.1.1 Temporal parent and slot history; B05.1.2 Approved interchange and cycle controls; B05.1.3 Functional position occupancy                    |
| B05 Asset structure and movement | B05.2 Project assignment and transfer | B05.2.1 Separate assignment and custody; B05.2.2 Approved frozen transfer manifest; B05.2.3 Partial receipt and discrepancy closure                 |
| B05 Asset structure and movement | B05.3 Quality and recovery            | B05.3.1 Failure and parent readiness impact; B05.3.2 Return repair and new unit replacement; B05.3.3 Retest warranty and recovery evidence          |
| B06 Lifecycle cost intelligence  | B06.1 Recognized economic costs       | B06.1.1 Purchase installation and service cost; B06.1.2 Receipt invoice deduplication; B06.1.3 Exact asset project and service allocations          |
| B06 Lifecycle cost intelligence  | B06.2 Lifecycle scenarios             | B06.2.1 Actual commitments and forecast separation; B06.2.2 Annual operating age and discount basis; B06.2.3 Normalized forward decision comparison |
| B06 Lifecycle cost intelligence  | B06.3 Learning from outcomes          | B06.3.1 Observed delivery and failure results; B06.3.2 Operating cost coverage and cohort refresh; B06.3.3 New BOQ evidence from prior asset life   |

The full product catalogue has eight L1 domains, 24 L2 capabilities and 72 L3 capabilities. These identifiers belong to this extension specification and do not renumber the earlier inventory catalogue.

# 9 Capabilities for handover and governance

L1 domains group product outcomes. L2 capabilities define workflows. Each L2 has three numbered L3 capabilities that can become development stories and acceptance tests.

| **L1 domain**               | **L2 capability**             | **L3 capabilities**                                                                                                                           |
|-----------------------------|-------------------------------|-----------------------------------------------------------------------------------------------------------------------------------------------|
| B07 Handbook and operations | B07.1 Progressive handbook    | B07.1.1 Versioned class and role templates; B07.1.2 Structured fields and document criteria; B07.1.3 Owners missing evidence and exceptions   |
| B07 Handbook and operations | B07.2 Controlled publication  | B07.2.1 Validation and authorized waivers; B07.2.2 Immutable package and manifest; B07.2.3 Recipient acceptance and structured export         |
| B07 Handbook and operations | B07.3 Continuing asset record | B07.3.1 FM work order and invoice references; B07.3.2 Component and warranty updates; B07.3.3 Published snapshot and current history          |
| B08 Platform and governance | B08.1 Enterprise integrations | B08.1.1 Procore and ERP source crosswalks; B08.1.2 Durable inbox outbox and reconciliation; B08.1.3 Authorized outbound updates and replay    |
| B08 Platform and governance | B08.2 Trust and access        | B08.2.1 Tenant project supplier and cost permissions; B08.2.2 Versioned audit and source evidence; B08.2.3 Quality freshness and model limits |
| B08 Platform and governance | B08.3 Product operations      | B08.3.1 Owned exceptions and job monitoring; B08.3.2 Migration restore and release control; B08.3.3 Benefit metrics and discovery evidence    |

The full product catalogue has eight L1 domains, 24 L2 capabilities and 72 L3 capabilities. These identifiers belong to this extension specification and do not renumber the earlier inventory catalogue.

# 10 End to end procurement decision flow

<img src="media/image1.png" style="width:7in;height:4.66667in" alt="Figure 1 Requirement to award and the return of operating evidence into future decisions" />

*Figure 1 Requirement to award and the return of operating evidence into future decisions*

Create a requirement before selecting a product. Benchmark equivalent actuals and check available inventory before confirming the sourcing route. For a new purchase, collect offers, validate technical compliance and compare normalized cost and delivery suitability. Freeze the approved decision, then map the authoritative purchase to physical unit identities. Receipt, commissioning and operating results become evidence for later evaluations.

A reuse recommendation follows its own engineering, reservation and transfer approvals. It cannot bypass condition assessment, compatibility, site readiness or commissioning acceptance. The requirement remains stable even when the selected product or physical unit changes.

# 11 Requirement and BOQ revision requirements

FR01 The product shall create a stable requirement ID during draft BOQ development. It represents the functional need; an individual physical unit ID is created at PO creation. A generic catalogue class may represent the requirement before a manufacturer model is selected.

FR02 Each BOQ revision shall preserve its source reference, status, project, work package, quantities, UOM, specification, required dates and approval evidence. Draft changes do not overwrite a prior approved baseline. A revised requirement explicitly identifies its predecessor and changed fields.

| **Field group**   | **Required content**                                                      | **Validation**                                                                                 |
|-------------------|---------------------------------------------------------------------------|------------------------------------------------------------------------------------------------|
| Identity          | Requirement UUID, source BOQ key, line key, revision and project          | A repeated import resolves to the same canonical requirement/revision.                         |
| Engineering       | Class, capacity, duty, compatible configuration, location and redundancy  | Engineering approves mandatory criteria; units and rating basis must be explicit.              |
| Quantity and cost | Quantity, UOM, cost code, budget basis and estimate currency              | Positive quantity and permitted decimal precision; code belongs to project.                    |
| Dates             | Required site arrival, installation and operational dates                 | Dependencies and timezone are explicit; operational date does not substitute for site arrival. |
| Revision impact   | Affected evaluation, award, PO, reserved inventory and physical positions | Approved downstream records are flagged for change review rather than silently replaced.       |

## State and change behaviour

Requirement revisions progress through Draft, In Review, Approved, Superseded or Cancelled. Approving a revision updates the procurement-facing current projection and publishes RequirementRevisionApproved. A change to capacity, quantity or need date invalidates dependent evaluations according to policy and opens impact actions for issued POs. It does not automatically amend a PO or release a reservation.

# 12 Equipment catalogue and reusable configurations

FR03 Separate the functional equipment class, manufacturer model, selectable configuration, functional position and serialized physical unit. A BOQ can specify an approved class and duty without prematurely selecting a supplier. Model options carry structured technical characteristics and evidence for comparison.

## Catalogue content

- Maintain internal item code, manufacturer/model, rated capacity and rating standard, duty modes, energy/fuel characteristics, dimensions, environmental limits and compatibility references.

- Define accessories and required subcomponents, software/control versions where material, approved substitutes, initial spares and service scope.

- Retain the source, effective dates, approval and applicable region for every technical configuration. Record unknown values rather than deriving unsupported performance from descriptive text.

## Configuration and evaluation controls

A configuration selected for evaluation is versioned. Its required accessories and scope become part of offer normalization and later handbook criteria. Replacing a model after award requires a substitution assessment linked to the original requirement, evaluation and approved deviation. An alternate model does not inherit another model’s observed reliability or maintenance cost without a justified comparison rule.

## Bulk materials and serialized equipment

Serialized long lead equipment receives unit-level lineage. Bulk material remains quantity/lot-based unless the approved tracking policy requires unit serialization. BOQ quantities, offered quantities, ordered quantities, shipment allocations and received quantities must use controlled UOM conversions. Logical asset groups and financial asset books never create additional physical quantities.

# 13 Benchmarking method and evidence quality

FR04 A benchmark shall identify the observed assets and economic cost allocations used, the comparison basis and the evidence cutoff. Show purchase cost, installed cost and observed annual operating cost separately. Forecast later years remain labelled as forecasts. The same allocation cannot contribute twice through parent, component or overlapping group rollups.

| **Comparison factor** | **Normalization or disclosure**                                                                                                                         |
|-----------------------|---------------------------------------------------------------------------------------------------------------------------------------------------------|
| Equipment equivalence | Match capacity, duty, configuration, environment and service scope. Standby and continuous-duty assets require separate or explicitly adjusted cohorts. |
| Commercial scope      | Identify freight, tax treatment, installation, consultant, commissioning, spares and support included in each observation.                              |
| Prices and geography  | Convert using approved currency, date and inflation/location basis. Preserve original amount and conversion source.                                     |
| Operating exposure    | Disclose service years, operating hours, load profile, maintenance plan and replacement events.                                                         |
| Quality and coverage  | Show observed asset count, covered cost categories, unallocated amount, missing periods, exclusions and outlier policy.                                 |
| Statistical results   | Publish descriptive ranges only when supported by the sample. A price percentile is not a confidence interval or guaranteed outcome.                    |

## Benchmark publication rules

A benchmark run freezes input references, cohort rules, normalization version and output measures. Minimum sample and coverage thresholds are configurable and must be approved by the product/Finance owners. Below the threshold, show sparse evidence and approved engineering assumptions; do not fabricate precision. Report source sample and quality alongside every recommendation.

Supplier-performance measures require comparable context. Record delivery promise version, project changes, route, scope and attributed delay causes. Do not label a supplier as unreliable from an unadjusted late-arrival count. Failure rates need exposure and failure definitions; an asset count alone is insufficient.

# 14 Available inventory and reuse assessment

FR05 Before creating a purchase recommendation, search authorized inventory for suitable existing units. The search includes unassigned, released, repairable and forecast-available assets, but each candidate must expose its actual status and release conditions.

1\. Match functional duty, capacity, configuration, site conditions and approved compatibility.

2\. Read physical custody, business assignment, existing reservations, condition, warranty and earliest confirmed release date.

3\. Estimate transfer, refurbishment, modification, retesting, recommissioning and opportunity costs on the same basis as a new purchase.

4\. Obtain engineering and source/destination approvals; reserve only through the authoritative inventory service.

5\. Freeze the reuse assessment and sourcing-route decision. If a reservation expires or a release date changes, invalidate the availability claim and open a review action.

## Decision and stock rules

A search result is a candidate, not a stock reservation. Take an asset or quantity lock when committing a reservation so two projects cannot allocate the same availability. An expected release date does not create on-hand stock. For time-limited reservations, persist the authority, expiry and approval state and reconcile after interruption.

The same UUID follows a reused serialized asset. A project transfer changes assignment and/or custody with effective history; it does not generate another acquisition cost. Present a forward decision cost for reuse that excludes sunk purchase expenditure, while preserving the asset’s complete lifetime serial cost in its passport.

# 15 Sourcing packages and supplier offer normalization

FR06 Group approved requirement revisions into sourcing packages with explicit technical scope, quantities, required dates and evaluation criteria. The authoritative RFQ may be in GEP, another sourcing system or an enabled Procore workflow selected during discovery. The extension stores traceable references and comparable evaluation data.

| **Offer content** | **Required treatment**                                                                                                |
|-------------------|-----------------------------------------------------------------------------------------------------------------------|
| Version and scope | Supplier identity, offer version, validity, line/configuration, quantity, UOM and included/excluded work.             |
| Money             | Source currency, unit/line amounts, discounts, recoverable and nonrecoverable tax treatment, FX basis and price date. |
| Delivery          | Manufacturing assumptions, promised milestones, Incoterms, dispatch route and required buyer approvals.               |
| Ancillary work    | Freight, insurance, customs, unloading, storage, installation, consultants, testing and commissioning.                |
| Operational scope | Warranty conditions, maintenance contract, training, consumables, initial spares and replacement support.             |
| Adjustments       | Signed scope normalization amount, cost category, rationale, evidence, approver and allocation across offered lines.  |

## Calculation and commercial controls

Normalized installed cost equals the comparable equipment offer plus approved non-overlapping scope adjustments through readiness for use. An adjustment already included in a package or base line cannot be added again. Shared costs allocate by an approved driver with exact totals. An unpriced exclusion remains a visible unresolved estimate, not zero cost.

FR07 An offer revision preserves prior versions. A material change to price, configuration, scope, delivery or validity marks dependent evaluations stale. Supplier access is limited to its own package invitations, submissions and dispatch obligations. Other suppliers’ prices, internal benchmark costs and evaluation notes remain restricted.

# 16 Technical evaluation lifecycle scenarios and award

FR08 Evaluate mandatory technical compliance before commercial ranking. Engineering signs deviations and substitutions. An unresolved mandatory failure makes an option ineligible unless an explicitly authorized revised requirement or exception permits it. A high aggregate score cannot erase a failed safety or compatibility criterion.

FR09 Compare eligible options using an approved evaluation version. Criteria may include normalized installed cost, lifecycle expenditure, delivery suitability, support coverage and evidence quality. Define units, preferred direction, scoring function and weights in advance; weights sum to one. Keep mandatory gates distinct from weighted criteria. Unsupported evidence produces an explicit unknown or disqualifying state according to approved policy.

| **Illustrative measure**                        | **Option A** | **Option B** |
|-------------------------------------------------|--------------|--------------|
| Equipment price in millions                     | 1.00         | 1.08         |
| Additional installed scope in millions          | 0.30         | 0.17         |
| Installed total in millions                     | 1.30         | 1.25         |
| Five year operation and maintenance in millions | 1.10         | 0.85         |
| Five year expenditure in millions               | 2.40         | 2.10         |

These figures are invented examples on an equivalent scope and duty basis. They demonstrate why equipment price alone cannot establish the evaluated cost. Delivery evidence and technical eligibility must still be reviewed. The example is undiscounted and is not a vendor comparison or a promised saving.

## Award baseline

FR10 Approval freezes requirement revisions, offered configurations, quantities, quote versions, adjustment amounts, TCO scenario, delivery assumptions, evidence cutoff and selection reason. Split awards preserve line quantities by supplier. Changed upstream inputs create a new evaluation/approval requirement; the original award remains auditable. Purchase placement occurs only through the designated procurement authority.

# 17 PO integration and permanent asset identity

FR11 A requirement and selected option exist before physical units. Once the canonical PO is created, allocate one immutable UUID for each identifiable serialized unit. GEP and Oracle aliases resolve to the same canonical PO before identity generation. The authoritative PO issue event changes ordered commitments; technical identity alone does not create physical stock or financial capitalization.

| **Identity or record**    | **Lifecycle purpose**                                                                       |
|---------------------------|---------------------------------------------------------------------------------------------|
| Requirement UUID          | Stable functional need across draft revisions, option changes and physical replacements.    |
| Option and offer version  | Evaluated model/configuration and the supplier scope used in a selection.                   |
| Award line                | Approved source for selected quantity and configuration; supports split sourcing.           |
| PO line and schedule      | Authoritative purchase, delivery splits and project distribution references.                |
| Physical unit UUID        | Persistent serial lifecycle through receipt, installation, repair, transfer and retirement. |
| Financial asset reference | Native ERP ID and accounting book, linked through approved source-cost allocations.         |

## Quantity and amendment rules

Link award quantities to PO lines with explicit allocation quantities and UOM. An external PO may consolidate or split award lines; reconciliation must prove no over-allocation. Increases append planned unit IDs, unused cancellations retain history, and existing IDs are never recycled. A received unit cannot be removed by a source amendment.

A physical replacement receives a new UUID linked to the original requirement and recovery case. Repair of the same physical serial retains its UUID. Manufacturer serials and barcodes enrich the planned identity; shipping references identify transport legs and packages, not the permanent technical asset.

# 18 Long lead schedules arrival probability and risk

FR12 Link technical approval, manufacture, factory acceptance, dispatch, port/customs, inland transport, site receipt, installation and commissioning milestones. A backward procurement plan identifies the latest feasible order and approval dates from the required operational date. Use approved lead-time assumptions and calendars; disclose forecast uncertainty and dependencies.

1\. Supplier maps PO line/schedule and planned unit IDs to packing lists and shipment legs, with container/BOL/AWB and carrier references.

2\. A daily tenant-local job scans active shipment references, deduplicates shared containers or legs, and calls a licensed tracking service in bounded batches.

3\. Persist source milestones and immutable item-arrival snapshots with event time, recorded time, evidence cutoff, model version and quality.

4\. Evaluate the selected site date in the dashboard and show risks, receiving resources, inspection gates and owner actions.

| **Timeline value**    | **Precise meaning**                                                                                           |
|-----------------------|---------------------------------------------------------------------------------------------------------------|
| Arrival by date       | Cumulative probability F(d) of physical site delivery by the end of date d in site timezone.                  |
| Arrival on date       | F(d) minus F(d minus 1), using a consistent complete or explicitly truncated distribution.                    |
| Receiving readiness   | Access, unloading, crane/crew, storage and inspection readiness shown separately from arrival probability.    |
| Accepted availability | Receipt plus required acceptance/testing, kept distinct from port ETA and delivery.                           |
| Historical knowledge  | Use only evidence and snapshots recorded by asKnownAt; later discoveries do not rewrite what users knew then. |

Unknown probability is null with a reason. Do not claim universal global item tracking from a barcode. Lane, carrier, air/ocean and inland coverage must be proven with the selected provider. Shared shipment and supplier risks are correlated; group readiness cannot be calculated by multiplying independent probabilities without a validated model.

# 19 Components groups transfers and recovery

FR13 Keep physical structure, logical grouping, business assignment, actual custody and financial grouping as separate relationships. An installed subcomponent has effective parent/slot history; a logical group represents a set of assets and engineering readiness rules. Neither a group nor an accounting book creates extra stock.

| **Operation**              | **Required behaviour**                                                                                                                        |
|----------------------------|-----------------------------------------------------------------------------------------------------------------------------------------------|
| Component install/remove   | Check approved compatibility, slot, work order, effective time and custody; reject cycles and overlapping physical parents.                   |
| Group readiness            | Evaluate approved mandatory and redundancy rules over unique effective members. Count compatible engineering capacity only.                   |
| Project/DC assignment      | Record owner, project, destination site and cost code with validity; assignment alone does not move stock.                                    |
| Physical transfer          | Freeze selected members, approve source/destination, issue to transit, accept partial receipts and reconcile discrepancies.                   |
| Failure and partial return | Link the failed serial and test; remove only selected components; leave parent on site with the correct vacancy and readiness.                |
| Repair/replacement         | Same repaired serial keeps ID; another physical unit gets a new ID and lineage. Retest before release; retain warranty and recovery evidence. |

FR14 Group transfer or return expansion freezes a physical manifest and deduplicates descendants. Later membership or structure changes invalidate approval or require a controlled exception. Existing reservations and already-issued quantities must be reconciled under lock. Cross-entity legal ownership and financial postings remain subject to ERP/Finance controls.

The earlier implementation specification defines the core temporal structure, movement and cost invariants. This product adds links back to the original option and award decision so recurring failures and transfer outcomes can inform a subsequent BOQ evaluation.

# 20 Progressive asset handbook and acceptance

FR15 Generate the handbook progressively from the requirement and selected configuration. Use approved templates by equipment class, project and recipient role. Each criterion identifies a structured field, document or test, validation rule, responsible party, approval authority and applicable milestone.

| **Handbook content**      | **Minimum evidence**                                                                                                  |
|---------------------------|-----------------------------------------------------------------------------------------------------------------------|
| Requirement and selection | Approved specification, option, deviations, selected scope and authorized decision summary.                           |
| Procurement and identity  | PO/line, supplier, physical ID, serial, configuration, accessories and installed location.                            |
| Delivery and installation | Receipt/condition, installation evidence, approved component structure and position.                                  |
| Testing and acceptance    | FAT/SAT/commissioning results, failures, corrective work, retests and acceptance approvals.                           |
| Operation and maintenance | Current approved manuals, spares, maintenance requirements, service contacts and training records.                    |
| Warranty and finance      | Contractual commencement conditions, expiry basis and claims; restricted commercial/financial annex where authorized. |

## Readiness and controlled waivers

A file attachment alone does not prove a criterion is satisfied. Validate the correct model/serial, document revision, approval, completeness, expiry and required fields. Show each missing criterion with owner and due date. A waived criterion requires authority, reason, scope and expiry; a critical engineering requirement cannot be waived by an ordinary document administrator.

FR16 Publish an immutable package snapshot with scope, template version, evidence cutoff, entry manifest, source hashes and approval. Provide a human-readable handbook and structured FM/EAM export according to the agreed target schema. Recipient acceptance records accepted, conditional or rejected status with exceptions. Publication and recipient acceptance are separate milestones.

Later maintenance updates the continuing asset record. Republishing creates another version; the original handover package stays available. Define who maintains current data after the construction project is archived and how access transfers to the operating owner.

# 21 FM costs actual outcomes and future BOQ feedback

FR17 Import service work orders and contractor invoice distributions with actual service intervals, contract references, asset/position references, cost codes and source economic keys. Resolve the physical component installed when the service occurred. Invoice date alone is insufficient for service attribution.

1\. Validate invoice/distribution totals and resolve technical identities through source crosswalks.

2\. Split multi-asset and multi-site service costs by approved contract driver. Preserve original accounting posting and effective service attribution.

3\. Where service spans an assignment or component boundary, split the attribution with evidence; do not overwrite prior project history.

4\. Reconcile AP, work-order labour and material consumption so one economic charge is recognized once.

5\. Publish eligible actual costs and outcomes to benchmark observations with coverage and provenance; refresh future evaluation runs without rewriting approved awards.

## Cost ownership and quality

Unmapped amounts remain explicit unallocated leaves with reason, owner and due date. AP payment holds follow Finance policy. Credits and warranty recoveries reference original costs; financial-asset capitalization and depreciation do not create another expenditure cost. Shared parent/component/group rollups sum distinct approved allocation IDs.

## Learning cycle

FR18 New BOQ evaluations may use observed installed cost, operating expenditure, service exposure, commissioning failures and delivery performance. The evidence must show comparability and observation coverage. A product with two observed operating years contributes two actual years; later years require a separately labelled forecast. Cost intelligence should expose its sources and uncertainty, including when the best answer is insufficient comparable evidence.

# 22 Cost measures TCO and decision calculations

| **Measure**                        | **Calculation and boundary**                                                                                       |
|------------------------------------|--------------------------------------------------------------------------------------------------------------------|
| Normalized installed estimate      | Comparable offer plus approved non-overlapping cost adjustments until ready for use.                               |
| Recognized actual/provisional cost | Active economic revision and one approved allocation partition. Disclose provisional receipt valuation separately. |
| Projected lifetime TCO             | Recognized cost through cutoff plus forecast for uncovered future intervals, less documented recoveries.           |
| Open commitments                   | Display separately. Include in the remaining estimate only through an explicit non-duplicating scenario policy.    |
| Present value                      | Sum C(t) divided by (1+r)^t, with approved timing and nominal/real consistency.                                    |
| Forward reuse decision             | Incremental future transfer/refurbishment/operation cost; sunk purchase remains in lifetime history.               |
| Cost year                          | Operating age from in-service anniversary is distinct from fiscal/calendar year.                                   |

## Worked lifecycle example

In thousand AED, year 0 is purchase 1000, ancillary 120, installation 150, consultant 40 and commissioning 40, totalling 1350. Years 1 and 2 are 120 and 135. Year 3 is use/service 150 plus replacement 200, totalling 350. Year 4 is use/service 160 plus disposal 25 less recovery 50, totalling 135. Undiscounted expenditure is 2090; present value at 8 percent with end-year timing is approximately 1953.9. These are illustrative scenario assumptions, not observed supplier costs.

## Recognition and precision rules

Receipt provisional cost 1000 replaced by final invoice 1050 yields recognized cost 1050, with both source references. A delta policy is an alternative only when consistently implemented. Do not combine full replacement and a duplicate adjustment. Use exact decimal values for money and quantities; API amounts are strings. Retain original currency, tax/FX policy and deterministic rounding evidence. Closed periods and approved allocations use versioned corrections rather than destructive edits.

# 23 User interface structure and interaction rules

| **Workspace**           | **Primary content and actions**                                                                                                      |
|-------------------------|--------------------------------------------------------------------------------------------------------------------------------------|
| Planning and BOQ        | Requirement revisions, equipment options, benchmarks, reusable assets and evaluation links. Create/revise need and request sourcing. |
| Sourcing and award      | Packages, offer versions, scope adjustments, technical deviations, evaluation evidence and approvals.                                |
| Delivery and assets     | PO/serial register, timeline, shipment milestones, receiving readiness, component tree, transfers and recovery cases.                |
| Handbook and operations | Criterion readiness, owner actions, document validation, package publication/acceptance and continuing asset history.                |
| Cost intelligence       | Actual/provisional costs, commitments, remaining forecast, TCO scenarios, cohort quality and source drill-through.                   |
| Administration          | Procore and ERP links, source contracts, templates, engineering rules, jobs, access and exception queues.                            |

## Persistent context

Keep organization, Procore company/project mapping, data centre, requirement or asset identity, business date and evidence cutoff visible. Assigned destination and physical custody are separate fields. Use project context for workflow navigation, but maintain the same physical UUID after transfer or project closure. Shared views display only authorized fields and source evidence.

## Interaction and accessibility

FR19 Provide keyboard and typed-date control for the timeline, day/week/month zoom, clear probability labels and stale/unknown states. Preserve filters and deep-link context. Cancel superseded requests so a slower response cannot overwrite the newly selected date. Use semantic tables, labelled inputs and status text in addition to colour. Target the enterprise accessibility standard, proposed as WCAG 2.2 AA.

Forms validate scope, amounts and dates before submission and repeat validation on the server. If an ETag changes, reload affected fields for review. Confirmation for an award, transfer or handbook publication shows the concrete selected units, amounts and evidence version. Read-only historical views cannot serve as a current mutation baseline.

# 24 BOQ and supplier evaluation workspace

<img src="media/image2.png" style="width:7in;height:4.66667in" alt="Figure 2 Proposed BOQ evaluation screen with normalized cost and explicit unknown delivery evidence" />

*Figure 2 Proposed BOQ evaluation screen with normalized cost and explicit unknown delivery evidence*

The requirement header shows draft/approved revision, engineering duty, quantity/UOM, project cost code and operational need date. Comparison panels use a common horizon, currency and operating basis. Each result links to the actual cohort, source offer, approved adjustment and scenario assumptions.

Required actions are View Comparable Assets, Assess Reuse, Request Offers, Review Technical Deviations, Normalize Scope, Calculate Scenario and Submit Evaluation. A stale offer or changed requirement marks the comparison out of date. The approval dialog records selection reason and unresolved exceptions. A recommendation remains distinguishable from an approved award.

# 25 Asset passport handbook and operational screens

<img src="media/image3.png" style="width:7in;height:4.66667in" alt="Figure 3 Proposed progressive handbook screen with source validation and publication blockers" />

*Figure 3 Proposed progressive handbook screen with source validation and publication blockers*

The asset header retains UUID/code, model/configuration, serial, requirement, PO line, owner, assigned project/DC, actual custody, parent/position and readiness. Separate tabs show procurement lineage, shipment evidence, structure, tests, handbook criteria, lifetime costs, financial references and audit.

The handbook workbench filters by mandatory/optional status, owner, due date and validation outcome. A missing critical approval blocks publication. The transfer workbench shows frozen members, approvals and partial receipts. The FM workbench shows invoice/distribution, service interval, work order, resolved physical serial, original posting project, attributed service project and unallocated balance.

# 26 Architecture integration boundaries and deployment

<img src="media/image4.png" style="width:7in;height:4.66667in" alt="Figure 4 Proposed system boundaries with persistent source records shown as database symbols" />

*Figure 4 Proposed system boundaries with persistent source records shown as database symbols*

Use a modular application with a typed API and isolated background workers. Azure SQL is the proposed transactional store in continuity with the earlier design. Managed evidence storage retains authorized document snapshots and hashes. A durable queue/outbox supports integration and recalculation. Curated analytical facts support reporting without multiplying many-to-many cost joins.

A Procore-facing entry point may use a supported embedded app or authorized record/deep link, subject to current platform validation. An external secured workspace is a viable initial delivery route. Exact app registration, authentication modes, embedding, events, API resources, custom fields and rate limits are discovery dependencies. No undocumented vendor endpoint is specified here.

# 27 Record ownership and integration mappings

| **Information**                     | **Proposed authority**                             | **Extension responsibility**                                                                    |
|-------------------------------------|----------------------------------------------------|-------------------------------------------------------------------------------------------------|
| Project context and project records | Enabled Procore tools according to tenant decision | Store verified company/project/object crosswalks; expose contextual workflow links.             |
| Engineering need and design         | Declared engineering/estimating source             | Preserve canonical requirement and revision lineage plus option/evaluation references.          |
| Sourcing and authoritative award    | Configured GEP or procurement workflow             | Import versions, normalize comparison evidence and reconcile approved award to PO.              |
| PO receipt invoice and fixed assets | Configured Oracle/enterprise authority             | Map aliases, unit identities, economic costs and native financial asset/book references.        |
| Inventory and structure             | One declared inventory/EAM writer                  | Own only when the earlier extension is the declared authority; otherwise consume and reconcile. |
| Shipment events and ETA             | Licensed logistics source                          | Allocate to units/lots, preserve milestones and derive versioned site forecasts.                |
| Maintenance execution               | Declared FM/EAM platform                           | Resolve service-date identity and costs; export approved handbook data and ingest outcomes.     |
| Evaluation and handbook snapshots   | Extension                                          | Own frozen comparison/decision lineage and published evidence manifests.                        |

## Procore record mapping

An external link includes tenant, platform, company ID, project ID where applicable, object type, opaque object ID, domain entity type/ID, source revision and synchronization state. Do not assume a Procore project ID is globally sufficient for tenancy, that every API object supports custom fields, or that an external identity token conveys Procore access. Validate each object mapping and required operation using the intended principal.

Select one writer per business fact and record direction: source to extension, extension to source, or reconciled references. Outbound changes require the source’s supported workflow and permissions. A failed acknowledgement creates a pending exception; the UI must not claim the source record was updated. Preserve originating system identifiers across migration, export and account reconnection.

# 28 Data model continuity and common schema rules

The earlier developer pack proposes 53 current tables under alm, covering tenant, project, catalogue, requirement, PO, physical units, temporal relationships, movement, quality, cost allocation, financial bridge, arrival snapshots and TCO. This document proposes 24 additional pcx entities for planning, evaluation and handbooks. They are a logical/physical design candidate, not an executed migration or a new downloadable schema package.

| **Convention**       | **Implementation rule**                                                                                                                                            |
|----------------------|--------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| Tenant and identity  | UUID primary keys. Every pcx child uses tenant_id and composite foreign keys to tenant-scoped parent keys. Store source IDs as opaque strings.                     |
| Common fields        | id uniqueidentifier; tenant_id uniqueidentifier; created_at datetime2(3) UTC; created_by nvarchar(120); version rowversion for mutable resources.                  |
| Business fields      | Money decimal(19,4); quantities decimal(19,6); FX decimal(28,12); rates decimal(9,6); bounded nvarchar codes and UTC datetime2 values.                             |
| Structured rules     | JSON syntax check plus application validation of schema version, permitted fields, units, rule references and semantics. No executable code in user-supplied JSON. |
| Approved records     | Freeze approved requirement/evaluation/award snapshots and handbook packages. Supersede by new version; retain source revisions and actor evidence.                |
| History and deletion | Use business effective periods plus system knowledge/audit where required. No cascading deletion of posted cost or approved decision history.                      |
| Permissions          | Tenant membership, project scope, supplier scope and commercial-field policy apply to API, queries, evidence, jobs and exports.                                    |

## Requirement migration decision

Retain the canonical alm.requirement UUID as the functional need and add pcx.requirement_revision for immutable revision data. The existing current requirement row becomes the procurement-facing approved projection. A draft may start with a generic item class; approved projection fields change only through approval. If legacy imports created separate requirement UUIDs per revision, establish an explicit lineage crosswalk before consolidating; never silently change existing PO/asset foreign keys.

# 29 Schema for requirements options and benchmarks

Each name below is a proposed table in schema pcx. Common tenant/audit fields and SQL types are defined in the preceding section. FK denotes a tenant-scoped reference; exact migration and index names are implementation work.

| **Entity**           | **Principal fields**                                                                                                  | **Invariant and purpose**                                                                                              |
|----------------------|-----------------------------------------------------------------------------------------------------------------------|------------------------------------------------------------------------------------------------------------------------|
| requirement_revision | requirement_id FK; revision_no int; state code; quantity decimal; specification_json; required dates; approved_at UTC | Unique tenant/requirement/revision. Freeze on approval; keep previous approved projection while later drafts change.   |
| boq_revision         | project_id FK; source_key nvarchar; revision_no int; state; source_hash char(64); approved_at UTC                     | Unique tenant/source/revision. A reimport with another hash is a controlled correction, not a duplicate silent update. |
| boq_line_revision    | boq_revision_id FK; source_line_key; requirement_revision_id FK; quantity decimal; uom; budget_amount; currency       | Unique line key within revision. Validate project, requirement, UOM and cost-code coherence.                           |
| equipment_option     | item_definition_id FK; option_code; revision_no; manufacturer/model; configuration_json; technical_basis              | Unique option/revision. Compare generic or model configuration using approved technical evidence.                      |
| benchmark_run        | cohort_json; normalization_version; input_manifest_hash; evidence_cutoff; quality_json; state                         | Immutable published input set and model/rule version. No untraceable recalculation of an approved evaluation.          |
| benchmark_result     | benchmark_run_id FK; option_id FK; metric_code; basis; value_decimal nullable; unit; sample_count; coverage           | Unique run/option/metric/basis. Unknown value stays null; numerical ranges require defined meaning.                    |
| reuse_assessment     | requirement_revision_id FK; asset_id FK; assessed_at; available_from; cost_scenario_id FK; reservation_ref; state     | Version suitability and release evidence. Authoritative reservation prevents simultaneous allocation.                  |
| sourcing_package     | project_id FK; source_system; source_key; revision_no; state; bid_due_at; evaluation_policy_ref                       | Unique source package/revision. One designated source owns commercial workflow state.                                  |

# 30 Schema for sourcing and evaluation

Each name below is a proposed table in schema pcx. Common tenant/audit fields and SQL types are defined in the preceding section. FK denotes a tenant-scoped reference; exact migration and index names are implementation work.

<table>
<colgroup>
<col style="width: 23%" />
<col style="width: 37%" />
<col style="width: 39%" />
</colgroup>
<thead>
<tr class="header">
<th><strong>Entity</strong></th>
<th><strong>Principal fields</strong></th>
<th><strong>Invariant and purpose</strong></th>
</tr>
</thead>
<tbody>
<tr class="odd">
<td>sourcing_package_line</td>
<td>package_id FK; line_key; requirement_revision_id FK; quantity; uom; scope_json</td>
<td>Unique package/line. Track quantities through split bids and awards using controlled conversions.</td>
</tr>
<tr class="even">
<td>supplier_offer</td>
<td>package_id FK; supplier_key; source_offer_key; revision_no; currency; validity; incoterms; state</td>
<td>Unique source offer/revision. Material changes invalidate dependent draft/current evaluations.</td>
</tr>
<tr class="odd">
<td>offer_line</td>
<td>offer_id FK; package_line_id FK; option_id FK; quantity; unit_price; base_amount; promised_dates; scope_json</td>
<td>Unique source line within offer. Validate offered quantity, comparable scope and configuration.</td>
</tr>
<tr class="even">
<td>normalization_<br />
adjustment</td>
<td>offer_line_id FK; category; signed_amount; currency; fx_basis; evidence_ref; state</td>
<td>Version approvals and allocation driver. Reject a duplicate scope adjustment already included in price.</td>
</tr>
<tr class="odd">
<td>technical_deviation</td>
<td>offer_line_id FK; criterion_ref; severity; proposed_alternative; disposition; approver; evidence_ref</td>
<td>Mandatory criterion disposition is an eligibility gate. Keep engineering authority and audit.</td>
</tr>
<tr class="even">
<td>evaluation</td>
<td>package_id FK; revision_no; criteria_policy_json; input_manifest_hash; evidence_cutoff; state</td>
<td>Freeze offer/requirement/scenario versions and approved criteria. New inputs create a new version.</td>
</tr>
<tr class="odd">
<td>evaluation_score</td>
<td>evaluation_id FK; offer_line_id FK; criterion_code; raw_value; score nullable; weight; evidence_ref</td>
<td>Unique evaluation/offer-line/criterion. Check weights, normalization direction and missing-evidence policy.</td>
</tr>
<tr class="even">
<td>award_decision</td>
<td>evaluation_id FK; decision_version; state; selected_at; rationale; approved_by; source_award_ref</td>
<td>Approval checks unchanged input fingerprint, authority and mandatory technical gates.</td>
</tr>
</tbody>
</table>

# 31 Schema for award handbooks and external links

Each name below is a proposed table in schema pcx. Common tenant/audit fields and SQL types are defined in the preceding section. FK denotes a tenant-scoped reference; exact migration and index names are implementation work.

<table>
<colgroup>
<col style="width: 23%" />
<col style="width: 37%" />
<col style="width: 39%" />
</colgroup>
<thead>
<tr class="header">
<th><strong>Entity</strong></th>
<th><strong>Principal fields</strong></th>
<th><strong>Invariant and purpose</strong></th>
</tr>
</thead>
<tbody>
<tr class="odd">
<td>award_line</td>
<td>award_decision_id FK; package_line_id FK; offer_line_id FK; selected_quantity; option_id FK; scenario_ref</td>
<td>Split award total cannot exceed approved requirement. Preserve selected configuration and evaluated scope.</td>
</tr>
<tr class="even">
<td>requirement_po_<br />
allocation</td>
<td>award_line_id FK; po_line_id FK; allocated_quantity; uom; source_revision; state</td>
<td>Lock award/PO lines and check cumulative quantities. Prevent duplicate allocation under replay.</td>
</tr>
<tr class="odd">
<td>handbook_template</td>
<td>equipment_class_ref; template_code; revision_no; recipient_role; state; approved_at</td>
<td>Unique template/version/role. New template does not silently alter a published package.</td>
</tr>
<tr class="even">
<td>handbook_requirement</td>
<td>template_id FK; criterion_code; kind; mandatory; criticality; rule_json; responsible_role</td>
<td>Unique template/criterion. Version field/document/test validation and waiver authority.</td>
</tr>
<tr class="odd">
<td>handbook_package</td>
<td>project_id FK; scope_manifest; template_id FK; cutoff; state; package_hash; published_at; acceptance_state</td>
<td>Immutable publication binds selected asset units, template version and evidence. New version for changes.</td>
</tr>
<tr class="even">
<td>handbook_entry</td>
<td>package_id FK; asset_id FK; criterion_id FK; evidence_sequence int; source_ref; source_revision; hash; validation</td>
<td>Unique package/asset/criterion/evidence sequence. criterion_id references handbook_requirement. Keep validation and waiver/approval evidence.</td>
</tr>
<tr class="odd">
<td>external_object_link</td>
<td>platform; company_key; project_key nullable; object_type; object_key; domain_type; domain_id; revision; sync_state</td>
<td>Unique external namespace/object mapping. One-to-many mappings require explicit link role, not accidental duplicates.</td>
</tr>
<tr class="even">
<td>decision_evidence</td>
<td>subject_type; subject_id; evidence_id FK; role; input_revision; content_hash; recorded_at</td>
<td>Resolve polymorphic subject within tenant on command. Preserve permitted source evidence and digest.</td>
</tr>
</tbody>
</table>

# 32 State transitions transactions and consistency

| **Aggregate**            | **States and command controls**                                                                                                                                         |
|--------------------------|-------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| Requirement revision     | Draft → In Review → Approved → Superseded; Cancelled where permitted. Approval promotes current projection and opens downstream impact actions.                         |
| Offer and evaluation     | Received/Validated offers feed Draft/Calculated/In Review/Approved evaluation. Changed source versions mark current comparison Stale; approved evidence remains frozen. |
| Award                    | Draft → In Review → Approved → Sent to Procurement → Reconciled. Source rejection or unmatched PO remains an owned exception.                                           |
| Handbook                 | Draft → Validating → Ready → Approved → Published. Recipient acceptance is separate; later changes create another version.                                              |
| External synchronization | Pending → Applied or Rejected/Needs Review. Persist source acknowledgement before showing successful writeback.                                                         |

## Atomic command wrapper

1\. Authenticate and authorize tenant, project, supplier, action and protected fields. Resolve all linked IDs within scope.

2\. Begin transaction. Reserve idempotency key by tenant/principal/route; hash canonical request. Same key/body replays the response; another body conflicts.

3\. Take aggregate locks in deterministic order, validate current ETag and input fingerprints, and check business/quantity/financial invariants.

4\. Persist state, versioned evidence, audit and outbox in the same transaction; store the response and commit.

5\. Perform external calls asynchronously. Deduplicate responses/events and reconcile source authority; never hold a SQL transaction over a network call.

An ETag protects the resource version; it does not prevent a separate conflicting reservation or allocation row. Use database constraints and locks for quantities and concurrent relationships. Approved criteria and offer manifests must be checked again at award approval. Temporal assignment/component checks validate full overlapping intervals, not only open current rows.

# 33 Extension API events and background jobs

The following are proposed extension routes under /extension/v1, not Procore vendor endpoints. Use typed versioned request/response contracts, decimal strings, UTC times, bounded cursor pagination and safe problem responses. Current vendor resource names and payloads must be validated separately.

| **Command or query**             | **Request and result**                                                                                                |
|----------------------------------|-----------------------------------------------------------------------------------------------------------------------|
| POST requirements/{id}/revisions | Quantity, UOM, specification, need dates and prior version; returns draft revision ID and ETag.                       |
| POST benchmark-runs              | Requirement/option versions, cohort/basis, cutoff and normalization version; returns 202 job/run ID.                  |
| POST reuse-assessments           | Requirement revision, candidate physical unit and approved scenario inputs; returns suitability and evidence state.   |
| POST offers/import               | Canonical source offer/line revisions and evidence; durable inbox acceptance, mapping errors retained.                |
| POST evaluations                 | Package, exact input versions and approved criteria policy; calculated results with eligibility and unknowns.         |
| POST awards/{id}/approve         | If-Match, decision reason and frozen input fingerprint; authority and quantity validation before approval.            |
| POST handbooks                   | Exact scope and template version with evidence cutoff; returns draft package ID and ETag.                             |
| POST handbooks/{id}/validate     | Runs typed field/document/test checks; 202 job and criterion-level results.                                           |
| POST handbooks/{id}/publish      | Approval evidence, current ETag and manifest hash; returns immutable package version and permitted export references. |
| GET assets/{id} and timeline     | Authorized identity/history, selectedDate and asKnownAt; forecasts and readiness remain separate.                     |

## Events and job behaviour

Use RequirementRevisionApproved, BenchmarkPublished, EvaluationInvalidated, AwardApproved, AwardPoReconciled, HandbookValidated, HandbookPublished and AssetOutcomeObserved alongside the earlier asset/cost events. Envelopes include event UUID, tenant, aggregate/version, schema version, occurred/recorded time and correlation ID. Consumers deduplicate and verify their allowed scope.

Workers perform source reconciliation, deduplicated daily tracking, benchmark refresh, forecast recalculation and handbook export. Persist checkpoints only after durable processing. Retry transient failures with bounded backoff and provider guidance; send permanent mapping/schema failures to an owned queue. Webhook coverage/authenticity and fallback polling must follow the actual vendor contract.

# 34 Security data quality and model governance

| **Control**                    | **Required behaviour**                                                                                                                                                |
|--------------------------------|-----------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| Tenant/project isolation       | Server-verified membership, tenant-scoped foreign keys, per-project authorization and consistent worker/export/evidence scope.                                        |
| Supplier and commercial access | Supplier can submit its own offers and dispatch data. Restrict competing bids, internal costs, evaluation notes and financial annexes.                                |
| Procore connection             | Validate documented authorization mode and least privileges. Encrypt token references, support revocation and recheck mapped project access.                          |
| Approvals and audit            | Actor, role, reason, source/version, correlation and evidence for awards, waivers, allocations and publication. Enforce delegated authority.                          |
| Evidence storage               | Authorized access, malware/type/size checks, hashes, retention and permitted snapshot rules. Do not assume unrestricted copying of external documents.                |
| Quality and freshness          | Expose missing identities, unallocated amounts, stale source runs, failed mappings and incomplete operating periods with owners.                                      |
| AI and calculation             | Use AI for extraction, candidate retrieval and explained estimates. Deterministic approved rules calculate totals and enforce eligibility.                            |
| Model change                   | Version cohorts, feature definitions and models; time-based holdouts and coverage/error checks. Approval required before a model changes a production recommendation. |

Untrusted supplier files and text cannot change system rules, weights or approvals. Extracted values show source evidence and validation status before becoming authoritative inputs. A model must not invent an ETA, technical certification, warranty term or missing cost. Source-based explanations should separate observed facts, normalized estimates and forecast assumptions.

Cross-project benchmarking may require additional commercial entitlement or approved aggregation. A user who can see an aggregate cohort need not receive another project’s raw invoice. Define de-identification and minimum cohort policies where required, while preserving internal audit lineage for authorized reviewers.

# 35 Analytics operational targets and resilience

| **Dataset or measure**           | **Grain and calculation control**                                                                                                                 |
|----------------------------------|---------------------------------------------------------------------------------------------------------------------------------------------------|
| Requirement and evaluation facts | One immutable revision or evaluated offer/criterion; compare against the exact approved baseline.                                                 |
| Economic cost facts              | One approved allocation leaf on one active economic revision. Separate provisional, actual, commitment and forecast measures.                     |
| Asset exposure and failure facts | Physical unit/component and service exposure interval; define failure type, duty and attribution.                                                 |
| Arrival facts                    | Physical unit/lot and immutable snapshot; selected date and knowledge cutoff remain explicit.                                                     |
| Handbook facts                   | Package/asset/criterion version and validation result; accepted/waived/missing counts shown separately.                                           |
| Pilot benefit measures           | Evaluation coverage, attribution coverage, late-risk actions and handover readiness compared with agreed baseline; no unsupported savings claims. |

## Proposed technical targets

Validate p95 under two seconds for paged asset/detail and comparison reads and under three seconds for a cached timeline slice of 100 rows, at agreed pilot volume. Long benchmark/import/export jobs return promptly with durable progress. Establish rate limits, pagination and provider quotas from actual contracts. These are acceptance targets, not measured results.

## Recovery and service operation

Track job age, rejected records, outbox backlog, stale forecasts, mapping drift, allocation balances and publication failures. Liveness is distinct from dependency readiness. Exercise restore, token revocation/reconnection, source replay, partial-batch restart and failed export recovery. Define recovery time, recovery point and retention commitments only after platform and business approval.

An unavailable source leaves the last valid evidence visibly stale. A lost outbound acknowledgement does not trigger an unbounded duplicate award or financial update. Reconcile by stable source/business keys before replaying uncertain outcomes. Restrict direct modification of immutable package evidence and keep release/configuration changes auditable.

# 36 Acceptance tests and capability traceability

| **Test** | **L1** | **Acceptance evidence**                                                                                                                          |
|----------|--------|--------------------------------------------------------------------------------------------------------------------------------------------------|
| T01      | B01    | Draft requirement receives one stable UUID before product selection; duplicate source revision does not create another need.                     |
| T02      | B01    | An approved BOQ baseline stays intact while a new draft changes quantity or specification; downstream impact actions are visible.                |
| T03      | B02    | Benchmark shows actual observation count, duty, currency/scope basis and missing coverage; incompatible duty is excluded or explicitly adjusted. |
| T04      | B02    | Sparse data produces an insufficient-evidence result; later operating years remain forecasts.                                                    |
| T05      | B02    | Two projects attempt to reserve the same existing unit; only one authoritative reservation succeeds.                                             |
| T06      | B02    | Reuse comparison excludes sunk purchase from forward cost and includes approved transfer/refurbishment/retest costs.                             |
| T07      | B03    | Offer revision preserves prior quote; a missing freight/install scope is priced or explicitly unresolved, never silently zero.                   |
| T08      | B03    | A failed mandatory technical criterion blocks ordinary award even when weighted price score is high.                                             |
| T09      | B03    | Offer or requirement changes after evaluation mark the comparison stale and prevent approval against the old fingerprint.                        |
| T10      | B03    | Split awards and their PO allocations conserve approved quantities and retain exact option/offer versions.                                       |
| T11      | B04    | GEP/Oracle duplicate PO aliases create one canonical line and the authorized number of permanent unit IDs.                                       |
| T12      | B04    | Same unit is not received or shipment-allocated twice under replay; cancelled IDs are not reused.                                                |
| T13      | B04    | Slider returns different on-date/by-date probabilities, distinct receiving readiness and explicit unknown values.                                |
| T14      | B04    | A late-recorded carrier event is absent from the prior as-known view; failed provider calls expose staleness and owned actions.                  |
| T15      | B05    | Concurrent or historical overlapping parent attachment, occupied slot and component cycle are rejected.                                          |
| T16      | B05    | Partial component return leaves the parent on site with a vacancy; new replacement gets a new ID, repaired same serial retains its ID.           |
| T17      | B05    | Transfer manifest deduplicates descendants; partial receipt leaves remaining quantities in transit and changed structure invalidates approval.   |
| T18      | B06    | Receipt 1000 plus final replacement invoice 1050 yields recognized cost 1050 with both source references.                                        |
| T19      | B06    | Allocation rounding balances exactly; parent/component/group views sum distinct allocation leaves once.                                          |
| T20      | B06    | FM service spanning a transfer resolves the serviced unit and project at service date while retaining original posting lineage.                  |
| T21      | B06    | Illustrative lifecycle example totals 2090 thousand AED and PV about 1953.9 at 8 percent with declared timing.                                   |
| T22      | B07    | Wrong-model or unapproved document fails the applicable handbook criterion despite an attached file being present.                               |
| T23      | B07    | Missing critical acceptance blocks publication; a permitted waiver records authorized scope, reason and expiry.                                  |
| T24      | B07    | Published package hash and evidence stay immutable after a later document/maintenance update; next publication creates another version.          |
| T25      | B07    | Recipient receives allowed structured fields and handbook; commercial annex and unrelated project data remain inaccessible.                      |
| T26      | B08    | Cross-tenant references/read access fail; supplier cannot see competing offers or internal cost evidence.                                        |
| T27      | B08    | Duplicate requests, source events and outbox replay produce one business effect; an unknown acknowledgement is reconciled before replay.         |
| T28      | B08    | Restore, reconnect and backfill preserve identity and approved snapshots without overwriting newer current source state.                         |

These are product-build acceptance scenarios, not tests executed during document preparation. Map each L3 story to its detailed functional requirement, domain command and one or more of these scenarios; add source-specific contract and authorization cases after discovery.

# 37 Release roadmap and pilot design

| **Release stage**               | **Scope and exit gate**                                                                                                                                     |
|---------------------------------|-------------------------------------------------------------------------------------------------------------------------------------------------------------|
| Discovery and reuse decision    | Classify Procore/native/configuration/partner/integration gaps; approve record ownership, sample payloads and pilot evidence.                               |
| MVP planning to purchase        | One equipment class, draft/approved requirement, benchmark coverage, offer normalization, technical gate, frozen award and canonical PO/unit linkage.       |
| MVP handover and feedback       | Track receipt and acceptance, collect a minimal approved handbook and import at least one real service/cost distribution to demonstrate the feedback chain. |
| Extended delivery and assets    | Licensed shipment tracking, dated arrival projections, receiving readiness, transfer/repair and deeper component/group rules.                               |
| Portfolio and operational scale | Broader equipment classes, approved FM/EAM export, full cost coverage, automated cohort refresh and validated scenario/model improvements.                  |

## Pilot data and operating boundaries

Select one active project and one equipment class such as gensets, plus available historical projects and operating assets that have comparable evidence. Do not set a minimum statistical cohort by inventing sample sufficiency; approve a threshold based on intended measures and disclose where data is sparse. Use only authorized source records and permitted commercial data.

The pilot should demonstrate one complete chain: a draft requirement uses prior evidence, an eligible option is evaluated and approved, a PO resolves to physical IDs, a received unit accumulates acceptance evidence, a handbook is published, and an actual service/cost record updates a later benchmark. Manual validated logistics evidence can precede predictive modelling, while the full tracking capability remains in the roadmap.

## Delivery planning

Work packages cover domain/product analysis, Procore integration, ERP/FM adapters, transactional backend, analytical models, frontend, quality/security and platform operations. Estimate schedule, team and cost after source access and discovery; no fixed delivery duration is asserted here. Each release needs passing relevant acceptance tests, reconciled data and an operational exception owner.

# 38 Implementation decisions migration and open dependencies

| **Decision**                     | **Required owner and evidence**                                                                                                                      |
|----------------------------------|------------------------------------------------------------------------------------------------------------------------------------------------------|
| Procore fit and connection model | Administrator/architect confirms licensed tools, installed apps, embedding/authentication options, API operations and permissions with test records. |
| Source authorities               | Procurement, Finance, inventory and FM owners choose one writer for each fact and approve change/replay semantics.                                   |
| Accounting and evaluation policy | Finance/engineering approve tax/FX, recognition, allocation, duty normalization, technical gates, scoring and TCO basis.                             |
| Asset and handbook standards     | Engineering/FM approve serial depth, compatibility, template criteria, waiver authority, target export schema and recipient acceptance.              |
| Commercial data use              | Data owner approves cross-project benchmark visibility, evidence retention, vendor licensing and publication annex access.                           |
| Operational targets              | Platform owner measures volume, latency, source quotas and recovery drills before committing service levels.                                         |

## Migration sequence

Reuse existing tenant/project/site/catalogue and technical IDs. Profile duplicate source requirements and serials; establish approved legacy crosswalks. Import BOQ/offer/evaluation history only where evidence supports it. Load opening costs with lineage and reconcile against detailed invoices so migration does not duplicate expenditure. Missing service dates or model configurations remain quality exceptions.

Apply additive schema changes, backfill and shadow the new projections, then switch approved writers under a controlled source boundary. Keep previous interfaces during an agreed transition. After operational facts exist, rollback disables new writers and uses forward corrections; it does not delete the asset or decision history. The document itself does not execute a migration or alter a live Procore/ERP account.

# 39 Reference basis glossary and review checklist

## Source basis and verification status

The functional basis is the requirements discussed in this conversation and the Asset Lifecycle Product Implementation Specification version 1.0 dated 20 October 2026. This document adds pre-award evaluation and progressive handbook detail. The prior SQL/API developer pack is a reference design; its engine and live-integration validation limits continue to apply.

The following are official starting points for discovery. Their current content was not successfully retrieved in this session, so they are not evidence that a specific feature exists or is missing: Procore Support https://support.procore.com/ ; Procore Marketplace https://marketplace.procore.com/ ; Procore Developers https://developers.procore.com/ . Capture exact pages, dates, product/tenant versions and test results when closing each discovery row.

| **Term**             | **Meaning in this product**                                                                     |
|----------------------|-------------------------------------------------------------------------------------------------|
| BOQ                  | Bill of quantities and its controlled requirement/line revisions.                               |
| PMIS                 | Project management information system; Procore is the proposed project-facing environment.      |
| LLE                  | Long lead equipment requiring planned technical, manufacturing and delivery milestones.         |
| TCO                  | Total cost of ownership over a declared horizon, scope and price/discount basis.                |
| Asset handbook       | Approved document and structured-data package at a defined evidence cutoff.                     |
| Digital asset record | Continuing identity, component, service and cost history after handover.                        |
| As known at          | Knowledge cutoff excluding facts recorded later, even if their business event date was earlier. |

## Review checklist

- Product owner confirms the intended users, decisions, scope and phased benefits.

- Procore administrator closes native/configuration/partner discovery before custom duplication.

- Engineering, procurement, Finance and FM approve authority and evidence rules.

- Development team converts the proposed schema/API contracts into versioned migrations and implementation stories.

- QA verifies the 28 scenarios plus detailed source/role cases, and operations proves repair/replay and restore.
