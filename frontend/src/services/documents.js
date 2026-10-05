// Reads documents entirely in the browser. Nothing is uploaded.
import * as pdfjs from "pdfjs-dist";
import pdfWorkerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";

pdfjs.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

const MAX_BYTES = 25 * 1024 * 1024;
const TEXT_EXTENSIONS = [".txt", ".md", ".csv", ".json"];
const TEXT_PAGE_CHARS = 3000; // plain text is split into pseudo-pages so budgeting and citations work the same way

export const ACCEPTED_EXTENSIONS = [".pdf", ...TEXT_EXTENSIONS];

function extensionOf(name) {
  const dot = name.lastIndexOf(".");
  return dot === -1 ? "" : name.slice(dot).toLowerCase();
}

async function extractPdf(file) {
  const data = new Uint8Array(await file.arrayBuffer());
  const pdf = await pdfjs.getDocument({ data, isEvalSupported: false }).promise;
  const pages = [];
  try {
    for (let n = 1; n <= pdf.numPages; n++) {
      const page = await pdf.getPage(n);
      const content = await page.getTextContent();
      const text = content.items
        .map((item) => (item.str ?? "") + (item.hasEOL ? "\n" : ""))
        .join("")
        .replace(/[ \t]+\n/g, "\n")
        .replace(/\n{3,}/g, "\n\n")
        .trim();
      pages.push({ page: n, text });
      page.cleanup();
    }
  } finally {
    await pdf.destroy();
  }
  return pages;
}

function splitText(text) {
  const pages = [];
  for (let i = 0, n = 1; i < text.length; i += TEXT_PAGE_CHARS, n++) {
    pages.push({ page: n, text: text.slice(i, i + TEXT_PAGE_CHARS) });
  }
  return pages;
}

export async function extractDocument(file) {
  const ext = extensionOf(file.name);
  if (!ACCEPTED_EXTENSIONS.includes(ext)) {
    throw new Error(`Unsupported file type. Accepted: ${ACCEPTED_EXTENSIONS.join(", ")}`);
  }
  if (file.size > MAX_BYTES) {
    throw new Error(`File is larger than ${MAX_BYTES / (1024 * 1024)} MB.`);
  }

  const pages = ext === ".pdf" ? await extractPdf(file) : splitText((await file.text()).trim());
  const charCount = pages.reduce((sum, p) => sum + p.text.length, 0);
  if (charCount === 0) {
    throw new Error("No extractable text found. Scanned PDFs need OCR, which is not supported yet.");
  }
  return { filename: file.name, pages, charCount, pageCount: pages.length };
}
