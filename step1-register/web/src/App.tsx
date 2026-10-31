import { useEffect, useState } from "react";
import { api, session } from "./api";
import { useLoad } from "./ui";
import { RegisterPage } from "./pages/Register";
import { BoqPage } from "./pages/Boq";
import { ExceptionsPage } from "./pages/Exceptions";
import { StructurePage } from "./pages/Structure";
import { ItemsPage } from "./pages/Items";

const TABS = [
  ["register", "Register"],
  ["boq", "BOQ submissions"],
  ["exceptions", "Exceptions"],
  ["structure", "WBS & cost codes"],
  ["items", "Item catalogue"],
] as const;
type Tab = (typeof TABS)[number][0];

function readHash(): { tab: Tab; project: string | null } {
  const [tab, project] = location.hash.replace(/^#\/?/, "").split("/");
  return { tab: (TABS.some((t) => t[0] === tab) ? tab : "register") as Tab, project: project || null };
}

export function App() {
  const [{ tab, project }, setRoute] = useState(readHash);
  const [user, setUser] = useState(session.user);
  const [token, setToken] = useState(session.token);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const h = () => setRoute(readHash());
    window.addEventListener("hashchange", h);
    return () => window.removeEventListener("hashchange", h);
  }, []);
  const config = useLoad(() => api("GET", "/api/config"), []);
  const projects = useLoad<any[]>(() => api("GET", "/api/projects"), [tick, token]);
  const go = (t: Tab, p: string | null = project) => (location.hash = `/${t}${p ? `/${p}` : ""}`);
  const current = projects.data?.find((p) => p.project_id === project) ?? projects.data?.[0] ?? null;
  const refresh = () => setTick((t) => t + 1);

  if (projects.error && /Sign in/.test(projects.error)) {
    return (
      <div className="login">
        <form
          className="card"
          onSubmit={(e) => {
            e.preventDefault();
            const f = new FormData(e.currentTarget);
            session.user = String(f.get("user") ?? "");
            session.token = String(f.get("token") ?? "");
            setUser(session.user);
            setToken(session.token);
          }}
        >
          <h2>Project Inventory Register</h2>
          <label>
            Your name
            <input name="user" defaultValue={user} required />
          </label>
          <label>
            App password
            <input name="token" type="password" required />
          </label>
          <button className="btn btn-primary">Sign in</button>
        </form>
      </div>
    );
  }

  return (
    <div className="shell">
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark">PI</span>
          <div>
            <div className="brand-title">Project Inventory Register</div>
            <div className="brand-sub">Inventory Intelligence · Step 1 · Procore {config.data?.procoreMode ?? ""}</div>
          </div>
        </div>
        <div className="topbar-right">
          <select
            className="project-select"
            value={current?.project_id ?? ""}
            onChange={(e) => go(tab, e.target.value)}
            aria-label="Project"
          >
            {(projects.data ?? []).map((p) => (
              <option key={p.project_id} value={p.project_id}>
                {p.project_name}
              </option>
            ))}
          </select>
          <input
            className="user-input"
            placeholder="Your name"
            value={user}
            onChange={(e) => {
              session.user = e.target.value;
              setUser(e.target.value);
            }}
          />
        </div>
      </header>
      <nav className="tabs">
        {TABS.map(([k, label]) => (
          <a key={k} href={`#/${k}${current ? `/${current.project_id}` : ""}`} className={k === tab ? "tab active" : "tab"}>
            {label}
            {k === "exceptions" && current?.open_exceptions ? <span className="badge">{current.open_exceptions}</span> : null}
          </a>
        ))}
      </nav>
      <main className="content">
        {projects.loading && !projects.data ? <div className="muted">Loading…</div> : null}
        {projects.data && !projects.data.length && tab !== "structure" ? (
          <div className="note">No projects yet. Open “WBS & cost codes” and sync from Procore.</div>
        ) : null}
        {tab === "register" && current && <RegisterPage key={current.project_id + tick} project={current} />}
        {tab === "boq" && current && <BoqPage key={current.project_id} project={current} onChange={refresh} />}
        {tab === "exceptions" && current && <ExceptionsPage key={current.project_id} project={current} onChange={refresh} />}
        {tab === "structure" && <StructurePage key={current?.project_id ?? "none"} project={current} onChange={refresh} />}
        {tab === "items" && <ItemsPage key={tick} />}
      </main>
    </div>
  );
}
