import { createHash } from "node:crypto";
import type { Db, Queryable } from "../db.js";
import { boqFileKey, type FileStore } from "../filestore.js";
import { audit } from "../sync.js";
import { detectFormat, parseCsv, parsePdf, parseXlsx, UnsupportedDocument, type ParsedDocument, type SourceRow } from "./parse.js";
import { classify, compactCode, containsPhrase, headingLevel, itemMatchKey, parseQuantity, sameProjectName, UomTable, type Uom } from "./normalize.js";

export class InputError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

export interface SubmitInput {
  projectId: string;
  fileName: string;
  mimeType: string | null;
  content: Buffer;
  sourceTool: "procore" | "upload" | "other";
  /** Procore context of the submission location (cross-checked against the project). */
  procoreProjectId?: number | null;
  procoreDocumentId?: string | null;
  sourceRevision?: string | null;
  /** Identity of the BOQ document across revisions; defaults to the Procore document id or the file name stem. */
  documentKey?: string | null;
  submittedBy: string;
}

export interface SubmitResult {
  revisionId: string;
  duplicate: boolean;
  supersededRevisionId: string | null;
}

interface WorkPackage {
  work_package_id: string;
  code: string;
  name: string;
  match_terms: string[];
}
interface CostAssignment {
  cost_assignment_id: string;
  work_package_id: string;
  budget_code: string | null;
  cost_code: string;
  cost_type: string | null;
}
interface Structure {
  wps: WorkPackage[];
  cas: CostAssignment[];
}
interface LineRecord {
  boq_line_id: string;
  project_id: string;
  boq_revision_id: string;
  line_type: string;
  sheet_name: string | null;
  source_locator: string;
  section_path: string[];
  raw_item_code: string | null;
  raw_description: string | null;
  raw_specification: string | null;
  raw_uom: string | null;
  stated_wbs_reference: string | null;
  stated_cost_code: string | null;
  organization_id: string;
  normalized_quantity: string | null;
  normalized_uom_id: string | null;
  item_id: string | null;
  raw_quantity: string | null;
  validation_status: string;
  validation_messages: unknown;
  mapping_status: string;
  resolution_note: string | null;
  resolved_by: string | null;
  proposed_work_package_id: string | null;
  proposed_cost_assignment_id: string | null;
}

const sha256 = (b: Buffer) => createHash("sha256").update(b).digest("hex");
const SYSTEM = "system:boq-mapping";

export function defaultDocumentKey(fileName: string) {
  const stem = fileName
    .replace(/\.[^.]+$/, "")
    .replace(/\(\d+\)$/, "")
    .replace(/[\s_-]*(rev(ision)?|r|v)[\s_.-]*[0-9a-z]{1,3}$/i, "")
    .trim()
    .toLowerCase();
  return `file:${stem}`;
}

export async function loadUoms(q: Queryable, organizationId: string) {
  return new UomTable((await q.query<Uom>("select uom_id, code, measurement_dimension, aliases from units_of_measure where organization_id = $1", [organizationId])).rows);
}

async function loadStructure(q: Queryable, projectId: string): Promise<Structure> {
  const wps = (await q.query<WorkPackage>(`select work_package_id, code, name, match_terms from work_packages where project_id = $1 and status = 'active'`, [projectId])).rows;
  const cas = (
    await q.query<CostAssignment>(
      `select cost_assignment_id, work_package_id, budget_code, cost_code, cost_type from cost_assignments where project_id = $1 and status = 'approved'`,
      [projectId],
    )
  ).rows;
  return { wps, cas };
}

async function parseDocument(fileName: string, mimeType: string | null, content: Buffer, uoms: UomTable): Promise<ParsedDocument> {
  const fmt = detectFormat(fileName, mimeType, content);
  if (fmt === "xlsx") return parseXlsx(content);
  if (fmt === "csv") return parseCsv(content, fileName);
  if (fmt === "pdf") return parsePdf(content, (u) => uoms.resolve(u) !== null);
  throw new UnsupportedDocument(`Unsupported file type: ${fileName}. Submit an Excel (.xlsx), CSV or PDF BOQ.`);
}

// ---------------------------------------------------------------------------------------------------------------
// Mapping: a line's work package comes from explicit codes, its BOQ headings, or its sheet; never from the item
// description alone ("copper cable" does not say whether it is for the UPS or the chillers).
// ---------------------------------------------------------------------------------------------------------------

export interface MappingResult {
  workPackageId: string | null;
  costAssignmentId: string | null;
  basis: string | null;
  messages: string[];
}

const termsOf = (w: WorkPackage) => [w.name, ...(w.code.replace(/\W/g, "").length >= 3 ? [w.code] : []), ...w.match_terms].filter((t) => t && t.trim());

function wpsIn(text: string, s: Structure) {
  return s.wps.filter((w) => termsOf(w).some((t) => containsPhrase(text, t)));
}

