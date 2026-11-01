/**
 * Automatic BOQ capture from Procore Documents.
 *
 * When the LDC stores a BOQ in a project's watched Procore folder, every new file and every new file version is
 * downloaded and sent through the normal BOQ intake (`submitBoq`), so its items reach the inventory register.
 *
 * Three triggers lead to the same idempotent scan of the watched folder:
 *  - a Procore webhook for a Documents event (fast path);
 *  - a periodic scan, which catches webhooks that were missed or never configured;
 *  - "Check Procore now" in the UI.
 * Each (project, Procore file, file version) is captured once (`procore_document_captures`). Temporary Procore
 * errors are retried on later scans; files that cannot be read as a BOQ are marked failed and are not retried until
 * a new version is stored.
 */
import { createHash, timingSafeEqual } from "node:crypto";
import type { Db, Queryable } from "./db.js";
import type { FileStore } from "./filestore.js";
import { defaultDocumentKey, InputError, submitBoq } from "./boq/ingest.js";
import { ProcoreError, type ProcoreAdapter, type ProcoreFileEntry } from "./procore.js";
import { audit, syncFromProcore } from "./sync.js";

export interface CaptureContext {
  db: Db;
  files: FileStore;
  procore: ProcoreAdapter;
  organizationId: string;
}

/** A top-level Documents folder with one of these names is watched when no folder has been chosen. */
export const BOQ_FOLDER_NAME = /\bboqs?\b|\bbills?\s+of\s+quantit/i;
/** File types the BOQ intake can read. */
export const SUPPORTED_FILE = /\.(xlsx|xlsm|csv|pdf)$/i;
export const MAX_ATTEMPTS = 5;
const ACTOR = "procore:documents";
const MAX_FOLDERS = 200;

export interface Watch {
  project_id: string;
  enabled: boolean;
  folder_id: string | null;
  folder_path: string | null;
  include_subfolders: boolean;
  last_scan_at: string | null;
  last_scan_status: string | null;
  last_scan_message: string | null;
}

export interface ScanResult {
  projectId: string;
  status: "ok" | "no_folder" | "error" | "disabled";
  message: string | null;
  folders: string[];
  filesSeen: number;
  captured: number;
  duplicates: number;
  failed: number;
  retrying: number;
  /** Files in the watched folder that are not a supported BOQ format (left alone). */
  skipped: string[];
}

type FileInFolder = ProcoreFileEntry & { folderId: string; folderPath: string };

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

// ---------------------------------------------------------------- watch configuration

export async function getWatch(q: Queryable, projectId: string): Promise<Watch> {
  const w = (await q.query<Watch>(`select * from procore_document_watches where project_id = $1`, [projectId])).rows[0];
  return (
    w ?? {
      project_id: projectId,
      enabled: true,
      folder_id: null,
      folder_path: null,
      include_subfolders: true,
      last_scan_at: null,
      last_scan_status: null,
      last_scan_message: null,
    }
  );
}

export async function setWatch(
  db: Db,
  organizationId: string,
  projectId: string,
  change: { enabled?: boolean; folderId?: string | null; folderPath?: string | null; includeSubfolders?: boolean },
  actor: string,
) {
  const cur = await getWatch(db, projectId);
  const next = {
    enabled: change.enabled ?? cur.enabled,
    folderId: change.folderId === undefined ? cur.folder_id : change.folderId,
    folderPath: change.folderId === undefined ? cur.folder_path : (change.folderPath ?? null),
    includeSubfolders: change.includeSubfolders ?? cur.include_subfolders,
  };
  await db.tx(async (q) => {
    await q.query(
      `insert into procore_document_watches (project_id, organization_id, enabled, folder_id, folder_path, include_subfolders, updated_by)
       values ($1, $2, $3, $4, $5, $6, $7)
       on conflict (project_id) do update set enabled = excluded.enabled, folder_id = excluded.folder_id, folder_path = excluded.folder_path,
         include_subfolders = excluded.include_subfolders, updated_by = excluded.updated_by, updated_at = now(),
         record_version = procore_document_watches.record_version + 1`,
      [projectId, organizationId, next.enabled, next.folderId, next.folderPath, next.includeSubfolders, actor],
    );
    await audit(q, { organizationId, projectId, actor, action: "procore_watch.updated", entity: "project", entityId: projectId, detail: next });
  });
  return getWatch(db, projectId);
}

