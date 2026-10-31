import { beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { migrate, pgliteDb, type Db } from "../src/db.js";
import { DemoProcoreAdapter } from "../src/procore.js";
import { ensureOrganization, syncFromProcore } from "../src/sync.js";
import { bc1Boq, bc2Boq, bc3PdfBoq } from "../scripts/samples.js";

let db: Db;
let app: Awaited<ReturnType<typeof buildApp>>;
let orgId: string;
const P: Record<string, any> = {};

async function api(method: "GET" | "POST" | "PATCH", url: string, payload?: unknown) {
  const res = await app.inject({ method, url, payload: payload as any, headers: { "x-user-name": "qs.tester" } });
  return { status: res.statusCode, body: res.json() as any };
}
const upload = (projectId: string, fileName: string, content: Buffer, extra: Record<string, unknown> = {}) =>
  api("POST", `/api/projects/${projectId}/boq`, { fileName, contentBase64: content.toString("base64"), ...extra });
const register = async (projectId: string, wpName?: string) => {
  const s = (await api("GET", `/api/projects/${projectId}/structure`)).body;
  const wp = wpName ? s.workPackages.find((w: any) => w.name === wpName) : null;
  return (await api("GET", `/api/projects/${projectId}/register${wp ? `?workPackageId=${wp.work_package_id}` : ""}`)).body.rows as any[];
};
const structure = async (projectId: string) => (await api("GET", `/api/projects/${projectId}/structure`)).body;
const caOf = async (projectId: string, wpName: string) => {
  const s = await structure(projectId);
  const wp = s.workPackages.find((w: any) => w.name === wpName);
  return s.costAssignments.find((c: any) => c.work_package_id === wp.work_package_id);
};
const linesOf = async (revisionId: string) => (await api("GET", `/api/boq/${revisionId}`)).body.lines as any[];
const line = (lines: any[], code: string) => lines.find((l) => l.raw_item_code === code);

beforeAll(async () => {
  db = await pgliteDb();
  await migrate(db);
  orgId = await ensureOrganization(db, "Test org");
  const procore = new DemoProcoreAdapter();
  await syncFromProcore(db, procore, orgId, "test");
  app = await buildApp({ db, procore, organizationId: orgId, webDist: "/nonexistent" });
  for (const p of (await api("GET", "/api/projects")).body) P[p.project_name] = p;
}, 60_000);

describe("Procore structure sync", () => {
  it("creates the projects with their work packages and cost assignments", async () => {
    expect(Object.keys(P)).toEqual(["Bangkok Central 1", "Bangkok Central 2", "Bangkok Central 3", "Bangkok Central 4"]);
    const s = await structure(P["Bangkok Central 1"].project_id);
    expect(s.workPackages.map((w: any) => w.name)).toEqual(["Chiller", "UPS", "Transformer", "Generator"]);
    expect(s.costAssignments.map((c: any) => c.budget_code)).toEqual(["26-100.M", "26-200.M", "26-300.M", "26-400.M"]);
  });
  it("is idempotent", async () => {
    await syncFromProcore(db, new DemoProcoreAdapter(), orgId, "test");
    const n = (await db.query(`select count(*)::int as n from work_packages`)).rows[0]!.n;
    expect(n).toBe(16);
  });
});

describe("BOQ submission for Bangkok Central 1", () => {
  let rev: string;
  let revA: Buffer;
  it("extracts every line and accounts for it", async () => {
    revA = await bc1Boq();
    const r = await upload(P["Bangkok Central 1"].project_id, "BC1_MEP_BOQ_RevA.xlsx", revA, { procoreDocumentId: "DOC-1", sourceRevision: "A" });
    expect(r.status).toBe(200);
    rev = r.body.revisionId;
    expect(r.body.revision.declared_project_name).toBe("Bangkok Central 1");
    expect(r.body.revision.project_conflict).toBe(false);
    expect(r.body.reconciliation).toMatchObject({ totalLines: 20, headings: 4, subtotals: 2, notes: 1, items: 13, published: 8, held: 2, unresolved: 3, invalid: 2, rejected: 0, accountedFor: true });
  });

  it("maps by heading or explicit cost code, never by description alone", async () => {
    const lines = await linesOf(rev);
    expect(line(lines, "1.2")).toMatchObject({ mapping_status: "mapped", work_package_name: "Chiller", mapping_basis: 'BOQ heading "1 CHILLER PLANT"' });
    expect(line(lines, "2.2")).toMatchObject({ mapping_status: "mapped", work_package_name: "UPS" });
    expect(line(lines, "E1")).toMatchObject({ mapping_status: "mapped", work_package_name: "Transformer", mapping_basis: "cost code 26-300" });
    // "GENERAL" copper cable: nothing establishes the work package
    expect(line(lines, "4.1").mapping_status).toBe("unresolved");
    // a heading naming two packages is ambiguous
    expect(line(lines, "3.1").mapping_status).toBe("unresolved");
    expect(JSON.stringify(line(lines, "3.1").validation_messages)).toMatch(/several work packages/);
    expect(line(lines, "E4").mapping_status).toBe("unresolved");
    expect(JSON.stringify(line(lines, "E4").validation_messages)).toMatch(/not in the project's approved/);
    // invalid quantity / unit are held, not published
    expect(line(lines, "2.3")).toMatchObject({ validation_status: "invalid", mapping_status: "proposed" });
    expect(line(lines, "E5")).toMatchObject({ validation_status: "invalid", mapping_status: "proposed" });
    // headings and subtotals are never items
    expect(lines.filter((l) => l.line_kind === "subtotal").map((l) => l.raw_description)).toEqual(["Sub-total carried to summary", "Total"]);
  });

  it("keeps the source unit and does not turn lump sums into counts", async () => {
    const lines = await linesOf(rev);
    expect(line(lines, "1.3")).toMatchObject({ raw_uom: "LS", uom_code: "lot" });
    expect(line(lines, "2.1")).toMatchObject({ raw_uom: "Nr", uom_code: "each" });
    expect(line(lines, "1.2")).toMatchObject({ raw_quantity: "1,200", uom_code: "m" });
    expect(Number(line(lines, "1.2").quantity)).toBe(1200);
  });

  it("shows Bangkok Central 1 -> UPS with item, spec, UOM, quantity, cost assignment and source", async () => {
    const rows = await register(P["Bangkok Central 1"].project_id, "UPS");
    expect(rows.map((r) => [r.item_description, r.normalized_uom, Number(r.boq_quantity), r.budget_code])).toEqual([
      ["Copper cable", "m", 800, "26-200.M"],
      ["Modular UPS", "each", 4, "26-200.M"],
    ]);
    expect(rows[0].ordered_quantity).toBeNull();
    const detail = (await api("GET", `/api/register/${rows[0].inventory_record_id}`)).body;
    expect(detail.sources).toHaveLength(1);
    expect(detail.sources[0]).toMatchObject({ source_locator: "Mechanical!R12", sheet_name: "Mechanical", procore_document_id: "DOC-1", source_revision: "A", file_name: "BC1_MEP_BOQ_RevA.xlsx" });
  });

  it("does not duplicate quantities when the same revision is imported again", async () => {
    const again = await upload(P["Bangkok Central 1"].project_id, "BC1_MEP_BOQ_RevA (copy).xlsx", revA);
    expect(again.body).toMatchObject({ duplicate: true, revisionId: rev });
    const rows = await register(P["Bangkok Central 1"].project_id, "UPS");
    expect(rows.map((r) => Number(r.boq_quantity))).toEqual([800, 4]);
  });

  it("splits a line across work packages only with quantities that reconcile", async () => {
    const tray = line(await linesOf(rev), "3.1");
    const ups = await caOf(P["Bangkok Central 1"].project_id, "UPS");
    const gen = await caOf(P["Bangkok Central 1"].project_id, "Generator");
    const bad = await api("POST", `/api/lines/${tray.boq_line_id}/resolve`, { allocations: [{ costAssignmentId: ups.cost_assignment_id, quantity: 500 }, { costAssignmentId: gen.cost_assignment_id, quantity: 500 }] });
    expect(bad.status).toBe(400);
    expect(bad.body.error).toMatch(/total 1000.*500/);
    const ok = await api("POST", `/api/lines/${tray.boq_line_id}/resolve`, { allocations: [{ costAssignmentId: ups.cost_assignment_id, quantity: 300 }, { costAssignmentId: gen.cost_assignment_id, quantity: 200 }], note: "per room layout" });
    expect(ok.status).toBe(200);
    const after = line(await linesOf(rev), "3.1");
    expect(after.mapping_status).toBe("split");
    expect(after.allocations.map((a: any) => [a.work_package, Number(a.quantity)]).sort()).toEqual([["Generator", 200], ["UPS", 300]]);
  });

  it("resolves, corrects and rejects exceptions", async () => {
    const lines = await linesOf(rev);
    const ups = await caOf(P["Bangkok Central 1"].project_id, "UPS");
    expect((await api("POST", `/api/lines/${line(lines, "4.1").boq_line_id}/resolve`, { allocations: [{ costAssignmentId: ups.cost_assignment_id, quantity: 300 }] })).status).toBe(200);
    expect((await api("POST", `/api/lines/${line(lines, "E5").boq_line_id}/correct`, { uom: "each" })).status).toBe(200);
    expect((await api("POST", `/api/lines/${line(lines, "E4").boq_line_id}/reject`, { reason: "Civil scope, not equipment" })).status).toBe(200);
    expect((await api("POST", `/api/lines/${line(lines, "2.3").boq_line_id}/correct`, { lineKind: "note" })).status).toBe(200);
    const after = await linesOf(rev);
    expect(line(after, "E5")).toMatchObject({ validation_status: "valid", mapping_status: "mapped", work_package_name: "Transformer" });
    const rec = (await api("GET", `/api/boq/${rev}`)).body.reconciliation;
    expect(rec).toMatchObject({ items: 12, published: 10, split: 1, held: 0, unresolved: 0, rejected: 1, accountedFor: true });
    const exceptions = (await api("GET", `/api/projects/${P["Bangkok Central 1"].project_id}/exceptions`)).body.rows;
    expect(exceptions).toHaveLength(0);
    const upsRows = await register(P["Bangkok Central 1"].project_id, "UPS");
    expect(upsRows.find((r) => r.item_description === "Copper cable").boq_quantity).toBe("1100.000000");
    expect(upsRows.find((r) => r.item_description.startsWith("Cable tray")).source_line_count).toBe(1);
  });

  it("a revised BOQ supersedes the old one; quantities are not summed across revisions; resolutions carry forward", async () => {
    const r = await upload(P["Bangkok Central 1"].project_id, "BC1_MEP_BOQ_RevB.xlsx", await bc1Boq({ upsCableQty: 900 }), { procoreDocumentId: "DOC-1", sourceRevision: "B" });
    expect(r.status).toBe(200);
    expect(r.body.supersededRevisionId).toBe(rev);
    const revs = (await api("GET", `/api/projects/${P["Bangkok Central 1"].project_id}/boq`)).body.revisions;
    expect(revs.map((x: any) => [x.source_revision, x.document_status])).toEqual([["B", "current"], ["A", "superseded"]]);
    const lines = await linesOf(r.body.revisionId);
    expect(line(lines, "3.1")).toMatchObject({ mapping_status: "split", mapping_basis: "resolution carried from the previous revision" });
    expect(line(lines, "4.1")).toMatchObject({ mapping_status: "mapped", work_package_name: "UPS" });
    expect(line(lines, "E4")).toMatchObject({ mapping_status: "rejected", resolution_note: "carried from the previous revision: Civil scope, not equipment" });
    expect(line(lines, "E5")).toMatchObject({ validation_status: "valid", mapping_status: "mapped", work_package_name: "Transformer" });
    expect(line(lines, "2.3")).toMatchObject({ line_kind: "note" });
    expect((await api("GET", `/api/boq/${r.body.revisionId}`)).body.reconciliation).toMatchObject({ unresolved: 0, invalid: 0, rejected: 1, accountedFor: true });
    const ups = await register(P["Bangkok Central 1"].project_id, "UPS");
    expect(Number(ups.find((x) => x.item_description === "Copper cable").boq_quantity)).toBe(900 + 300);
    // superseded revision lines cannot be edited
    const old = line(await linesOf(rev), "1.2");
    expect((await api("POST", `/api/lines/${old.boq_line_id}/reject`, { reason: "x" })).status).toBe(409);
  });
});

describe("Project separation", () => {
  it("shares the item definition but keeps project quantities separate", async () => {
    const r = await upload(P["Bangkok Central 2"].project_id, "BC2_MEP_BOQ_RevA.xlsx", await bc2Boq());
    expect(r.body.reconciliation).toMatchObject({ items: 3, published: 3, accountedFor: true });
    const bc2 = await register(P["Bangkok Central 2"].project_id, "UPS");
    expect(bc2.map((x) => [x.item_description, Number(x.boq_quantity)])).toEqual([["Copper cable", 600]]);
    const bc1 = await register(P["Bangkok Central 1"].project_id, "UPS");
    const bc1Cable = bc1.find((x) => x.item_description === "Copper cable");
    expect(bc1Cable.item_id).toBe(bc2[0].item_id);
    expect(bc1Cable.inventory_record_id).not.toBe(bc2[0].inventory_record_id);
    // an unfamiliar item is still recorded (provisional item definition)
    const gen = await register(P["Bangkok Central 2"].project_id, "Generator");
    expect(gen[0]).toMatchObject({ item_description: "Fuel polishing unit", item_verification_status: "provisional" });
    const items = (await api("GET", "/api/items")).body;
    const cable = items.find((i: any) => i.item_id === bc1Cable.item_id);
    expect(cable.usage.map((u: any) => u.project_name).sort()).toEqual(["Bangkok Central 1", "Bangkok Central 1", "Bangkok Central 2"]);
  });

  it("the database refuses cross-project references", async () => {
    const bc1 = P["Bangkok Central 1"].project_id;
    const bc2 = P["Bangkok Central 2"].project_id;
    const s2 = await structure(bc2);
    const bc1Req = (await register(bc1, "UPS"))[0];
    const anyItem = bc1Req.item_id;
    const uom = (await db.query(`select uom_id from units_of_measure where code = 'm'`)).rows[0]!.uom_id;
    await expect(
      db.query(
        `insert into inventory_requirements (organization_id, project_id, work_package_id, cost_assignment_id, item_id, uom_id, item_description) values ($1, $2, $3, $4, $5, $6, 'x')`,
        [orgId, bc1, s2.workPackages[0].work_package_id, s2.costAssignments[0].cost_assignment_id, anyItem, uom],
      ),
    ).rejects.toThrow(/foreign key/);
    // cost assignment of another work package in the same project
    const s1 = await structure(bc1);
    await expect(
      db.query(
        `insert into inventory_requirements (organization_id, project_id, work_package_id, cost_assignment_id, item_id, uom_id, item_description) values ($1, $2, $3, $4, $5, $6, 'x')`,
        [orgId, bc1, s1.workPackages[0].work_package_id, s1.costAssignments[1].cost_assignment_id, anyItem, uom],
      ),
    ).rejects.toThrow(/foreign key/);
    const bc2Line = (await db.query(`select boq_line_id from boq_lines where project_id = $1 and raw_item_code = '1.1'`, [bc2])).rows[0]!.boq_line_id;
    await expect(
      db.query(`insert into requirement_boq_allocations (project_id, inventory_record_id, boq_line_id, allocated_quantity, uom_id) values ($1, $2, $3, 1, $4)`, [bc1, bc1Req.inventory_record_id, bc2Line, uom]),
    ).rejects.toThrow(/another project|foreign key/);
    // and through the API
    const bc1Open = (await db.query(`select l.boq_line_id from boq_lines l join boq_document_revisions d using (boq_revision_id) where l.project_id = $1 and d.document_status = 'current' and l.raw_item_code = '1.2'`, [bc1])).rows[0]!.boq_line_id;
    const res = await api("POST", `/api/lines/${bc1Open}/resolve`, { allocations: [{ costAssignmentId: s2.costAssignments[1].cost_assignment_id, quantity: 1200 }] });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/not part of this BOQ line's project/);
  });

  it("the database refuses allocations above the line quantity", async () => {
    const bc2 = P["Bangkok Central 2"].project_id;
    const l = (await db.query(`select boq_line_id, uom_id from boq_lines where project_id = $1 and raw_item_code = '1.1'`, [bc2])).rows[0]!;
    const req = (await db.query(`select inventory_record_id from requirement_boq_allocations where boq_line_id = $1`, [l.boq_line_id])).rows[0]!;
    await expect(
      db.query(`insert into requirement_boq_allocations (project_id, inventory_record_id, boq_line_id, allocated_quantity, uom_id) values ($1, $2, $3, 1, $4)`, [bc2, req.inventory_record_id, l.boq_line_id, l.uom_id]),
    ).rejects.toThrow();
  });

  it("flags a file that names another project instead of moving it", async () => {
    const bc4 = P["Bangkok Central 4"].project_id;
    const r = await upload(bc4, "BC4_BOQ.xlsx", await bc1Boq({ projectName: "Bangkok Central 2" }));
    expect(r.body.revision.project_conflict).toBe(true);
    expect(r.body.reconciliation.published).toBe(0);
    expect(r.body.reconciliation.held).toBe(10);
    expect(await register(bc4)).toHaveLength(0);
    expect((await db.query(`select count(*)::int as n from boq_document_revisions where project_id = $1`, [P["Bangkok Central 2"].project_id])).rows[0]!.n).toBe(1);
    const c = await api("POST", `/api/boq/${r.body.revisionId}/confirm-project`, { note: "LDC reused the BC2 template; uploaded in the BC4 Documents tool" });
    expect(c.body.reconciliation).toMatchObject({ published: 8, held: 2 });
    const msgs: string[] = (await api("GET", `/api/boq/${r.body.revisionId}`)).body.revision.processing_messages;
    expect(msgs.some((m) => m.includes("Nothing is published"))).toBe(false);
    expect(msgs.some((m) => /^Project confirmed by .+: LDC reused the BC2 template/.test(m))).toBe(true);
    expect((await register(bc4)).length).toBeGreaterThan(0);
  });

  it("rejects a submission whose Procore context is another project", async () => {
    const r = await upload(P["Bangkok Central 3"].project_id, "x.xlsx", await bc2Boq(), { procoreProjectId: P["Bangkok Central 1"].procore_project_id });
    expect(r.status).toBe(400);
  });

  it("row-level security limits a signed-in user to their projects", async () => {
    const user = "11111111-1111-1111-1111-111111111111";
    await db.query(`insert into project_members (project_id, user_id) values ($1, $2)`, [P["Bangkok Central 2"].project_id, user]);
    const seen = await db.tx(async (q) => {
      await q.query(`select set_config('request.jwt.claim.sub', $1, true)`, [user]);
      await q.query(`set local role authenticated`);
      const projects = (await q.query(`select project_name from projects order by 1`)).rows.map((r: any) => r.project_name);
      const reg = (await q.query(`select distinct project_name from inventory_register`)).rows.map((r: any) => r.project_name);
      const lines = (await q.query(`select distinct project_id from boq_lines`)).rows.length;
      return { projects, reg, lines };
    });
    expect(seen).toEqual({ projects: ["Bangkok Central 2"], reg: ["Bangkok Central 2"], lines: 1 });
  });
});

describe("PDF BOQ", () => {
  it("extracts items from the text layer and maps them by heading", async () => {
    const r = await upload(P["Bangkok Central 3"].project_id, "BC3_Generator_BOQ.pdf", bc3PdfBoq());
    expect(r.status).toBe(200);
    expect(r.body.reconciliation).toMatchObject({ headings: 2, items: 3, published: 3, accountedFor: true });
    const gen = await register(P["Bangkok Central 3"].project_id, "Generator");
    expect(gen.map((x) => [x.item_description, Number(x.boq_quantity), x.normalized_uom])).toEqual([
      ["Copper cable specification A", 450, "m"],
      ["Diesel generator set 2000 kVA", 2, "each"],
    ]);
    const d = (await api("GET", `/api/register/${gen[0].inventory_record_id}`)).body;
    expect(d.sources[0]).toMatchObject({ page_number: 1, source_locator: "p1:L6" });
  });
  it("refuses a scanned PDF without a text layer", async () => {
    const { textPdf } = await import("../scripts/samples.js");
    const r = await upload(P["Bangkok Central 3"].project_id, "scan.pdf", textPdf([]));
    expect(r.status).toBe(422);
    expect(r.body.error).toMatch(/OCR/);
  });
});
