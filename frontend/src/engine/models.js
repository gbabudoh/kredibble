// Curated WebLLM models, newest families first, sized for integrated and entry-level GPUs.
// Each entry maps to a prebuilt MLC model; the f16 variant is used when the
// adapter supports "shader-f16", otherwise the f32 variant.
// `thinking`: the model writes hidden reasoning first unless told not to (Qwen3.x); the app
// turns it off, because a long reasoning preamble is slow on a laptop GPU and not shown anyway.
export const MODELS = [
  {
    key: "qwen3.5-2b",
    label: "Qwen3.5 2B (balanced)",
    f16: "Qwen3.5-2B-q4f16_1-MLC",
    f32: "Qwen3.5-2B-q4f32_1-MLC",
    thinking: true,
  },
  {
    key: "qwen3.5-0.8b",
    label: "Qwen3.5 0.8B (fastest)",
    f16: "Qwen3.5-0.8B-q4f16_1-MLC",
    f32: "Qwen3.5-0.8B-q4f32_1-MLC",
    thinking: true,
  },
  {
    key: "ministral3-3b",
    label: "Ministral 3 3B",
    f16: "Ministral-3-3B-Instruct-2512-BF16-q4f16_1-MLC",
    f32: "Ministral-3-3B-Instruct-2512-BF16-q4f32_1-MLC",
    thinking: false,
  },
  {
    key: "qwen3.5-4b",
    label: "Qwen3.5 4B (higher quality)",
    f16: "Qwen3.5-4B-q4f16_1-MLC",
    f32: "Qwen3.5-4B-q4f32_1-MLC",
    thinking: true,
  },
  {
    key: "qwen3.5-9b",
    label: "Qwen3.5 9B (dedicated GPU)",
    f16: "Qwen3.5-9B-q4f16_1-MLC",
    f32: "Qwen3.5-9B-q4f32_1-MLC",
    thinking: true,
  },
];

export const DEFAULT_MODEL_KEY = "qwen3.5-2b";

/** Whether a loaded model id belongs to a model that thinks before answering. */
export const modelThinks = (modelId) => MODELS.some((m) => m.thinking && (m.f16 === modelId || m.f32 === modelId));