export function mapLine(line: Pick<LineRecord, "section_path" | "sheet_name" | "stated_cost_code" | "stated_wbs_reference">, s: Structure): MappingResult {
  const messages: string[] = [];
  let explicitWp: string | null = null;
  let explicitCa: CostAssignment | null = null;
  let explicitBasis: string | null = null;

  if (line.stated_cost_code) {
    const code = compactCode(line.stated_cost_code);
    const byBudget = s.cas.filter((c) => c.budget_code && compactCode(c.budget_code) === code);
    if (byBudget.length === 1) {
      explicitCa = byBudget[0]!;
      explicitWp = explicitCa.work_package_id;
      explicitBasis = `budget code ${line.stated_cost_code}`;
    } else {
      const wpIds = [...new Set(s.cas.filter((c) => compactCode(c.cost_code) === code).map((c) => c.work_package_id))];
      const wpByCode = s.wps.filter((w) => compactCode(w.code) === code).map((w) => w.work_package_id);
      const ids = [...new Set([...wpIds, ...wpByCode])];
      if (ids.length === 1) {
        explicitWp = ids[0]!;
        explicitBasis = `cost code ${line.stated_cost_code}`;
      } else if (ids.length > 1) messages.push(`Cost code ${line.stated_cost_code} matches several work packages`);
      else messages.push(`Cost code ${line.stated_cost_code} is not in the project's approved WBS / budget codes`);
    }
  }
  if (line.stated_wbs_reference) {
    const byCode = s.wps.filter((w) => compactCode(w.code) === compactCode(line.stated_wbs_reference));
    const found = byCode.length ? byCode : wpsIn(line.stated_wbs_reference, s);
    if (found.length === 1) {
      if (explicitWp && explicitWp !== found[0]!.work_package_id) {
        messages.push(`Stated work package "${line.stated_wbs_reference}" conflicts with ${explicitBasis}`);
        return { workPackageId: null, costAssignmentId: null, basis: null, messages };
      }
      explicitWp = found[0]!.work_package_id;
      explicitBasis ??= `stated work package "${line.stated_wbs_reference}"`;
    } else if (found.length > 1) messages.push(`Stated work package "${line.stated_wbs_reference}" matches several work packages`);
    else messages.push(`Stated work package "${line.stated_wbs_reference}" is not in the project's WBS`);
  }

  let contextWp: string | null = null;
  let contextBasis: string | null = null;
  for (const heading of [...line.section_path].reverse()) {
    const found = wpsIn(heading, s);
    if (found.length === 1) {
      contextWp = found[0]!.work_package_id;
      contextBasis = `BOQ heading "${heading}"`;
      break;
    }
    if (found.length > 1) {
      messages.push(`Heading "${heading}" names several work packages (${found.map((w) => w.name).join(", ")})`);
      break;
    }
  }
  if (!contextWp && line.sheet_name) {
    const found = wpsIn(line.sheet_name, s);
    if (found.length === 1) {
      contextWp = found[0]!.work_package_id;
      contextBasis = `sheet "${line.sheet_name}"`;
    }
  }

  if (explicitWp && contextWp && explicitWp !== contextWp) {
    messages.push(`${explicitBasis} conflicts with ${contextBasis}`);
    return { workPackageId: null, costAssignmentId: null, basis: null, messages };
  }
  const wp = explicitWp ?? contextWp;
  const basis = explicitWp ? explicitBasis : contextBasis;
  if (!wp) {
    if (!messages.length) messages.push("No work package stated: no cost code, WBS reference, heading or sheet identifies it (the description alone does not)");
    return { workPackageId: null, costAssignmentId: null, basis: null, messages };
  }
  if (explicitCa) return { workPackageId: wp, costAssignmentId: explicitCa.cost_assignment_id, basis, messages };
  const cas = s.cas.filter((c) => c.work_package_id === wp);
  if (cas.length === 1) return { workPackageId: wp, costAssignmentId: cas[0]!.cost_assignment_id, basis, messages };
  messages.push(cas.length ? `Work package has ${cas.length} cost assignments; choose one` : "Work package has no approved cost assignment");
  return { workPackageId: wp, costAssignmentId: null, basis, messages };
}

// ---------------------------------------------------------------------------------------------------------------

async function findOrCreateItem(q: Queryable, organizationId: string, line: LineRecord, uom: Uom, actor: string): Promise<string> {
  const description = line.raw_description ?? "";
  const key = itemMatchKey(description, line.raw_specification, uom.measurement_dimension);
  const found = await q.query<{ item_id: string }>(
    `select item_id from item_definitions where organization_id = $1 and match_key = $2 and verification_status <> 'rejected' order by created_at limit 1`,
    [organizationId, key],
  );
  if (found.rows[0]) return found.rows[0].item_id;
  const created = await q.query<{ item_id: string }>(
    `insert into item_definitions (organization_id, name, specification_text, match_key, base_uom_id, tracking_mode, verification_status, created_by)
     values ($1, $2, $3, $4, $5, $6, 'provisional', $7) returning item_id`,
    [organizationId, description, line.raw_specification, key, uom.uom_id, uom.measurement_dimension === "lot" ? "batch" : "bulk", actor],
  );
  return created.rows[0]!.item_id;
}

