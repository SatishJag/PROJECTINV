import ExcelJS from "exceljs";

type Row = (string | number | null)[];
interface SheetSpec {
  name: string;
  header: string[];
  rows: Row[];
}

async function workbook(projectName: string, title: string, sheets: SheetSpec[]) {
  const wb = new ExcelJS.Workbook();
  wb.created = wb.modified = new Date("2026-01-01T00:00:00Z");
  for (const s of sheets) {
    const ws = wb.addWorksheet(s.name);
    ws.addRow([title]);
    ws.addRow([`Project: ${projectName}`]);
    ws.addRow([]);
    ws.addRow(s.header);
    for (const r of s.rows) ws.addRow(r);
    ws.columns.forEach((c) => (c.width = 18));
  }
  return Buffer.from(await wb.xlsx.writeBuffer());
}

const MECH_HEADER = ["Item", "Description", "Specification", "Unit", "Qty", "Rate", "Amount"];
const ELEC_HEADER = ["Item", "Cost Code", "Description", "Specification", "Unit", "Qty", "Rate", "Amount"];

/** Bangkok Central 1 MEP BOQ. upsCableQty lets a later revision change one quantity. */
export function bc1Boq(opts: { upsCableQty?: number; projectName?: string } = {}) {
  return workbook(opts.projectName ?? "Bangkok Central 1", "LDC MEP BOQ - Equipment", [
    {
      name: "Mechanical",
      header: MECH_HEADER,
      rows: [
        ["1", "CHILLER PLANT", null, null, null, null, null],
        ["1.1", "Water-cooled centrifugal chiller", "1000 TR, R-1233zd, 400V/3ph", "nos", 2, null, null],
        ["1.2", "Copper cable", "Specification A, 4C x 95mm² XLPE/SWA", "m", "1,200", null, null],
        ["1.3", "Chiller controls integration", null, "LS", 1, null, null],
        [null, "Sub-total carried to summary", null, null, null, null, null],
        ["2", "UPS SYSTEM", null, null, null, null, null],
        ["2.1", "Modular UPS", "500 kVA, N+1, lithium-ion", "Nr", 4, null, null],
        ["2.2", "Copper cable", "Specification A, 4C x 95mm² XLPE/SWA", "m", opts.upsCableQty ?? 800, null, null],
        ["2.3", "Battery cabinet", "40 min autonomy", "nos", "Incl.", null, null],
        ["3", "UPS AND GENERATOR ROOMS", null, null, null, null, null],
        ["3.1", "Cable tray, hot-dip galvanised", "600 mm wide", "m", 500, null, null],
        ["4", "GENERAL", null, null, null, null, null],
        ["4.1", "Copper cable", "Specification A, 4C x 95mm² XLPE/SWA", "m", 300, null, null],
        [null, "Note: all cables to be LSZH where routed indoors", null, null, null, null, null],
        [null, "Total", null, null, null, null, null],
      ],
    },
    {
      name: "Electrical",
      header: ELEC_HEADER,
      rows: [
        ["E1", "26-300", "Cast resin transformer", "Specification B, 2500 kVA 22/0.4 kV", "each", 2, null, null],
        ["E2", "26-400", "Diesel generator set", "2000 kVA prime, 400V", "Nr", 2, null, null],
        ["E3", "26-400", "Generator fuel day tank", "1000 l double-wall", "nos", 2, null, null],
        ["E4", "99-999", "Earthing system", null, "lot", 1, null, null],
        ["E5", "26-300", "Transformer protection relay", null, "boxes", 2, null, null],
      ],
    },
  ]);
}

export function bc2Boq() {
  return workbook("Bangkok Central 2", "LDC MEP BOQ - Equipment", [
    {
      name: "Electrical",
      header: ELEC_HEADER,
      rows: [
        ["1", null, "UPS SYSTEM", null, null, null, null, null],
        ["1.1", null, "Copper cable", "Specification A, 4C x 95mm² XLPE/SWA", "m", 600, null, null],
        ["2", null, "TRANSFORMERS", null, null, null, null, null],
        ["2.1", null, "Cast resin transformer", "Specification B, 2500 kVA 22/0.4 kV", "each", 2, null, null],
        ["3", null, "GENERATORS", null, null, null, null, null],
        ["3.1", null, "Fuel polishing unit", "Skid mounted, 40 l/min", "nos", 1, null, null],
      ],
    },
  ]);
}

/** Minimal text PDF (one text line per row) for the PDF extraction path. */
export function textPdf(lines: string[]) {
  const esc = (s: string) => s.replace(/[\\()]/g, (c) => `\\${c}`);
  const content = ["BT", "/F1 10 Tf", "14 TL", "40 800 Td", ...lines.map((l) => `(${esc(l)}) Tj T*`), "ET"].join("\n");
  const objs = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let pdf = "%PDF-1.4\n";
  const offsets: number[] = [];
  objs.forEach((o, i) => {
    offsets.push(Buffer.byteLength(pdf));
    pdf += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}`;
  pdf += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf, "latin1");
}

export function bc3PdfBoq() {
  return textPdf([
    "LDC BOQ - Generator package",
    "Project: Bangkok Central 3",
    "Item Description Qty Unit",
    "1 GENERATOR",
    "1.1 Diesel generator set 2000 kVA 2 nos",
    "1.2 Copper cable specification A 450 m",
    "2 UPS",
    "2.1 Modular UPS 500 kVA 3 nos",
  ]);
}