async function saveScanOutcome(q: Queryable, organizationId: string, projectId: string, r: ScanResult) {
  await q.query(
    `insert into procore_document_watches (project_id, organization_id, last_scan_at, last_scan_status, last_scan_message)
     values ($1, $2, now(), $3, $4)
     on conflict (project_id) do update set last_scan_at = now(), last_scan_status = excluded.last_scan_status,
       last_scan_message = excluded.last_scan_message`,
    [projectId, organizationId, r.status === "disabled" ? "ok" : r.status, r.message],
  );
}

// ---------------------------------------------------------------- folder walk

async function watchedFolders(procore: ProcoreAdapter, procoreProjectId: number, w: Watch) {
  if (w.folder_id) {
    const f = await procore.getFolder(procoreProjectId, w.folder_id);
    return [{ id: f.id, path: w.folder_path || f.name }];
  }
  const root = await procore.getFolder(procoreProjectId, null);
  return root.folders.filter((f) => BOQ_FOLDER_NAME.test(f.name)).map((f) => ({ id: f.id, path: f.name }));
}

async function filesIn(procore: ProcoreAdapter, procoreProjectId: number, start: { id: string; path: string }[], recursive: boolean) {
  const out: FileInFolder[] = [];
  const queue = [...start];
  const seen = new Set<string>();
  while (queue.length && seen.size < MAX_FOLDERS) {
    const f = queue.shift()!;
    if (seen.has(f.id)) continue;
    seen.add(f.id);
    const folder = await procore.getFolder(procoreProjectId, f.id);
    for (const file of folder.files) out.push({ ...file, folderId: f.id, folderPath: f.path });
    if (recursive) for (const sub of folder.folders) queue.push({ id: sub.id, path: `${f.path}/${sub.name}` });
  }
  return out;
}

// ---------------------------------------------------------------- capture of one file version

/**
 * Which BOQ document a Procore file belongs to, so a new revision supersedes the right one:
 * a new version of a file already captured keeps that file's document; otherwise the folder plus the file-name stem
 * without its revision suffix ("BC1 MEP BOQ RevB.xlsx" stored next to "... RevA.xlsx" supersedes it).
 */
async function documentKeyFor(q: Queryable, projectId: string, f: FileInFolder) {
  const prev = (
    await q.query<{ document_key: string }>(
      `select document_key from boq_document_revisions where project_id = $1 and procore_document_id = $2 order by submitted_at desc limit 1`,
      [projectId, f.id],
    )
  ).rows[0];
  if (prev) return prev.document_key;
  return `procore-folder:${f.folderId}:${defaultDocumentKey(f.name).replace(/^file:/, "")}`;
}

const isTemporary = (e: unknown) => e instanceof ProcoreError && (e.status === null || e.status === 429 || e.status >= 500);

