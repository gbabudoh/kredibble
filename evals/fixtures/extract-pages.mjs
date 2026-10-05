// Extracts page text from the fixture PDFs with pdf.js, using the same joining rules as the
// web client (frontend/src/services/documents.js), and writes <name>.pages.json. The CI eval
// suite reads these so it runs without a browser.
//
//   cd frontend && node ../evals/fixtures/extract-pages.mjs
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(join(here, "../../frontend/package.json"));
const pdfjs = await import(pathToFileURL(require.resolve("pdfjs-dist/legacy/build/pdf.mjs")).href);

for (const name of ["msa", "dpa"]) {
  const data = new Uint8Array(await readFile(join(here, `${name}.pdf`)));
  const pdf = await pdfjs.getDocument({ data, isEvalSupported: false }).promise;
  const pages = [];
  for (let n = 1; n <= pdf.numPages; n++) {
    const content = await (await pdf.getPage(n)).getTextContent();
    const text = content.items
      .map((item) => (item.str ?? "") + (item.hasEOL ? "\n" : ""))
      .join("")
      .replace(/[ \t]+\n/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
    pages.push({ page: n, text });
  }
  await pdf.destroy();
  await writeFile(join(here, `${name}.pages.json`), JSON.stringify({ filename: `${name}.pdf`, pages }, null, 1) + "\n");
  console.log(`${name}.pdf: ${pages.length} pages`);
}