async function allocate(q: Queryable, organizationId: string, line: LineRecord, costAssignmentId: string, quantity: number, basis: string, actor: string) {
  const ca = (await q.query<{ work_package_id: string }>(`select work_package_id from cost_assignments where cost_assignment_id = $1 and project_id = $2`, [costAssignmentId, line.project_id])).rows[0];
  if (!ca) throw new InputError("Cost assignment is not part of this BOQ line's project");
  const req = await q.query<{ inventory_record_id: string }>(
    `insert into inventory_requirements (organization_id, project_id, work_package_id, cost_assignment_id, item_id, uom_id, item_description, specification, status, created_by)
     values ($1, $2, $3, $4, $5, $6, $7, $8, 'active', $9)
     on conflict (project_id, work_package_id, cost_assignment_id, item_id, uom_id, status) do update set updated_at = now()
     returning inventory_record_id`,
    [organizationId, line.project_id, ca.work_package_id, costAssignmentId, line.item_id, line.normalized_uom_id, line.raw_description, line.raw_specification, actor],
  );
  // An earlier decision on the same line and requirement is kept as 'rejected' and approved again here, never deleted.
  await q.query(
    `insert into requirement_boq_allocations (organization_id, project_id, inventory_record_id, boq_line_id, allocated_quantity, uom_id, approval_status, basis, approved_by, approved_at, created_by)
     values ($1, $2, $3, $4, $5, $6, 'approved', $7, $8, now(), $8)
     on conflict (inventory_record_id, boq_line_id) do update set allocated_quantity = excluded.allocated_quantity, uom_id = excluded.uom_id,
        approval_status = 'approved', basis = excluded.basis, approved_by = excluded.approved_by, approved_at = now()`,
    [organizationId, line.project_id, req.rows[0]!.inventory_record_id, line.boq_line_id, quantity, line.normalized_uom_id, basis, actor],
  );
}

async function getLine(q: Queryable, lineId: string) {
  const l = (await q.query<LineRecord>(`select * from boq_lines where boq_line_id = $1`, [lineId])).rows[0];
  if (!l) throw new InputError("BOQ line not found", 404);
  return l;
}

/** Previous revision's resolution of the same source line (same sheet, code and description). */
async function carriedResolution(q: Queryable, prevRevisionId: string | null, line: LineRecord) {
  if (!prevRevisionId) return null;
  const prev = (
    await q.query<{ boq_line_id: string; normalized_quantity: string | null; normalized_uom_id: string | null; mapping_status: string }>(
      `select boq_line_id, normalized_quantity, normalized_uom_id, mapping_status from boq_lines
       where boq_revision_id = $1 and line_type = 'item' and coalesce(sheet_name, '') = coalesce($2, '') and coalesce(raw_item_code, '') = coalesce($3, '')
         and raw_description = $4 and mapping_status in ('mapped', 'split') limit 1`,
      [prevRevisionId, line.sheet_name, line.raw_item_code, line.raw_description],
    )
  ).rows[0];
  if (!prev) return null;
  const allocs = (
    await q.query<{ cost_assignment_id: string; work_package_id: string; allocated_quantity: string }>(
      `select r.cost_assignment_id, r.work_package_id, a.allocated_quantity from requirement_boq_allocations a
       join inventory_requirements r on r.inventory_record_id = a.inventory_record_id
       where a.boq_line_id = $1 and a.approval_status = 'approved'`,
      [prev.boq_line_id],
    )
  ).rows;
  return { prev, allocs };
}

/**
 * Re-applies a reviewer's rejection or extraction correction from the previous revision when the source line is
 * unchanged (same sheet, code, description, specification, raw quantity and raw unit).
 */
async function carryLineDecisions(q: Queryable, prevRevisionId: string, line: LineRecord): Promise<LineRecord> {
  if (line.line_type !== "item") return line;
  const p = (
    await q.query<LineRecord>(
      `select * from boq_lines where boq_revision_id = $1 and resolved_by is not null
         and coalesce(sheet_name, '') = coalesce($2, '') and coalesce(raw_item_code, '') = coalesce($3, '') and coalesce(raw_description, '') = coalesce($4, '')
         and coalesce(raw_specification, '') = coalesce($5, '') and coalesce(raw_quantity, '') = coalesce($6, '') and coalesce(raw_uom, '') = coalesce($7, '')
       order by resolved_at desc limit 1`,
      [prevRevisionId, line.sheet_name, line.raw_item_code, line.raw_description, line.raw_specification, line.raw_quantity, line.raw_uom],
    )
  ).rows[0];
  if (!p) return line;
  if (p.mapping_status === "rejected") {
    return (
      await q.query<LineRecord>(
        `update boq_lines set mapping_status = 'rejected', resolution_note = $2, resolved_by = $3, resolved_at = now(), updated_at = now() where boq_line_id = $1 returning *`,
        [line.boq_line_id, `carried from the previous revision: ${p.resolution_note ?? ""}`.trim(), p.resolved_by],
      )
    ).rows[0]!;
  }
  const num = (v: string | null) => (v === null ? null : Number(v));
  const corrected = p.line_type !== "item" || p.validation_status !== line.validation_status || num(p.normalized_quantity) !== num(line.normalized_quantity) || p.normalized_uom_id !== line.normalized_uom_id;
  if (!corrected) return line;
  return (
    await q.query<LineRecord>(
      `update boq_lines set line_type = $2, normalized_quantity = $3, normalized_uom_id = $4, validation_status = $5, validation_messages = $6::jsonb,
          mapping_status = case when $2 = 'item' then 'unmapped' else 'not_applicable' end,
          resolution_note = 'correction carried from the previous revision', resolved_by = $7, resolved_at = now(), updated_at = now()
       where boq_line_id = $1 returning *`,
      [line.boq_line_id, p.line_type, p.normalized_quantity, p.normalized_uom_id, p.validation_status, JSON.stringify(p.validation_messages ?? []), p.resolved_by],
    )
  ).rows[0]!;
}

