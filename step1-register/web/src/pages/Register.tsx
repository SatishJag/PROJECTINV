import { useState } from "react";
import { api, download, qty, saveCsv, when } from "../api";
import { Card, Drawer, ErrorNote, Pill, statusTone, useLoad } from "../ui";

export function RegisterPage({ project }: { project: any }) {
  const [wp, setWp] = useState<string>("");
  const [open, setOpen] = useState<string | null>(null);
  const structure = useLoad(() => api("GET", `/api/projects/${project.project_id}/structure`), [project.project_id]);
  const reg = useLoad(() => api("GET", `/api/projects/${project.project_id}/register${wp ? `?workPackageId=${wp}` : ""}`), [project.project_id, wp]);
  const rows: any[] = reg.data?.rows ?? [];
  const wps: any[] = structure.data?.workPackages ?? [];
  const wpName = wps.find((w) => w.work_package_id === wp)?.name;

  const exportCsv = () =>
    saveCsv(`${project.project_name}${wpName ? ` - ${wpName}` : ""} inventory register.csv`, [
      ["Inventory record", "Project", "Procore project", "Work package", "Budget code", "Cost code", "Cost type", "Item code", "Item", "Specification", "Original UOM", "UOM", "BOQ quantity", "Ordered quantity", "Sources", "Item status"],
      ...rows.map((r) => [r.record_number, r.project_name, r.procore_project_id, `${r.work_package_code} ${r.work_package_name}`, r.budget_code, r.cost_code, r.cost_type, r.internal_item_code, r.item_description, r.specification, (r.original_uoms ?? []).join(" / "), r.normalized_uom, Number(r.boq_quantity), "Unknown", r.source_line_count, r.item_verification_status]),
    ]);

  return (
    <>
      <div className="summary">
        <div className="kpi">
          <div className="kpi-label">Project</div>
          <div className="kpi-value">{project.project_name}</div>
          <div className="kpi-sub">Procore {project.procore_company_id ?? "–"} / {project.procore_project_id ?? "–"}</div>
        </div>
        <div className="kpi">
          <div className="kpi-label">Inventory records</div>
          <div className="kpi-value">{project.inventory_records}</div>
        </div>
        <div className="kpi">
          <div className="kpi-label">Current BOQ documents</div>
          <div className="kpi-value">{project.boq_documents}</div>
        </div>
        <div className="kpi">
          <div className="kpi-label">Open exceptions</div>
          <div className={`kpi-value ${project.open_exceptions ? "text-bad" : ""}`}>{project.open_exceptions}</div>
        </div>
      </div>
      <div className="chips" role="tablist" aria-label="Work package">
        <button className={wp === "" ? "chip active" : "chip"} onClick={() => setWp("")}>
          All work packages
        </button>
        {wps.map((w) => (
          <button key={w.work_package_id} className={wp === w.work_package_id ? "chip active" : "chip"} onClick={() => setWp(w.work_package_id)}>
            {w.name}
          </button>
        ))}
      </div>
      <Card
        title={`${project.project_name}${wpName ? ` → ${wpName}` : ""}`}
        actions={
          <button className="btn" onClick={exportCsv} disabled={!rows.length}>
            Export CSV
          </button>
        }
      >
        <ErrorNote error={reg.error} />
        <div className="table-wrap">
          <table className="grid">
            <thead>
              <tr>
                <th>Record</th>
                <th>Work package</th>
                <th>Item</th>
                <th>Specification</th>
                <th>UOM</th>
                <th className="num">BOQ qty</th>
                <th className="num">Ordered qty</th>
                <th>Cost assignment</th>
                <th>Item ID</th>
                <th>Source</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.inventory_record_id} className="clickable" onClick={() => setOpen(r.inventory_record_id)}>
                  <td className="mono">{r.record_number}</td>
                  <td>{r.work_package_name}</td>
                  <td>{r.item_description}</td>
                  <td className="wrap">{r.specification}</td>
                  <td>
                    {r.normalized_uom}
                    {(r.original_uoms ?? []).some((u: string) => u !== r.normalized_uom) ? <span className="muted"> ({r.original_uoms.join(", ")})</span> : null}
                  </td>
                  <td className="num">{qty(r.boq_quantity)}</td>
                  <td className="num muted" title="Unknown until supported by purchase evidence">
                    Unknown
                  </td>
                  <td className="mono">{r.budget_code}</td>
                  <td>
                    <span className="mono">{r.internal_item_code}</span> <Pill tone={statusTone(r.item_verification_status)}>{r.item_verification_status}</Pill>
                  </td>
                  <td>
                    <a className="link">{r.source_line_count} line{r.source_line_count === 1 ? "" : "s"}</a>
                  </td>
                </tr>
              ))}
              {!rows.length && !reg.loading ? (
                <tr>
                  <td colSpan={10} className="empty">
                    No BOQ-derived items{wpName ? ` for ${wpName}` : ""} yet.
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </Card>
      {open && <RecordDrawer id={open} onClose={() => setOpen(null)} />}
    </>
  );
}