async function captureFile(ctx: CaptureContext, project: { project_id: string; procore_project_id: number }, f: FileInFolder, via: string, r: ScanResult) {
  const { db, procore, organizationId, files } = ctx;
  const version = f.version ?? f.updatedAt ?? "unversioned";
  const existing = (
    await db.query<{ status: string; attempts: number }>(
      `select status, attempts from procore_document_captures where project_id = $1 and procore_file_id = $2 and procore_file_version = $3`,
      [project.project_id, f.id, version],
    )
  ).rows[0];
  if (existing && existing.status !== "retry" && existing.status !== "pending") return;
  if (existing && existing.attempts >= MAX_ATTEMPTS) return;

  const claim = (
    await db.query<{ capture_id: string; attempts: number }>(
      `insert into procore_document_captures (organization_id, project_id, procore_file_id, procore_file_version, file_name, folder_path, detected_via, attempts)
       values ($1, $2, $3, $4, $5, $6, $7, 1)
       on conflict (project_id, procore_file_id, procore_file_version) do update set attempts = procore_document_captures.attempts + 1,
         updated_at = now(), record_version = procore_document_captures.record_version + 1
       returning capture_id, attempts`,
      [organizationId, project.project_id, f.id, version, f.name, f.folderPath, via],
    )
  ).rows[0]!;

  const finish = async (status: string, message: string | null, revisionId: string | null = null, documentKey: string | null = null) => {
    await db.query(
      `update procore_document_captures set status = $2, message = $3, boq_revision_id = $4, document_key = $5, processed_at = now(), updated_at = now()
       where capture_id = $1`,
      [claim.capture_id, status, message, revisionId, documentKey],
    );
  };

  try {
    const file = await procore.downloadDocument(project.procore_project_id, f.id);
    const documentKey = await documentKeyFor(db, project.project_id, f);
    const res = await submitBoq(db, files, organizationId, {
      projectId: project.project_id,
      fileName: file.fileName || f.name,
      mimeType: file.mimeType,
      content: file.content,
      sourceTool: "procore_documents",
      procoreProjectId: project.procore_project_id,
      procoreDocumentId: f.id,
      sourceRevision: file.revision ?? version,
      documentKey,
      submittedBy: ACTOR,
    });
    if (res.duplicate) {
      r.duplicates++;
      await finish("duplicate", "Same content as a BOQ already imported for this project; nothing changed", res.revisionId, documentKey);
    } else {
      r.captured++;
      await finish("captured", res.supersededRevisionId ? "New revision; the previous revision of this BOQ is superseded" : null, res.revisionId, documentKey);
    }
    await audit(db, {
      organizationId,
      projectId: project.project_id,
      actor: ACTOR,
      action: res.duplicate ? "procore_document.duplicate" : "procore_document.captured",
      entity: "boq_revision",
      entityId: res.revisionId,
      detail: { procoreFileId: f.id, version, fileName: f.name, folder: f.folderPath, via },
    });
  } catch (e) {
    const message = String((e as Error)?.message ?? e).slice(0, 500);
    const retry = (isTemporary(e) || !(e instanceof InputError || e instanceof ProcoreError)) && claim.attempts < MAX_ATTEMPTS;
    if (retry) r.retrying++;
    else r.failed++;
    await finish(retry ? "retry" : "failed", retry ? `Temporary error, will retry: ${message}` : message);
  }
}

// ---------------------------------------------------------------- scan (serialized per project)

async function doScan(ctx: CaptureContext, projectId: string, via: "webhook" | "scan" | "manual"): Promise<ScanResult> {
  const { db, procore, organizationId } = ctx;
  const project = (
    await db.query<{ project_id: string; procore_project_id: number | null }>(
      `select project_id, procore_project_id from projects where project_id = $1 and organization_id = $2`,
      [projectId, organizationId],
    )
  ).rows[0];
  if (!project) throw new InputError("Project not found", 404);
  if (!project.procore_project_id) throw new InputError("This project is not linked to a Procore project");
  const r: ScanResult = { projectId, status: "ok", message: null, folders: [], filesSeen: 0, captured: 0, duplicates: 0, failed: 0, retrying: 0, skipped: [] };
  const w = await getWatch(db, projectId);
  if (!w.enabled) {
    r.status = "disabled";
    r.message = "Automatic capture is switched off for this project";
    return r;
  }
  const pid = Number(project.procore_project_id);
  try {
    const folders = await watchedFolders(procore, pid, w);
    r.folders = folders.map((f) => f.path);
    if (!folders.length) {
      r.status = "no_folder";
      r.message = 'No top-level folder named "BOQ" in this project\'s Procore Documents. Create one or choose the folder to watch.';
    } else {
      const files = await filesIn(procore, pid, folders, w.include_subfolders);
      r.filesSeen = files.length;
      for (const f of files) {
        if (!SUPPORTED_FILE.test(f.name)) {
          r.skipped.push(`${f.folderPath}/${f.name}`);
          continue;
        }
        await captureFile(ctx, { project_id: projectId, procore_project_id: pid }, f, via, r);
      }
      const parts = [`${r.filesSeen} file(s) in ${r.folders.join(", ")}`];
      if (r.captured) parts.push(`${r.captured} captured`);
      if (r.duplicates) parts.push(`${r.duplicates} unchanged`);
      if (r.failed) parts.push(`${r.failed} could not be read`);
      if (r.retrying) parts.push(`${r.retrying} to retry`);
      if (r.skipped.length) parts.push(`${r.skipped.length} not a BOQ format`);
      if (!r.captured && !r.duplicates && !r.failed && !r.retrying) parts.push("nothing new");
      r.message = parts.join("; ");
    }
  } catch (e) {
    r.status = "error";
    r.message = `Could not read Procore Documents: ${String((e as Error)?.message ?? e).slice(0, 400)}`;
  }
  await saveScanOutcome(db, organizationId, projectId, r);
  return r;
}

