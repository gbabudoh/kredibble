// Mirrors model weights and WebGPU kernels for self-hosted / air-gapped deployments.
// Run on a machine with internet access, then copy the output folder to the server and
// set MODELS_DIR (see DEPLOYMENT.md). The app then downloads models from your server only.
//
//   cd frontend
//   node scripts/fetch-models.mjs --out ../models                       # default model (f16 + f32) + embedder
//   node scripts/fetch-models.mjs --out ../models --models qwen2.5-1.5b,llama3.2-1b --precision f16
//
// Layout written (mirrors what WebLLM requests):
//   <out>/<model_id>/resolve/main/{mlc-chat-config.json, ndarray-cache.json, tokenizer files, shards}
//   <out>/libs/<kernel>.wasm
//   <out>/manifest.json
import { createWriteStream } from "node:fs";
import { mkdir, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { prebuiltAppConfig } from "@mlc-ai/web-llm";
import { MODELS, DEFAULT_MODEL_KEY } from "../src/engine/models.js";
import { EMBEDDING_MODEL_ID } from "../src/rag/model-ids.js";

const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? fallback : args[i + 1];
};
const OUT = resolve(opt("out", "../models"));
const keys = opt("models", DEFAULT_MODEL_KEY).split(",");
const precisions = opt("precision", "f16,f32").split(",");

const ids = [];
for (const key of keys) {
  const model = MODELS.find((m) => m.key === key);
  if (!model) throw new Error(`Unknown model "${key}". Choose from: ${MODELS.map((m) => m.key).join(", ")}`);
  for (const p of precisions) ids.push(model[p]);
}
ids.push(EMBEDDING_MODEL_ID);

const modelBase = (url) => {
  let u = url.endsWith("/") ? url : `${url}/`;
  if (!/\/resolve\/.+\//.test(u)) u += "resolve/main/";
  return u;
};

async function download(url, path) {
  const existing = await stat(path).catch(() => null);
  const head = await fetch(url, { method: "HEAD", redirect: "follow" });
  const size = Number(head.headers.get("content-length") || 0);
  if (existing && size && existing.size === size) return { skipped: true, size };
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}: ${url}`);
  await mkdir(dirname(path), { recursive: true });
  await pipeline(Readable.fromWeb(res.body), createWriteStream(path));
  return { skipped: false, size: (await stat(path)).size };
}

const manifest = { generatedAt: new Date().toISOString(), models: [] };
let total = 0;
for (const id of ids) {
  const record = prebuiltAppConfig.model_list.find((m) => m.model_id === id);
  if (!record) throw new Error(`Model ${id} is not in this WebLLM version's prebuilt list.`);
  const base = modelBase(record.model);
  const dir = join(OUT, id, "resolve", "main");
  console.log(`\n${id}`);

  const config = await (await fetch(new URL("mlc-chat-config.json", base))).json();
  // The weight index was renamed: WebLLM >= 0.2.8x requests tensor-cache.json, older
  // versions ndarray-cache.json. Mirror whichever exists under both names.
  let index = null;
  for (const name of ["tensor-cache.json", "ndarray-cache.json"]) {
    const res = await fetch(new URL(name, base));
    if (res.ok) { index = await res.text(); break; }
  }
  if (!index) throw new Error(`No tensor-cache.json or ndarray-cache.json for ${id}`);
  await mkdir(dir, { recursive: true });
  for (const name of ["tensor-cache.json", "ndarray-cache.json"]) await writeFile(join(dir, name), index);
  const shards = JSON.parse(index).records.map((r) => r.dataPath);

  const files = [...new Set(["mlc-chat-config.json", ...(config.tokenizer_files || []), ...shards])];
  for (const [i, file] of files.entries()) {
    const r = await download(new URL(file, base).href, join(dir, file));
    total += r.size;
    process.stdout.write(`\r  ${i + 1}/${files.length} files${r.skipped ? " (cached)" : ""}   `);
  }
  const lib = basename(new URL(record.model_lib).pathname);
  await download(record.model_lib, join(OUT, "libs", lib));
  manifest.models.push({ id, lib });
  console.log(`\n  kernel: ${lib}`);
}
await writeFile(join(OUT, "manifest.json"), JSON.stringify(manifest, null, 2));
console.log(`\nDone: ${manifest.models.length} models, ${(total / 1e9).toFixed(2)} GB in ${OUT}`);
