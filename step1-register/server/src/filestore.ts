/**
 * Where original BOQ files live. Files are kept out of Postgres: the database stores only the key, size and sha256.
 *
 * Keys are content-addressed per project (`boq/<org>/<project>/<sha256>`), so storing the same file twice is a no-op,
 * and a file can never be silently replaced: the sha256 is checked again when the file is read back.
 *
 *  - AzureBlobFileStore: production on Azure. Authenticates with the VM's managed identity (no keys) or, for local
 *    development against Azurite, a connection string. Old files move to cheaper tiers through the storage account's
 *    lifecycle policy (infra), not through this code.
 *  - LocalFileStore: development and tests (a folder on disk).
 * An S3 store can be added behind the same interface for AWS clients.
 */
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { Readable } from "node:stream";

export interface FilePutMeta {
  sha256: string;
  contentType?: string | null;
  fileName?: string | null;
}

export interface FileStore {
  /** "local" or "azure-blob"; recorded on each revision so files stay readable if the default store changes. */
  readonly kind: string;
  /** Stores the file under `key`. Idempotent: an existing object with the same key is kept (created = false). */
  put(key: string, content: Buffer, meta: FilePutMeta): Promise<{ created: boolean }>;
  /** Reads the whole file and checks it against the expected sha256. */
  get(key: string, expectedSha256?: string | null): Promise<Buffer>;
  /** Streams the file (downloads of large originals). */
  open(key: string): Promise<Readable>;
}

export class FileStoreError extends Error {}

export const boqFileKey = (organizationId: string, projectId: string, sha256: string) => `boq/${organizationId}/${projectId}/${sha256}`;

const sha256Of = (b: Buffer) => createHash("sha256").update(b).digest("hex");
const checkKey = (key: string) => {
  if (!/^[a-z0-9][a-z0-9/_.-]{0,500}$/i.test(key) || key.includes("..")) throw new FileStoreError(`Invalid file key: ${key}`);
  return key;
};
function verify(key: string, content: Buffer, expected?: string | null) {
  if (expected && sha256Of(content) !== expected) throw new FileStoreError(`Stored file ${key} does not match its recorded sha256`);
  return content;
}

// ---------------------------------------------------------------- local folder (dev, tests)

export class LocalFileStore implements FileStore {
  readonly kind = "local";
  constructor(readonly root: string) {}

  private file(key: string) {
    return path.join(this.root, ...checkKey(key).split("/"));
  }

  async put(key: string, content: Buffer) {
    const target = this.file(key);
    if (fs.existsSync(target)) return { created: false };
    await fs.promises.mkdir(path.dirname(target), { recursive: true });
    const tmp = `${target}.${randomUUID()}.tmp`;
    await fs.promises.writeFile(tmp, content);
    await fs.promises.rename(tmp, target);
    return { created: true };
  }

  async get(key: string, expectedSha256?: string | null) {
    try {
      return verify(key, await fs.promises.readFile(this.file(key)), expectedSha256);
    } catch (e: any) {
      if (e?.code === "ENOENT") throw new FileStoreError(`File ${key} is missing from the file store`);
      throw e;
    }
  }

  async open(key: string) {
    const f = this.file(key);
    if (!fs.existsSync(f)) throw new FileStoreError(`File ${key} is missing from the file store`);
    return fs.createReadStream(f);
  }
}

// ---------------------------------------------------------------- Azure Blob Storage

export interface AzureBlobConfig {
  container: string;
  /** e.g. https://<account>.blob.core.windows.net; authenticated with DefaultAzureCredential (managed identity). */
  accountUrl?: string | null;
  /** Alternative for local development (Azurite) or when a key must be used. */
  connectionString?: string | null;
}

export class AzureBlobFileStore implements FileStore {
  readonly kind = "azure-blob";
  private containerClient: Promise<import("@azure/storage-blob").ContainerClient> | null = null;

  constructor(private readonly cfg: AzureBlobConfig) {
    if (!cfg.accountUrl && !cfg.connectionString) throw new FileStoreError("Azure Blob store needs an account URL or a connection string");
  }

  private container() {
    this.containerClient ??= (async () => {
      const { BlobServiceClient } = await import("@azure/storage-blob");
      let service;
      if (this.cfg.connectionString) service = BlobServiceClient.fromConnectionString(this.cfg.connectionString);
      else {
        const { DefaultAzureCredential } = await import("@azure/identity");
        service = new BlobServiceClient(this.cfg.accountUrl!, new DefaultAzureCredential());
      }
      const c = service.getContainerClient(this.cfg.container);
      await c.createIfNotExists(); // private: no public access level
      return c;
    })().catch((e) => {
      this.containerClient = null;
      throw e;
    });
    return this.containerClient;
  }

