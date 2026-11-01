import { buildApp } from "./app.js";
import { migrate, pgDb, pgliteDb } from "./db.js";
import { procoreFromEnv } from "./procore.js";
import { ensureOrganization, syncFromProcore } from "./sync.js";

const env = process.env;
const log = (m: string) => console.log(`[projectinv] ${m}`);

const db = env.DATABASE_URL ? pgDb(env.DATABASE_URL) : await pgliteDb();
if (!env.DATABASE_URL) log("DATABASE_URL not set: using an in-memory database (data is lost on restart)");
await migrate(db, log);
const organizationId = await ensureOrganization(db, env.ORGANIZATION_NAME ?? "Default organization");
const procore = procoreFromEnv(env, log);
log(`Procore: ${procore.mode} (company ${procore.companyId})`);
if (procore.mode === "demo" || env.SYNC_ON_START === "true") {
  const r = await syncFromProcore(db, procore, organizationId, "system:startup").catch((e) => {
    log(`initial Procore sync failed: ${e.message}`);
    return null;
  });
  if (r) log(`synced ${r.projects.length} projects`);
}
const app = await buildApp({ db, procore, organizationId, appPassword: env.APP_PASSWORD || null });
const port = Number(env.PORT ?? 4100);
await app.listen({ port, host: "0.0.0.0" });
log(`listening on :${port}`);
