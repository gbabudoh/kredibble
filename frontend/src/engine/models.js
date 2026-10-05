// Curated WebLLM models that fit integrated / entry-level GPUs.
// Each entry maps to a prebuilt MLC model; the f16 variant is used when the
// adapter supports "shader-f16", otherwise the f32 variant.
export const MODELS = [
  {
    key: "qwen2.5-1.5b",
    label: "Qwen2.5 1.5B Instruct (balanced)",
    f16: "Qwen2.5-1.5B-Instruct-q4f16_1-MLC",
    f32: "Qwen2.5-1.5B-Instruct-q4f32_1-MLC",
  },
  {
    key: "llama3.2-1b",
    label: "Llama 3.2 1B Instruct (lightest)",
    f16: "Llama-3.2-1B-Instruct-q4f16_1-MLC",
    f32: "Llama-3.2-1B-Instruct-q4f32_1-MLC",
  },
  {
    key: "llama3.2-3b",
    label: "Llama 3.2 3B Instruct",
    f16: "Llama-3.2-3B-Instruct-q4f16_1-MLC",
    f32: "Llama-3.2-3B-Instruct-q4f32_1-MLC",
  },
  {
    key: "qwen2.5-3b",
    label: "Qwen2.5 3B Instruct (higher quality)",
    f16: "Qwen2.5-3B-Instruct-q4f16_1-MLC",
    f32: "Qwen2.5-3B-Instruct-q4f32_1-MLC",
  },
  {
    key: "phi3.5-mini",
    label: "Phi-3.5 mini (dedicated GPU)",
    f16: "Phi-3.5-mini-instruct-q4f16_1-MLC",
    f32: "Phi-3.5-mini-instruct-q4f32_1-MLC",
  },
];

export const DEFAULT_MODEL_KEY = "qwen2.5-1.5b";
