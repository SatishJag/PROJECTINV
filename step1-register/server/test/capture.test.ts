import { beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { drainCaptureWork, scanAllProjects } from "../src/capture.js";
import { migrate, pgliteDb, type Db } from "../src/db.js";
import { DemoProcoreAdapter, DEMO_PROJECTS } from "../src/procore.js";
import { ensureOrganization, syncFromProcore } from "../src/sync.js";
import { bc1Boq, bc2Boq, textPdf } from "../scripts/samples.js";

const SECRET = "test-webhook-secret";
let db: Db;
let app: Awaited<ReturnType<typeof buildApp>>;
let procore: DemoProcoreAdapter;
let orgId: string;
const P: Record<string, any> = {};
const PC: Record<string, number> = Object.fromEntries(DEMO_PROJECTS.map((p) => [p.name, p.id]));
let deliveries = 0;

async function api(method: "GET" | "POST" | "PUT", url: string, payload?: unknown, headers: Record<string, string> = {}) {
  const res = await app.inject({ method, url, payload: payload as any, headers: { "x-user-name": "qs.tester", ...headers } });
  return { status: res.statusCode, body: res.json() as any };
}

/** What Procore sends when a file is stored in Documents (v2 payload shape). */
function webhook(projectName: string, resourceId: string, eventType = "create", resourceName = "Documents", ulid = `01J${++deliveries}`) {
  return { ulid, id: deliveries, company_id: procore.companyId, project_id: PC[projectName], resource_name: resourceName, resource_id: resourceId, event_type: eventType, api_version: "v2" };
}
async function deliver(body: unknown, auth = `Bearer ${SECRET}`) {
  const r = await api("POST", "/api/procore/webhooks", body, { authorization: auth });
  await drainCaptureWork();
  return r;
}
/** The LDC stores a file in the project's Procore Documents (no webhook yet). */
const store = async (projectName: string, folder: string, fileName: string, content: Buffer | Promise<Buffer>) =>
  procore.storeDocument(PC[projectName]!, folder, fileName, await content);

const register = async (projectName: string, wpName?: string) => {
  const id = P[projectName].project_id;
  const s = (await api("GET", `/api/projects/${id}/structure`)).body;
  const wp = wpName ? s.workPackages.find((w: any) => w.name === wpName) : null;
  return (await api("GET", `/api/projects/${id}/register${wp ? `?workPackageId=${wp.work_package_id}` : ""}`)).body.rows as any[];
};
const captures = async (projectName: string) => (await api("GET", `/api/projects/${P[projectName].project_id}/procore-watch`)).body.captures as any[];
const revisions = async (projectName: string) => (await api("GET", `/api/projects/${P[projectName].project_id}/boq`)).body.revisions as any[];

beforeAll(async () => {
  db = await pgliteDb();
  await migrate(db);
  orgId = await ensureOrganization(db, "Capture test org");
  procore = new DemoProcoreAdapter();
  await syncFromProcore(db, procore, orgId, "test");
  app = await buildApp({ db, procore, organizationId: orgId, webDist: "/nonexistent", webhookSecret: SECRET });
  for (const p of (await api("GET", "/api/projects")).body) P[p.project_name] = p;
}, 60_000);

describe("BOQ stored in Procore Documents is captured automatically", () => {
  let fileA: string;

  it("captures every item when the LDC stores a BOQ in the project's BOQ folder", async () => {
    const s = await store("Bangkok Central 1", "BOQ", "BC1_MEP_BOQ_RevA.xlsx", bc1Boq());
    fileA = s.fileId;
    const r = await deliver(webhook("Bangkok Central 1", s.fileId));
    expect(r.status).toBe(202);
    expect(r.body.status).toBe("accepted");

    const c = await captures("Bangkok Central 1");
    expect(c).toHaveLength(1);
    expect(c[0]).toMatchObject({ procore_file_id: s.fileId, procore_file_version: "1", status: "captured", detected_via: "webhook", folder_path: "BOQ" });

    const ups = await register("Bangkok Central 1", "UPS");
    expect(ups.map((x) => [x.item_description, Number(x.boq_quantity), x.normalized_uom, x.budget_code])).toEqual([
      ["Copper cable", 800, "m", "26-200.M"],
      ["Modular UPS", 4, "each", "26-200.M"],
    ]);
    expect(ups[0].ordered_quantity).toBeNull();
    const detail = (await api("GET", `/api/register/${ups[0].inventory_record_id}`)).body;
    expect(detail.sources[0]).toMatchObject({ source_tool: "procore_documents", procore_document_id: s.fileId, source_revision: "1", source_locator: "Mechanical!R12" });
  });

  it("ignores a redelivered webhook and an unchanged folder", async () => {
    const body = webhook("Bangkok Central 1", fileA, "create", "Documents", "01J-REDELIVERED");
    await deliver(body);
    const again = await deliver(body);
    expect(again.body.status).toBe("duplicate");
    await api("POST", `/api/projects/${P["Bangkok Central 1"].project_id}/procore-scan`);
    expect(await captures("Bangkok Central 1")).toHaveLength(1);
    expect(await revisions("Bangkok Central 1")).toHaveLength(1);
    expect((await register("Bangkok Central 1", "UPS")).map((x) => Number(x.boq_quantity))).toEqual([800, 4]);
  });

  it("a new version of the same Procore file supersedes the old one; quantities are not summed", async () => {
    const s = await store("Bangkok Central 1", "BOQ", "BC1_MEP_BOQ_RevA.xlsx", bc1Boq({ upsCableQty: 900 }));
    expect(s.fileId).toBe(fileA);
    await deliver(webhook("Bangkok Central 1", s.fileId, "update"));
    const c = await captures("Bangkok Central 1");
    expect(c.find((x) => x.procore_file_version === "2")).toMatchObject({ status: "captured", document_status: "current" });
    const revs = await revisions("Bangkok Central 1");
    expect(revs.map((r) => r.document_status).sort()).toEqual(["current", "superseded"]);
    expect((await register("Bangkok Central 1", "UPS")).map((x) => Number(x.boq_quantity))).toEqual([900, 4]);
  });

  it("a revised BOQ stored as a new file next to the old one also supersedes it", async () => {
    const s = await store("Bangkok Central 1", "BOQ", "BC1_MEP_BOQ_RevB.xlsx", bc1Boq({ upsCableQty: 950 }));
    expect(s.fileId).not.toBe(fileA);
    await deliver(webhook("Bangkok Central 1", s.fileId));
    const current = (await revisions("Bangkok Central 1")).filter((r) => r.document_status === "current");
    expect(current.map((r) => r.file_name)).toEqual(["BC1_MEP_BOQ_RevB.xlsx"]);
    expect((await register("Bangkok Central 1", "UPS")).map((x) => Number(x.boq_quantity))).toEqual([950, 4]);
  });

  it("keeps each project's BOQ with its own project", async () => {
    const s = await store("Bangkok Central 2", "BOQ", "BC2_MEP_BOQ_RevA.xlsx", bc2Boq());
    await deliver(webhook("Bangkok Central 2", s.fileId));
    expect((await captures("Bangkok Central 2"))[0]).toMatchObject({ status: "captured" });
    expect((await register("Bangkok Central 2")).length).toBeGreaterThan(0);
    expect((await register("Bangkok Central 1", "UPS")).map((x) => Number(x.boq_quantity))).toEqual([950, 4]);
    const bc1Sources = await db.query(`select count(*)::int as n from boq_document_revisions where project_id = $1 and file_name like 'BC2%'`, [P["Bangkok Central 1"].project_id]);
    expect(bc1Sources.rows[0]!.n).toBe(0);
  });

  it("catches a BOQ whose webhook never arrived on the periodic scan", async () => {
    await store("Bangkok Central 3", "BOQ/Electrical", "BC3_UPS_BOQ.xlsx", bc1Boq({ projectName: "Bangkok Central 3" }));
    expect(await captures("Bangkok Central 3")).toHaveLength(0);
    await scanAllProjects({ db, procore, organizationId: orgId });
    const c = await captures("Bangkok Central 3");
    expect(c).toHaveLength(1);
    expect(c[0]).toMatchObject({ status: "captured", detected_via: "scan", folder_path: "BOQ/Electrical" });
    expect((await register("Bangkok Central 3", "UPS")).length).toBe(2);
  });

  it("leaves files outside the watched folder, and non-BOQ formats, alone", async () => {
    await store("Bangkok Central 4", "Drawings", "BC4_Electrical_SLD.pdf", textPdf(["Single line diagram"]));
    await store("Bangkok Central 4", "BOQ", "BOQ cover letter.docx", Buffer.from("not a BOQ"));
    const r = (await api("POST", `/api/projects/${P["Bangkok Central 4"].project_id}/procore-scan`)).body;
    expect(r.result).toMatchObject({ status: "ok", filesSeen: 1, captured: 0, skipped: ["BOQ/BOQ cover letter.docx"] });
    expect(await captures("Bangkok Central 4")).toHaveLength(0);
  });

  it("marks an unreadable file failed and does not retry it until a new version is stored", async () => {
    const s = await store("Bangkok Central 4", "BOQ", "BC4_scan.pdf", textPdf([]));
    await deliver(webhook("Bangkok Central 4", s.fileId));
    let c = (await captures("Bangkok Central 4")).find((x) => x.procore_file_id === s.fileId);
    expect(c).toMatchObject({ status: "failed", attempts: 1 });
    expect(c.message).toMatch(/OCR/);
    await api("POST", `/api/projects/${P["Bangkok Central 4"].project_id}/procore-scan`);
    c = (await captures("Bangkok Central 4")).find((x) => x.procore_file_id === s.fileId);
    expect(c.attempts).toBe(1);
  });

  it("retries a download that failed for a temporary Procore error", async () => {
    const s = await store("Bangkok Central 4", "BOQ", "BC4_MEP_BOQ.xlsx", bc1Boq({ projectName: "Bangkok Central 4" }));
    procore.failNextDownloads = 1;
    await deliver(webhook("Bangkok Central 4", s.fileId));
    let c = (await captures("Bangkok Central 4")).find((x) => x.procore_file_id === s.fileId);
    expect(c).toMatchObject({ status: "retry", attempts: 1 });
    await scanAllProjects({ db, procore, organizationId: orgId });
    c = (await captures("Bangkok Central 4")).find((x) => x.procore_file_id === s.fileId);
    expect(c).toMatchObject({ status: "captured", attempts: 2 });
  });

  it("watches a chosen folder instead of the default BOQ folder", async () => {
    const id = P["Bangkok Central 2"].project_id;
    const root = (await api("GET", `/api/projects/${id}/procore-folders`)).body;
    const specs = root.folders.find((f: any) => f.name === "Specifications");
    await api("PUT", `/api/projects/${id}/procore-watch`, { folderId: specs.id, folderPath: "Specifications" });
    await store("Bangkok Central 2", "Specifications", "BC2_Spec_BOQ.xlsx", bc1Boq({ projectName: "Bangkok Central 2", upsCableQty: 123 }));
    const r = (await api("POST", `/api/projects/${id}/procore-scan`)).body;
    expect(r.result).toMatchObject({ status: "ok", folders: ["Specifications"], captured: 1 });
    await api("PUT", `/api/projects/${id}/procore-watch`, { folderId: null });
  });
});

describe("Procore webhook receiver", () => {
  it("refuses deliveries without the configured secret", async () => {
    const r = await deliver(webhook("Bangkok Central 1", "1"), "Bearer wrong");
    expect(r.status).toBe(401);
    const none = await api("POST", "/api/procore/webhooks", webhook("Bangkok Central 1", "1"));
    expect(none.status).toBe(401);
  });

  it("refuses all deliveries when no secret is configured", async () => {
    const open = await buildApp({ db, procore, organizationId: orgId, webDist: "/nonexistent" });
    const r = await open.inject({ method: "POST", url: "/api/procore/webhooks", payload: webhook("Bangkok Central 1", "1"), headers: { authorization: "Bearer " } });
    expect(r.statusCode).toBe(503);
  });

  it("records but ignores events that are not about documents", async () => {
    const body = webhook("Bangkok Central 1", "55", "update", "Purchase Order Contracts");
    await deliver(body);
    const ev = (await api("GET", "/api/procore/webhook-events")).body.find((e: any) => e.delivery_id === body.ulid);
    expect(ev).toMatchObject({ state: "ignored" });
  });

  it("is reachable when the app password is set (Procore cannot sign in)", async () => {
    const locked = await buildApp({ db, procore, organizationId: orgId, webDist: "/nonexistent", appPassword: "pw", webhookSecret: SECRET });
    const r = await locked.inject({ method: "POST", url: "/api/procore/webhooks", payload: webhook("Bangkok Central 1", "1", "update", "Documents", "01J-LOCKED"), headers: { authorization: `Bearer ${SECRET}` } });
    expect(r.statusCode).toBe(202);
    await drainCaptureWork();
    const blocked = await locked.inject({ method: "GET", url: "/api/projects" });
    expect(blocked.statusCode).toBe(401);
  });
});

describe("demo: act as the LDC storing a BOQ in Procore", () => {
  it("stores the file in the demo Documents tool and delivers the webhook", async () => {
    const id = P["Bangkok Central 3"].project_id;
    const content = (await bc2Boq()).toString("base64");
    const r = await api("POST", `/api/projects/${id}/demo/procore-documents`, { fileName: "BC3_extra_BOQ.xlsx", contentBase64: content });
    expect(r.status).toBe(200);
    expect(r.body.event).toMatchObject({ state: "processed", resource_name: "Documents" });
    expect(r.body.captures.find((c: any) => c.file_name === "BC3_extra_BOQ.xlsx")).toMatchObject({ status: "captured", detected_via: "webhook" });
  });
});