/**
 * Keeps the line's entry in the exception queue (mapping_exceptions) in step with its state: an item whose quantity or
 * unit cannot be read, or that no work package / cost assignment can be attributed to, has one open exception; once the
 * line is published, corrected or rejected the exception is resolved or dismissed with the reason.
 */
async function syncExceptions(q: Queryable, organizationId: string, lineId: string, actor: string) {
  const l = (await q.query<LineRecord & { mapping_basis: string | null }>(`select * from boq_lines where boq_line_id = $1`, [lineId])).rows[0]!;
  const msgs = (Array.isArray(l.validation_messages) ? l.validation_messages : []) as { kind?: string; message?: string }[];
  const text = (kind: string) => msgs.filter((m) => m.kind === kind).map((m) => m.message).join("; ");
  let want: { type: string; detail: string } | null = null;
  if (l.line_type === "item" && l.mapping_status !== "rejected") {
    if (l.validation_status === "invalid") {
      const v = text("validation");
      want = { type: /unit/i.test(v) && !/quantity/i.test(v) ? "uom_unresolvable" : "quantity_invalid", detail: v || "The quantity or unit cannot be read" };
    } else if (l.mapping_status === "unresolved" || l.mapping_status === "unmapped") {
      want = { type: l.proposed_work_package_id ? "other" : "unattributed_work_package", detail: text("mapping") || "No work package identified" };
    }
  }
  const open = (
    await q.query<{ mapping_exception_id: string; exception_type: string }>(
      `select mapping_exception_id, exception_type from mapping_exceptions where boq_line_id = $1 and state in ('open', 'in_review')`,
      [lineId],
    )
  ).rows;
  for (const e of open) {
    if (want && e.exception_type === want.type) {
      await q.query(`update mapping_exceptions set exception_detail = $2 where mapping_exception_id = $1`, [e.mapping_exception_id, want.detail]);
      want = null;
      continue;
    }
    const dismissed = l.line_type !== "item" || l.mapping_status === "rejected";
    const resolution =
      l.resolution_note ??
      (dismissed ? `Line ${l.line_type === "item" ? "rejected" : `marked as ${l.line_type}`}` : `Line ${l.mapping_status}${l.mapping_basis ? ` (${l.mapping_basis})` : ""}`);
    await q.query(`update mapping_exceptions set state = $2, resolution = $3, resolved_by = $4, resolved_at = now() where mapping_exception_id = $1`, [
      e.mapping_exception_id,
      dismissed ? "dismissed" : "resolved",
      resolution,
      actor,
    ]);
  }
  if (want) {
    await q.query(
      `insert into mapping_exceptions (organization_id, project_id, boq_line_id, exception_type, exception_detail, created_by) values ($1, $2, $3, $4, $5, $6)`,
      [organizationId, l.project_id, lineId, want.type, want.detail, actor],
    );
  }
}

/** Maps one item line and publishes it when it is valid, fully attributed and its revision is not held. */
async function mapAndPublish(q: Queryable, organizationId: string, line: LineRecord, s: Structure, uoms: UomTable, held: boolean, prevRevisionId: string | null) {
  if (line.line_type !== "item" || line.mapping_status === "rejected") return;
  let m = mapLine(line, s);
  let carried: { costAssignmentId: string; quantity: number }[] | null = null;
  if (!m.costAssignmentId) {
    const c = await carriedResolution(q, prevRevisionId, line);
    if (c && c.allocs.length) {
      const sameQty = Number(c.prev.normalized_quantity) === Number(line.normalized_quantity) && c.prev.normalized_uom_id === line.normalized_uom_id;
      if (c.allocs.length === 1) carried = [{ costAssignmentId: c.allocs[0]!.cost_assignment_id, quantity: Number(line.normalized_quantity) }];
      else if (sameQty) carried = c.allocs.map((a) => ({ costAssignmentId: a.cost_assignment_id, quantity: Number(a.allocated_quantity) }));
      else m.messages.push("The previous revision split this line across work packages, but its quantity has changed: re-split it");
      if (carried) m = { workPackageId: c.allocs[0]!.work_package_id, costAssignmentId: carried[0]!.costAssignmentId, basis: "resolution carried from the previous revision", messages: [] };
    }
  }
  const valid = line.validation_status === "valid";
  let status: string;
  if (!m.costAssignmentId) status = "unresolved";
  else if (!valid || held) status = "proposed";
  else status = carried && carried.length > 1 ? "split" : "mapped";
  await q.query(
    `update boq_lines set mapping_status = $2, mapping_basis = $3, proposed_work_package_id = $4, proposed_cost_assignment_id = $5,
        validation_messages = (select coalesce(jsonb_agg(x), '[]') from jsonb_array_elements(validation_messages) x where x->>'kind' <> 'mapping') || $6::jsonb,
        updated_at = now(), record_version = record_version + 1
     where boq_line_id = $1`,
    [line.boq_line_id, status, m.basis, m.workPackageId, m.costAssignmentId, JSON.stringify(m.messages.map((message) => ({ kind: "mapping", message })))],
  );
  await syncExceptions(q, organizationId, line.boq_line_id, SYSTEM);
  if (status !== "mapped" && status !== "split") return;
  const uom = uoms.byId(line.normalized_uom_id!)!;
  line.item_id ??= await findOrCreateItem(q, organizationId, line, uom, SYSTEM);
  await q.query(`update boq_lines set item_id = $2 where boq_line_id = $1`, [line.boq_line_id, line.item_id]);
  for (const a of carried ?? [{ costAssignmentId: m.costAssignmentId!, quantity: Number(line.normalized_quantity) }]) {
    await allocate(q, organizationId, line, a.costAssignmentId, a.quantity, m.basis ?? "auto", SYSTEM);
  }
}

