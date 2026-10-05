import { describe, expect, it } from "vitest";
import { DocumentIndex, combineDocuments, pageLabel } from "../src/rag/retriever.js";
import { chunkPages } from "../src/rag/chunker.js";
import { formatSource } from "../src/core/prompt.js";
import { redactPages, scanDocument } from "../src/privacy/pii.js";

const doc = (filename, pages) => ({ filename, pages: pages.map((text, i) => ({ page: i + 1, text })), pageCount: pages.length, charCount: pages.join("").length });

const nda = doc("nda.pdf", ["1. CONFIDENTIALITY\nThe receiving party keeps all information secret for five years."]);
const lease = doc("lease.pdf", [
  "The tenant pays rent monthly.",
  "The deposit of £1,200 is returned within ten days of the tenancy ending. Contact landlord@example.com.",
]);

describe("several documents searched together", () => {
  it("leaves a single document unchanged", () => {
    expect(combineDocuments([nda])).toBe(nda);
  });

  it("merges pages and keeps each page's file and number", () => {
    const both = combineDocuments([nda, lease]);
    expect(both.filename).toBe("2 documents");
    expect(both.files).toEqual(["nda.pdf", "lease.pdf"]);
    expect(both.pageCount).toBe(3);
    expect(both.pages.map(pageLabel)).toEqual(["nda.pdf p. 1", "lease.pdf p. 1", "lease.pdf p. 2"]);
  });

  it("does not carry a section heading into the next file", () => {
    const chunks = chunkPages(combineDocuments([nda, lease]).pages);
    const leaseChunks = chunks.filter((c) => c.file === "lease.pdf");
    expect(leaseChunks.length).toBeGreaterThan(0);
    expect(leaseChunks.every((c) => !c.section)).toBe(true);
  });

  it("finds the answer in the right file and cites it", () => {
    const index = new DocumentIndex(combineDocuments([nda, lease]));
    const [best] = index.select(index.retrieve("When is the deposit returned?").ranked, 2000);
    expect(best.file).toBe("lease.pdf");
    expect(best.page).toBe(2);
    expect(formatSource(best)).toMatch(/^\[S1\] \(lease\.pdf · p\. 2/);
  });

  it("keeps single-document citations as before", () => {
    const index = new DocumentIndex(lease);
    const [best] = index.select(index.retrieve("deposit").ranked, 2000);
    expect(best.file).toBeUndefined();
    expect(formatSource(best)).toMatch(/^\[S1\] \(p\. 2/);
  });

  it("names the file in personal-data findings and redacted pages", () => {
    const pages = combineDocuments([nda, lease]).pages;
    const [finding] = scanDocument(pages).findings;
    expect(finding).toMatchObject({ file: "lease.pdf", page: 2 });
    expect(redactPages(pages)[2]).toMatchObject({ file: "lease.pdf", page: 2 });
    expect(redactPages(pages)[2].text).not.toContain("landlord@example.com");
  });
});
