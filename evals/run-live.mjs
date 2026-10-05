// Live evaluation: drives the real app in Chrome (real WebLLM model + embeddings on the GPU)
// through the answer key in gold.json and scores the results. Needs a machine with WebGPU.
//
//   1. Start the app:      ./run_dev.sh   (or .\run_dev.ps1)
//   2. cd evals && npm install
//   3. node run-live.mjs [--model qwen2.5-1.5b] [--fewshot] [--only qa,compliance]
//
// Options / env: --base-url (default http://127.0.0.1:8000), CHROME_PATH, --profile <dir>
// (keep a profile to avoid re-downloading models; on Windows use a short path, e.g. C:\kpp,
// because Chrome's CacheStorage fails on very long profile paths).
// Writes reports/<timestamp>-<model>.json and prints a summary.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import puppeteer from "puppeteer-core";

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? fallback : args[i + 1];
};
const flag = (name) => args.includes(`--${name}`);

const MODEL = opt("model", "qwen2.5-1.5b");
const BASE_URL = opt("base-url", "http://127.0.0.1:8000");
const PROFILE = opt("profile", undefined);
const ONLY = (opt("only", "qa,unrelated,extraction,compliance")).split(",");
const FEWSHOT = flag("fewshot");
const LIMIT = Number(opt("limit", "0")) || Infinity;
const CHROME = process.env.CHROME_PATH || {
  win32: "C:/Program Files/Google/Chrome/Application/chrome.exe",
  darwin: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
}[process.platform] || "/usr/bin/google-chrome";

const gold = JSON.parse(await readFile(join(here, "gold.json"), "utf8"));

// Few-shot experiment: approved answers from OTHER documents, as a team's history would hold.
// Some deliberately share a topic with gold questions but carry different facts, so the run
// measures both benefit (style) and leakage (the answer borrowing the example's facts).
const SEEDED_EXAMPLES = [
  { question: "How quickly must the processor report a personal data breach?", answer: "The Processor must notify the Controller without undue delay and within forty-eight (48) hours of becoming aware of a Personal Data Breach [S1].", rating: "up" },
  { question: "What annual fee does the controller pay?", answer: "The Controller pays an annual fee of £18,000, invoiced quarterly in advance [S2].", rating: "up" },
  { question: "Which law governs this agreement?", answer: "it says English law", rating: "down", correction: "This agreement is governed by the laws of the State of New York." },
  { question: "How long does the agreement last?", answer: "It lasts for as long as the Processor processes Personal Data on behalf of the Controller [S1].", rating: "up" },
];
const LEAK_MARKERS = ["48", "forty-eight", "New York", "18,000"];
const fixture = (doc) => join(here, "fixtures", `${doc}.pdf`);
const contains = (text, options) => options.some((o) => text.toLowerCase().includes(o.toLowerCase()));

const browser = await puppeteer.launch({
  executablePath: CHROME, headless: "new", userDataDir: PROFILE,
  args: ["--enable-unsafe-webgpu"], protocolTimeout: 3_600_000,
});
const page = await browser.newPage();
const pageErrors = [];
let consoleErrors = [];
page.on("pageerror", (e) => pageErrors.push(e.message));
page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text().slice(0, 400)); });
await page.evaluateOnNewDocument((model, fewshot) => {
  localStorage.setItem("kredibble_model", model);
  localStorage.setItem("kredibble_fewshot", fewshot ? "on" : "off");
}, MODEL, FEWSHOT);
await page.goto(`${BASE_URL}/`, { waitUntil: "networkidle0" });
await page.evaluate(() => document.querySelector('[data-action="load-model"]').click());
await page.waitForFunction(() => ["On-device", "Error"].includes(document.querySelector("#top-status-text").textContent), { timeout: 1_800_000, polling: 2000 });
const modelId = await page.$eval("#diag-model-id", (e) => e.textContent.replace(" (loaded)", ""));
if (!(await page.$eval("#top-status-text", (e) => e.textContent === "On-device"))) throw new Error(`Model failed to load: ${modelId}`);
console.log(`model: ${modelId}${FEWSHOT ? " (few-shot on)" : ""}`);