/** Receives a BOQ file for a project, extracts and validates every line, maps and publishes what is attributable. */
export async function submitBoq(db: Db, files: FileStore, organizationId: string, input: SubmitInput): Promise<SubmitResult> {
  const project = (
    await db.query<{ project_id: string; project_name: string; procore_company_id: number | null; procore_project_id: number | null }>(
      `select project_id, project_name, procore_company_id, procore_project_id from projects where project_id = $1 and organization_id = $2`,
      [input.projectId, organizationId],
    )
  ).rows[0];
  if (!project) throw new InputError("Project not found", 404);
  if (input.procoreProjectId && project.procore_project_id && Number(input.procoreProjectId) !== Number(project.procore_project_id)) {
    throw new InputError(`The submission's Procore project (${input.procoreProjectId}) is not this project's (${project.procore_project_id})`);
  }
  if (!input.content.length) throw new InputError("The file is empty");
  const hash = sha256(input.content);
  const dup = (await db.query<{ boq_revision_id: string }>(`select boq_revision_id from boq_document_revisions where project_id = $1 and file_hash = $2`, [project.project_id, hash])).rows[0];
  if (dup) return { revisionId: dup.boq_revision_id, duplicate: true, supersededRevisionId: null };
  if (input.procoreDocumentId && input.sourceRevision) {
    const same = (
      await db.query<{ boq_revision_id: string }>(
        `select boq_revision_id from boq_document_revisions where project_id = $1 and procore_document_id = $2 and source_revision = $3`,
        [project.project_id, input.procoreDocumentId, input.sourceRevision],
      )
    ).rows[0];
    if (same) throw new InputError(`Procore document ${input.procoreDocumentId} revision ${input.sourceRevision} was already imported with different content`, 409);
  }

  const uoms = await loadUoms(db, organizationId);
  let parsed: ParsedDocument;
  try {
    parsed = await parseDocument(input.fileName, input.mimeType, input.content, uoms);
  } catch (e) {
    if (e instanceof UnsupportedDocument) throw new InputError(e.message, 422);
    throw e;
  }
  const documentKey = input.documentKey?.trim() || (input.procoreDocumentId ? `procore:${input.procoreDocumentId}` : defaultDocumentKey(input.fileName));
  const conflict = !!parsed.declaredProjectName && !sameProjectName(parsed.declaredProjectName, project.project_name);
  const messages = [...parsed.messages];
  if (conflict) messages.unshift(`The document names project "${parsed.declaredProjectName}" but was submitted under "${project.project_name}". Nothing is published until the project is confirmed.`);
  if (!parsed.rows.length) messages.push("No BOQ lines were found");

  // The original goes to the file store before anything is recorded. The key is content-addressed, so a retry after a
  // failure further down simply finds the file already there.
  const storageKey = boqFileKey(organizationId, project.project_id, hash);
  await files.put(storageKey, input.content, { sha256: hash, contentType: input.mimeType, fileName: input.fileName });

  return db.tx(async (q) => {
    const prev = (
      await q.query<{ boq_revision_id: string }>(`select boq_revision_id from boq_document_revisions where project_id = $1 and document_key = $2 and document_status = 'accepted'`, [
        project.project_id,
        documentKey,
      ])
    ).rows[0];
    if (prev) await q.query(`update boq_document_revisions set document_status = 'superseded', updated_at = now() where boq_revision_id = $1`, [prev.boq_revision_id]);
    const rev = (
      await q.query<{ boq_revision_id: string }>(
        `insert into boq_document_revisions (organization_id, project_id, document_key, source_tool, procore_company_id, procore_project_id, procore_document_id,
            source_revision, source_file_name, mime_type, file_hash, file_size, storage_kind, storage_key, declared_project_name, project_conflict, submitted_by,
            processing_status, document_status, processing_messages, supersedes_revision_id, created_by)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, 'processed', 'accepted', $18, $19, $17) returning boq_revision_id`,
        [
          organizationId,
          project.project_id,
          documentKey,
          input.sourceTool,
          project.procore_company_id,
          project.procore_project_id,
          input.procoreDocumentId ?? null,
          input.sourceRevision ?? null,
          input.fileName,
          input.mimeType,
          hash,
          input.content.length,
          files.kind,
          storageKey,
          parsed.declaredProjectName,
          conflict,
          input.submittedBy,
          JSON.stringify(messages),
          prev?.boq_revision_id ?? null,
        ],
      )
    ).rows[0]!.boq_revision_id;

    const structure = await loadStructure(q, project.project_id);
    const stack: { level: number; text: string; id: string }[] = [];
    const lines: LineRecord[] = [];
    for (const r of parsed.rows) {
      const kind = classify(r);
      const level = kind === "heading" ? headingLevel(r) : 0;
      if (kind === "heading") while (stack.length && stack[stack.length - 1]!.level >= level) stack.pop();
      const v = kind === "item" ? validate(r, uoms) : { status: "not_applicable", quantity: null, uomId: null, messages: [] as string[] };
      const ins = (
        await q.query<LineRecord>(
          `insert into boq_lines (organization_id, project_id, boq_revision_id, line_no, parent_source_line_id, line_type, source_locator, sheet_name, row_number,
              page_number, section_path, raw_item_code, raw_description, raw_specification, raw_quantity, raw_uom, stated_wbs_reference, stated_cost_code,
              normalized_quantity, normalized_uom_id, validation_status, validation_messages, mapping_status, created_by)
           values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24) returning *`,
          [
            organizationId,
            project.project_id,
            rev,
            lines.length + 1,
            stack[stack.length - 1]?.id ?? null,
            kind,
            r.locator,
            r.sheet,
            r.row,
            r.page,
            stack.map((h) => h.text),
            r.itemCode,
            r.description,
            r.specification,
            r.quantity,
            r.uom,
            r.wbsReference,
            r.costCode,
            v.quantity,
            v.uomId,
            v.status,
            JSON.stringify(v.messages.map((message) => ({ kind: "validation", message }))),
            kind === "item" ? "unmapped" : "not_applicable",
            input.submittedBy,
          ],
        )
      ).rows[0]!;
      if (kind === "heading") stack.push({ level, text: [r.itemCode, r.description].filter(Boolean).join(" "), id: ins.boq_line_id });
      lines.push(ins);
    }
    for (const l of lines) {
      const carried = prev ? await carryLineDecisions(q, prev.boq_revision_id, l) : l;
      await mapAndPublish(q, organizationId, carried, structure, uoms, conflict, prev?.boq_revision_id ?? null);
    }
    // The run's reconciliation: every extracted line is a validated item, an exception, a rejection or a non-item line.
    const rc = await reconciliation(q, rev);
    const exceptions = (
      await q.query<{ n: number }>(
        `select count(distinct e.boq_line_id)::int as n from mapping_exceptions e join boq_lines l on l.boq_line_id = e.boq_line_id
         where l.boq_revision_id = $1 and e.state in ('open', 'in_review')`,
        [rev],
      )
    ).rows[0]!.n;
    await q.query(
      `insert into ingestion_runs (organization_id, project_id, boq_revision_id, run_status, completed_at, extracted_count, item_count, validated_count,
          exception_count, rejected_count, non_item_count, run_notes, created_by)
       values ($1, $2, $3, 'completed', now(), $4, $5, $6, $7, $8, $9, $10, $11)`,
      [organizationId, project.project_id, rev, rc.totalLines, rc.items, rc.items - exceptions - rc.rejected, exceptions, rc.rejected, rc.totalLines - rc.items, messages.join("\n") || null, input.submittedBy],
    );
    await audit(q, {
      organizationId,
      projectId: project.project_id,
      actor: input.submittedBy,
      action: "boq.submitted",
      entity: "boq_revision",
      entityId: rev,
      detail: { fileName: input.fileName, hash, lines: lines.length, supersedes: prev?.boq_revision_id ?? null, conflict },
    });
    return { revisionId: rev, duplicate: false, supersededRevisionId: prev?.boq_revision_id ?? null };
  });
}

