import { useState } from "react";
import { api } from "../api";
import { Card, ErrorNote, Pill, statusTone, useLoad } from "../ui";

export function StructurePage({ project, onChange }: { project: any | null; onChange: () => void }) {
  const st = useLoad(() => (project ? api("GET", `/api/projects/${project.project_id}/structure`) : Promise.resolve(null)), [project?.project_id]);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const sync = async (only?: number) => {
    setBusy(true);
    setError(null);
    try {
      const r = await api("POST", "/api/procore/sync", only ? { procoreProjectId: only } : {});
      setMsg(r.projects.map((p: any) => `${p.name}: ${p.error ? `failed – ${p.error}` : `${p.workPackages} work packages, ${p.costAssignments} cost assignments`}`).join(" · "));
      st.reload();
      onChange();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };
  const run = async (fn: () => Promise<unknown>) => {
    setError(null);
    try {
      await fn();
      st.reload();
      onChange();
    } catch (e: any) {
      setError(e.message);
    }
  };
  const wps: any[] = st.data?.workPackages ?? [];
  const cas: any[] = st.data?.costAssignments ?? [];
  return (
    <>
      <Card
        title={project ? `WBS work packages · ${project.project_name}` : "WBS work packages"}
        actions={
          <>
            {project?.procore_project_id ? (
              <button className="btn" disabled={busy} onClick={() => sync(Number(project.procore_project_id))}>
                Sync this project
              </button>
            ) : null}
            <button className="btn btn-primary" disabled={busy} onClick={() => sync()}>
              {busy ? "Syncing…" : "Sync all from Procore"}
            </button>
          </>
        }
      >
        <ErrorNote error={error ?? st.error} />
        {msg && <div className="note note-ok small">{msg}</div>}
        <p className="muted small">
          Work packages come from the project's Procore WBS cost-code segment; cost assignments from its WBS / budget codes (cost code + cost type + other segments). “Match terms” are extra BOQ heading or sheet words that identify a package. A “work package” here is the equipment task, not Procore's timekeeping Task Code.
        </p>
        <div className="table-wrap">
          <table className="grid">
            <thead>
              <tr>
                <th>Code</th>
                <th>Work package</th>
                <th>Match terms</th>
                <th>Cost assignments</th>
                <th>Procore ref</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {wps.map((w) => (
                <tr key={w.work_package_id}>
                  <td className="mono">{w.code}</td>
                  <td>{w.name}</td>
                  <td>
                    <TermsEditor
                      terms={w.match_terms}
                      onSave={(t) => run(() => api("PATCH", `/api/work-packages/${w.work_package_id}`, { matchTerms: t }))}
                    />
                  </td>
                  <td>
                    {cas
                      .filter((c) => c.work_package_id === w.work_package_id)
                      .map((c) => (
                        <div key={c.cost_assignment_id}>
                          <span className="mono">{c.budget_code ?? c.cost_code}</span> <span className="muted small">{c.description}</span>
                        </div>
                      ))}
                  </td>
                  <td className="mono small">{w.source_wbs_reference}</td>
                  <td>
                    <Pill tone={statusTone(w.status === "active" ? "valid" : "rejected")}>{w.status}</Pill>
                  </td>
                </tr>
              ))}
              {!wps.length ? (
                <tr>
                  <td colSpan={6} className="empty">
                    No work packages. Sync from Procore or add one below.
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </Card>
      {project && (
        <div className="two-col">
          <Card title="Add a work package">
            <form
              className="form"
              onSubmit={(e) => {
                e.preventDefault();
                const f = new FormData(e.currentTarget);
                const form = e.currentTarget;
                run(() =>
                  api("POST", `/api/projects/${project.project_id}/work-packages`, {
                    code: f.get("code"),
                    name: f.get("name"),
                    matchTerms: String(f.get("terms") ?? "").split(",").map((s) => s.trim()).filter(Boolean),
                  }).then(() => form.reset()),
                );
              }}
            >
              <label>
                Code
                <input name="code" required />
              </label>
              <label>
                Name
                <input name="name" required />
              </label>
              <label className="full">
                Match terms (comma separated)
                <input name="terms" placeholder="e.g. diesel generator, genset" />
              </label>
              <div className="full">
                <button className="btn">Add work package</button>
              </div>
            </form>
          </Card>
          <Card title="Add a cost assignment">
            <form
              className="form"
              onSubmit={(e) => {
                e.preventDefault();
                const f = new FormData(e.currentTarget);
                const form = e.currentTarget;
                run(() =>
                  api("POST", `/api/projects/${project.project_id}/cost-assignments`, {
                    workPackageId: f.get("wp"),
                    costCode: f.get("costCode"),
                    costType: f.get("costType") || null,
                    budgetCode: f.get("budgetCode") || null,
                  }).then(() => form.reset()),
                );
              }}
            >
              <label className="full">
                Work package
                <select name="wp" required>
                  {wps.map((w) => (
                    <option key={w.work_package_id} value={w.work_package_id}>
                      {w.code} {w.name}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Cost code
                <input name="costCode" required />
              </label>
              <label>
                Cost type
                <input name="costType" placeholder="M, L, E, S, O…" />
              </label>
              <label className="full">
                Full budget code
                <input name="budgetCode" placeholder="defaults to cost code.cost type" />
              </label>
              <div className="full">
                <button className="btn">Add cost assignment</button>
              </div>
            </form>
          </Card>
        </div>
      )}
    </>
  );
}

function TermsEditor({ terms, onSave }: { terms: string[]; onSave: (t: string[]) => void }) {
  const [edit, setEdit] = useState(false);
  const [v, setV] = useState(terms.join(", "));
  if (!edit)
    return (
      <span className="clickable-text" onClick={() => setEdit(true)}>
        {terms.length ? terms.join(", ") : <span className="muted">add…</span>}
      </span>
    );
  return (
    <span className="inline-form">
      <input value={v} onChange={(e) => setV(e.target.value)} />
      <button
        className="btn btn-small"
        onClick={() => {
          onSave(v.split(",").map((s) => s.trim()).filter(Boolean));
          setEdit(false);
        }}
      >
        Save
      </button>
    </span>
  );
}
