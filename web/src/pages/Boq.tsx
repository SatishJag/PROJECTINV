import { useRef, useState } from "react";
import { api, download, qty, when } from "../api";
import { Card, Drawer, ErrorNote, Messages, Pill, statusTone, useLoad } from "../ui";

export function Reconciliation({ r }: { r: any }) {
  return (
    <div className="recon">
      <span>
        <b>{r.items}</b> items
      </span>
      <span className="text-ok">
        <b>{r.published + r.split}</b> published{r.split ? ` (${r.split} split)` : ""}
      </span>
      {r.held ? (
        <span className="text-warn">
          <b>{r.held}</b> held
        </span>
      ) : null}
      {r.unresolved ? (
        <span className="text-bad">
          <b>{r.unresolved}</b> unresolved
        </span>
      ) : null}
      {r.invalid ? (
        <span className="text-bad">
          <b>{r.invalid}</b> invalid
        </span>
      ) : null}
      {r.rejected ? (
        <span>
          <b>{r.rejected}</b> rejected
        </span>
      ) : null}
      <span className="muted">
        {r.headings} headings · {r.subtotals} subtotals · {r.notes} notes
      </span>
      <Pill tone={r.accountedFor ? "ok" : "bad"}>{r.accountedFor ? "all lines accounted for" : "not reconciled"}</Pill>
    </div>
  );
}

export function BoqPage({ project, onChange }: { project: any; onChange: () => void }) {
  const list = useLoad(() => api("GET", `/api/projects/${project.project_id}/boq`), [project.project_id]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const form = useRef<HTMLFormElement>(null);

  const done = (r: any) => {
    setNotice(r.duplicate ? "This file was already imported for this project; nothing was added." : `Imported ${r.revision.file_name}${r.supersededRevisionId ? " (supersedes the previous revision)" : ""}.`);
    list.reload();
    onChange();
    setOpen(r.revisionId);
  };
  const submit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const fd = new FormData(e.currentTarget);
      const fd2 = new FormData();
      for (const [k, v] of fd.entries()) if (k !== "file" && String(v).trim()) fd2.append(k, v);
      fd2.append("file", fd.get("file") as File);
      done(await api("POST", `/api/projects/${project.project_id}/boq`, fd2));
      form.current?.reset();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };
  const fromProcore = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      done(await api("POST", `/api/projects/${project.project_id}/boq/from-procore`, { documentId: String(new FormData(e.currentTarget).get("documentId")) }));
    } catch (err: any) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div className="two-col">
        <Card title="Submit a BOQ">
          <form ref={form} className="form" onSubmit={submit}>
            <label className="full">
              BOQ file (Excel .xlsx, CSV or text PDF)
              <input type="file" name="file" accept=".xlsx,.xlsm,.csv,.pdf" required />
            </label>
            <label>
              Procore document ID
              <input name="procoreDocumentId" placeholder="optional" />
            </label>
            <label>
              Revision
              <input name="sourceRevision" placeholder="e.g. A, B, 02" />
            </label>
            <label className="full">
              Document key <span className="muted">(links revisions of the same BOQ; defaults to the Procore document ID or file name)</span>
              <input name="documentKey" placeholder="optional" />
            </label>
            <div className="full">
              <button className="btn btn-primary" disabled={busy}>
                {busy ? "Processing…" : `Submit to ${project.project_name}`}
              </button>
            </div>
          </form>
        </Card>
        <Card title="Import from Procore Documents">
          <form className="form" onSubmit={fromProcore}>
            <label className="full">
              Procore file ID
              <input name="documentId" required placeholder="Documents tool file ID" />
            </label>
            <div className="full">
              <button className="btn" disabled={busy || !project.procore_project_id}>
                Import latest version
              </button>
            </div>
            <p className="muted full small">The project comes from where the file sits in Procore; a different project name inside the file is flagged, never used to move it.</p>
          </form>
        </Card>
      </div>
      <ErrorNote error={error} />
      {notice && <div className="note note-ok">{notice}</div>}
      <Card title="Submitted revisions">
        <ErrorNote error={list.error} />
        <div className="table-wrap">
          <table className="grid">
            <thead>
              <tr>
                <th>File</th>
                <th>Source</th>
                <th>Revision</th>
                <th>Status</th>
                <th>Submitted</th>
                <th>Reconciliation</th>
              </tr>
            </thead>
            <tbody>
              {(list.data?.revisions ?? []).map((r: any) => (
                <tr key={r.boq_revision_id} className="clickable" onClick={() => setOpen(r.boq_revision_id)}>
                  <td>
                    {r.file_name}
                    {r.project_conflict ? (
                      <div>
                        <Pill tone="bad">project conflict</Pill>
                      </div>
                    ) : null}
                  </td>
                  <td>{r.procore_document_id ? `Procore ${r.procore_document_id}` : "Upload"}</td>
                  <td>{r.source_revision ?? "–"}</td>
                  <td>
                    <Pill tone={statusTone(r.document_status)}>{r.document_status}</Pill>
                  </td>
                  <td>
                    {when(r.submitted_at)}
                    <div className="muted small">{r.submitted_by}</div>
                  </td>
                  <td>
                    <Reconciliation r={r.reconciliation} />
                  </td>
                </tr>
              ))}
              {list.data && !list.data.revisions.length ? (
                <tr>
                  <td colSpan={6} className="empty">
                    No BOQ submitted for {project.project_name} yet.
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </Card>
      {open && (
        <RevisionDrawer
          id={open}
          onClose={() => setOpen(null)}
          onChange={() => {
            list.reload();
            onChange();
          }}
        />
      )}
    </>
  );
}

