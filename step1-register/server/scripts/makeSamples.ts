import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { bc1Boq, bc2Boq, bc3PdfBoq } from "./samples.js";

const out = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../samples");
fs.mkdirSync(out, { recursive: true });
const files: [string, Buffer][] = [
  ["BC1_MEP_BOQ_RevA.xlsx", await bc1Boq()],
  ["BC1_MEP_BOQ_RevB.xlsx", await bc1Boq({ upsCableQty: 900 })],
  ["BC2_MEP_BOQ_RevA.xlsx", await bc2Boq()],
  ["BC3_Generator_BOQ.pdf", bc3PdfBoq()],
  ["BC2_named_file_for_conflict_test.xlsx", await bc1Boq({ projectName: "Bangkok Central 2" })],
];
for (const [name, buf] of files) fs.writeFileSync(path.join(out, name), buf);
console.log(`wrote ${files.length} sample BOQs to ${out}`);
