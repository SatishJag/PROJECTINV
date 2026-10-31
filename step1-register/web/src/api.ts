export const session = {
  get user() {
    return localStorage.getItem("pir.user") ?? "";
  },
  set user(v: string) {
    localStorage.setItem("pir.user", v);
  },
  get token() {
    return localStorage.getItem("pir.token") ?? "";
  },
  set token(v: string) {
    localStorage.setItem("pir.token", v);
  },
};

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export async function api<T = any>(method: string, url: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = { "x-user-name": session.user || "user" };
  if (session.token) headers.authorization = `Bearer ${session.token}`;
  let payload: BodyInit | undefined;
  if (body instanceof FormData) payload = body;
  else if (body !== undefined) {
    headers["content-type"] = "application/json";
    payload = JSON.stringify(body);
  }
  const res = await fetch(url, { method, headers, body: payload });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) throw new ApiError(data?.error ?? res.statusText, res.status);
  return data as T;
}

export async function download(url: string, fileName: string) {
  const headers: Record<string, string> = {};
  if (session.token) headers.authorization = `Bearer ${session.token}`;
  const res = await fetch(url, { headers });
  if (!res.ok) throw new ApiError("Download failed", res.status);
  const blob = await res.blob();
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = fileName;
  a.click();
  URL.revokeObjectURL(a.href);
}

export const qty = (v: unknown) => {
  if (v === null || v === undefined || v === "") return "";
  const n = Number(v);
  return Number.isFinite(n) ? n.toLocaleString(undefined, { maximumFractionDigits: 3 }) : String(v);
};

export const when = (v: string | null | undefined) => (v ? new Date(v).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }) : "");

export function toCsv(rows: (string | number | null | undefined)[][]) {
  return rows.map((r) => r.map((c) => (c === null || c === undefined ? "" : /[",\n]/.test(String(c)) ? `"${String(c).replace(/"/g, '""')}"` : String(c))).join(",")).join("\n");
}
export function saveCsv(name: string, rows: (string | number | null | undefined)[][]) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([toCsv(rows)], { type: "text/csv" }));
  a.download = name;
  a.click();
}
