import { Fragment, useState } from "react";
import { api, qty } from "../api";
import { Card, ErrorNote, Messages, Pill, statusTone, useLoad } from "../ui";

export function ExceptionsPage({ project, onChange }: { project: any; onChange: () => void }) {
  const ex = useLoad(() => api("GET", `/api/projects/${project.project_id}/exceptions`), [project.project_id]);
  const st = useLoad(() => api("GET", `/api/projects/${project.project_id}/structure`), [project.project_id]);
  const [open, setOpen] = useState<string | null>(null);
  const rows: any[] = ex.data?.rows ?? [];
  const reload = () => {
    ex.reload();
    onChange();
  };
  return (
    <Card title={`Exception queue · ${project.project_name}`}>
      <p className="muted small">
        Lines whose work package, cost assignment, quantity or unit is not established by the document. Resolve each one: assign it, split it across work packages (quantities must add up to the line), correct an extraction, or reject it as not an inventory item.
      </p>
      <ErrorNote error={ex.error} />
      <div className="table-wrap">
        <table className="grid">
          <thead>
            <tr>
              <th>Source</th>
              <th>Description</th>
              <th className="num">Qty</th>
              <th>Unit</th>
              <th>Status</th>
              <th>Why</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {rows.map((l) => (
              <Fragment key={l.boq_line_id}>
                <tr>
                  <td>
                    <span className="mono">{l.source_locator}</span>
                    <div className="muted small">
                      {l.file_name}
                      {l.source_revision ? ` · rev ${l.source_revision}` : ""}
                    </div>
                  </td>
                  <td className="wrap">
                    {l.raw_item_code ? <span className="mono">{l.raw_item_code} </span> : null}
                    {l.raw_description}
                    {l.raw_specification ? <div className="small">{l.raw_specification}</div> : null}
                    {l.section_path?.length ? <div className="muted small">under {l.section_path.join(" › ")}</div> : null}
                  </td>
                  <td className="num">{l.raw_quantity}</td>
                  <td>
                    {l.raw_uom}
                    {l.uom_code && l.uom_code !== l.raw_uom ? <span className="muted"> → {l.uom_code}</span> : null}
                  </td>
                  <td>
                    <Pill tone={statusTone(l.validation_status)}>{l.validation_status}</Pill> <Pill tone={statusTone(l.mapping_status)}>{l.mapping_status}</Pill>
                    {l.work_package_name ? <div className="small">proposed: {l.work_package_name}</div> : null}
                  </td>
                  <td className="wrap">
                    <Messages list={l.validation_messages} />
                    {l.project_conflict ? <div className="text-bad small">Document names another project: confirm it on the BOQ submission</div> : null}
                  </td>
                  <td>
                    <button className="btn btn-small" onClick={() => setOpen(open === l.boq_line_id ? null : l.boq_line_id)}>
                      {open === l.boq_line_id ? "Close" : "Resolve"}
                    </button>
                  </td>
                </tr>
                {open === l.boq_line_id && (
                  <tr className="expand">
                    <td colSpan={7}>
                      <ResolvePanel
                        line={l}
                        structure={st.data}
                        onDone={() => {
                          setOpen(null);
                          reload();
                        }}
                      />
                    </td>
                  </tr>
                )}
              </Fragment>
            ))}
            {!rows.length && !ex.loading ? (
              <tr>
                <td colSpan={7} className="empty">
                  No open exceptions. Every current BOQ line is attributed, rejected or not an item.
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

function ResolvePanel({ line, structure, onDone }: { line: any; structure: any; onDone: () => void }) {
  const cas: any[] = structure?.costAssignments ?? [];
  const wps: any[] = structure?.workPackages ?? [];
  const label = (c: any) => `${wps.find((w) => w.work_package_id === c.work_package_id)?.name ?? "?"} · ${c.budget_code ?? c.cost_code}`;
  const total = Number(line.quantity ?? 0);
  const [allocs, setAllocs] = useState<{ ca: string; q: string }[]>([{ ca: line.proposed_cost_assignment_id ?? "", q: String(total || "") }]);
  const [note, setNote] = useState("");
  const [reason, setReason] = useState("");
  const [fixQty, setFixQty] = useState("");
  const [fixUom, setFixUom] = useState("");
  const [error, setError] = useState<string | null>(null);
  const sum = allocs.reduce((t, a) => t + (Number(a.q) || 0), 0);
  const run = async (fn: () => Promise<unknown>) => {
    setError(null);
    try {
      await fn();
      onDone();
    } catch (e: any) {
      setError(e.message);
    }
  };
  const valid = line.validation_status === "valid";
  return (
    <div className="resolve">
      <ErrorNote error={error} />
      {valid ? (
        <div className="resolve-block">
          <h4>Assign / split</h4>
          {allocs.map((a, i) => (
            <div className="inline-form" key={i}>
              <select value={a.ca} onChange={(e) => setAllocs(allocs.map((x, j) => (j === i ? { ...x, ca: e.target.value } : x)))}>
                <option value="">Choose work package · cost assignment</option>
                {cas.map((c) => (
                  <option key={c.cost_assignment_id} value={c.cost_assignment_id}>
                    {label(c)}
                  </option>
                ))}
              </select>
              <input className="qty-input" inputMode="decimal" value={a.q} onChange={(e) => setAllocs(allocs.map((x, j) => (j === i ? { ...x, q: e.target.value } : x)))} />
              <span className="muted">{line.uom_code}</span>
              {allocs.length > 1 && (
                <button className="btn btn-ghost" onClick={() => setAllocs(allocs.filter((_, j) => j !== i))}>
                  ✕
                </button>
              )}
            </div>
          ))}
          <div className="inline-form">
            <button className="btn btn-small" onClick={() => setAllocs([...allocs, { ca: "", q: "" }])}>
              + Split to another work package
            </button>
            <span className={Math.abs(sum - total) < 1e-9 ? "text-ok small" : "text-bad small"}>
              {qty(sum)} of {qty(total)} {line.uom_code} allocated
            </span>
          </div>
          <div className="inline-form">
            <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Evidence / note (e.g. drawing ref)" />
            <button
              className="btn btn-primary"
              disabled={allocs.some((a) => !a.ca || !(Number(a.q) > 0)) || Math.abs(sum - total) > 1e-9}
              onClick={() => run(() => api("POST", `/api/lines/${line.boq_line_id}/resolve`, { allocations: allocs.map((a) => ({ costAssignmentId: a.ca, quantity: Number(a.q) })), note: note || null }))}
            >
              Publish to register
            </button>
          </div>
        </div>
      ) : null}
      <div className="resolve-block">
        <h4>Correct extraction</h4>
        <div className="inline-form">
          <input className="qty-input" inputMode="decimal" placeholder="Quantity" value={fixQty} onChange={(e) => setFixQty(e.target.value)} />
          <input className="qty-input" placeholder="Unit (m, each, lot…)" value={fixUom} onChange={(e) => setFixUom(e.target.value)} />
          <button
            className="btn"
            disabled={!fixQty && !fixUom}
            onClick={() => run(() => api("POST", `/api/lines/${line.boq_line_id}/correct`, { quantity: fixQty ? Number(fixQty) : null, uom: fixUom || null }))}
          >
            Apply
          </button>
          <button className="btn btn-ghost" onClick={() => run(() => api("POST", `/api/lines/${line.boq_line_id}/correct`, { lineKind: "heading" }))}>
            It is a heading
          </button>
          <button className="btn btn-ghost" onClick={() => run(() => api("POST", `/api/lines/${line.boq_line_id}/correct`, { lineKind: "note" }))}>
            It is a note
          </button>
        </div>
      </div>
      <div className="resolve-block">
        <h4>Reject</h4>
        <div className="inline-form">
          <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Why this is not an inventory item" />
          <button className="btn btn-danger" disabled={!reason.trim()} onClick={() => run(() => api("POST", `/api/lines/${line.boq_line_id}/reject`, { reason }))}>
            Reject line
          </button>
        </div>
      </div>
    </div>
  );
}
