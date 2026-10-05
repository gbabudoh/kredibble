// Generates the eval fixture dpa.pdf: a data processing agreement containing 5 of the 8 GDPR Art. 28 terms (rights, deletion and audit are deliberately absent).
// Answer key: ../gold.json. Usage (needs puppeteer-core and Chrome): node make-dpa.mjs <output.pdf>
// After regenerating, refresh the CI text: cd frontend && node ../evals/fixtures/extract-pages.mjs
import puppeteer from "puppeteer-core";
const boiler = [
  "The parties shall cooperate in good faith in the performance of this Agreement and shall keep each other reasonably informed.",
  "Each party shall bear its own costs in connection with the negotiation and execution of this Agreement.",
  "Notices under this Agreement shall be in writing and delivered to the addresses set out in the Order Form.",
  "This Agreement may be executed in counterparts, each of which shall constitute an original.",
  "No failure or delay in exercising any right shall operate as a waiver of that right.",
  "If any provision is found invalid, the remaining provisions shall continue in full force and effect.",
];
const sections = [
  ["Definitions", ""],
  ["Scope of Processing", "The Processor shall process Personal Data only on the documented instructions of the Controller, including with regard to transfers of Personal Data to a third country."],
  ["Personnel", "The Processor shall ensure that all persons authorised to process the Personal Data have committed themselves to confidentiality or are under an appropriate statutory obligation of confidentiality."],
  ["Security", "The Processor shall implement appropriate technical and organisational measures to ensure a level of security appropriate to the risk, including encryption of Personal Data at rest and in transit."],
  ["Sub-processing", "The Processor shall not engage another processor without the prior specific or general written authorisation of the Controller."],
  ["Personal Data Breaches", "The Processor shall notify the Controller without undue delay, and in any event within forty-eight (48) hours, after becoming aware of a Personal Data Breach."],
  ["Fees", "The Controller shall pay the Processor an annual fee of £18,000, invoiced quarterly in advance."],
  ["Liability", ""], ["Term", "This Agreement shall remain in force for so long as the Processor processes Personal Data on behalf of the Controller."],
  ["General", ""],
];
let html = `<html><body style="font-family:Georgia;font-size:12pt;line-height:1.6;margin:40px"><h1>DATA PROCESSING AGREEMENT</h1>`;
sections.forEach(([title, fact], i) => {
  const n = i + 1;
  html += `<h2>${n}. ${title}</h2>`;
  const paras = [0, 1, 2].map((p) => `${n}.${p + 1} ` + [0, 1].map((k) => boiler[(n * 2 + p + k) % boiler.length]).join(" "));
  if (fact) paras.splice(0, 0, `${n}.0 ${fact}`);
  html += paras.map((t) => `<p>${t}</p>`).join("");
});
html += "</body></html>";
const browser = await puppeteer.launch({ executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe", headless: "new" });
const page = await browser.newPage();
await page.setContent(html);
await page.pdf({ path: process.argv[2], format: "A4" });
await browser.close();
