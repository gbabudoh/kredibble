// Where model files come from. By default WebLLM downloads from Hugging Face; when the
// server hosts a mirror (MODELS_DIR, filled by scripts/fetch-models.mjs) the app rewrites
// every model URL to this server, so no request leaves the deployment's own origin.
import { prebuiltAppConfig } from "@mlc-ai/web-llm";

const basename = (url) => new URL(url).pathname.split("/").pop();

/**
 * Builds a WebLLM appConfig pointing at a self-hosted mirror.
 * @param {string} baseUrl  absolute URL of the mirror root, e.g. https://ai.corp/models
 * @param {string[]} available  model ids present in the mirror
 */
export function selfHostedAppConfig(baseUrl, available) {
  const root = baseUrl.replace(/\/+$/, "");
  return {
    model_list: prebuiltAppConfig.model_list
      .filter((record) => available.includes(record.model_id))
      .map((record) => ({
        ...record,
        model: `${root}/${record.model_id}`,
        model_lib: `${root}/libs/${basename(record.model_lib)}`,
      })),
  };
}

/** Asks the server whether it hosts models. Falls back to the public defaults. */
export async function loadModelSource() {
  try {
    const res = await fetch("/api/v1/config", { cache: "no-store" });
    if (!res.ok) throw new Error(String(res.status));
    const config = await res.json();
    if (config.model_base_url && config.models_available?.length) {
      const base = new URL(config.model_base_url, location.origin).href;
      return { selfHosted: true, appConfig: selfHostedAppConfig(base, config.models_available), available: config.models_available };
    }
  } catch {
    // No config endpoint (e.g. static hosting): use the public model hosts.
  }
  return { selfHosted: false, appConfig: prebuiltAppConfig, available: null };
}