interface Slot {
  queued: Promise<ScanResult> | null;
  tail: Promise<unknown>;
}
const slots = new Map<string, Slot>();
const inFlight = new Set<Promise<unknown>>();
const track = <T>(p: Promise<T>) => {
  inFlight.add(p);
  p.finally(() => inFlight.delete(p)).catch(() => {});
  return p;
};

/**
 * Scans the project's watched folder. Scans of one project never overlap, and a burst of webhooks while a scan is
 * running is folded into one follow-up scan.
 */
export function scanProject(ctx: CaptureContext, projectId: string, via: "webhook" | "scan" | "manual"): Promise<ScanResult> {
  let slot = slots.get(projectId);
  if (!slot) {
    slot = { queued: null, tail: Promise.resolve() };
    slots.set(projectId, slot);
  }
  if (slot.queued) return slot.queued;
  const s = slot;
  const p: Promise<ScanResult> = s.tail.then(() => {
    if (s.queued === p) s.queued = null;
    return doScan(ctx, projectId, via);
  });
  s.queued = p;
  s.tail = p.catch(() => undefined);
  return track(p);
}

/** Waits for background webhook processing and scans (tests, shutdown). */
export async function drainCaptureWork() {
  while (inFlight.size) await Promise.allSettled([...inFlight]);
}

export async function listCaptures(q: Queryable, projectId: string, limit = 100) {
  return (
    await q.query(
      `select c.*, d.document_status, d.processing_status, d.project_conflict
       from procore_document_captures c left join boq_document_revisions d on d.boq_revision_id = c.boq_revision_id
       where c.project_id = $1 order by c.detected_at desc, c.file_name limit $2`,
      [projectId, limit],
    )
  ).rows;
}

// ---------------------------------------------------------------- webhooks

export class WebhookRejected extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

/**
 * Procore does not sign webhook deliveries. The only control is the Authorization header configured on the hook,
 * compared here in constant time.
 */