function validate(r: SourceRow, uoms: UomTable) {
  const messages: string[] = [];
  const quantity = parseQuantity(r.quantity);
  const uom = uoms.resolve(r.uom);
  if (!r.description) messages.push("No description");
  if (!r.quantity) messages.push("No quantity");
  else if (quantity === null) messages.push(`Quantity "${r.quantity}" is not a number`);
  else if (quantity <= 0) messages.push("Quantity is zero");
  if (!r.uom) messages.push("No unit of measure");
  else if (!uom) messages.push(`Unit "${r.uom}" is not a recognised unit of measure`);
  return { status: messages.length ? "invalid" : "valid", quantity: quantity !== null && quantity > 0 ? quantity : null, uomId: uom?.uom_id ?? null, messages };
}

async function assertEditable(q: Queryable, line: LineRecord) {
  const rev = (await q.query<{ document_status: string; project_conflict: boolean }>(`select document_status, project_conflict from boq_document_revisions where boq_revision_id = $1`, [line.boq_revision_id])).rows[0]!;
  if (rev.document_status !== "accepted") throw new InputError("This BOQ revision has been superseded; resolve lines on the current revision", 409);
  return rev;
}

/** Assigns an item line to one cost assignment (whole quantity) or splits it across several; quantities must reconcile. */
export async function resolveLine(db: Db, organizationId: string, lineId: string, allocations: { costAssignmentId: string; quantity: number }[], actor: string, note?: string | null) {
  return db.tx(async (q) => {
    const line = await getLine(q, lineId);
    const rev = await assertEditable(q, line);
    if (rev.project_conflict) throw new InputError("Confirm the document's project before resolving its lines", 409);
    if (line.line_type !== "item") throw new InputError("Only item lines can be allocated");
    if (line.validation_status !== "valid") throw new InputError("Correct the line's quantity / unit first");
    if (!allocations.length) throw new InputError("At least one allocation is required");
    const ids = new Set(allocations.map((a) => a.costAssignmentId));
    if (ids.size !== allocations.length) throw new InputError("Each cost assignment may appear once");
    const total = allocations.reduce((t, a) => t + a.quantity, 0);
    if (allocations.some((a) => !(a.quantity > 0))) throw new InputError("Allocated quantities must be positive");
    if (Math.abs(total - Number(line.normalized_quantity)) > 1e-6) throw new InputError(`Allocations total ${total}, but the BOQ line quantity is ${Number(line.normalized_quantity)}`);
    await q.query(`update requirement_boq_allocations set approval_status = 'rejected' where boq_line_id = $1 and approval_status <> 'rejected'`, [lineId]);
    const uoms = await loadUoms(q, organizationId);
    line.item_id ??= await findOrCreateItem(q, organizationId, line, uoms.byId(line.normalized_uom_id!)!, actor);
    const first = (
      await q.query<{ work_package_id: string }>(`select work_package_id from cost_assignments where cost_assignment_id = $1 and project_id = $2`, [allocations[0]!.costAssignmentId, line.project_id])
    ).rows[0];
    if (!first) throw new InputError("Cost assignment is not part of this BOQ line's project");
    await q.query(
      `update boq_lines set item_id = $2, mapping_status = $3, mapping_basis = 'manual', proposed_work_package_id = $4, proposed_cost_assignment_id = $5,
          resolution_note = $6, resolved_by = $7, resolved_at = now(), updated_at = now(), record_version = record_version + 1 where boq_line_id = $1`,
      [lineId, line.item_id, allocations.length > 1 ? "split" : "mapped", first.work_package_id, allocations[0]!.costAssignmentId, note ?? null, actor],
    );
    await syncExceptions(q, organizationId, lineId, actor);
    for (const a of allocations) await allocate(q, organizationId, line, a.costAssignmentId, a.quantity, note ? `manual: ${note}` : "manual", actor);
    await audit(q, { organizationId, projectId: line.project_id, actor, action: "boq_line.resolved", entity: "boq_line", entityId: lineId, detail: { allocations, note } });
  });
}

