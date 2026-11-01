import { useCallback, useEffect, useState, type ReactNode } from "react";

export function useLoad<T>(fn: () => Promise<T>, deps: unknown[]) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const reload = useCallback(() => {
    setLoading(true);
    fn()
      .then((d) => {
        setData(d);
        setError(null);
      })
      .catch((e) => setError(String(e.message ?? e)))
      .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  useEffect(reload, [reload]);
  return { data, error, loading, reload };
}

export const Pill = ({ tone = "neutral", children }: { tone?: "ok" | "warn" | "bad" | "neutral" | "info"; children: ReactNode }) => <span className={`pill pill-${tone}`}>{children}</span>;

export const statusTone = (s: string) =>
  ({ mapped: "ok", split: "ok", valid: "ok", current: "ok", verified: "ok", validated: "ok", extracted: "ok", proposed: "warn", unresolved: "bad", unmapped: "bad", invalid: "bad", rejected: "neutral", superseded: "neutral", provisional: "warn", not_applicable: "neutral", no_current_source: "neutral", captured: "ok", duplicate: "neutral", failed: "bad", retry: "warn", pending: "info" })[s] as any ?? "neutral";

export function Card({ title, actions, children }: { title?: ReactNode; actions?: ReactNode; children: ReactNode }) {
  return (
    <section className="card">
      {(title || actions) && (
        <header className="card-head">
          <h2>{title}</h2>
          <div className="card-actions">{actions}</div>
        </header>
      )}
      {children}
    </section>
  );
}

export const ErrorNote = ({ error }: { error: string | null }) => (error ? <div className="note note-bad">{error}</div> : null);

export function Drawer({ title, onClose, children }: { title: ReactNode; onClose: () => void; children: ReactNode }) {
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [onClose]);
  return (
    <div className="drawer-backdrop" onClick={onClose}>
      <aside className="drawer" onClick={(e) => e.stopPropagation()}>
        <header className="drawer-head">
          <h2>{title}</h2>
          <button className="btn btn-ghost" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </header>
        <div className="drawer-body">{children}</div>
      </aside>
    </div>
  );
}

export const Messages = ({ list }: { list: { message: string }[] | string[] | null | undefined }) =>
  list && list.length ? (
    <ul className="msgs">
      {list.map((m, i) => (
        <li key={i}>{typeof m === "string" ? m : m.message}</li>
      ))}
    </ul>
  ) : null;
