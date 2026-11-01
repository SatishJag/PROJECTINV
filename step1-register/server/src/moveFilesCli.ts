/** npm run files:migrate — moves BOQ originals still stored in Postgres into the configured file store. */
import { pgDb } from "./db.js";
import { fileStoreFromEnv, moveLegacyFiles } from "./filestore.js";

if (!process.env.DATABASE_URL) throw new Error("Set DATABASE_URL");
const db = pgDb(process.env.DATABASE_URL);
const files = fileStoreFromEnv(process.env);
const n = await moveLegacyFiles(db, files, (m) => console.log(m));
console.log(`${n} file(s) moved to ${files.kind}`);
await db.close();
