/**
 * Procore adapter for Step 1: projects, the project's WBS (cost-code segment items = work packages; WBS / budget codes
 * = cost assignments) and BOQ files submitted in the project's Documents tool.
 * Auth and request handling follow the proven AdvaPay adapter (SatishJag/Procore advapay/apps/server/src/procore.ts):
 * OAuth client credentials, `Procore-Company-Id` header, paging, paced requests, 429 handling.
 */

export interface ProcoreProject {
  id: number;
  name: string;
  projectNumber: string | null;
}
export interface ProcoreCostCode {
  id: string;
  code: string;
  name: string;
  parentId: string | null;
}
export interface ProcoreBudgetCode {
  id: string;
  /** Full budget code, e.g. "26-200.M". */
  budgetCode: string;
  description: string | null;
  costCodeId: string | null;
  costCode: string;
  costType: string | null;
  segments: { segmentId: string | null; itemId: string | null; code: string | null; name: string | null }[];
}
export interface ProcoreWbs {
  costCodes: ProcoreCostCode[];
  budgetCodes: ProcoreBudgetCode[];
}
export interface ProcoreFile {
  fileName: string;
  mimeType: string | null;
  revision: string | null;
  content: Buffer;
}
/** A file in a Documents folder listing; `version` is the latest file version number. */
export interface ProcoreFileEntry {
  id: string;
  name: string;
  version: string | null;
  updatedAt: string | null;
}
/** One Documents folder with its direct subfolders and files. `folderId` null = the project's root folder. */
export interface ProcoreFolder {
  id: string;
  name: string;
  folders: { id: string; name: string }[];
  files: ProcoreFileEntry[];
}
export interface ProcoreAdapter {
  readonly mode: "live" | "demo";
  readonly companyId: number;
  listProjects(): Promise<ProcoreProject[]>;
  getWbs(projectId: number): Promise<ProcoreWbs>;
  getFolder(projectId: number, folderId: string | null): Promise<ProcoreFolder>;
  downloadDocument(projectId: number, documentId: string): Promise<ProcoreFile>;
}

/** Procore's root folder also lists system folders that never hold BOQs. */
const SYSTEM_FOLDER = /^(recycle bin|trash)$/i;
const latestVersion = (versions: unknown) =>
  ((Array.isArray(versions) ? versions : []) as Record<string, any>[]).slice().sort((a, b) => Number(b.number ?? 0) - Number(a.number ?? 0))[0];

export class ProcoreError extends Error {
  constructor(
    readonly method: string,
    readonly path: string,
    readonly status: number | null,
    detail: string,
  ) {
    super(`Procore ${method} ${path}${status ? ` -> ${status}` : ""}: ${detail.slice(0, 400)}`);
  }
}

export interface LiveProcoreConfig {
  baseUrl: string;
  clientId: string;
  clientSecret: string;
  companyId: number;
  costCodeSegmentId?: string | null;
  costTypeSegmentId?: string | null;
  minIntervalMs?: number;
  fetchImpl?: typeof fetch;
  log?: (m: string) => void;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const str = (v: unknown) => (v === null || v === undefined || v === "" ? null : String(v));

export class LiveProcoreAdapter implements ProcoreAdapter {
  readonly mode = "live" as const;
  private token: { value: string; expiresAt: number } | null = null;
  private nextSlot = 0;
  private readonly f: typeof fetch;

  constructor(private readonly cfg: LiveProcoreConfig) {
    this.f = cfg.fetchImpl ?? fetch;
  }
  get companyId() {
    return this.cfg.companyId;
  }

