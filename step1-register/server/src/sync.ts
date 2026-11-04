import type { Db, Queryable } from "./db.js";
import type { ProcoreAdapter } from "./procore.js";

export async function ensureOrganization(db: Queryable, name: string): Promise<string> {
  const found = (await db.query<{ organization_id: string }>(`select organization_id from organizations where name = $1 order by created_at limit 1`, [name])).rows[0];
  const id = found?.organization_id ?? (await db.query<{ organization_id: string }>(`insert into organizations (name) values ($1) returning organization_id`, [name])).rows[0]!.organization_id;
  await db.query(`select seed_units_of_measure($1)`, [id]);
  return id;
}

export async function audit(q: Queryable, e: { organizationId?: string | null; projectId?: string | null; actor: string; action: string; entity: string; entityId?: string | null; detail?: unknown }) {
  await q.query(
    `insert into audit_events (organization_id, project_id, actor, action, entity, entity_id, detail) values ($1, $2, $3, $4, $5, $6, $7)`,
    [e.organizationId ?? null, e.projectId ?? null, e.actor, e.action, e.entity, e.entityId ?? null, JSON.stringify(e.detail ?? {})],
  );
}

/** Keeps the full budget-code context as one row per segment: cost code, cost type and every configured segment. */
export async function writeSegments(q: Queryable, organizationId: string, projectId: string, costAssignmentId: string, costCode: string, costType: string | null, segments: unknown) {
  const rows: { name: string; value: string }[] = [{ name: "cost_code", value: costCode }];
  if (costType) rows.push({ name: "cost_type", value: costType });
  for (const [i, sg] of (Array.isArray(segments) ? segments : []).entries()) {
    const o = (sg ?? {}) as Record<string, unknown>;
    const name = String(o.name ?? o.segment ?? o.segment_name ?? `segment_${i + 1}`);
    const value = o.code ?? o.value ?? o.segment_item_code ?? o.id;
    if (value !== undefined && value !== null && !rows.some((r) => r.name === name)) rows.push({ name, value: String(value) });
  }
  for (const [i, r] of rows.entries()) {
    await q.query(
      `insert into cost_code_segments (organization_id, project_id, cost_assignment_id, segment_name, segment_value, segment_position)
       values ($1, $2, $3, $4, $5, $6)
       on conflict (project_id, cost_assignment_id, segment_name) do update set segment_value = excluded.segment_value, segment_position = excluded.segment_position`,
      [organizationId, projectId, costAssignmentId, r.name, r.value, i + 1],
    );
  }
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
            `insert into work_packages (project_id, source_wbs_reference, code, name, status, created_by)
             values ($1, $2, $3, $4, 'active', $5)
             on conflict (project_id, code) do update set name = excluded.name, source_wbs_reference = excluded.source_wbs_reference,
                updated_at = now(), record_version = work_packages.record_version + 1
             returning work_package_id`,
            [projectId, c.id, c.code, c.name, actor],
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
          const ca = (
            await q.query<{ cost_assignment_id: string }>(
              `insert into cost_assignments (project_id, work_package_id, procore_budget_code_id, budget_code, cost_code, cost_type,
                                             segment_context, description, status, created_by)
               values ($1, $2, $3, $4, $5, $6, $7, $8, 'approved', $9)
               on conflict (project_id, procore_budget_code_id) do update set work_package_id = excluded.work_package_id,
                  budget_code = excluded.budget_code, cost_code = excluded.cost_code, cost_type = excluded.cost_type,
                  segment_context = excluded.segment_context, description = excluded.description
               returning cost_assignment_id`,
              [projectId, wp, b.id, b.budgetCode, b.costCode, b.costType, JSON.stringify(b.segments), b.description, actor],
            )
          ).rows[0]!.cost_assignment_id;
          await writeSegments(q, organizationId, projectId, ca, b.costCode, b.costType, b.segments);
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
