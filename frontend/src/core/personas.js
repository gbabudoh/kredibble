// User persona and workspace configurations across all 7 Kredibble target segments.
// Zero-trust data preservation is enforced at every tier: either in-browser WebLLM
// or self-hosted private Python inference clusters.

export const PERSONAS = [
  {
    id: "personal_vault",
    name: "Personal Vault Assistant",
    shortName: "Personal Vault",
    audience: "You & your household",
    tier: "Basic User",
    tierKey: "basic",
    badge: "Personal",
    icon: "shieldLock",
    tagline: "Household & Personal Privacy",
    description: "Private organization and analysis of sensitive personal tax forms, medical records, legal papers, and personal journaling.",
    privacyGuarantee: "In-Browser WebGPU. Zero server footprint. Volatile RAM or passphrase-locked IndexedDB only.",
    deliveryMethod: "In-browser WebLLM",
    suggestedPrompts: [
      {
        icon: "fileSearch",
        title: "Scan & parse personal tax/bill PDF",
        desc: "Examine tax returns, bank statements, or utility bills in memory",
        action: "pick-file",
      },
      {
        icon: "shieldCheck",
        title: "Medical document explanation",
        desc: "Explain lab results or clinical discharge notes in plain English",
        prompt: "Summarise this medical document into clear, plain English. Highlight diagnosis, recommended actions, and medication instructions without sharing data externally.",
      },
      {
        icon: "edit",
        title: "Confidential journal / voice note",
        desc: "Dictate private thoughts with zero profiling or cloud tracking",
        prompt: "Help me structure my personal journal notes for today. Group them into Key Wins, Challenges, and Tomorrow's Focus.",
      },
      {
        icon: "lock",
        title: "Tenancy or mortgage agreement check",
        desc: "Verify lease obligations, deposit return terms, and notice periods",
        prompt: "What are my exact obligations, notice period, and deposit return terms in this agreement?",
      },
    ],
    systemDirective: `You are the Personal Vault Assistant in Kredibble.
Your role is to assist individuals with personal documents, medical notes, tax statements, and household contracts.
Maintain strict confidentiality, empathy, clarity, and precision. Never invent numbers, dates, or legal/medical advice.`,
  },

  {
    id: "ideashield",
    name: "IdeaShield Workspace",
    shortName: "IdeaShield",
    audience: "Founders & solo",
    tier: "Entrepreneur / Solopreneur",
    tierKey: "solopreneur",
    badge: "Solopreneur",
    icon: "sparkles",
    tagline: "IP & Stealth Venture Shield",
    description: "Brainstorm market strategies, draft pitch deck copy, and refine unreleased product blueprints without leaking first-mover advantage.",
    privacyGuarantee: "Offline WebLLM inference loops. Prevents unpatented IP from training public AI models.",
    deliveryMethod: "In-browser WebLLM",
    suggestedPrompts: [
      {
        icon: "sparkles",
        title: "Pitch deck narrative drafter",
        desc: "Craft high-converting problem, solution, and market slides",
        prompt: "Draft a compelling 5-slide pitch deck narrative for an early-stage startup. Include: Problem, Solution, Market Opportunity, Business Model, and Moat.",
      },
      {
        icon: "briefcase",
        title: "Competitive moat & IP strategy",
        desc: "Analyze defensibility and unreleased product roadmaps",
        prompt: "Analyze the competitive defensibility of our product architecture and suggest 3 strategic moats before public launch.",
      },
      {
        icon: "fileSearch",
        title: "Investor FAQ prep from deck notes",
        desc: "Attach your pitch notes to stress-test unit economics and Q&A",
        action: "pick-file",
      },
      {
        icon: "edit",
        title: "Zero-leakage product roadmap",
        desc: "Outline quarterly technical milestones without cloud storage",
        prompt: "Help me draft a 6-month product development roadmap with MVP milestones, tech stack priorities, and risk mitigations.",
      },
    ],
    systemDirective: `You are the IdeaShield Workspace Co-Founder Assistant in Kredibble.
Your role is to help solopreneurs and founders develop unreleased intellectual property, pitch strategies, business models, and market positioning.
Provide sharp, strategic, investor-grade insights while upholding total IP confidentiality.`,
  },

  {
    id: "private_ledger",
    name: "Private Ledger & Proposal Drafter",
    shortName: "Ledger & Quotes",
    audience: "Small business (1–9)",
    tier: "Micro Business (1–9 Employees)",
    tierKey: "micro",
    badge: "Micro Business",
    icon: "receipt",
    tagline: "Invoices, Quotes & Pricing",
    description: "Reconcile receipts, parse contractor invoices, and draft customer quotes without exposing bank details or customer contacts.",
    privacyGuarantee: "Volatile RAM parsing ensures client banking and trade pricing are never indexed into third-party cloud datasets.",
    deliveryMethod: "In-browser WebLLM",
    suggestedPrompts: [
      {
        icon: "receipt",
        title: "Extract invoice totals & VAT breakdown",
        desc: "Instant verbatim extraction of sums, dates, and supplier terms",
        action: "pick-file",
      },
      {
        icon: "edit",
        title: "Draft client quote & terms",
        desc: "Turn raw line items and labor hours into a polished proposal",
        prompt: "Draft a formal client quotation based on the following project scope, estimated hours, materials cost, and payment milestones: ",
      },
      {
        icon: "shieldCheck",
        title: "Contractor agreement review",
        desc: "Check IP assignment, payment milestones, and liability terms",
        prompt: "Review this contractor agreement: does it explicitly assign all IP to the company and what are the termination terms?",
      },
      {
        icon: "user",
        title: "Client follow-up & payment notice",
        desc: "Professional communication templates preserving customer data",
        prompt: "Write a polite but firm payment reminder email for an invoice that is 14 days overdue, referencing standard UK commercial terms.",
      },
    ],
    systemDirective: `You are the Private Ledger & Proposal Assistant for micro-businesses in Kredibble.
Your role is to assist with invoice parsing, quotation drafting, contractor terms, and supplier pricing reconciliation.
Be exact with financial figures, commercial terms, and professional business correspondence.`,
  },

  {
    id: "sme_hub",
    name: "SME Contract & Meeting Hub",
    shortName: "Contracts & Meetings",
    audience: "Teams (10–250)",
    tier: "SMEs (10–250 Employees)",
    tierKey: "sme",
    badge: "SME Pro",
    icon: "building",
    tagline: "Contracts, Policies & Minutes",
    description: "Review multi-page supplier contracts, summarize internal policy manuals, and convert meeting recordings into actionable minutes.",
    privacyGuarantee: "In-memory document indexing guarantees legal agreements and HR disputes stay behind your firewall.",
    deliveryMethod: "Hybrid / Self-Hosted Python",
    suggestedPrompts: [
      {
        icon: "fileSearch",
        title: "Multi-file policy & agreement search",
        desc: "Query across company handbooks, supplier SLAs, and NDAs",
        action: "pick-file",
      },
      {
        icon: "shieldCheck",
        title: "GDPR Art. 28 processor review",
        desc: "Automated verification of mandatory data protection clauses",
        prompt: "Evaluate this agreement against GDPR Article 28 data processor requirements. List compliant, missing, and ambiguous clauses.",
      },
      {
        icon: "list",
        title: "Meeting transcript → Action items",
        desc: "Extract owners, deadlines, and key decisions from minutes",
        prompt: "Summarise the following meeting transcript into: 1) Key Decisions Made, 2) Action Items with Owners & Deadlines, 3) Open Questions.",
      },
      {
        icon: "briefcase",
        title: "Vendor SLA & penalty clause audit",
        desc: "Identify service credit thresholds and termination rights",
        prompt: "What are the service level commitments (SLAs), uptime guarantees, and penalty/credit mechanisms defined in this contract?",
      },
    ],
    systemDirective: `You are the SME Contract & Operations Assistant in Kredibble.
Your role is to assist SME management, operations, and legal teams with reviewing supplier contracts, compliance checklists, internal policies, and meeting minutes.
Deliver structured, executive-ready outputs with strict factual grounding and verbatim citations.`,
  },

  {
    id: "enterprise_audit",
    name: "Enterprise Audit & Matter-Wall",
    shortName: "Audit & Deal Room",
    audience: "Enterprise",
    tier: "Corporate Bodies & Large Enterprise",
    tierKey: "enterprise",
    badge: "Enterprise",
    icon: "scale",
    tagline: "M&A, Governance & Risk",
    description: "High-throughput document analysis, SOC 2/ISO 27001 compliance red-flag detection, and automated redaction for sensitive deal rooms.",
    privacyGuarantee: "Matter-wall data isolation. Zero token telemetry leaves your private VPC or dedicated on-prem cluster.",
    deliveryMethod: "Self-Hosted Python (vLLM / VPC)",
    suggestedPrompts: [
      {
        icon: "scale",
        title: "M&A due diligence red-flag audit",
        desc: "Surface change-of-control, non-compete, and uncapped liability",
        action: "pick-file",
      },
      {
        icon: "shieldCheck",
        title: "SOC 2 & ISO 27001 controls check",
        desc: "Cross-reference vendor security documentation against framework controls",
        prompt: "Analyze the attached vendor security exhibit against SOC 2 Type II trust criteria (Security, Availability, Confidentiality). Flag any gaps.",
      },
      {
        icon: "lock",
        title: "Automated redaction & PII scan",
        desc: "Detect and mask NI, SSN, IBAN, and payment identifiers",
        prompt: "Scan this document for confidential identifiers, financial records, and regulatory liabilities.",
      },
      {
        icon: "briefcase",
        title: "Board resolution & minutes summarizer",
        desc: "Synthesize executive deliberations preserving privilege",
        prompt: "Draft an executive summary of these board minutes highlighting approved resolutions, risk registers, and governance votes.",
      },
    ],
    systemDirective: `You are the Enterprise Audit & Matter-Wall Intelligence Assistant in Kredibble.
Your role is to provide rigorous legal, financial, and regulatory analysis for corporate enterprises and deal rooms.
Maintain strict adherence to corporate governance standards, SOC 2/ISO compliance frameworks, exact citation verification, and zero data leakage.`,
  },

  {
    id: "clinical_judicial",
    name: "Clinical & Judicial Scribe",
    shortName: "Clinical & Legal Scribe",
    audience: "Healthcare & legal",
    tier: "Institutions (Healthcare, Legal, Public)",
    tierKey: "institution",
    badge: "Institution",
    icon: "stethoscope",
    tagline: "PHI, SOAP Notes & Court Transcripts",
    description: "Transcribe consultations into clinical SOAP notes and summarize court proceedings with zero-third-party-data-transfer compliance.",
    privacyGuarantee: "Zero cloud API routing. Compliant with HIPAA, NHS Digital Information Governance, and FERPA standards.",
    deliveryMethod: "Dedicated On-Premise Python / WebLLM",
    suggestedPrompts: [
      {
        icon: "stethoscope",
        title: "Clinical consultation → SOAP note",
        desc: "Structure subjective narrative, objective findings, assessment, and plan",
        prompt: "Format the following clinical consultation transcript into a standardized SOAP note (Subjective, Objective, Assessment, Plan) with medication dosages.",
      },
      {
        icon: "scale",
        title: "Judicial transcript / precedent summary",
        desc: "Summarise witness testimony, legal arguments, and rulings",
        action: "pick-file",
      },
      {
        icon: "shieldCheck",
        title: "HIPAA BAA & PHI safeguard review",
        desc: "Audit data handling agreements against HIPAA safeguard rules",
        prompt: "Review this Business Associate Agreement (BAA) against statutory HIPAA administrative, physical, and technical safeguard requirements.",
      },
      {
        icon: "edit",
        title: "Patient discharge instructions",
        desc: "Create easy-to-follow patient guidance without external telemetry",
        prompt: "Convert this clinical summary into clear, compassionate patient discharge instructions, outlining medication schedules and warning signs.",
      },
    ],
    systemDirective: `You are the Clinical & Judicial Scribe Assistant in Kredibble.
Your role is to support healthcare clinicians, researchers, and legal/judicial officers with clinical SOAP documentation, intake summaries, and court transcript analysis.
Strictly protect Protected Health Information (PHI) and judicial privilege. Maintain medical and legal accuracy without substituting for human professional diagnosis or judicial authority.`,
  },

  {
    id: "safeguard_grant",
    name: "Safeguard & Grant Assistant",
    shortName: "Safeguard & Grants",
    audience: "Charities & NGOs",
    tier: "Charities & Non-Governmental Organisations",
    tierKey: "charity",
    badge: "Charity & NGO",
    icon: "heartHandshake",
    tagline: "Vulnerable Notes & Grant Drafting",
    description: "Draft grant applications, synthesize impact reports, and anonymize sensitive case files without compromising donor or beneficiary trust.",
    privacyGuarantee: "Isolated memory sessions safeguard vulnerable individuals and donor contributions with zero cloud tracking.",
    deliveryMethod: "In-browser WebLLM / Self-Hosted",
    suggestedPrompts: [
      {
        icon: "heartHandshake",
        title: "Draft grant proposal narrative",
        desc: "Turn mission objectives and raw project stats into funding copy",
        prompt: "Draft a compelling grant funding proposal section for our community outreach initiative. Include: Statement of Need, Target Beneficiaries, Measurable Outcomes, and Budget Justification.",
      },
      {
        icon: "shieldCheck",
        title: "Safeguarding case note anonymization",
        desc: "Strip identifying details while preserving incident context",
        action: "pick-file",
      },
      {
        icon: "edit",
        title: "Annual impact & donor report",
        desc: "Synthesize program metrics and beneficiary success stories",
        prompt: "Draft an engaging Annual Impact Summary based on our quarterly program results, highlighting volunteer hours, funds deployed, and lives supported.",
      },
      {
        icon: "user",
        title: "Volunteer training & briefing guide",
        desc: "Create clear policy guidance for field volunteers",
        prompt: "Create a concise volunteer briefing checklist for safeguarding protocols, emergency contacts, and confidentiality rules when working with vulnerable youth.",
      },
    ],
    systemDirective: `You are the Safeguard & Grant Assistant for charities and non-profit organizations in Kredibble.
Your role is to assist NGO caseworkers, grant writers, and community leaders with grant proposals, impact reporting, and safeguarding note anonymization.
Prioritize beneficiary dignity, donor confidentiality, clarity, and persuasive philanthropic drafting.`,
  },
];

export const DEFAULT_PERSONA_ID = "personal_vault";

export function getPersona(id) {
  return PERSONAS.find((p) => p.id === id) || PERSONAS[0];
}
