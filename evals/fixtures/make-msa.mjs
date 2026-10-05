// Generates the eval fixture msa.pdf: a 15-page services agreement with facts planted deep inside.
// Answer key: ../gold.json. Usage (needs puppeteer-core and Chrome): node make-msa.mjs <output.pdf>
// After regenerating, refresh the CI text: cd frontend && node ../evals/fixtures/extract-pages.mjs
import puppeteer from "puppeteer-core";
const boiler = [
  "Each party shall perform its obligations under this Agreement with reasonable skill, care and diligence in accordance with good industry practice.",
  "The Supplier shall maintain complete and accurate records relating to the Services and shall make them available to the Customer on reasonable request.",
  "Any change to the scope of the Services shall be agreed in writing through the change control procedure set out in this Agreement.",
  "The Customer shall provide the Supplier with timely access to such information, premises and personnel as the Supplier reasonably requires.",
  "Each party shall comply with all applicable laws, regulations and codes of practice in connection with the performance of this Agreement.",
  "The Supplier shall ensure that all personnel engaged in the Services are suitably qualified, experienced and supervised.",
  "Nothing in this clause shall restrict either party from exercising any right or remedy available to it under this Agreement or at law.",
  "The parties shall meet at regular intervals to review the performance of the Services and to resolve any operational issues.",
];
const sections = [
  ["Definitions and Interpretation", ""],
  ["Commencement and Term", "This Agreement shall commence on the Effective Date and shall continue for an initial term of three (3) years, after which it shall renew automatically for successive periods of twelve (12) months unless terminated in accordance with clause 22."],
  ["Supply of Services", ""], ["Service Levels", "The Supplier shall achieve system availability of not less than 99.5% in each calendar month, measured in accordance with Schedule 2."],
  ["Customer Obligations", ""], ["Supplier Personnel", ""], ["Change Control", ""], ["Subcontracting", ""],
  ["Charges", ""],
  ["Payment Terms", "The Customer shall pay each undisputed invoice within forty-five (45) days of receipt. Late payments shall bear interest at four per cent (4%) per annum above the Bank of England base rate."],
  ["Audit Rights", ""], ["Intellectual Property", ""], ["Confidentiality", "Each party shall keep the other party's Confidential Information secret for the term of this Agreement and for five (5) years after its expiry."],
  ["Data Protection", "The Supplier shall notify the Customer of any Personal Data Breach without undue delay and in any event within twenty-four (24) hours of becoming aware of it."],
  ["Security", ""], ["Warranties", ""],
  ["Limitation of Liability", "Subject to clause 18.4, each party's total aggregate liability arising under or in connection with this Agreement shall not exceed £2,500,000 in any Contract Year. Neither party excludes liability for death or personal injury caused by negligence or for fraud."],
  ["Indemnities", ""], ["Insurance", "The Supplier shall maintain professional indemnity insurance with a limit of not less than £5,000,000 per claim."],
  ["Force Majeure", ""], ["Business Continuity", ""],
  ["Termination", "Either party may terminate this Agreement for convenience by giving the other party not less than ninety (90) days' written notice. Either party may terminate immediately if the other commits a material breach which is not remedied within thirty (30) days of written notice."],
  ["Consequences of Termination", ""], ["Dispute Resolution", ""],
  ["Governing Law and Jurisdiction", "This Agreement and any dispute arising from it shall be governed by the laws of England and Wales, and the courts of England shall have exclusive jurisdiction."],
];
let html = `<html><body style="font-family:Georgia;font-size:12pt;line-height:1.6;margin:40px"><h1>MASTER SERVICES AGREEMENT</h1>`;
sections.forEach(([title, fact], i) => {
  const n = i + 1;
  html += `<h2>${n}. ${title}</h2>`;
  const paras = [];
  for (let p = 0; p < 4; p++) paras.push(`${n}.${p + 1} ` + [0, 1, 2].map((k) => boiler[(n * 3 + p * 2 + k) % boiler.length]).join(" "));
  if (fact) paras.splice(1, 0, `${n}.${paras.length + 1} ${fact}`);
  html += paras.map((t) => `<p>${t}</p>`).join("");
});
html += "</body></html>";
const browser = await puppeteer.launch({ executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe", headless: "new" });
const page = await browser.newPage();
await page.setContent(html);
await page.pdf({ path: process.argv[2], format: "A4" });
await browser.close();
