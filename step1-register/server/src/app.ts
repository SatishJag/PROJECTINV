import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";
import multipart from "@fastify/multipart";
import fastifyStatic from "@fastify/static";
import { z } from "zod";
import type { Db } from "./db.js";
import { FileStoreError, type FileStore } from "./filestore.js";
import { DemoProcoreAdapter, type ProcoreAdapter } from "./procore.js";
import { audit, syncFromProcore } from "./sync.js";
import {
  getWatch,
  listCaptures,
  processWebhook,
  processWebhookInBackground,
  recordWebhook,
  scanProject,
  setWatch,
  webhookAuthorized,
  WebhookRejected,
  type CaptureContext,
} from "./capture.js";
import { confirmProject, correctLine, InputError, reconciliation, rejectLine, resolveLine, submitBoq } from "./boq/ingest.js";

export interface AppDeps {
  db: Db;
  /** Where original BOQ files are kept (Azure Blob in production). */
  files: FileStore;
  procore: ProcoreAdapter;
  organizationId: string;
  appPassword?: string | null;
  webDist?: string | null;
  /** Value Procore sends as "Authorization: Bearer <secret>" on webhook deliveries; webhooks are refused without it. */
  webhookSecret?: string | null;
}

const uuid = z.string().uuid();

export async function buildApp(deps: AppDeps) {
  const { db, procore, organizationId, files } = deps;
  const app = Fastify({ logger: false, bodyLimit: 60 * 1024 * 1024 });
  await app.register(multipart, { limits: { fileSize: 50 * 1024 * 1024, files: 1 } });

  const actorOf = (req: FastifyRequest) => String(req.headers["x-user-name"] ?? "").trim().slice(0, 120) || "user";

  app.addHook("onRequest", async (req, reply) => {
    if (!deps.appPassword || !req.url.startsWith("/api/") || req.url === "/api/health" || req.url.startsWith("/api/procore/webhooks")) return;
    if (req.headers.authorization !== `Bearer ${deps.appPassword}`) return reply.code(401).send({ error: "Sign in required" });
  });

  app.setErrorHandler((err: any, _req, reply) => {
    if (err instanceof InputError) return reply.code(err.status).send({ error: err.message });
    if (err instanceof WebhookRejected) return reply.code(err.status).send({ error: err.message });
    if (err instanceof FileStoreError) {
      console.error(err);
      return reply.code(502).send({ error: err.message });
    }
    if (err instanceof z.ZodError) return reply.code(400).send({ error: err.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") });
    if (err?.code && /^(23|22|P0)/.test(String(err.code))) return reply.code(409).send({ error: err.message });
    if (err?.statusCode && err.statusCode < 500) return reply.code(err.statusCode).send({ error: err.message });
    console.error(err);
    return reply.code(500).send({ error: "Internal error" });
  });

  const projectOr404 = async (id: string) => {
    uuid.parse(id);
    const p = (await db.query(`select * from projects where project_id = $1 and organization_id = $2`, [id, organizationId])).rows[0];
    if (!p) throw new InputError("Project not found", 404);
    return p;
  };
  const revisionOr404 = async (id: string) => {
    uuid.parse(id);
    const r = (
      await db.query(
        `select boq_revision_id, project_id, document_key, source_tool, procore_company_id, procore_project_id, procore_document_id, source_revision,
                file_name, mime_type, file_hash, file_size, declared_project_name, project_conflict, submitted_by, submitted_at, document_status,
                processing_status, processing_messages, supersedes_revision_id
         from boq_document_revisions where boq_revision_id = $1 and organization_id = $2`,
        [id, organizationId],
      )
    ).rows[0];
    if (!r) throw new InputError("BOQ revision not found", 404);
    return r;
  };
  const lineInOrg = async (id: string) => {
    uuid.parse(id);
    const r = (await db.query(`select l.boq_line_id from boq_lines l join projects p on p.project_id = l.project_id where l.boq_line_id = $1 and p.organization_id = $2`, [id, organizationId])).rows[0];
    if (!r) throw new InputError("BOQ line not found", 404);
  };

  app.get("/api/health", async () => {
    await db.query("select 1");
    return { ok: true };
  });

  app.get("/api/config", async () => ({
    procoreMode: procore.mode,
    procoreCompanyId: procore.companyId,
    passwordRequired: !!deps.appPassword,
    webhooksConfigured: !!deps.webhookSecret,
  }));

  app.post("/api/procore/sync", async (req) => {
    const body = z.object({ procoreProjectId: z.number().int().optional() }).parse(req.body ?? {});
    return syncFromProcore(db, procore, organizationId, actorOf(req), body.procoreProjectId);
  });

  app.get("/api/projects", async () =>
    (
      await db.query(
        `select p.*,
           (select count(*)::int from work_packages w where w.project_id = p.project_id) as work_packages,
           (select count(*)::int from cost_assignments c where c.project_id = p.project_id) as cost_assignments,
           (select count(*)::int from boq_document_revisions d where d.project_id = p.project_id and d.document_status = 'current') as boq_documents,
           (select count(*)::int from inventory_register r where r.project_id = p.project_id and r.source_line_count > 0) as inventory_records,
           (select count(*)::int from boq_lines l join boq_document_revisions d on d.boq_revision_id = l.boq_revision_id
              where l.project_id = p.project_id and d.document_status = 'current' and l.line_kind = 'item'
                and (l.mapping_status in ('unresolved', 'unmapped', 'proposed') or (l.validation_status = 'invalid' and l.mapping_status <> 'rejected'))) as open_exceptions
         from projects p where p.organization_id = $1 order by p.project_name`,
        [organizationId],
      )
    ).rows,
  );

  app.get<{ Params: { id: string } }>("/api/projects/:id/structure", async (req) => {
    const p = await projectOr404(req.params.id);
    const wps = (await db.query(`select * from work_packages where project_id = $1 order by code`, [p.project_id])).rows;
    const cas = (await db.query(`select * from cost_assignments where project_id = $1 order by budget_code nulls last, cost_code`, [p.project_id])).rows;
    return { project: p, workPackages: wps, costAssignments: cas };
  });

  app.post<{ Params: { id: string } }>("/api/projects/:id/work-packages", async (req) => {
    const p = await projectOr404(req.params.id);
    const b = z.object({ code: z.string().trim().min(1), name: z.string().trim().min(1), parentWorkPackageId: uuid.nullish(), matchTerms: z.array(z.string().trim().min(1)).default([]) }).parse(req.body);
    const r = await db.query(
      `insert into work_packages (organization_id, project_id, parent_work_package_id, code, name, match_terms, created_by) values ($1, $2, $3, $4, $5, $6, $7) returning *`,
      [organizationId, p.project_id, b.parentWorkPackageId ?? null, b.code, b.name, b.matchTerms, actorOf(req)],
    );
    await audit(db, { organizationId, projectId: p.project_id, actor: actorOf(req), action: "work_package.created", entity: "work_package", entityId: r.rows[0]!.work_package_id, detail: b });
    return r.rows[0];
  });

  app.patch<{ Params: { id: string } }>("/api/work-packages/:id", async (req) => {
    uuid.parse(req.params.id);
    const b = z.object({ name: z.string().trim().min(1).optional(), matchTerms: z.array(z.string().trim().min(1)).optional(), status: z.enum(["active", "inactive"]).optional() }).parse(req.body);
    const r = await db.query(
      `update work_packages set name = coalesce($3, name), match_terms = coalesce($4, match_terms), status = coalesce($5, status), updated_at = now(), record_version = record_version + 1
       where work_package_id = $1 and organization_id = $2 returning *`,
      [req.params.id, organizationId, b.name ?? null, b.matchTerms ?? null, b.status ?? null],
    );
    if (!r.rows[0]) throw new InputError("Work package not found", 404);
    await audit(db, { organizationId, projectId: r.rows[0].project_id, actor: actorOf(req), action: "work_package.updated", entity: "work_package", entityId: req.params.id, detail: b });
    return r.rows[0];
  });

  app.post<{ Params: { id: string } }>("/api/projects/:id/cost-assignments", async (req) => {
    const p = await projectOr404(req.params.id);
    const b = z.object({ workPackageId: uuid, costCode: z.string().trim().min(1), costType: z.string().trim().nullish(), budgetCode: z.string().trim().nullish(), description: z.string().nullish() }).parse(req.body);
    const r = await db.query(
      `insert into cost_assignments (organization_id, project_id, work_package_id, cost_code, cost_type, budget_code, description, created_by)
       values ($1, $2, $3, $4, $5, $6, $7, $8) returning *`,
      [organizationId, p.project_id, b.workPackageId, b.costCode, b.costType ?? null, b.budgetCode ?? [b.costCode, b.costType].filter(Boolean).join("."), b.description ?? null, actorOf(req)],
    );
    await audit(db, { organizationId, projectId: p.project_id, actor: actorOf(req), action: "cost_assignment.created", entity: "cost_assignment", entityId: r.rows[0]!.cost_assignment_id, detail: b });
    return r.rows[0];
  });

  app.get<{ Params: { id: string }; Querystring: { workPackageId?: string; includeSuperseded?: string } }>("/api/projects/:id/register", async (req) => {
    const p = await projectOr404(req.params.id);
    const wp = req.query.workPackageId ? uuid.parse(req.query.workPackageId) : null;
    const rows = (
      await db.query(
        `select * from inventory_register where project_id = $1 and ($2::uuid is null or work_package_id = $2) and ($3 or source_line_count > 0)
         order by work_package_code, item_description`,
        [p.project_id, wp, req.query.includeSuperseded === "true"],
      )
    ).rows;
    return { project: p, rows };
  });

  app.get<{ Params: { id: string } }>("/api/register/:id", async (req) => {
    uuid.parse(req.params.id);
    const rec = (await db.query(`select * from inventory_register where inventory_record_id = $1 and organization_id = $2`, [req.params.id, organizationId])).rows[0];
    if (!rec) throw new InputError("Inventory record not found", 404);
    const sources = (
      await db.query(
        `select a.allocation_id, a.allocated_quantity, a.approval_status, a.basis, a.approved_by, a.approved_at,
                l.boq_line_id, l.source_locator, l.sheet_name, l.row_number, l.page_number, l.section_path, l.raw_item_code, l.raw_description,
                l.raw_specification, l.raw_quantity, l.raw_uom, l.raw_wbs_reference, l.raw_cost_code, l.quantity as line_quantity,
                d.boq_revision_id, d.file_name, d.source_tool, d.procore_document_id, d.source_revision, d.document_status, d.submitted_at, d.file_hash
         from requirement_boq_allocations a join boq_lines l on l.boq_line_id = a.boq_line_id join boq_document_revisions d on d.boq_revision_id = l.boq_revision_id
         where a.inventory_record_id = $1 order by d.submitted_at desc, l.source_locator`,
        [req.params.id],
      )
    ).rows;
    return { record: rec, sources };
  });

  const submit = async (req: FastifyRequest, projectId: string, f: { fileName: string; mimeType: string | null; content: Buffer }, fields: Record<string, string | undefined>, sourceTool: "upload" | "procore_documents") => {
    const result = await submitBoq(db, files, organizationId, {
      projectId,
      ...f,
      sourceTool,
      procoreProjectId: fields.procoreProjectId ? Number(fields.procoreProjectId) : null,
      procoreDocumentId: fields.procoreDocumentId?.trim() || null,
      sourceRevision: fields.sourceRevision?.trim() || null,
      documentKey: fields.documentKey?.trim() || null,
      submittedBy: actorOf(req),
    });
    return { ...result, revision: await revisionOr404(result.revisionId), reconciliation: await reconciliation(db, result.revisionId) };
  };

  app.post<{ Params: { id: string } }>("/api/projects/:id/boq", async (req) => {
    const p = await projectOr404(req.params.id);
    if (req.isMultipart()) {
      const fields: Record<string, string> = {};
      let file: { fileName: string; mimeType: string | null; content: Buffer } | null = null;
      for await (const part of req.parts()) {
        if (part.type === "file") file = { fileName: part.filename, mimeType: part.mimetype ?? null, content: await part.toBuffer() };
        else fields[part.fieldname] = String(part.value ?? "");
      }
      if (!file) throw new InputError("Attach the BOQ file");
      return submit(req, p.project_id, file, fields, "upload");
    }
    const b = z
      .object({ fileName: z.string().min(1), mimeType: z.string().nullish(), contentBase64: z.string().min(1), procoreDocumentId: z.string().nullish(), sourceRevision: z.string().nullish(), documentKey: z.string().nullish(), procoreProjectId: z.number().nullish() })
      .parse(req.body);
    return submit(
      req,
      p.project_id,
      { fileName: b.fileName, mimeType: b.mimeType ?? null, content: Buffer.from(b.contentBase64, "base64") },
      { procoreDocumentId: b.procoreDocumentId ?? undefined, sourceRevision: b.sourceRevision ?? undefined, documentKey: b.documentKey ?? undefined, procoreProjectId: b.procoreProjectId ? String(b.procoreProjectId) : undefined },
      "upload",
    );
  });

  app.post<{ Params: { id: string } }>("/api/projects/:id/boq/from-procore", async (req) => {
    const p = await projectOr404(req.params.id);
    const b = z.object({ documentId: z.string().trim().min(1) }).parse(req.body);
    if (!p.procore_project_id) throw new InputError("This project is not linked to a Procore project");
    const f = await procore.downloadDocument(Number(p.procore_project_id), b.documentId);
    return submit(req, p.project_id, f, { procoreDocumentId: b.documentId, sourceRevision: f.revision ?? undefined }, "procore_documents");
  });

  app.get<{ Params: { id: string } }>("/api/projects/:id/boq", async (req) => {
    const p = await projectOr404(req.params.id);
    const revs = (
      await db.query(
        `select boq_revision_id, document_key, source_tool, procore_document_id, source_revision, file_name, file_size, declared_project_name, project_conflict,
                submitted_by, submitted_at, document_status, processing_status, supersedes_revision_id
         from boq_document_revisions where project_id = $1 order by submitted_at desc`,
        [p.project_id],
      )
    ).rows;
    return { project: p, revisions: await Promise.all(revs.map(async (r) => ({ ...r, reconciliation: await reconciliation(db, r.boq_revision_id) }))) };
  });

  app.get<{ Params: { id: string } }>("/api/boq/:id", async (req) => {
    const rev = await revisionOr404(req.params.id);
    const lines = (
      await db.query(
        `select l.*, u.code as uom_code, w.code as work_package_code, w.name as work_package_name, c.budget_code,
            (select coalesce(json_agg(json_build_object('quantity', a.allocated_quantity, 'record_number', r.record_number, 'inventory_record_id', r.inventory_record_id,
                     'work_package', w2.name, 'budget_code', c2.budget_code)), '[]')
             from requirement_boq_allocations a join inventory_requirements r on r.inventory_record_id = a.inventory_record_id
             join work_packages w2 on w2.work_package_id = r.work_package_id join cost_assignments c2 on c2.cost_assignment_id = r.cost_assignment_id
             where a.boq_line_id = l.boq_line_id and a.approval_status = 'approved') as allocations
         from boq_lines l left join units_of_measure u on u.uom_id = l.uom_id left join work_packages w on w.work_package_id = l.proposed_work_package_id
         left join cost_assignments c on c.cost_assignment_id = l.proposed_cost_assignment_id
         where l.boq_revision_id = $1 order by l.sheet_name nulls first, l.page_number nulls first, l.row_number`,
        [rev.boq_revision_id],
      )
    ).rows;
    return { revision: rev, reconciliation: await reconciliation(db, rev.boq_revision_id), lines };
  });

  app.get<{ Params: { id: string } }>("/api/boq/:id/file", async (req, reply: FastifyReply) => {
    const rev = await revisionOr404(req.params.id);
    const f = (
      await db.query<{ storage_kind: string | null; storage_key: string | null; file_content: Buffer | null }>(
        `select storage_kind, storage_key, case when storage_key is null then file_content end as file_content from boq_document_revisions where boq_revision_id = $1`,
        [rev.boq_revision_id],
      )
    ).rows[0]!;
    reply.header("content-type", rev.mime_type || "application/octet-stream");
    reply.header("content-disposition", `attachment; filename="${String(rev.file_name).replace(/["\\\r\n]/g, "")}"`);
    if (!f.storage_key) return reply.send(Buffer.from(f.file_content!)); // stored before the file store existed
    if (f.storage_kind !== files.kind) throw new FileStoreError(`This file is in the "${f.storage_kind}" store, but this server uses "${files.kind}"`);
    if (rev.file_size) reply.header("content-length", String(rev.file_size));
    return reply.send(await files.open(f.storage_key));
  });

  app.post<{ Params: { id: string } }>("/api/boq/:id/confirm-project", async (req) => {
    const rev = await revisionOr404(req.params.id);
    const b = z.object({ note: z.string().trim().min(1) }).parse(req.body);
    await confirmProject(db, organizationId, rev.boq_revision_id, actorOf(req), b.note);
    return { revision: await revisionOr404(rev.boq_revision_id), reconciliation: await reconciliation(db, rev.boq_revision_id) };
  });

  app.get<{ Params: { id: string } }>("/api/projects/:id/exceptions", async (req) => {
    const p = await projectOr404(req.params.id);
    const rows = (
      await db.query(
        `select l.*, u.code as uom_code, d.file_name, d.source_revision, d.project_conflict, w.name as work_package_name, c.budget_code
         from boq_lines l join boq_document_revisions d on d.boq_revision_id = l.boq_revision_id
         left join units_of_measure u on u.uom_id = l.uom_id left join work_packages w on w.work_package_id = l.proposed_work_package_id
         left join cost_assignments c on c.cost_assignment_id = l.proposed_cost_assignment_id
         where l.project_id = $1 and d.document_status = 'current' and l.line_kind = 'item'
           and (l.mapping_status in ('unresolved', 'unmapped', 'proposed') or (l.validation_status = 'invalid' and l.mapping_status <> 'rejected'))
         order by d.submitted_at desc, l.sheet_name nulls first, l.page_number nulls first, l.row_number`,
        [p.project_id],
      )
    ).rows;
    return { project: p, rows };
  });

  app.post<{ Params: { id: string } }>("/api/lines/:id/resolve", async (req) => {
    await lineInOrg(req.params.id);
    const b = z.object({ allocations: z.array(z.object({ costAssignmentId: uuid, quantity: z.number().positive() })).min(1), note: z.string().nullish() }).parse(req.body);
    await resolveLine(db, organizationId, req.params.id, b.allocations, actorOf(req), b.note ?? null);
    return { ok: true };
  });
  app.post<{ Params: { id: string } }>("/api/lines/:id/reject", async (req) => {
    await lineInOrg(req.params.id);
    const b = z.object({ reason: z.string().trim().min(1) }).parse(req.body);
    await rejectLine(db, organizationId, req.params.id, b.reason, actorOf(req));
    return { ok: true };
  });
  app.post<{ Params: { id: string } }>("/api/lines/:id/correct", async (req) => {
    await lineInOrg(req.params.id);
    const b = z.object({ quantity: z.number().positive().nullish(), uom: z.string().trim().min(1).nullish(), lineKind: z.enum(["item", "heading", "subtotal", "note"]).nullish() }).parse(req.body);
    await correctLine(db, organizationId, req.params.id, b, actorOf(req));
    return { ok: true };
  });

  app.get("/api/items", async () =>
    (
      await db.query(
        `select i.*, u.code as base_uom,
           (select coalesce(json_agg(json_build_object('project_name', x.project_name, 'work_package', x.work_package_name, 'record_number', x.record_number,
                    'boq_quantity', x.boq_quantity, 'uom', x.normalized_uom) order by x.project_name, x.work_package_name), '[]')
            from inventory_register x where x.item_id = i.item_id and x.source_line_count > 0) as usage
         from item_definitions i join units_of_measure u on u.uom_id = i.base_uom_id where i.organization_id = $1 order by i.name`,
        [organizationId],
      )
    ).rows,
  );

  app.patch<{ Params: { id: string } }>("/api/items/:id", async (req) => {
    uuid.parse(req.params.id);
    const b = z
      .object({
        verificationStatus: z.enum(["provisional", "verified", "rejected"]).optional(),
        category: z.string().trim().nullish(),
        trackingMode: z.enum(["quantity", "lot", "serialized"]).optional(),
        manufacturerPartNumber: z.string().trim().nullish(),
      })
      .parse(req.body);
    const r = await db.query(
      `update item_definitions set verification_status = coalesce($3, verification_status), category = coalesce($4, category), tracking_mode = coalesce($5, tracking_mode),
          manufacturer_part_number = coalesce($6, manufacturer_part_number), updated_at = now(), record_version = record_version + 1
       where item_id = $1 and organization_id = $2 returning *`,
      [req.params.id, organizationId, b.verificationStatus ?? null, b.category ?? null, b.trackingMode ?? null, b.manufacturerPartNumber ?? null],
    );
    if (!r.rows[0]) throw new InputError("Item not found", 404);
    await audit(db, { organizationId, actor: actorOf(req), action: "item.updated", entity: "item_definition", entityId: req.params.id, detail: b });
    return r.rows[0];
  });

  // ---------------------------------------------------------------- automatic capture from Procore Documents
  const capture: CaptureContext = { db, procore, organizationId, files };

  /** Procore webhook receiver: stored, acknowledged at once, processed in the background. */
  app.post("/api/procore/webhooks", async (req, reply) => {
    if (!deps.webhookSecret) return reply.code(503).send({ error: "Webhooks are not configured (set PROCORE_WEBHOOK_SECRET)" });
    if (!webhookAuthorized(deps.webhookSecret, req.headers.authorization)) return reply.code(401).send({ error: "Delivery is not authorized" });
    const r = await recordWebhook(capture, req.body);
    if (r.eventId) processWebhookInBackground(capture, r.eventId);
    return reply.code(202).send({ status: r.duplicate ? "duplicate" : "accepted" });
  });

  app.get("/api/procore/webhook-events", async () =>
    (
      await db.query(
        `select e.event_id, e.delivery_id, e.procore_project_id, e.resource_name, e.event_type, e.resource_id, e.state, e.message, e.received_at, e.processed_at,
                p.project_name
         from procore_webhook_events e left join projects p on p.project_id = e.project_id
         where e.organization_id = $1 order by e.received_at desc limit 100`,
        [organizationId],
      )
    ).rows,
  );

  app.get<{ Params: { id: string } }>("/api/projects/:id/procore-watch", async (req) => {
    const p = await projectOr404(req.params.id);
    return { watch: await getWatch(db, p.project_id), captures: await listCaptures(db, p.project_id) };
  });

  app.put<{ Params: { id: string } }>("/api/projects/:id/procore-watch", async (req) => {
    const p = await projectOr404(req.params.id);
    const b = z
      .object({ enabled: z.boolean().optional(), folderId: z.string().trim().min(1).nullable().optional(), folderPath: z.string().trim().nullish(), includeSubfolders: z.boolean().optional() })
      .parse(req.body ?? {});
    return { watch: await setWatch(db, organizationId, p.project_id, b, actorOf(req)) };
  });

  /** Browse the project's Procore Documents folders (to choose the folder to watch). */
  app.get<{ Params: { id: string }; Querystring: { folderId?: string } }>("/api/projects/:id/procore-folders", async (req) => {
    const p = await projectOr404(req.params.id);
    if (!p.procore_project_id) throw new InputError("This project is not linked to a Procore project");
    const f = await procore.getFolder(Number(p.procore_project_id), req.query.folderId?.trim() || null);
    return { id: f.id, name: f.name, folders: f.folders, files: f.files.map((x) => ({ id: x.id, name: x.name, version: x.version })) };
  });

  /** "Check Procore now": scan the watched folder immediately. */
  app.post<{ Params: { id: string } }>("/api/projects/:id/procore-scan", async (req) => {
    const p = await projectOr404(req.params.id);
    const result = await scanProject(capture, p.project_id, "manual");
    return { result, watch: await getWatch(db, p.project_id), captures: await listCaptures(db, p.project_id) };
  });

  /**
   * Demo company only: act as the LDC storing a BOQ in Procore Documents. The file is stored in the simulated
   * Documents tool and the webhook Procore would send is delivered, so the capture runs exactly as it would live.
   */
  app.post<{ Params: { id: string } }>("/api/projects/:id/demo/procore-documents", async (req) => {
    if (!(procore instanceof DemoProcoreAdapter)) throw new InputError("Only available with the demo Procore company", 404);
    const p = await projectOr404(req.params.id);
    const b = z
      .object({ fileName: z.string().trim().min(1), contentBase64: z.string().min(1), folderPath: z.string().trim().default("BOQ"), mimeType: z.string().nullish(), sendWebhook: z.boolean().default(true) })
      .parse(req.body);
    const stored = procore.storeDocument(Number(p.procore_project_id), b.folderPath, b.fileName, Buffer.from(b.contentBase64, "base64"), b.mimeType ?? null);
    let event = null;
    if (b.sendWebhook) {
      const r = await recordWebhook(capture, {
        ulid: `demo-${stored.fileId}-${stored.version}-${Date.now()}`,
        company_id: procore.companyId,
        project_id: Number(p.procore_project_id),
        resource_name: "Documents",
        resource_id: stored.fileId,
        event_type: stored.version === "1" ? "create" : "update",
        api_version: "v2",
      });
      event = r.eventId ? await processWebhook(capture, r.eventId) : null;
    }
    return { stored, event, watch: await getWatch(db, p.project_id), captures: await listCaptures(db, p.project_id) };
  });

  app.get("/api/units", async () => (await db.query(`select uom_id, code, name, measurement_dimension, aliases from units_of_measure order by measurement_dimension, code`)).rows);

  const dist = deps.webDist ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../web/dist");
  if (fs.existsSync(dist)) {
    await app.register(fastifyStatic, { root: dist });
    app.setNotFoundHandler((req, reply) => (req.url.startsWith("/api/") ? reply.code(404).send({ error: "Not found" }) : reply.sendFile("index.html")));
  }
  return app;
}
