import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { migrate, pgliteDb, type Db } from "../src/db.js";
import { AzureBlobFileStore, boqFileKey, FileStoreError, LocalFileStore, moveLegacyFiles, type FileStore } from "../src/filestore.js";
import { DemoProcoreAdapter } from "../src/procore.js";
import { ensureOrganization, syncFromProcore } from "../src/sync.js";
import { bc1Boq } from "../scripts/samples.js";

const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "pir-store-"));
const readAll = async (s: NodeJS.ReadableStream) => {
  const parts: Buffer[] = [];
  for await (const c of s) parts.push(Buffer.from(c as Buffer));
  return Buffer.concat(parts);
};

/** Behaviour every store must have. */
function contract(name: string, make: () => FileStore) {
  describe(name, () => {
    const content = Buffer.from("Item,Description,Qty\n1.1,Modular UPS,4\n");
    const key = boqFileKey("org-1", "project-1", sha(content));

    it("stores a file once and reads it back intact", async () => {
      const s = make();
      expect(await s.put(key, content, { sha256: sha(content), contentType: "text/csv", fileName: "BOQ Rev A.csv" })).toEqual({ created: true });
      expect(await s.put(key, content, { sha256: sha(content) })).toEqual({ created: false });
      expect((await s.get(key, sha(content))).equals(content)).toBe(true);
      expect((await readAll(await s.open(key))).equals(content)).toBe(true);
    });
    it("refuses a file that does not match its recorded sha256", async () => {
      await expect(make().get(key, "0".repeat(64))).rejects.toThrow(/does not match/);
    });
    it("reports a missing file clearly", async () => {
      await expect(make().get("boq/org-1/project-1/missing")).rejects.toBeInstanceOf(FileStoreError);
      await expect(make().open("boq/org-1/project-1/missing")).rejects.toBeInstanceOf(FileStoreError);
    });
    it("rejects keys that try to leave the store", async () => {
      await expect(make().put("../etc/passwd", content, { sha256: sha(content) })).rejects.toThrow(/Invalid file key/);
    });
  });
}

const localRoot = tmp();
contract("Local folder store", () => new LocalFileStore(localRoot));

// Azure Blob Storage, exercised against Azurite (Microsoft's local emulator) with the real Azure SDK.
let azurite: ChildProcess | null = null;
let azureConn = "";
const freePort = () =>
  new Promise<number>((resolve) => {
    const srv = net.createServer().listen(0, () => {
      const p = (srv.address() as net.AddressInfo).port;
      srv.close(() => resolve(p));
    });
  });
beforeAll(async () => {
  const port = await freePort();
  const bin = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../node_modules/.bin/azurite-blob");
  azurite = spawn(bin, ["--inMemoryPersistence", "--blobHost", "127.0.0.1", "--blobPort", String(port), "--silent", "--skipApiVersionCheck"], { stdio: "ignore" });
  for (let i = 0; i < 100; i++) {
    const ok = await new Promise<boolean>((r) => net.connect(port, "127.0.0.1").on("connect", function (this: net.Socket) { this.end(); r(true); }).on("error", () => r(false)));
    if (ok) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  azureConn = `DefaultEndpointsProtocol=http;AccountName=devstoreaccount1;AccountKey=Eby8vdM02xNOcqFlqUwJPLlmEtlCDXJ1OUzFT50uSRZ6IFsuFq2UVErCz4I6tq/K1SZFPTOtr/KBHBeksoGMGw==;BlobEndpoint=http://127.0.0.1:${port}/devstoreaccount1;`;
}, 30_000);
afterAll(() => {
  azurite?.kill();
});
contract("Azure Blob store (Azurite)", () => new AzureBlobFileStore({ container: "boq-originals", connectionString: azureConn }));

describe("BOQ originals live in the file store, not in Postgres", () => {
  let db: Db;
  let app: Awaited<ReturnType<typeof buildApp>>;
  let store: AzureBlobFileStore;
  let projectId: string;

  beforeAll(async () => {
    db = await pgliteDb();
    await migrate(db);
    const orgId = await ensureOrganization(db, "Store test org");
    const procore = new DemoProcoreAdapter();
    await syncFromProcore(db, procore, orgId, "test");
    store = new AzureBlobFileStore({ container: "boq-test", connectionString: azureConn });
    app = await buildApp({ db, files: store, procore, organizationId: orgId, webDist: "/nonexistent" });
    projectId = (await db.query(`select project_id from projects where project_name = 'Bangkok Central 1'`)).rows[0]!.project_id;
  }, 60_000);

  it("uploads the original to Azure Blob and keeps only its key, size and hash in the database", async () => {
    const content = await bc1Boq();
    const res = await app.inject({ method: "POST", url: `/api/projects/${projectId}/boq`, payload: { fileName: "BC1_MEP_BOQ_RevA.xlsx", contentBase64: content.toString("base64") } });
    expect(res.statusCode).toBe(200);
    const rev = (await db.query(`select * from boq_document_revisions where boq_revision_id = $1`, [res.json().revisionId])).rows[0]!;
    expect(rev).toMatchObject({ storage_kind: "azure-blob", file_content: null, file_size: content.length, file_hash: sha(content) });
    expect(rev.storage_key).toBe(boqFileKey(rev.organization_id, projectId, sha(content)));
    expect((await store.get(rev.storage_key, rev.file_hash)).equals(content)).toBe(true);

    const dl = await app.inject({ method: "GET", url: `/api/boq/${rev.boq_revision_id}/file` });
    expect(dl.statusCode).toBe(200);
    expect(dl.rawPayload.equals(content)).toBe(true);
  });

  it("moves files stored in the database before the file store existed", async () => {
    const content = await bc1Boq({ upsCableQty: 1 });
    const res = await app.inject({ method: "POST", url: `/api/projects/${projectId}/boq`, payload: { fileName: "legacy.xlsx", contentBase64: content.toString("base64") } });
    const id = res.json().revisionId;
    // Make it look like a row written by the old code.
    await db.query(`update boq_document_revisions set file_content = $2, storage_kind = null, storage_key = null where boq_revision_id = $1`, [id, content]);
    const legacy = await app.inject({ method: "GET", url: `/api/boq/${id}/file` });
    expect(legacy.rawPayload.equals(content)).toBe(true);

    expect(await moveLegacyFiles(db, store)).toBe(1);
    expect(await moveLegacyFiles(db, store)).toBe(0);
    const rev = (await db.query(`select storage_kind, storage_key, file_content from boq_document_revisions where boq_revision_id = $1`, [id])).rows[0]!;
    expect(rev).toMatchObject({ storage_kind: "azure-blob", file_content: null });
    const dl = await app.inject({ method: "GET", url: `/api/boq/${id}/file` });
    expect(dl.rawPayload.equals(content)).toBe(true);
  });

  it("the database refuses a revision with no original kept anywhere", async () => {
    await expect(db.query(`update boq_document_revisions set storage_key = null, file_content = null`)).rejects.toThrow(/boq_revision_original_kept/);
  });
});