/** Marks a line as not an inventory item (e.g. a misread heading); it stays accounted for in the reconciliation. */
export async function rejectLine(db: Db, organizationId: string, lineId: string, reason: string, actor: string) {
  if (!reason?.trim()) throw new InputError("A reason is required");
  return db.tx(async (q) => {
    const line = await getLine(q, lineId);
    await assertEditable(q, line);
    await q.query(`update requirement_boq_allocations set approval_status = 'rejected' where boq_line_id = $1 and approval_status <> 'rejected'`, [lineId]);
    await q.query(
      `update boq_lines set mapping_status = 'rejected', resolution_note = $2, resolved_by = $3, resolved_at = now(), updated_at = now(), record_version = record_version + 1 where boq_line_id = $1`,
      [lineId, reason, actor],
    );
    await syncExceptions(q, organizationId, lineId, actor);
    await audit(q, { organizationId, projectId: line.project_id, actor, action: "boq_line.rejected", entity: "boq_line", entityId: lineId, detail: { reason } });
  });
}

/** Corrects an extraction: quantity / unit typed from the source, or the line kind. Raw values are kept. */
export async function correctLine(db: Db, organizationId: string, lineId: string, fix: { quantity?: number | null; uom?: string | null; lineKind?: "item" | "heading" | "subtotal" | "note" | null }, actor: string) {
  return db.tx(async (q) => {
    const line = await getLine(q, lineId);
    const rev = await assertEditable(q, line);
    const uoms = await loadUoms(q, organizationId);
    await q.query(`update requirement_boq_allocations set approval_status = 'rejected' where boq_line_id = $1 and approval_status <> 'rejected'`, [lineId]);
    if (fix.lineKind && fix.lineKind !== "item") {
      await q.query(
        `update boq_lines set line_type = $2, validation_status = 'not_applicable', mapping_status = 'not_applicable', resolved_by = $3, resolved_at = now(), updated_at = now() where boq_line_id = $1`,
        [lineId, fix.lineKind, actor],
      );
      await syncExceptions(q, organizationId, lineId, actor);
    } else {
      const quantity = fix.quantity !== undefined && fix.quantity !== null ? Number(fix.quantity) : line.normalized_quantity !== null ? Number(line.normalized_quantity) : null;
      const uom = fix.uom ? uoms.resolve(fix.uom) : line.normalized_uom_id ? uoms.byId(line.normalized_uom_id) : uoms.resolve(line.raw_uom);
      if (fix.uom && !uom) throw new InputError(`Unit "${fix.uom}" is not a recognised unit of measure`);
      const msgs: string[] = [];
      if (!line.raw_description) msgs.push("No description");
      if (!(quantity !== null && quantity > 0)) msgs.push("No valid quantity");
      if (!uom) msgs.push("No valid unit of measure");
      const status = msgs.length ? "invalid" : "valid";
      const updated = (
        await q.query<LineRecord>(
          `update boq_lines set line_type = 'item', normalized_quantity = $2, normalized_uom_id = $3, validation_status = $4, item_id = null, mapping_status = 'unmapped',
              validation_messages = $5, resolved_by = $6, resolved_at = now(), updated_at = now(), record_version = record_version + 1
           where boq_line_id = $1 returning *`,
          [lineId, quantity !== null && quantity > 0 ? quantity : null, uom?.uom_id ?? null, status, JSON.stringify(msgs.map((message) => ({ kind: "validation", message }))), actor],
        )
      ).rows[0]!;
      const prevRev = (await q.query<{ supersedes_revision_id: string | null }>(`select supersedes_revision_id from boq_document_revisions where boq_revision_id = $1`, [line.boq_revision_id])).rows[0]?.supersedes_revision_id ?? null;
      await mapAndPublish(q, organizationId, updated, await loadStructure(q, line.project_id), uoms, rev.project_conflict, prevRev);
    }
    await audit(q, { organizationId, projectId: line.project_id, actor, action: "boq_line.corrected", entity: "boq_line", entityId: lineId, detail: fix });
  });
}

