import { migrate, pgDb } from "./db.js";

if (!process.env.DATABASE_URL) throw new Error("Set DATABASE_URL");
const db = pgDb(process.env.DATABASE_URL);
await migrate(db, console.log);
await db.close();