  private async accessToken() {
    if (this.token && Date.now() < this.token.expiresAt) return this.token.value;
    const res = await this.f(`${this.cfg.baseUrl}/oauth/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "client_credentials", client_id: this.cfg.clientId, client_secret: this.cfg.clientSecret }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) throw new ProcoreError("POST", "/oauth/token", res.status, await res.text());
    const body = (await res.json()) as { access_token: string; expires_in?: number };
    this.token = { value: body.access_token, expiresAt: Date.now() + ((body.expires_in ?? 3600) - 60) * 1000 };
    return this.token.value;
  }

  private async raw(path: string, query: Record<string, string | number> = {}, absolute = false): Promise<Response> {
    const qs = new URLSearchParams(Object.entries(query).map(([k, v]) => [k, String(v)])).toString();
    const url = absolute ? path : `${this.cfg.baseUrl}${path}${qs ? `?${qs}` : ""}`;
    for (let attempt = 0; ; attempt++) {
      const now = Date.now();
      const at = Math.max(now, this.nextSlot);
      this.nextSlot = at + (this.cfg.minIntervalMs ?? 250);
      if (at > now) await sleep(at - now);
      const headers: Record<string, string> = absolute
        ? {}
        : { authorization: `Bearer ${await this.accessToken()}`, accept: "application/json", "procore-company-id": String(this.cfg.companyId) };
      let res: Response;
      try {
        res = await this.f(url, { headers, signal: AbortSignal.timeout(60_000) });
      } catch (e) {
        if (attempt < 3) {
          await sleep(500 * 2 ** attempt);
          continue;
        }
        throw new ProcoreError("GET", path, null, String(e));
      }
      if (res.status === 401 && attempt === 0 && !absolute) {
        this.token = null;
        continue;
      }
      if (res.status === 429 && attempt < 4) {
        const retry = Number(res.headers.get("retry-after"));
        const reset = Number(res.headers.get("x-rate-limit-reset"));
        const wait = retry > 0 ? retry * 1000 : reset > 0 ? reset * 1000 - Date.now() + 500 : 5000 * 2 ** attempt;
        if (wait > 120_000) throw new ProcoreError("GET", path, 429, "Procore's hourly API limit is used up; try again after it resets");
        this.cfg.log?.(`Procore 429 on ${path}: waiting ${Math.round(wait / 1000)}s`);
        await sleep(Math.max(wait, 1000));
        continue;
      }
      if (res.status >= 500 && attempt < 3) {
        await sleep(500 * 2 ** attempt);
        continue;
      }
      if (!res.ok) throw new ProcoreError("GET", path, res.status, await res.text());
      return res;
    }
  }

  private async get(path: string, query: Record<string, string | number> = {}) {
    const text = await (await this.raw(path, query)).text();
    return text ? JSON.parse(text) : null;
  }

  private async listAll(path: string, query: Record<string, string | number> = {}) {
    const all: Record<string, any>[] = [];
    for (let page = 1; ; page++) {
      const rows = await this.get(path, { ...query, page, per_page: 100 });
      if (!Array.isArray(rows)) return all;
      all.push(...rows);
      if (rows.length < 100) return all;
    }
  }

  async listProjects() {
    const rows = await this.listAll("/rest/v1.0/projects", { company_id: this.cfg.companyId });
    return rows
      .filter((p) => p.active !== false)
      .map((p) => ({ id: Number(p.id), name: String(p.name ?? p.display_name ?? p.id), projectNumber: str(p.project_number) }));
  }

  private async segmentIds(projectId: number) {
    if (this.cfg.costCodeSegmentId) return { costCode: this.cfg.costCodeSegmentId, costType: this.cfg.costTypeSegmentId ?? null };
    const segs = await this.listAll(`/rest/v1.0/projects/${projectId}/work_breakdown_structure/segments`).catch(() => []);
    const find = (re: RegExp) => str(segs.find((s) => re.test(String(s.name ?? s.segment_type ?? "")))?.id);
    return { costCode: find(/cost\s*code/i), costType: find(/cost\s*type/i) };
  }

  async getWbs(projectId: number): Promise<ProcoreWbs> {
    const base = `/rest/v1.0/projects/${projectId}/work_breakdown_structure`;
    const seg = await this.segmentIds(projectId);
    const items = seg.costCode ? await this.listAll(`${base}/segments/${seg.costCode}/segment_items`) : [];
    const costCodes: ProcoreCostCode[] = items.map((r) => ({
      id: String(r.id),
      code: String(r.code ?? ""),
      name: String(r.name ?? r.description ?? r.code ?? ""),
      parentId: str(r.parent_id),
    }));
    const wbs = await this.listAll(`${base}/wbs_codes`).catch(() => []);
    const budgetCodes: ProcoreBudgetCode[] = wbs.map((w) => {
      const segments = ((w.segment_items ?? w.segments ?? []) as Record<string, any>[]).map((s) => ({
        segmentId: str(s.segment_id),
        itemId: str(s.segment_item_id ?? s.id),
        code: str(s.code),
        name: str(s.name),
      }));
      const cc = segments.find((s) => s.segmentId === seg.costCode) ?? segments[0];
      const ct = seg.costType ? segments.find((s) => s.segmentId === seg.costType) : segments[1];
      const ccItem = costCodes.find((c) => c.id === cc?.itemId);
      const costCode = cc?.code ?? ccItem?.code ?? "";
      return {
        id: String(w.id),
        budgetCode: String(w.flat_code ?? w.code ?? [costCode, ct?.code].filter(Boolean).join(".")),
        description: str(w.description ?? w.flat_name),
        costCodeId: cc?.itemId ?? null,
        costCode,
        costType: ct?.code ?? ct?.name ?? null,
        segments,
      };
    });
    return { costCodes, budgetCodes };
  }

  /**
   * Documents tool folder: GET /rest/v1.0/folders (root) or /rest/v1.0/folders/{id}, with project_id. Nested folders
   * come back without their contents, so callers walk the tree one folder at a time. Not yet verified live.
   */
  async getFolder(projectId: number, folderId: string | null): Promise<ProcoreFolder> {
    const path = folderId ? `/rest/v1.0/folders/${encodeURIComponent(folderId)}` : "/rest/v1.0/folders";
    const f = await this.get(path, { project_id: projectId });
    const live = (x: Record<string, any>) => !x.is_deleted && !x.is_recycle_bin && !SYSTEM_FOLDER.test(String(x.name ?? ""));
    return {
      id: String(f?.id ?? folderId ?? "root"),
      name: String(f?.name ?? ""),
      folders: ((f?.folders ?? []) as Record<string, any>[]).filter(live).map((x) => ({ id: String(x.id), name: String(x.name ?? x.id) })),
      files: ((f?.files ?? []) as Record<string, any>[])
        .filter((x) => !x.is_deleted)
        .map((x) => {
          const v = latestVersion(x.file_versions);
          return { id: String(x.id), name: String(x.name ?? x.id), version: str(v?.number) ?? str(v?.id), updatedAt: str(x.updated_at ?? v?.created_at) };
        }),
    };
  }

  /** Documents tool file (GET /rest/v1.0/files/{id}); the latest file version is downloaded. Not yet verified live. */
  async downloadDocument(projectId: number, documentId: string): Promise<ProcoreFile> {
    const file = await this.get(`/rest/v1.0/files/${encodeURIComponent(documentId)}`, { project_id: projectId });
    const v = latestVersion(file?.file_versions);
    const url = str(v?.url ?? v?.prostore_file?.url);
    if (!url) throw new ProcoreError("GET", `/rest/v1.0/files/${documentId}`, null, "the file has no downloadable version");
    const res = await this.raw(url, {}, true);
    return {
      fileName: String(file?.name ?? v?.prostore_file?.filename ?? `procore-${documentId}`),
      mimeType: res.headers.get("content-type"),
      revision: str(v?.number) ?? str(v?.id),
      content: Buffer.from(await res.arrayBuffer()),
    };
  }
}

/** Demo company: the Bangkok Central data-centre projects with their equipment WBS. */
export const DEMO_COMPANY_ID = 4283715;
const DEMO_WBS: [string, string][] = [
  ["26-100", "Chiller"],
  ["26-200", "UPS"],
  ["26-300", "Transformer"],
  ["26-400", "Generator"],
];
export const DEMO_PROJECTS: ProcoreProject[] = [
  { id: 900101, name: "Bangkok Central 1", projectNumber: "BKK-01" },
  { id: 900102, name: "Bangkok Central 2", projectNumber: "BKK-02" },
  { id: 900103, name: "Bangkok Central 3", projectNumber: "BKK-03" },
  { id: 900104, name: "Bangkok Central 4", projectNumber: "BKK-04" },
];

interface DemoFolder {
  id: string;
  name: string;
  parentId: string | null;
  projectId: number;
}
interface DemoDocument {
  id: string;
  name: string;
  folderId: string;
  projectId: number;
  versions: { number: number; mimeType: string | null; content: Buffer }[];
}

/**
 * Demo company: the Bangkok Central data-centre projects with their equipment WBS, plus an in-memory Documents tool
 * in which the LDC "stores" BOQ files (each project starts with Drawings, Specifications and BOQ folders).
 */
export class DemoProcoreAdapter implements ProcoreAdapter {
  readonly mode = "demo" as const;
  readonly companyId = DEMO_COMPANY_ID;
  private readonly folders = new Map<string, DemoFolder>();
  private readonly files = new Map<string, DemoDocument>();
  private seq = 7_000_000;
  /** Test hook: the next n downloads fail as if Procore answered 503. */
  failNextDownloads = 0;

  async listProjects() {
    return DEMO_PROJECTS;
  }
  async getWbs(projectId: number): Promise<ProcoreWbs> {
    const costCodes = DEMO_WBS.map(([code, name], i) => ({ id: `${projectId}-cc-${i + 1}`, code, name, parentId: null }));
    const budgetCodes = costCodes.map((c) => ({
      id: `${projectId}-wbs-${c.code}.M`,
      budgetCode: `${c.code}.M`,
      description: `${c.name} - Materials`,
      costCodeId: c.id,
      costCode: c.code,
      costType: "M",
      segments: [
        { segmentId: "cost_code", itemId: c.id, code: c.code, name: c.name },
        { segmentId: "cost_type", itemId: "M", code: "M", name: "Materials" },
      ],
    }));
    return { costCodes, budgetCodes };
  }

  private project(projectId: number) {
    if (!DEMO_PROJECTS.some((p) => p.id === projectId)) throw new ProcoreError("GET", "/rest/v1.0/folders", 404, `project ${projectId} is not in the demo company`);
  }
  private root(projectId: number) {
    this.project(projectId);
    const id = `root-${projectId}`;
    if (!this.folders.has(id)) {
      this.folders.set(id, { id, name: "Documents", parentId: null, projectId });
      for (const n of ["Drawings", "Specifications", "BOQ"]) this.child(projectId, id, n);
    }
    return id;
  }
  private child(projectId: number, parentId: string, name: string) {
    const found = [...this.folders.values()].find((f) => f.parentId === parentId && f.name.toLowerCase() === name.toLowerCase());
    if (found) return found.id;
    const id = String(++this.seq);
    this.folders.set(id, { id, name, parentId, projectId });
    return id;
  }

  /** Simulates someone storing a file in Procore Documents. Same name in the same folder = a new version. */
  storeDocument(projectId: number, folderPath: string, fileName: string, content: Buffer, mimeType: string | null = null) {
    let folderId = this.root(projectId);
    for (const part of folderPath.split("/").map((x) => x.trim()).filter(Boolean)) folderId = this.child(projectId, folderId, part);
    let doc = [...this.files.values()].find((d) => d.folderId === folderId && d.name === fileName);
    if (!doc) {
      doc = { id: String(++this.seq), name: fileName, folderId, projectId, versions: [] };
      this.files.set(doc.id, doc);
    }
    doc.versions.push({ number: doc.versions.length + 1, mimeType, content });
    return { fileId: doc.id, version: String(doc.versions.length), folderId };
  }

  async getFolder(projectId: number, folderId: string | null): Promise<ProcoreFolder> {
    const id = folderId ?? this.root(projectId);
    const f = this.folders.get(id);
    if (!f || f.projectId !== projectId) throw new ProcoreError("GET", `/rest/v1.0/folders/${id}`, 404, "not found in the demo company");
    return {
      id,
      name: f.name,
      folders: [...this.folders.values()].filter((x) => x.parentId === id).map((x) => ({ id: x.id, name: x.name })),
      files: [...this.files.values()]
        .filter((d) => d.folderId === id)
        .map((d) => ({ id: d.id, name: d.name, version: String(d.versions.length), updatedAt: null })),
    };
  }

  async downloadDocument(projectId: number, documentId: string): Promise<ProcoreFile> {
    if (this.failNextDownloads > 0) {
      this.failNextDownloads--;
      throw new ProcoreError("GET", `/rest/v1.0/files/${documentId}`, 503, "Service Unavailable (simulated)");
    }
    const d = this.files.get(documentId);
    if (!d || d.projectId !== projectId) throw new ProcoreError("GET", `/rest/v1.0/files/${documentId}`, 404, "not found in the demo company");
    const v = d.versions[d.versions.length - 1]!;
    return { fileName: d.name, mimeType: v.mimeType, revision: String(v.number), content: v.content };
  }
}

export function procoreFromEnv(env: NodeJS.ProcessEnv, log?: (m: string) => void): ProcoreAdapter {
  if (env.PROCORE_MODE !== "demo" && env.PROCORE_CLIENT_ID && env.PROCORE_CLIENT_SECRET) {
    return new LiveProcoreAdapter({
      baseUrl: (env.PROCORE_BASE_URL ?? "https://sandbox.procore.com").replace(/\/+$/, ""),
      clientId: env.PROCORE_CLIENT_ID,
      clientSecret: env.PROCORE_CLIENT_SECRET,
      companyId: Number(env.PROCORE_COMPANY_ID ?? DEMO_COMPANY_ID),
      costCodeSegmentId: env.PROCORE_COST_CODE_SEGMENT_ID ?? null,
      costTypeSegmentId: env.PROCORE_COST_TYPE_SEGMENT_ID ?? null,
      log,
    });
  }
  return new DemoProcoreAdapter();
}
