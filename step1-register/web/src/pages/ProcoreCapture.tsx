import { useState } from "react";
import { api, when } from "../api";
import { Card, ErrorNote, Pill, statusTone, useLoad } from "../ui";

const VIA: Record<string, string> = { webhook: "Procore webhook", scan: "Periodic scan", manual: "Check now" };
const STATUS: Record<string, string> = { captured: "captured", duplicate: "unchanged", failed: "could not read", retry: "will retry", pending: "pending" };

const toBase64 = (f: File) =>
  new Promise<string>((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).replace(/^data:[^,]*,/, ""));
    r.onerror = () => reject(r.error);
    r.readAsDataURL(f);
  });

/**
 * BOQs the LDC stores in the project's Procore Documents folder are captured automatically (webhook, then a periodic
 * scan as a safety net). This card shows what is watched and every file version that was picked up.
 */
export function ProcoreCapture({ project, onCaptured, onOpen }: { project: any; onCaptured: () => void; onOpen: (revisionId: string) => void }) {
  const base = `/api/projects/${project.project_id}`;
  const state = useLoad(() => api("GET", `${base}/procore-watch`), [project.project_id]);
  const config = useLoad(() => api("GET", "/api/config"), []);
  const [folders, setFolders] = useState<{ id: string; name: string }[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const demo = config.data?.procoreMode === "demo";
  const watch = state.data?.watch;
  const captures: any[] = state.data?.captures ?? [];
  const linked = !!project.procore_project_id;

  const run = async (fn: () => Promise<any>, after?: (r: any) => void) => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const r = await fn();
      after?.(r);
      state.reload();
      onCaptured();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  const checkNow = () => run(() => api("POST", `${base}/procore-scan`), (r) => setNotice(r.result.message));
  const toggle = () => run(() => api("PUT", `${base}/procore-watch`, { enabled: !watch?.enabled }));
  const loadFolders = () => run(async () => setFolders((await api("GET", `${base}/procore-folders`)).folders));
  const chooseFolder = (id: string) => {
    const f = folders?.find((x) => x.id === id);
    return run(() => api("PUT", `${base}/procore-watch`, id ? { folderId: id, folderPath: f?.name ?? null } : { folderId: null }), () => setFolders(null));
  };
  const demoStore = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = e.currentTarget;
    const fd = new FormData(form);
    const file = fd.get("file") as File;
    await run(
      async () =>
        api("POST", `${base}/demo/procore-documents`, {
          fileName: file.name,
          mimeType: file.type || null,
          contentBase64: await toBase64(file),
          folderPath: String(fd.get("folderPath") || "BOQ"),
        }),
      (r) => {
        setNotice(`Stored ${file.name} in Procore (${String(fd.get("folderPath") || "BOQ")}, version ${r.stored.version}). Webhook: ${r.event?.message ?? r.event?.state ?? "not sent"}`);
        form.reset();
      },
    );
  };

  const folderLabel = watch?.folder_id ? watch.folder_path || `folder ${watch.folder_id}` : 'Automatic: top-level folder named "BOQ"';

  return (
    <Card
      title="Automatic capture from Procore Documents"
      actions={
        <>
          <Pill tone={!linked ? "neutral" : watch?.enabled ? "ok" : "neutral"}>{!linked ? "not linked to Procore" : watch?.enabled ? "watching" : "off"}</Pill>
          <button className="btn" disabled={busy || !linked || !watch?.enabled} onClick={checkNow}>
            {busy ? "Checking…" : "Check Procore now"}
          </button>
        </>
      }
    >
      <ErrorNote error={state.error || error} />
      {notice && <div className="note note-ok">{notice}</div>}
      <div className="form">
        <div className="full">
          <span className="muted">Watched folder: </span>
          <b>{folderLabel}</b>
          {watch?.include_subfolders ? <span className="muted"> (and its subfolders)</span> : null}{" "}
          {folders ? (
            <select disabled={busy} defaultValue={watch?.folder_id ?? ""} onChange={(e) => chooseFolder(e.target.value)}>
              <option value="">Automatic: folder named "BOQ"</option>
              {folders.map((f) => (
                <option key={f.id} value={f.id}>
                  {f.name}
                </option>
              ))}
            </select>
          ) : (
            <button className="btn btn-ghost" disabled={busy || !linked} onClick={loadFolders}>
              Change folder
            </button>
          )}
          <button className="btn btn-ghost" disabled={busy || !linked} onClick={toggle}>
            {watch?.enabled ? "Switch off" : "Switch on"}
          </button>
        </div>
        <p className="muted full small">
          When the LDC stores a BOQ (Excel, CSV or text PDF) in this folder in Procore, it is imported automatically: every item goes to the register under this
          project. A new version of the same file, or a "Rev B" file next to "Rev A", supersedes the previous revision. Last check:{" "}
          {watch?.last_scan_at ? `${when(watch.last_scan_at)}: ${watch.last_scan_message ?? watch.last_scan_status}` : "not yet"}.
          {!config.data?.webhooksConfigured && !demo ? " Webhooks are not configured, so new files are found by the periodic scan." : ""}
        </p>
      </div>

      {demo && linked && (
        <form className="form demo-box" onSubmit={demoStore}>
          <label>
            Demo: store a BOQ in Procore as the LDC
            <input type="file" name="file" accept=".xlsx,.xlsm,.csv,.pdf" required />
          </label>
          <label>
            Procore folder
            <input name="folderPath" defaultValue="BOQ" />
          </label>
          <div className="full">
            <button className="btn" disabled={busy}>
              Store in Procore
            </button>
          </div>
        </form>
      )}

      <div className="table-wrap">
        <table className="grid">
          <thead>
            <tr>
              <th>Detected</th>
              <th>File</th>
              <th>Folder</th>
              <th>Version</th>
              <th>Found by</th>
              <th>Result</th>
              <th>Notes</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {captures.map((c) => (
              <tr key={c.capture_id}>
                <td>{when(c.detected_at)}</td>
                <td>{c.file_name}</td>
                <td>{c.folder_path}</td>
                <td>{c.procore_file_version}</td>
                <td>{VIA[c.detected_via] ?? c.detected_via}</td>
                <td>
                  <Pill tone={statusTone(c.status)}>{STATUS[c.status] ?? c.status}</Pill>
                  {c.document_status === "superseded" ? <span className="muted small"> superseded</span> : null}
                </td>
                <td className="small">{c.message}</td>
                <td>
                  {c.boq_revision_id && (
                    <button className="btn btn-ghost" onClick={() => onOpen(c.boq_revision_id)}>
                      Lines
                    </button>
                  )}
                </td>
              </tr>
            ))}
            {!captures.length && (
              <tr>
                <td colSpan={8} className="muted">
                  No BOQ captured from Procore yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </Card>
  );
}