if (FEWSHOT) {
  await page.evaluate((examples) => new Promise((resolve, reject) => {
    const req = indexedDB.open("KredibbleChatDB");
    req.onsuccess = () => {
      const tx = req.result.transaction(["feedback"], "readwrite");
      const store = tx.objectStore("feedback");
      store.clear();
      examples.forEach((e, i) => store.put({
        id: `seed:${i}`, createdAt: new Date().toISOString(), rating: e.rating, reasons: e.rating === "down" ? ["wrong"] : [],
        correction: e.correction || "", question: e.question, answer: e.answer, intent: "qa", status: "grounded",
        doc: "other-dpa.pdf", docFingerprint: "seed", model: null, registryVersion: "seed",
      }));
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    };
    req.onerror = () => reject(req.error);
  }), SEEDED_EXAMPLES);
  await page.reload({ waitUntil: "networkidle0" });
  await page.evaluate(() => document.querySelector('[data-action="load-model"]').click());
  await page.waitForFunction(() => document.querySelector("#top-status-text").textContent === "On-device", { timeout: 600_000, polling: 1000 });
  console.log(`seeded ${SEEDED_EXAMPLES.length} approved examples from another document`);
}

let loadedDoc = null;
async function freshChat(doc) {
  // New chat clears the document, so each question starts from a clean thread with the doc re-indexed.
  await page.evaluate(() => document.querySelector(".btn-new-chat").click());
  await (await page.$("#file-upload-input")).uploadFile(fixture(doc));
  await page.waitForFunction(() => /keyword \+ semantic|semantic unavailable/.test(document.querySelector("#attached-doc-meta")?.textContent || ""), { timeout: 900_000, polling: 500 });
  loadedDoc = doc;
}

const lastMessage = () => page.evaluate(() => new Promise((resolve) => {
  const req = indexedDB.open("KredibbleChatDB");
  req.onsuccess = () => {
    const all = req.result.transaction(["threads"]).objectStore("threads").getAll();
    all.onsuccess = () => resolve(all.result.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0].messages.at(-1));
  };
}));

async function ask(doc, q) {
  await freshChat(doc);
  consoleErrors = [];
  const started = Date.now();
  await page.type("#chat-textarea", q);
  await page.keyboard.press("Enter");
  // Done when the reply has its action bar, or as soon as the engine reports an error
  // (e.g. the GPU dropped the model): no point waiting for an answer that cannot come.
  await page.waitForFunction(() => {
    const engineFailed = ["Error", "Not loaded"].includes(document.querySelector("#top-status-text").textContent);
    const replied = document.querySelector(".msg-turn.assistant .msg-actions") && document.querySelector("#stop-icon").style.display === "none";
    return engineFailed || replied;
  }, { timeout: 1_800_000, polling: 500 });
  const engine = await page.$eval("#top-status-text", (e) => e.textContent);
  if (engine !== "On-device") {
    const banner = await page.$eval("#engine-banner-text", (e) => e.textContent);
    throw new Error(`Engine stopped during "${q}": ${banner}\n${consoleErrors.join("\n")}`);
  }
  const m = await lastMessage();
  return {
    q, seconds: Number(((Date.now() - started) / 1000).toFixed(1)), answer: m.content, error: !!m.error,
    route: m.meta?.route?.intent, verification: m.meta?.verification, task: m.meta?.task,
    examplesUsed: m.meta?.examplesUsed ?? 0, consoleErrors: [...consoleErrors],
  };
}

const report = { model: modelId, fewshot: FEWSHOT, startedAt: new Date().toISOString(), sections: {} };