  async put(key: string, content: Buffer, meta: FilePutMeta) {
    const blob = (await this.container()).getBlockBlobClient(checkKey(key));
    try {
      await blob.uploadData(content, {
        blobHTTPHeaders: { blobContentType: meta.contentType || "application/octet-stream" },
        metadata: { sha256: meta.sha256, filename: encodeURIComponent(meta.fileName ?? "").slice(0, 1024) },
        conditions: { ifNoneMatch: "*" },
      });
      return { created: true };
    } catch (e: any) {
      // Same key = same content (content-addressed): the earlier upload stands.
      if (e?.statusCode === 409 || e?.statusCode === 412 || e?.code === "BlobAlreadyExists") return { created: false };
      throw e;
    }
  }

  async get(key: string, expectedSha256?: string | null) {
    const blob = (await this.container()).getBlockBlobClient(checkKey(key));
    try {
      return verify(key, await blob.downloadToBuffer(), expectedSha256);
    } catch (e: any) {
      if (e?.statusCode === 404) throw new FileStoreError(`File ${key} is missing from the file store`);
      throw e;
    }
  }

  async open(key: string) {
    const blob = (await this.container()).getBlockBlobClient(checkKey(key));
    try {
      const res = await blob.download();
      return res.readableStreamBody as Readable;
    } catch (e: any) {
      if (e?.statusCode === 404) throw new FileStoreError(`File ${key} is missing from the file store`);
      throw e;
    }
  }
}

// ---------------------------------------------------------------- configuration

/**
 * FILE_STORE=azure-blob with AZURE_STORAGE_ACCOUNT_URL (managed identity) or AZURE_STORAGE_CONNECTION_STRING, and
 * AZURE_STORAGE_CONTAINER (default "boq-originals"). Otherwise a local folder (FILE_STORE_DIR, default ./data/files).
 */
export function fileStoreFromEnv(env: NodeJS.ProcessEnv): FileStore {
  const azure = env.AZURE_STORAGE_ACCOUNT_URL || env.AZURE_STORAGE_CONNECTION_STRING;
  const kind = env.FILE_STORE || (azure ? "azure-blob" : "local");
  if (kind === "azure-blob") {
    return new AzureBlobFileStore({
      container: env.AZURE_STORAGE_CONTAINER || "boq-originals",
      accountUrl: env.AZURE_STORAGE_ACCOUNT_URL || null,
      connectionString: env.AZURE_STORAGE_CONNECTION_STRING || null,
    });
  }
  if (kind === "local") return new LocalFileStore(path.resolve(env.FILE_STORE_DIR || "data/files"));
  throw new FileStoreError(`Unknown FILE_STORE "${kind}" (use azure-blob or local)`);
}

/**
 * Moves originals stored in the database before the file store existed (boq_document_revisions.file_content) into the
 * store, checking each against its recorded sha256. Safe to run repeatedly; returns how many files were moved.
 */
export async function moveLegacyFiles(db: import("./db.js").Queryable, files: FileStore, log: (m: string) => void = () => {}) {
  let moved = 0;
  for (;;) {
    const rows = (
      await db.query<{ boq_revision_id: string; organization_id: string; project_id: string; file_hash: string; mime_type: string | null; file_name: string; file_content: Buffer }>(
        `select boq_revision_id, organization_id, project_id, file_hash, mime_type, file_name, file_content
         from boq_document_revisions where storage_key is null and file_content is not null order by submitted_at limit 20`,
      )
    ).rows;
    if (!rows.length) return moved;
    for (const r of rows) {
      const content = Buffer.from(r.file_content);
      verify(r.boq_revision_id, content, r.file_hash);
      const key = boqFileKey(r.organization_id, r.project_id, r.file_hash);
      await files.put(key, content, { sha256: r.file_hash, contentType: r.mime_type, fileName: r.file_name });
      await db.query(
        `update boq_document_revisions set storage_kind = $2, storage_key = $3, file_content = null, updated_at = now()
         where boq_revision_id = $1 and storage_key is null`,
        [r.boq_revision_id, files.kind, key],
      );
      moved++;
      log(`moved ${r.file_name} (${content.length} bytes) to ${files.kind}`);
    }
  }
}
