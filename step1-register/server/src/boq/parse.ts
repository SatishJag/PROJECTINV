import ExcelJS from "exceljs";

/** One physical row of the source document, with where it came from. */
export interface SourceRow {
  sheet: string | null;
  row: number | null;
  page: number | null;
  locator: string;
  itemCode: string | null;
  description: string | null;
  specification: string | null;
  quantity: string | null;
  uom: string | null;
  wbsReference: string | null;
  costCode: string | null;
}

export interface ParsedDocument {
  format: "xlsx" | "csv" | "pdf";
  rows: SourceRow[];
  /** Project name stated in the document (title block / "Project:" cell), used only as a cross-check. */
  declaredProjectName: string | null;
  messages: string[];
}

export class UnsupportedDocument extends Error {}

type Role = "itemCode" | "description" | "specification" | "quantity" | "uom" | "wbsReference" | "costCode";

const HEADER_PATTERNS: [Role, RegExp][] = [
  ["costCode", /^(cost\s*code|budget\s*code|cost\s*ref)/],
  ["wbsReference", /^(wbs|work\s*package|package|system)\b/],
  ["description", /^(item\s*)?(description|particulars|desc\.?|details|item\s*name|material)\b/],
  ["specification", /^(spec(ification)?|make|model|technical|rating)/],
  ["quantity", /^(qty|quantity|quantities|boq\s*qty|q'ty)\b/],
  ["uom", /^(unit|uom|u\/m|units|unit\s*of\s*measure)\b/],
  ["itemCode", /^(item(\s*(no\.?|code|ref))?|ref(erence)?|code|s\/?no\.?|sl\.?\s*no\.?|no\.?|#)$/],
];

const clean = (v: unknown) => {
  if (v === null || v === undefined) return null;
  const s = String(v).replace(/\s+/g, " ").trim();
  return s === "" ? null : s;
};

function roleOf(header: string): Role | null {
  const h = header.toLowerCase().replace(/[:*]/g, "").trim();
  if (/rate|amount|price|total|cost\s*$/.test(h) && !/cost\s*code/.test(h)) return null;
  for (const [role, re] of HEADER_PATTERNS) if (re.test(h)) return role;
  return null;
}

/** Finds the header row (needs a description column and a quantity or unit column) and the column of each role. */
function findHeader(grid: string[][]): { index: number; cols: Partial<Record<Role, number>> } | null {
  for (let i = 0; i < Math.min(grid.length, 40); i++) {
    const cols: Partial<Record<Role, number>> = {};
    grid[i]!.forEach((cell, c) => {
      if (!cell) return;
      const r = roleOf(cell);
      if (r && cols[r] === undefined) cols[r] = c;
    });
    if (cols.description !== undefined && (cols.quantity !== undefined || cols.uom !== undefined)) return { index: i, cols };
  }
  return null;
}

const PROJECT_LABEL = /^project(\s*name)?\s*[:\-–]\s*(.+)$/i;

function declaredProject(grid: string[][], upTo: number): string | null {
  for (let i = 0; i < Math.min(upTo, grid.length); i++) {
    const row = grid[i]!;
    for (let c = 0; c < row.length; c++) {
      const cell = row[c];
      if (!cell) continue;
      const m = cell.match(PROJECT_LABEL);
      if (m) return clean(m[2]);
      if (/^project(\s*name)?\s*:?$/i.test(cell)) {
        const next = row.slice(c + 1).find((x) => x);
        if (next) return clean(next);
      }
    }
  }
  return null;
}

function rowsFromGrid(grid: string[][], sheet: string | null, rowNumbers: number[]): { rows: SourceRow[]; declared: string | null; found: boolean } {
  const header = findHeader(grid);
  if (!header) return { rows: [], declared: declaredProject(grid, grid.length), found: false };
  const at = (r: string[], role: Role) => (header.cols[role] === undefined ? null : clean(r[header.cols[role]!]));
  const rows: SourceRow[] = [];
  for (let i = header.index + 1; i < grid.length; i++) {
    const r = grid[i]!;
    const row: SourceRow = {
      sheet,
      row: rowNumbers[i] ?? i + 1,
      page: null,
      locator: `${sheet ?? "Sheet"}!R${rowNumbers[i] ?? i + 1}`,
      itemCode: at(r, "itemCode"),
      description: at(r, "description"),
      specification: at(r, "specification"),
      quantity: at(r, "quantity"),
      uom: at(r, "uom"),
      wbsReference: at(r, "wbsReference"),
      costCode: at(r, "costCode"),
    };
    if (!row.description && !row.quantity && !row.uom && !row.itemCode) continue;
    rows.push(row);
  }
  return { rows, declared: declaredProject(grid, header.index), found: true };
}

function cellText(cell: ExcelJS.Cell): string {
  const v = cell.value as any;
  if (v === null || v === undefined) return "";
  if (typeof v === "object") {
    if ("result" in v) return v.result === undefined || v.result === null ? "" : String(v.result);
    if ("richText" in v) return (v.richText as { text: string }[]).map((t) => t.text).join("");
    if ("text" in v) return String(v.text);
    if (v instanceof Date) return v.toISOString().slice(0, 10);
  }
  return String(v);
}

export async function parseXlsx(content: Buffer): Promise<ParsedDocument> {
  const wb = new ExcelJS.Workbook();
  try {
    await wb.xlsx.load(content as any);
  } catch (e) {
    throw new UnsupportedDocument(`Could not read the Excel workbook (${(e as Error).message}). Legacy .xls files must be saved as .xlsx.`);
  }
  const out: ParsedDocument = { format: "xlsx", rows: [], declaredProjectName: null, messages: [] };
  wb.eachSheet((ws) => {
    if (ws.state && ws.state !== "visible") {
      out.messages.push(`Sheet "${ws.name}" is hidden and was not read`);
      return;
    }
    const grid: string[][] = [];
    const rowNumbers: number[] = [];
    ws.eachRow({ includeEmpty: false }, (row, n) => {
      const cells: string[] = [];
      row.eachCell({ includeEmpty: true }, (cell, c) => {
        cells[c - 1] = cellText(cell).replace(/\s+/g, " ").trim();
      });
      grid.push(Array.from(cells, (x) => x ?? ""));
      rowNumbers.push(n);
    });
    const r = rowsFromGrid(grid, ws.name, rowNumbers);
    if (!r.found) {
      if (grid.length) out.messages.push(`Sheet "${ws.name}": no BOQ table header found (needs Description and Qty/Unit columns); not read`);
    }
    out.rows.push(...r.rows);
    out.declaredProjectName ??= r.declared;
  });
  return out;
}

function parseCsvText(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cur = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else cur += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") {
      row.push(cur.trim());
      cur = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(cur.trim());
      rows.push(row);
      row = [];
      cur = "";
    } else cur += ch;
  }
  if (cur || row.length) {
    row.push(cur.trim());
    rows.push(row);
  }
  return rows;
}

export function parseCsv(content: Buffer, fileName: string): ParsedDocument {
  const grid = parseCsvText(content.toString("utf8").replace(/^\uFEFF/, ""));
  const sheet = fileName.replace(/\.[^.]+$/, "");
  const r = rowsFromGrid(grid, sheet, grid.map((_, i) => i + 1));
  return { format: "csv", rows: r.rows, declaredProjectName: r.declared, messages: r.found ? [] : ["No BOQ table header found (needs Description and Qty/Unit columns)"] };
}

// PDF: text layer only. A line ending in "<quantity> <unit>" (or "<unit> <quantity>") is an item; other lines are
// kept as headings/notes so the reconciliation can account for them.
const PDF_ITEM_QTY_UNIT = /^(?:(?<code>[A-Z]?\d+(?:\.\d+)*[a-z]?|[A-Z]{1,3}-?\d+(?:\.\d+)*)\s+)?(?<desc>.+?)\s+(?<qty>\d{1,3}(?:,\d{3})*(?:\.\d+)?|\d+(?:\.\d+)?)\s+(?<uom>[A-Za-z][A-Za-z.]{0,8}[²³23]?)(?:\s+[\d,]+(?:\.\d+)?){0,2}$/;
const PDF_ITEM_UNIT_QTY = /^(?:(?<code>[A-Z]?\d+(?:\.\d+)*[a-z]?|[A-Z]{1,3}-?\d+(?:\.\d+)*)\s+)?(?<desc>.+?)\s+(?<uom>[A-Za-z][A-Za-z.]{0,8}[²³23]?)\s+(?<qty>\d{1,3}(?:,\d{3})*(?:\.\d+)?|\d+(?:\.\d+)?)(?:\s+[\d,]+(?:\.\d+)?){0,2}$/;
const PDF_HEADING = /^(?:(?<code>[A-Z]?\d+(?:\.\d+)*|[A-Z])[.)]?\s+)?(?<desc>.+)$/;

export async function parsePdf(content: Buffer, isKnownUnit: (u: string) => boolean): Promise<ParsedDocument> {
  const { extractText, getDocumentProxy } = await import("unpdf");
  let pages: string[];
  try {
    const pdf = await getDocumentProxy(new Uint8Array(content));
    pages = ((await extractText(pdf, { mergePages: false })).text as unknown as string[]) ?? [];
  } catch (e) {
    throw new UnsupportedDocument(`Could not read the PDF (${(e as Error).message})`);
  }
  if (!pages.join("").trim()) {
    throw new UnsupportedDocument("The PDF has no text layer (scanned). OCR is required before it can be extracted; submit the Excel BOQ or a text PDF.");
  }
  const out: ParsedDocument = { format: "pdf", rows: [], declaredProjectName: null, messages: ["PDF extracted from its text layer; check the lines against the source pages"] };
  let headerSeen = false;
  pages.forEach((text, p) => {
    text
      .split(/\r?\n/)
      .map((l) => l.replace(/\s+/g, " ").trim())
      .forEach((line, li) => {
        if (!line) return;
        const base = { sheet: null, row: li + 1, page: p + 1, locator: `p${p + 1}:L${li + 1}`, specification: null, wbsReference: null, costCode: null };
        const proj = line.match(PROJECT_LABEL);
        if (proj && !out.declaredProjectName) {
          out.declaredProjectName = clean(proj[2]);
          return;
        }
        if (/\bdescription\b/i.test(line) && /\b(qty|quantity|unit)\b/i.test(line)) {
          headerSeen = true;
          return;
        }
        if (!headerSeen) return;
        if (/^page \d+/i.test(line)) return;
        for (const re of [PDF_ITEM_QTY_UNIT, PDF_ITEM_UNIT_QTY]) {
          const m = line.match(re);
          if (m?.groups && isKnownUnit(m.groups.uom!.trim())) {
            out.rows.push({ ...base, itemCode: m.groups.code ?? null, description: clean(m.groups.desc), quantity: m.groups.qty!, uom: m.groups.uom!.trim() });
            return;
          }
        }
        const h = line.match(PDF_HEADING);
        out.rows.push({ ...base, itemCode: h?.groups?.code ?? null, description: clean(h?.groups?.desc ?? line), quantity: null, uom: null });
      });
  });
  if (!headerSeen) out.messages.push("No BOQ table header (Description / Qty / Unit) found in the PDF text");
  return out;
}

export function detectFormat(fileName: string, mimeType: string | null, content: Buffer): "xlsx" | "csv" | "pdf" | null {
  const ext = fileName.toLowerCase().split(".").pop() ?? "";
  if (content.subarray(0, 4).toString("latin1") === "%PDF" || ext === "pdf") return "pdf";
  if (content[0] === 0x50 && content[1] === 0x4b) return "xlsx";
  if (ext === "csv" || mimeType === "text/csv") return "csv";
  if (ext === "xlsx" || ext === "xlsm") return "xlsx";
  return null;
}
