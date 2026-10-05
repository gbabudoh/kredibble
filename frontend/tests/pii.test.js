import { describe, expect, it } from "vitest";
import msa from "../../evals/fixtures/msa.pages.json";
import dpa from "../../evals/fixtures/dpa.pages.json";
import { findPII, mask, redact, scanDocument } from "../src/privacy/pii.js";

const types = (text) => findPII(text).map((h) => [h.type, h.value]);

describe("personal data detection", () => {
  it("finds common identifiers", () => {
    expect(types("Contact jane.doe@acme.co.uk or +44 20 7946 0958.")).toEqual([
      ["email", "jane.doe@acme.co.uk"], ["phone", "+44 20 7946 0958"],
    ]);
    expect(types("Mobile 07700 900123, US office (555) 123-4567.")).toEqual([["phone", "07700 900123"], ["phone", "(555) 123-4567"]]);
    expect(types("Card 4111 1111 1111 1111 expires soon.")).toEqual([["card", "4111 1111 1111 1111"]]);
    expect(types("Pay to GB82 WEST 1234 5698 7654 32 today.")).toEqual([["iban", "GB82 WEST 1234 5698 7654 32"]]);
    expect(types("NI number AB 12 34 56 C on file.")).toEqual([["uk_ni", "AB 12 34 56 C"]]);
    expect(types("SSN 123-45-6789.")).toEqual([["us_ssn", "123-45-6789"]]);
    expect(types("Logged from 192.168.10.5.")).toEqual([["ip", "192.168.10.5"]]);
  });

  it("rejects look-alikes that fail validation", () => {
    expect(types("Card 4111 1111 1111 1112")).toEqual([]);            // Luhn fails
    expect(types("IBAN GB82 WEST 1234 5698 7654 33")).toEqual([]);    // mod-97 fails
    expect(types("Number 000-12-3456 and 666-12-3456")).toEqual([]);  // invalid SSN areas
    expect(types("NI GB 12 34 56 A")).toEqual([]);                    // invalid NI prefix
    expect(types("NI QQ 12 34 56 C")).toEqual([]);                    // QQ: documentation-only prefix
    expect(types("Version 1.2.3.400")).toEqual([]);                   // not an IP (400 > 255)
    expect(types("Card 0000 0000 0000 0000")).toEqual([]);            // repeated digit
  });

  it("does not flag ordinary contract figures, dates or clause numbers", () => {
    const text = "Liability is capped at £2,500,000. Pay within forty-five (45) days. Clause 17.4 applies from 1 March 2026. Reference 2026-10-05. Availability 99.5%. Invoice INV-2026-000123.";
    expect(findPII(text)).toEqual([]);
  });

  it("finds nothing in the fixture contracts (false-positive regression)", () => {
    expect(scanDocument(msa.pages).total).toBe(0);
    expect(scanDocument(dpa.pages).total).toBe(0);
  });

  it("redacts in place and masks previews", () => {
    expect(redact("Email jane@acme.com, SSN 123-45-6789.")).toBe("Email [EMAIL REDACTED], SSN [US_SSN REDACTED].");
    expect(mask("jane.doe@acme.co.uk")).toBe("ja••.•••@••••.••.uk"); // punctuation kept, characters hidden
    expect(mask("4111 1111 1111 1111")).toBe("41•• •••• •••• ••11");
  });

  it("reports findings by page and type", () => {
    const report = scanDocument([{ page: 1, text: "a@b.com" }, { page: 2, text: "c@d.org and 123-45-6789" }]);
    expect(report.counts).toEqual({ email: 2, us_ssn: 1 });
    expect(report.findings.map((f) => f.page)).toEqual([1, 2, 2]);
  });
});
