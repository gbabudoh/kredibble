import { describe, expect, it } from "vitest";
import { selfHostedAppConfig } from "../src/engine/source.js";
import { LocalLLM } from "../src/engine/llm.js";

describe("self-hosted model source", () => {
  const ids = ["Qwen3.5-2B-q4f32_1-MLC", "snowflake-arctic-embed-s-q0f32-MLC-b4"];
  const config = selfHostedAppConfig("https://ai.example.org/models/", ids);

  it("rewrites model and kernel URLs to the mirror and keeps only mirrored models", () => {
    expect(config.model_list.map((m) => m.model_id)).toEqual(ids);
    for (const m of config.model_list) {
      expect(m.model).toBe(`https://ai.example.org/models/${m.model_id}`);
      expect(m.model_lib).toMatch(/^https:\/\/ai\.example\.org\/models\/libs\/[^/]+\.wasm$/);
      expect(JSON.stringify(m)).not.toMatch(/huggingface|githubusercontent/);
    }
  });

  it("offers only mirrored models and falls back to the mirrored precision", () => {
    const llm = new LocalLLM();
    llm.setSource({ appConfig: config, available: ids });
    llm.gpu = { supported: true, f16: true, description: "test" };
    expect(llm.availableModels().map((m) => m.key)).toEqual(["qwen3.5-2b"]);
    // GPU prefers f16, but only f32 is mirrored.
    expect(llm.resolveModelId("qwen3.5-2b")).toBe("Qwen3.5-2B-q4f32_1-MLC");
  });
});