/** The submission location's project is confirmed as correct despite the name in the file; held lines are published. */
export async function confirmProject(db: Db, organizationId: string, revisionId: string, actor: string, note: string) {
  if (!note?.trim()) throw new InputError("Say why the project is correct");
  return db.tx(async (q) => {
    const rev = (await q.query<{ project_id: string; project_conflict: boolean; document_status: string; supersedes_revision_id: string | null }>(
      `select project_id, project_conflict, document_status, supersedes_revision_id from boq_document_revisions where boq_revision_id = $1 and organization_id = $2`,
      [revisionId, organizationId],
    )).rows[0];
    if (!rev) throw new InputError("BOQ revision not found", 404);
    if (!rev.project_conflict) return;
    await q.query(
      `update boq_document_revisions set project_conflict = false, updated_at = now(),
          processing_messages = (select coalesce(jsonb_agg(m), '[]'::jsonb) from jsonb_array_elements(processing_messages) m where m #>> '{}' not like 'The document names project%')
            || jsonb_build_array($2::text)
       where boq_revision_id = $1`,
      [revisionId, `Project confirmed by ${actor}: ${note.trim()}`],
    );
    const s = await loadStructure(q, rev.project_id);
    const uoms = await loadUoms(q, organizationId);
    const lines = (await q.query<LineRecord>(`select * from boq_lines where boq_revision_id = $1 and line_type = 'item' and mapping_status in ('proposed', 'unmapped')`, [revisionId])).rows;
    for (const l of lines) await mapAndPublish(q, organizationId, l, s, uoms, false, rev.supersedes_revision_id);
    await audit(q, { organizationId, projectId: rev.project_id, actor, action: "boq.project_confirmed", entity: "boq_revision", entityId: revisionId, detail: { note } });
  });
}

/** Every extracted line accounted for: items published / split / unresolved / invalid / rejected, plus headings etc. */
export async function reconciliation(q: Queryable, revisionId: string) {
  const counts = (
    await q.query<{ line_type: string; mapping_status: string; validation_status: string; n: number }>(
      `select line_type, mapping_status, validation_status, count(*)::int as n from boq_lines where boq_revision_id = $1 group by 1, 2, 3`,
      [revisionId],
    )
  ).rows;
  const sum = (f: (r: (typeof counts)[number]) => boolean) => counts.filter(f).reduce((t, r) => t + Number(r.n), 0);
  const mismatched = (
    await q.query<{ boq_line_id: string; source_locator: string; quantity: string; allocated: string }>(
      `select l.boq_line_id, l.source_locator, l.normalized_quantity as quantity, coalesce(sum(a.allocated_quantity), 0) as allocated
       from boq_lines l left join requirement_boq_allocations a on a.boq_line_id = l.boq_line_id and a.approval_status = 'approved'
       where l.boq_revision_id = $1 and l.mapping_status in ('mapped', 'split')
       group by l.boq_line_id, l.source_locator, l.normalized_quantity having coalesce(sum(a.allocated_quantity), 0) <> l.normalized_quantity`,
      [revisionId],
    )
  ).rows;
  const items = sum((r) => r.line_type === "item");
  const out = {
    totalLines: sum(() => true),
    headings: sum((r) => r.line_type === "heading"),
    subtotals: sum((r) => r.line_type === "subtotal"),
    notes: sum((r) => r.line_type === "note"),
    items,
    published: sum((r) => r.line_type === "item" && r.mapping_status === "mapped"),
    split: sum((r) => r.line_type === "item" && r.mapping_status === "split"),
    held: sum((r) => r.line_type === "item" && r.mapping_status === "proposed"),
    unresolved: sum((r) => r.line_type === "item" && (r.mapping_status === "unresolved" || r.mapping_status === "unmapped")),
    invalid: sum((r) => r.line_type === "item" && r.validation_status === "invalid" && r.mapping_status !== "rejected"),
    rejected: sum((r) => r.line_type === "item" && r.mapping_status === "rejected"),
    quantityMismatches: mismatched,
  };
  return { ...out, accountedFor: out.published + out.split + out.held + out.unresolved + out.rejected === items && mismatched.length === 0 };
}