function RevisionDrawer({ id, onClose, onChange }: { id: string; onClose: () => void; onChange: () => void }) {
  const d = useLoad(() => api("GET", `/api/boq/${id}`), [id]);
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [kind, setKind] = useState("item");
  const rev = d.data?.revision;
  const confirm = async () => {
    try {
      await api("POST", `/api/boq/${id}/confirm-project`, { note });
      d.reload();
      onChange();
    } catch (e: any) {
      setError(e.message);
    }
  };
  const lines = (d.data?.lines ?? []).filter((l: any) => kind === "all" || l.line_kind === kind);
  return (
    <Drawer title={rev ? `${rev.file_name}${rev.source_revision ? ` · rev ${rev.source_revision}` : ""}` : "BOQ revision"} onClose={onClose}>
      <ErrorNote error={d.error ?? error} />
      {rev && (
        <>
          <div className="source-meta">
            <Pill tone={statusTone(rev.document_status)}>{rev.document_status}</Pill> · {rev.procore_document_id ? `Procore document ${rev.procore_document_id}` : "uploaded"} · sha256{" "}
            <span className="mono">{rev.file_hash.slice(0, 12)}…</span> · {when(rev.submitted_at)} by {rev.submitted_by}
          </div>
          <Reconciliation r={d.data.reconciliation} />
          <Messages list={rev.processing_messages} />
          {rev.project_conflict && rev.document_status === "current" && (
            <div className="note note-bad">
              The file names <b>{rev.declared_project_name}</b>. Nothing from it is published until someone confirms this project is correct.
              <div className="inline-form">
                <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Why is this project correct?" />
                <button className="btn btn-primary" disabled={!note.trim()} onClick={confirm}>
                  Confirm project
                </button>
              </div>
            </div>
          )}
          <div className="row-between">
            <div className="chips">
              {["item", "heading", "subtotal", "note", "all"].map((k) => (
                <button key={k} className={kind === k ? "chip active" : "chip"} onClick={() => setKind(k)}>
                  {k === "all" ? "All lines" : `${k}s`}
                </button>
              ))}
            </div>
            <button className="btn btn-small" onClick={() => download(`/api/boq/${id}/file`, rev.file_name)}>
              Original file
            </button>
          </div>
          <div className="table-wrap">
            <table className="grid compact">
              <thead>
                <tr>
                  <th>Location</th>
                  <th>Kind</th>
                  <th>Code</th>
                  <th>Description</th>
                  <th>Spec</th>
                  <th className="num">Raw qty</th>
                  <th>Raw unit</th>
                  <th>UOM</th>
                  <th>Check</th>
                  <th>Attribution</th>
                </tr>
              </thead>
              <tbody>
                {lines.map((l: any) => (
                  <tr key={l.boq_line_id}>
                    <td className="mono">{l.source_locator}</td>
                    <td>{l.line_kind}</td>
                    <td>{l.raw_item_code}</td>
                    <td className="wrap">
                      {l.raw_description}
                      {l.section_path?.length && l.line_kind === "item" ? <div className="muted small">{l.section_path.join(" › ")}</div> : null}
                    </td>
                    <td className="wrap">{l.raw_specification}</td>
                    <td className="num">{l.raw_quantity}</td>
                    <td>{l.raw_uom}</td>
                    <td>{l.uom_code}</td>
                    <td>{l.line_kind === "item" ? <Pill tone={statusTone(l.validation_status)}>{l.validation_status}</Pill> : null}</td>
                    <td className="wrap">
                      {l.line_kind === "item" ? <Pill tone={statusTone(l.mapping_status)}>{l.mapping_status}</Pill> : null}
                      {l.allocations?.length ? (
                        <div className="small">
                          {l.allocations.map((a: any) => (
                            <div key={a.inventory_record_id}>
                              {a.work_package} {qty(a.quantity)} → <span className="mono">{a.record_number}</span>
                            </div>
                          ))}
                        </div>
                      ) : l.work_package_name ? (
                        <div className="small">{l.work_package_name}</div>
                      ) : null}
                      {l.mapping_basis ? <div className="muted small">{l.mapping_basis}</div> : null}
                      <Messages list={l.validation_messages} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </Drawer>
  );
}
