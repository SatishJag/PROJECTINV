import type { Db, Queryable } from "./db.js";
import type { ProcoreAdapter } from "./procore.js";

export async function ensureOrganization(db: Queryable, name: string): Promise<string> {
  const r = await db.query<{ organization_id: string }>(
    `insert into organizations (name) values ($1) on conflict (name) do update set name = excluded.name returning organization_id`,
    [name],
  );
  return r.rows[0]!.organization_id;
}

export async function audit(q: Queryable, e: { organizationId?: string | null; projectId?: string | null; actor: string; action: string; entity: string; entityId?: string | null; detail?: unknown }) {
  await q.query(
    `insert into audit_events (organization_id, project_id, actor, action, entity, entity_id, detail) values ($1, $2, $3, $4, $5, $6, $7)`,
    [e.organizationId ?? null, e.projectId ?? null, e.actor, e.action, e.entity, e.entityId ?? null, JSON.stringify(e.detail ?? {})],
  );
}

export interface SyncResult {
  projects: { projectId: string; name: string; workPackages: number; costAssignments: number; error?: string }[];
}

/** Projects, then each project's WBS (work packages) and budget codes (cost assignments), from Procore. */
export async function syncFromProcore(db: Db, procore: ProcoreAdapter, organizationId: string, actor: string, onlyProcoreProjectId?: number): Promise<SyncResult> {
  const projects = (await procore.listProjects()).filter((p) => onlyProcoreProjectId === undefined || p.id === onlyProcoreProjectId);
  const out: SyncResult = { projects: [] };
  for (const p of projects) {
    const projectId = (
      await db.query<{ project_id: string }>(
        `insert into projects (organization_id, procore_company_id, procore_project_id, project_code, project_name, created_by)
         values ($1, $2, $3, $4, $5, $6)
         on conflict (organization_id, procore_company_id, procore_project_id)
         do update set project_name = excluded.project_name, project_code = excluded.project_code, updated_at = now(),
                       record_version = projects.record_version + 1
         returning project_id`,
        [organizationId, procore.companyId, p.id, p.projectNumber, p.name, actor],
      )
    ).rows[0]!.project_id;
    try {
      const wbs = await procore.getWbs(p.id);
      const counts = await db.tx(async (q) => {
        const wpByRef = new Map<string, string>();
        for (const c of wbs.costCodes) {
          const r = await q.query<{ work_package_id: string }>(
            `insert into work_packages (organization_id, project_id, source_wbs_reference, code, name, created_by)
             values ($1, $2, $3, $4, $5, $6)
             on conflict (project_id, code) do update set name = excluded.name, source_wbs_reference = excluded.source_wbs_reference,
                updated_at = now(), record_version = work_packages.record_version + 1
             returning work_package_id`,
            [organizationId, projectId, c.id, c.code, c.name, actor],
          );
          wpByRef.set(c.id, r.rows[0]!.work_package_id);
        }
        for (const c of wbs.costCodes) {
          if (!c.parentId || !wpByRef.has(c.parentId)) continue;
          await q.query(`update work_packages set parent_work_package_id = $1 where work_package_id = $2 and project_id = $3`, [wpByRef.get(c.parentId), wpByRef.get(c.id), projectId]);
        }
        let assignments = 0;
        for (const b of wbs.budgetCodes) {
          let wp = b.costCodeId ? wpByRef.get(b.costCodeId) : undefined;
          if (!wp) {
            wp = (await q.query<{ work_package_id: string }>(`select work_package_id from work_packages where project_id = $1 and code = $2`, [projectId, b.costCode])).rows[0]?.work_package_id;
          }
          if (!wp) continue;
          await q.query(
            `insert into cost_assignments (organization_id, project_id, work_package_id, procore_budget_code_id, budget_code, cost_code, cost_type,
                                           segment_references, description, created_by)
             values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
             on conflict (project_id, procore_budget_code_id) do update set work_package_id = excluded.work_package_id,
                budget_code = excluded.budget_code, cost_code = excluded.cost_code, cost_type = excluded.cost_type,
                segment_references = excluded.segment_references, description = excluded.description, updated_at = now(),
                record_version = cost_assignments.record_version + 1`,
            [organizationId, projectId, wp, b.id, b.budgetCode, b.costCode, b.costType, JSON.stringify(b.segments), b.description, actor],
          );
          assignments++;
        }
        await audit(q, { organizationId, projectId, actor, action: "procore.sync", entity: "project", entityId: projectId, detail: { procoreProjectId: p.id, workPackages: wbs.costCodes.length, costAssignments: assignments } });
        return { workPackages: wbs.costCodes.length, costAssignments: assignments };
      });
      out.projects.push({ projectId, name: p.name, ...counts });
    } catch (e) {
      out.projects.push({ projectId, name: p.name, workPackages: 0, costAssignments: 0, error: String((e as Error).message ?? e) });
    }
  }
  return out;
}
