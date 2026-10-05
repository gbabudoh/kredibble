import { describe, expect, it } from "vitest";
import registry from "../src/registry/registry.json";
import { router, routeMessage } from "../src/intent/router.js";

describe("intent router", () => {
  it("matches scikit-learn's predict_proba on the exported parity samples", () => {
    for (const { text, probs } of registry.intents.router.parity) {
      const js = router.predict(text);
      for (const [cls, p] of Object.entries(probs)) {
        expect(js[cls], `${text} / ${cls}`).toBeCloseTo(p, 3);
      }
    }
  });

  it("routes typical requests", () => {
    const route = (t, overlap = 0.5) => routeMessage(t, { hasDocument: true, documentOverlap: overlap }).intent;
    expect(route("What is the liability cap?")).toBe("qa");
    expect(route("Summarise this agreement.")).toBe("summary");
    expect(route("Recap the agreement.")).toBe("summary"); // regex override
    expect(route("Extract all the dates and amounts.")).toBe("extract");
    expect(route("Is this DPA GDPR compliant?")).toBe("compliance");
  });

  it("only skips the document when the router is confident AND the question shares no vocabulary with it", () => {
    const general = (overlap) => routeMessage("What is the capital of France?", { hasDocument: true, documentOverlap: overlap });
    expect(general(0).intent).toBe("general");
    expect(general(0.5).intent).toBe("qa");
    // A contract question the router finds "general-ish" stays on the document when its words occur there.
    expect(routeMessage("Who bears the cost of audits?", { hasDocument: true, documentOverlap: 0.6 }).intent).toBe("qa");
  });

  it("uses plain chat when no document is loaded", () => {
    expect(routeMessage("Summarise this agreement.", { hasDocument: false }).intent).toBe("chat");
  });
});
