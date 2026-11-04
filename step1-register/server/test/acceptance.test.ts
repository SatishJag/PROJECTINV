import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { migrate, pgliteDb } from "../src/db.js";

const here = path.dirname(fileURLToPath(import.meta.url));

describe("Step 1 acceptance checks A1-A10 (db-tests/acceptance_step1.sql)", () => {
  it("all pass against the migrated schema", async () => {
    const db = await pgliteDb();
    try {
      await migrate(db);
      // The script runs in one transaction that it rolls back, and raises an error on the first failed check.
      await expect(db.exec(fs.readFileSync(path.resolve(here, "../../db-tests/acceptance_step1.sql"), "utf8"))).resolves.toBeUndefined();
    } finally {
      await db.close();
    }
  }, 60_000);
});