function RecordDrawer({ id, onClose }: { id: string; onClose: () => void }) {
  const d = useLoad(() => api("GET", `/api/register/${id}`), [id]);
  const r = d.data?.record;
  return (
    <Drawer title={r ? `${r.record_number} · ${r.item_description}` : "Inventory record"} onClose={onClose}>
      <ErrorNote error={d.error} />
      {r && (
        <>
          <dl className="facts">
            <dt>Project</dt>
            <dd>
              {r.project_name} <span className="muted">(Procore {r.procore_company_id}/{r.procore_project_id})</span>
            </dd>
            <dt>Work package</dt>
            <dd>
              {r.work_package_code} {r.work_package_name}
            </dd>
            <dt>Cost assignment</dt>
            <dd>
              <span className="mono">{r.budget_code}</span> · cost code {r.cost_code}
              {r.cost_type ? ` · type ${r.cost_type}` : ""}
            </dd>
            <dt>Item</dt>
            <dd>
              <span className="mono">{r.internal_item_code}</span> {r.item_description} <Pill tone={statusTone(r.item_verification_status)}>{r.item_verification_status}</Pill>
            </dd>
            <dt>Specification</dt>
            <dd>{r.specification ?? <span className="muted">not stated</span>}</dd>
            <dt>BOQ quantity</dt>
            <dd>
              {qty(r.boq_quantity)} {r.normalized_uom}
            </dd>
            <dt>Ordered quantity</dt>
            <dd className="muted">Unknown until supported by purchase evidence</dd>
          </dl>
          <h3>Source evidence</h3>
          {d.data.sources.map((s: any) => (
            <div key={s.allocation_id} className={`source ${s.document_status !== "current" ? "source-old" : ""}`}>
              <div className="source-head">
                <strong>{s.file_name}</strong>
                <Pill tone={statusTone(s.document_status)}>{s.document_status}</Pill>
              </div>
              <div className="source-meta">
                {s.source_tool === "procore_documents" || s.procore_document_id ? `Procore document ${s.procore_document_id ?? "–"} · ` : "Uploaded · "}
                revision {s.source_revision ?? "–"} · {when(s.submitted_at)}
              </div>
              <div className="source-meta">
                Location <span className="mono">{s.source_locator}</span>
                {s.page_number ? ` (page ${s.page_number})` : s.sheet_name ? ` (sheet ${s.sheet_name}, row ${s.row_number})` : ""}
                {s.section_path?.length ? ` · under ${s.section_path.join(" › ")}` : ""}
              </div>
              <table className="grid compact">
                <tbody>
                  <tr>
                    <th>Item code</th>
                    <td>{s.raw_item_code}</td>
                    <th>Raw qty</th>
                    <td>{s.raw_quantity}</td>
                  </tr>
                  <tr>
                    <th>Description</th>
                    <td>{s.raw_description}</td>
                    <th>Raw unit</th>
                    <td>{s.raw_uom}</td>
                  </tr>
                  <tr>
                    <th>Specification</th>
                    <td>{s.raw_specification}</td>
                    <th>Allocated</th>
                    <td>
                      {qty(s.allocated_quantity)} of {qty(s.line_quantity)}
                    </td>
                  </tr>
                  <tr>
                    <th>Basis</th>
                    <td colSpan={3}>
                      {s.basis} · {s.approved_by}
                    </td>
                  </tr>
                </tbody>
              </table>
              <button className="btn btn-small" onClick={() => download(`/api/boq/${s.boq_revision_id}/file`, s.file_name)}>
                Download original file
              </button>
            </div>
          ))}
        </>
      )}
    </Drawer>
  );
}