if (ONLY.includes("qa")) {
  const rows = [];
  for (const item of gold.qa.slice(0, LIMIT)) {
    const r = await ask(item.doc, item.q);
    r.correct = contains(r.answer, item.expect) && r.verification?.status !== "abstained";
    r.grounded = r.verification?.status === "grounded";
    // Leakage: the answer contains a fact that exists only in a seeded example, not in the document.
    r.leaked = FEWSHOT ? LEAK_MARKERS.filter((x) => r.answer.includes(x)) : [];
    rows.push(r);
    if (r.error) console.log(`   reply error: ${r.answer.slice(0, 200)}
   console: ${r.consoleErrors.join(" | ").slice(0, 600)}`);
    console.log(`${r.correct ? "✓" : "✗"} ${r.grounded ? "grounded" : (r.verification?.status || "-").padEnd(8)} ${String(r.seconds).padStart(5)}s  ex=${r.examplesUsed}${r.leaked.length ? ` LEAK:${r.leaked.join(",")}` : ""}  ${item.q}`);
  }
  report.sections.qa = {
    correct: rows.filter((r) => r.correct).length, grounded: rows.filter((r) => r.grounded).length, total: rows.length,
    withExamples: rows.filter((r) => r.examplesUsed > 0).length, leaked: rows.filter((r) => r.leaked.length).length, rows,
  };
}

if (ONLY.includes("unrelated")) {
  const rows = [];
  for (const item of gold.unrelated) {
    const r = await ask(item.doc, item.q);
    // Acceptable: routed to general (labelled), or not presented as grounded in the document.
    r.ok = r.route === "general" || r.verification?.status !== "grounded";
    rows.push(r);
    console.log(`${r.ok ? "✓" : "✗"} route=${r.route} status=${r.verification?.status}  ${item.q}`);
  }
  report.sections.unrelated = { ok: rows.filter((r) => r.ok).length, total: rows.length, rows };
}

if (ONLY.includes("extraction")) {
  const rows = [];
  for (const item of gold.extraction) {
    const r = await ask(item.doc, item.q);
    r.found = item.expect_values.filter((v) => r.answer.includes(v));
    r.missing = item.expect_values.filter((v) => !r.found.includes(v));
    rows.push(r);
    console.log(`extraction: ${r.found.length}/${item.expect_values.length} values, ${r.task?.rows} rows, ${r.seconds}s${r.missing.length ? `, missing ${r.missing.join(", ")}` : ""}`);
  }
  report.sections.extraction = { rows };
}

if (ONLY.includes("compliance")) {
  const rows = [];
  for (const item of gold.compliance) {
    const r = await ask(item.doc, item.q);
    const findings = r.task?.findings || [];
    r.items = Object.entries(item.key).map(([id, truth]) => {
      const verdict = findings.find((f) => f.id === id)?.verdict;
      // A failed check ("error") is never counted as correct, even for an absent requirement.
      const ok = truth === "present" ? ["addressed", "partial"].includes(verdict) : ["not_found", "unverified"].includes(verdict);
      return { id, truth, verdict, ok, falsePositive: truth === "absent" && ["addressed", "partial"].includes(verdict) };
    });
    rows.push(r);
    const ok = r.items.filter((x) => x.ok).length;
    console.log(`compliance: ${ok}/${r.items.length} correct, ${r.items.filter((x) => x.falsePositive).length} false "addressed", ${r.seconds}s`);
    for (const x of r.items.filter((y) => !y.ok)) console.log(`   ✗ ${x.id}: expected ${x.truth}, got ${x.verdict}`);
  }
  report.sections.compliance = { rows };
}

report.finishedAt = new Date().toISOString();
report.pageErrors = pageErrors;
await browser.close();

await mkdir(join(here, "reports"), { recursive: true });
const file = join(here, "reports", `${report.startedAt.replace(/[:.]/g, "-")}-${MODEL}${FEWSHOT ? "-fewshot" : ""}.json`);
await writeFile(file, JSON.stringify(report, null, 2));

console.log("\n=== summary");
if (report.sections.qa) {
  const qa = report.sections.qa;
  console.log(`document Q&A: ${qa.correct}/${qa.total} correct, ${qa.grounded} grounded${FEWSHOT ? `, examples used in ${qa.withExamples}, leaked facts in ${qa.leaked}` : ""}`);
}
if (report.sections.unrelated) console.log(`unrelated questions handled: ${report.sections.unrelated.ok}/${report.sections.unrelated.total}`);
if (pageErrors.length) console.log(`page errors: ${pageErrors.length}`);
console.log(`report: ${file}`);
