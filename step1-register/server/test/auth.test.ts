import { beforeAll, describe, expect, it } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";
import { buildApp } from "../src/app.js";
import { jwtAuthenticator } from "../src/auth.js";
import { LocalFileStore } from "../src/filestore.js";
import { migrate, pgliteDb, type Db } from "../src/db.js";
import { DemoProcoreAdapter } from "../src/procore.js";
import { ensureOrganization } from "../src/sync.js";
import { bc1Boq, bc2Boq } from "../scripts/samples.js";

const ISSUER = "https://login.example.test/tenant/v2.0";
const AUDIENCE = "api://projectinv-test";
const OWNER = "0f000000-0000-4000-8000-000000000001";
const BC1_ENGINEER = "0f000000-0000-4000-8000-000000000002";
const OUTSIDER = "0f000000-0000-4000-8000-000000000003";

let db: Db;
let app: Awaited<ReturnType<typeof buildApp>>;
let sign: (oid: string, name: string, opts?: { audience?: string }) => Promise<string>;
const P: Record<string, string> = {};

async function call(token: string | null, method: "GET" | "POST" | "PUT", url: string, payload?: unknown) {
  const res = await app.inject({ method, url, payload: payload as any, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), "x-user-name": "spoofed" } });
  return { status: res.statusCode, body: res.json() as any };
}

beforeAll(async () => {
  const { publicKey, privateKey } = await generateKeyPair("RS256");
  const jwk = { ...(await exportJWK(publicKey)), kid: "k1", alg: "RS256" };
  sign = (oid, name, opts = {}) =>
    new SignJWT({ oid, preferred_username: name }).setProtectedHeader({ alg: "RS256", kid: "k1" }).setIssuer(ISSUER).setAudience(opts.audience ?? AUDIENCE).setIssuedAt().setExpirationTime("10m").sign(privateKey);
  db = await pgliteDb();
  await migrate(db);
  const orgId = await ensureOrganization(db, "Auth org");
  const auth = jwtAuthenticator(createLocalJWKSet({ keys: [jwk] }), { issuer: ISSUER, audience: AUDIENCE, ownerUserIds: [OWNER] });
  app = await buildApp({ db, files: new LocalFileStore(fs.mkdtempSync(path.join(os.tmpdir(), "pir-auth-"))), procore: new DemoProcoreAdapter(), organizationId: orgId, auth, webDist: "/nonexistent" });
}, 60_000);

describe("Per-user sign-in: the API runs as the signed-in user under row-level security", () => {
  it("refuses requests without a valid token", async () => {
    expect((await call(null, "GET", "/api/projects")).status).toBe(401);
    expect((await call(await sign(OWNER, "owner@x", { audience: "someone-else" }), "GET", "/api/projects")).status).toBe(401);
    expect((await call("not-a-jwt", "GET", "/api/projects")).status).toBe(401);
    expect((await call(null, "GET", "/api/health")).status).toBe(200);
  });

  it("an owner syncs Procore and gives an engineer access to Bangkok Central 1 only", async () => {
    const owner = await sign(OWNER, "owner@x");
    expect((await call(owner, "GET", "/api/me")).body).toMatchObject({ user: { userId: OWNER }, organizationRole: "owner" });
    const sy = await call(owner, "POST", "/api/procore/sync", {});
    expect(sy.status).toBe(200);
    for (const p of (await call(owner, "GET", "/api/projects")).body) P[p.project_name] = p.project_id;
    expect(Object.keys(P)).toHaveLength(4);
    const mm = await call(owner, "PUT", `/api/members/${BC1_ENGINEER}`, { role: "member" });
    expect(mm.status).toBe(200);
    expect((await call(owner, "PUT", `/api/projects/${P["Bangkok Central 1"]}/members/${BC1_ENGINEER}`, { role: "engineer" })).status).toBe(200);
  });

  it("a member cannot sync Procore or manage memberships", async () => {
    const eng = await sign(BC1_ENGINEER, "eng@x");
    expect((await call(eng, "POST", "/api/procore/sync", {})).status).toBe(403);
    expect((await call(eng, "PUT", `/api/members/${OUTSIDER}`, { role: "owner" })).status).toBe(403);
  });

  it("the engineer sees and works on Bangkok Central 1 only, and is recorded as the actor", async () => {
    const eng = await sign(BC1_ENGINEER, "eng@x");
    expect((await call(eng, "GET", "/api/projects")).body.map((p: any) => p.project_name)).toEqual(["Bangkok Central 1"]);
    expect((await call(eng, "GET", `/api/projects/${P["Bangkok Central 2"]}/register`)).status).toBe(404);
    const up = await call(eng, "POST", `/api/projects/${P["Bangkok Central 1"]}/boq`, { fileName: "BC1_MEP_BOQ_RevA.xlsx", contentBase64: (await bc1Boq()).toString("base64") });
    expect(up.status).toBe(200);
    expect(up.body.reconciliation).toMatchObject({ published: 8, unresolved: 3, accountedFor: true });
    expect((await call(eng, "POST", `/api/projects/${P["Bangkok Central 2"]}/boq`, { fileName: "BC2.xlsx", contentBase64: (await bc2Boq()).toString("base64") })).status).toBe(404);
    const s = (await call(eng, "GET", `/api/projects/${P["Bangkok Central 1"]}/structure`)).body;
    const ups = s.workPackages.find((w: any) => w.name === "UPS");
    const rows = (await call(eng, "GET", `/api/projects/${P["Bangkok Central 1"]}/register?workPackageId=${ups.work_package_id}`)).body.rows;
    expect(rows.map((r: any) => [r.item_description, Number(r.boq_quantity)])).toEqual([["Copper cable", 800], ["Modular UPS", 4]]);
    const rev = (await db.query(`select submitted_by, created_by from boq_document_revisions where boq_revision_id = $1`, [up.body.revisionId])).rows[0];
    expect(rev).toEqual({ submitted_by: "eng@x", created_by: "eng@x" });
  });

  it("the engineer cannot touch a Bangkok Central 2 line, even by its id", async () => {
    const owner = await sign(OWNER, "owner@x");
    expect((await call(owner, "PUT", `/api/projects/${P["Bangkok Central 2"]}/members/${OUTSIDER}`, { role: "engineer" })).status).toBe(200);
    await call(owner, "PUT", `/api/members/${OUTSIDER}`, { role: "member" });
    const other = await sign(OUTSIDER, "bc2@x");
    expect((await call(other, "POST", `/api/projects/${P["Bangkok Central 2"]}/boq`, { fileName: "BC2.xlsx", contentBase64: (await bc2Boq()).toString("base64") })).status).toBe(200);
    const bc2Line = (await db.query(`select boq_line_id from boq_lines where project_id = $1 and line_type = 'item' limit 1`, [P["Bangkok Central 2"]])).rows[0]!.boq_line_id;
    const eng = await sign(BC1_ENGINEER, "eng@x");
    expect((await call(eng, "POST", `/api/lines/${bc2Line}/reject`, { reason: "not mine" })).status).toBe(404);
    expect((await db.query(`select mapping_status from boq_lines where boq_line_id = $1`, [bc2Line])).rows[0]!.mapping_status).not.toBe("rejected");
  });
});
