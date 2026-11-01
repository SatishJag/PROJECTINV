import { buildApp } from "./app.js";
import { migrate, pgDb, pgliteDb } from "./db.js";
import { procoreFromEnv } from "./procore.js";
import { ensureOrganization, syncFromProcore } from "./sync.js";
import { startCapturePoller } from "./capture.js";
import { fileStoreFromEnv } from "./filestore.js";

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
const files = fileStoreFromEnv(env);
log(`BOQ originals are stored in: ${files.kind}${files.kind === "local" ? " folder (development only)" : ""}`);
const app = await buildApp({ db, files, procore, organizationId, appPassword: env.APP_PASSWORD || null, webhookSecret: env.PROCORE_WEBHOOK_SECRET || null });
// Catch-up scan of every project's watched Procore Documents folder (covers missed or unconfigured webhooks).
const scanMinutes = Number(env.PROCORE_SCAN_MINUTES ?? (procore.mode === "live" ? 15 : 0));
startCapturePoller({ db, files, procore, organizationId }, scanMinutes, log);
log(scanMinutes > 0 ? `Procore Documents scan every ${scanMinutes} min` : "Procore Documents periodic scan off (PROCORE_SCAN_MINUTES)");
if (procore.mode === "live" && !env.PROCORE_WEBHOOK_SECRET) log("PROCORE_WEBHOOK_SECRET not set: Procore webhooks are refused; BOQs are captured by the periodic scan only");
const port = Number(env.PORT ?? 4100);
await app.listen({ port, host: "0.0.0.0" });
log(`listening on :${port}`);