export function webhookAuthorized(secret: string | null | undefined, authorization: string | undefined) {
  if (!secret) return false;
  const a = Buffer.from(String(authorization ?? ""));
  const b = Buffer.from(`Bearer ${secret}`);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Stores a delivery before it is acknowledged. Redeliveries of the same ulid/id are recognised and not reprocessed. */
export async function recordWebhook(ctx: CaptureContext, payload: unknown): Promise<{ eventId: string | null; duplicate: boolean }> {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new WebhookRejected("Body must be a JSON object", 400);
  const p = payload as Record<string, any>;
  const deliveryId = String(p.ulid ?? p.id ?? "").trim();
  if (!deliveryId) throw new WebhookRejected("Delivery has neither ulid nor id", 400);
  const json = JSON.stringify(p);
  const row = (
    await ctx.db.query<{ event_id: string }>(
      `insert into procore_webhook_events (organization_id, delivery_id, procore_company_id, procore_project_id, resource_name, event_type, resource_id, payload, payload_hash)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       on conflict (organization_id, delivery_id) do nothing returning event_id`,
      [
        ctx.organizationId,
        deliveryId.slice(0, 120),
        p.company_id == null ? null : String(p.company_id),
        p.project_id == null ? null : String(p.project_id),
        String(p.resource_name ?? p.resource_type ?? "").slice(0, 120) || null,
        String(p.event_type ?? p.reason ?? "").slice(0, 40) || null,
        p.resource_id == null ? null : String(p.resource_id),
        json,
        sha256(json),
      ],
    )
  ).rows[0];
  return { eventId: row?.event_id ?? null, duplicate: !row };
}

/** Documents-tool resources ("Documents", "Files", "Folders", ...). Anything else is not about BOQ files. */
const DOCUMENT_RESOURCE = /file|folder|document/;

export async function processWebhook(ctx: CaptureContext, eventId: string) {
  const { db, procore, organizationId } = ctx;
  const ev = (await db.query<Record<string, any>>(`select * from procore_webhook_events where event_id = $1 and organization_id = $2`, [eventId, organizationId])).rows[0];
  if (!ev || ev.state !== "received") return ev;
  const done = async (state: string, message: string | null, projectId: string | null = null) => {
    return (
      await db.query<Record<string, any>>(
        `update procore_webhook_events set state = $2, message = $3, project_id = coalesce($4, project_id), processed_at = now()
         where event_id = $1 returning event_id, delivery_id, procore_project_id, project_id, resource_name, event_type, resource_id, state, message, received_at, processed_at`,
        [eventId, state, message, projectId],
      )
    ).rows[0];
  };
  try {
    if (String(ev.procore_company_id) !== String(procore.companyId)) return await done("ignored", `Company ${ev.procore_company_id} is not the connected company`);
    const resource = String(ev.resource_name ?? "").toLowerCase().replace(/[^a-z]/g, "");
    if (!DOCUMENT_RESOURCE.test(resource)) return await done("ignored", `Not a Documents event (${ev.resource_name ?? "no resource"})`);
    if (String(ev.event_type ?? "").toLowerCase() === "delete") return await done("ignored", "Deletions do not remove captured BOQ revisions");
    if (!ev.procore_project_id) return await done("ignored", "Company-level event without a project");
    const find = async () =>
      (
        await db.query<{ project_id: string }>(`select project_id from projects where organization_id = $1 and procore_company_id = $2 and procore_project_id = $3`, [
          organizationId,
          procore.companyId,
          Number(ev.procore_project_id),
        ])
      ).rows[0]?.project_id;
    let projectId = await find();
    if (!projectId) {
      // A project created in Procore after the last sync: bring it (and its WBS) in first.
      await syncFromProcore(db, procore, organizationId, ACTOR, Number(ev.procore_project_id));
      projectId = await find();
    }
    if (!projectId) return await done("failed", `Procore project ${ev.procore_project_id} was not found in the company`);
    const r = await scanProject(ctx, projectId, "webhook");
    return await done(r.status === "error" ? "failed" : "processed", r.message, projectId);
  } catch (e) {
    return await done("failed", String((e as Error)?.message ?? e).slice(0, 500));
  }
}

/** Processes a stored delivery in the background, after Procore has had its answer. */
export function processWebhookInBackground(ctx: CaptureContext, eventId: string, log: (m: string) => void = console.error) {
  track(processWebhook(ctx, eventId).catch((e) => log(`webhook ${eventId} failed: ${e?.message ?? e}`)));
}

/** Deliveries left unprocessed (e.g. the server restarted after storing them). */
export async function processPendingWebhooks(ctx: CaptureContext) {
  const ids = (
    await ctx.db.query<{ event_id: string }>(`select event_id from procore_webhook_events where organization_id = $1 and state = 'received' order by received_at limit 100`, [
      ctx.organizationId,
    ])
  ).rows;
  for (const { event_id } of ids) await processWebhook(ctx, event_id);
  return ids.length;
}

// ---------------------------------------------------------------- periodic catch-up scan

export async function scanAllProjects(ctx: CaptureContext) {
  await processPendingWebhooks(ctx);
  const projects = (
    await ctx.db.query<{ project_id: string }>(
      `select p.project_id from projects p left join procore_document_watches w on w.project_id = p.project_id
       where p.organization_id = $1 and p.procore_project_id is not null and coalesce(w.enabled, true) order by p.project_name`,
      [ctx.organizationId],
    )
  ).rows;
  const results: ScanResult[] = [];
  for (const p of projects) results.push(await scanProject(ctx, p.project_id, "scan"));
  return results;
}

/** Starts the periodic scan. Returns a function that stops it. */
export function startCapturePoller(ctx: CaptureContext, minutes: number, log: (m: string) => void) {
  if (!(minutes > 0)) return () => {};
  let busy = false;
  const tick = async () => {
    if (busy) return;
    busy = true;
    try {
      const rs = await scanAllProjects(ctx);
      const captured = rs.reduce((n, r) => n + r.captured, 0);
      if (captured) log(`Procore Documents scan: ${captured} BOQ file(s) captured`);
    } catch (e) {
      log(`Procore Documents scan failed: ${(e as Error)?.message ?? e}`);
    } finally {
      busy = false;
    }
  };
  const t = setInterval(tick, minutes * 60_000);
  t.unref?.();
  setTimeout(tick, 5_000).unref?.();
  return () => clearInterval(t);
}
