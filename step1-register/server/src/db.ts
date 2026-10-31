import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

export interface Queryable {
  query<T = Record<string, any>>(text: string, params?: unknown[]): Promise<{ rows: T[] }>;
}

export interface Db extends Queryable {
  tx<T>(fn: (q: Queryable) => Promise<T>): Promise<T>;
  exec(sql: string): Promise<void>;
  close(): Promise<void>;
}

// numeric -> JS string by default; keep it a string (exact) and convert where needed.
pg.types.setTypeParser(20, (v) => Number(v)); // int8 (counts, Procore ids)

export function pgDb(connectionString: string): Db {
  const ssl = /supabase\.(co|com)|sslmode=require/.test(connectionString) ? { rejectUnauthorized: false } : undefined;
  const pool = new pg.Pool({ connectionString, ssl, max: 10 });
  return {
    query: (text, params) => pool.query(text, params as any[]) as any,
    async tx(fn) {
      const client = await pool.connect();
      try {
        await client.query("begin");
        const out = await fn({ query: (t, p) => client.query(t, p as any[]) as any });
        await client.query("commit");
        return out;
      } catch (e) {
        await client.query("rollback").catch(() => {});
        throw e;
      } finally {
        client.release();
      }
    },
    async exec(sql) {
      await pool.query(sql);
    },
    close: () => pool.end(),
  };
}

/** In-process Postgres (PGlite) for tests and for running without DATABASE_URL. */
export async function pgliteDb(): Promise<Db> {
  const { PGlite } = await import("@electric-sql/pglite");
  const lite = new PGlite();
  const wrap = (q: { query: (t: string, p?: any[]) => Promise<any> }): Queryable => ({
    query: async (t, p) => {
      const r = await q.query(t, p as any[]);
      return { rows: r.rows };
    },
  });
  return {
    ...wrap(lite),
    tx: (fn) => lite.transaction((t) => fn(wrap(t))),
    async exec(sql) {
      await lite.exec(sql);
    },
    close: () => lite.close(),
  };
}

export function migrationsDir() {
  const here = path.dirname(fileURLToPath(import.meta.url));
  for (const c of [path.resolve(here, "../../supabase/migrations"), path.resolve(here, "../supabase/migrations"), path.resolve(process.cwd(), "supabase/migrations")]) {
    if (fs.existsSync(c)) return c;
  }
  throw new Error("supabase/migrations not found");
}

/** Applies supabase/migrations/*.sql in order, once each (tracked in schema_migrations). */
export async function migrate(db: Db, log: (m: string) => void = () => {}) {
  await db.exec("create table if not exists schema_migrations (version text primary key, applied_at timestamptz not null default now())");
  const done = new Set((await db.query<{ version: string }>("select version from schema_migrations")).rows.map((r) => r.version));
  const files = fs.readdirSync(migrationsDir()).filter((f) => f.endsWith(".sql")).sort();
  for (const f of files) {
    if (done.has(f)) continue;
    const sql = fs.readFileSync(path.join(migrationsDir(), f), "utf8");
    // One simple-protocol batch runs as a single implicit transaction.
    await db.exec(`${sql}\n;insert into schema_migrations (version) values ('${f.replace(/'/g, "''")}');`);
    log(`migration applied: ${f}`);
  }
}
