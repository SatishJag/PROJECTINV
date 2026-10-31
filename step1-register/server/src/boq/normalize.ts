import type { SourceRow } from "./parse.js";

export interface Uom {
  uom_id: string;
  code: string;
  measurement_dimension: string;
  aliases: string[];
}

const uomKey = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim().replace(/\.$/, "");

export class UomTable {
  private readonly byKey = new Map<string, Uom>();
  constructor(readonly all: Uom[]) {
    for (const u of all) {
      this.byKey.set(uomKey(u.code), u);
      for (const a of u.aliases) this.byKey.set(uomKey(a), u);
    }
  }
  /** Maps the BOQ's unit text to a unit; never derives a unit from the description (e.g. "95mm²" is a size). */
  resolve(raw: string | null): Uom | null {
    if (!raw) return null;
    return this.byKey.get(uomKey(raw)) ?? this.byKey.get(uomKey(raw).replace(/\./g, "")) ?? null;
  }
  byId(id: string) {
    return this.all.find((u) => u.uom_id === id) ?? null;
  }
}

/** "1,200" / "1 200" / "2.5" -> number; anything else (Incl., Rate only, -, 0) -> null. */
export function parseQuantity(raw: string | null): number | null {
  if (!raw) return null;
  const s = raw.replace(/[,\s]/g, "");
  if (!/^\d+(\.\d+)?$/.test(s)) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

export type LineKind = "item" | "heading" | "subtotal" | "note";

const SUBTOTAL = /\b(sub[\s-]?total|grand\s+total|total|carried\s+(forward|to|over)|brought\s+forward|c\/f|b\/f|collection|summary)\b/i;
const NOTE = /^(note|notes|nb|n\.b\.|remark|remarks)\b/i;

export function classify(r: SourceRow): LineKind {
  const desc = r.description ?? "";
  if (SUBTOTAL.test(desc) && !r.uom) return "subtotal";
  if (NOTE.test(desc)) return "note";
  if (r.quantity || r.uom) return "item";
  return "heading";
}

/** Heading depth: from a numbered code ("2" = 1, "2.1" = 2), else 1 for ALL-CAPS text, 2 otherwise. */
export function headingLevel(r: SourceRow): number {
  const code = r.itemCode?.replace(/\.0+$/, "");
  if (code && /^[A-Z]?\d+(\.\d+)*$/i.test(code)) return code.split(".").length;
  if (code && /^[A-Z]$/i.test(code)) return 1;
  const d = r.description ?? "";
  return d === d.toUpperCase() ? 1 : 2;
}

export const normText = (s: string | null | undefined) =>
  (s ?? "")
    .toLowerCase()
    .replace(/²/g, "2")
    .replace(/³/g, "3")
    .replace(/[^a-z0-9.]+/g, " ")
    .replace(/(?<!\d)\.|\.(?!\d)/g, " ")
    .replace(/\s+/g, " ")
    .trim();

const tokens = (s: string) => normText(s).split(" ").filter(Boolean);
const singular = (t: string) => (t.length > 3 && t.endsWith("s") ? t.slice(0, -1) : t);

/** True when `phrase` appears in `text` as whole words (plural-tolerant): "UPS" in "UPS SYSTEM", not in "GROUPS". */
export function containsPhrase(text: string | null | undefined, phrase: string): boolean {
  const t = tokens(text ?? "").map(singular);
  const p = tokens(phrase).map(singular);
  if (!p.length || p.length > t.length) return false;
  for (let i = 0; i + p.length <= t.length; i++) if (p.every((w, j) => t[i + j] === w)) return true;
  return false;
}

export const compactCode = (s: string | null | undefined) => (s ?? "").toUpperCase().replace(/[\s_]/g, "");

/** Identity key for matching item definitions: the full description and specification, plus the unit's dimension. */
export function itemMatchKey(description: string, specification: string | null, dimension: string) {
  return `${normText(description)}|${normText(specification)}|${dimension}`;
}

export function sameProjectName(a: string, b: string) {
  const x = normText(a);
  const y = normText(b);
  return x === y || x.includes(y) || y.includes(x);
}
