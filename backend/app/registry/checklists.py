"""Compliance checklists, as data.

Each item is checked independently on-device: the client retrieves passages with the
item's `query`, asks the model whether they address `requirement`, and verifies the
returned quote against the passage. A positive verdict also needs the quote to contain
one of `must_mention` (case-insensitive): in testing, a small model quoted a real but
unrelated clause (the instructions clause as evidence for data-subject rights). Adding a checklist means adding data here, not code.

These checklists help a reviewer find the relevant clauses quickly. They are not legal
advice and do not replace review by qualified counsel.
"""

CHECKLISTS = {
    "gdpr_art28": {
        "title": "GDPR Article 28 – processor contract terms",
        "match": ["gdpr", "data protection", "processor", "article 28", "art. 28", "dpa", "personal data"],
        "items": [
            {"id": "a28_instructions", "must_mention": ["instruction"], "title": "Documented instructions",
             "requirement": "The processor processes personal data only on documented instructions from the controller.",
             "query": "process personal data only on documented instructions of the controller"},
            {"id": "a28_confidentiality", "must_mention": ["confidential"], "title": "Staff confidentiality",
             "requirement": "Persons authorised to process the personal data are committed to confidentiality.",
             "query": "personnel authorised to process personal data confidentiality obligation"},
            {"id": "a28_security", "must_mention": ["security", "technical and organisational", "technical and organizational", "encrypt"], "title": "Security measures (Art. 32)",
             "requirement": "The processor takes appropriate technical and organisational security measures.",
             "query": "appropriate technical and organisational security measures"},
            {"id": "a28_subprocessors", "must_mention": ["sub-processor", "subprocessor", "another processor", "subcontract"], "title": "Sub-processors",
             "requirement": "The processor does not engage another processor without the controller's prior authorisation.",
             "query": "sub-processor subcontract prior written authorisation consent"},
            {"id": "a28_rights", "must_mention": ["data subject", "rights", "request"], "title": "Data subject rights assistance",
             "requirement": "The processor assists the controller in responding to data subject rights requests.",
             "query": "assist controller respond data subject rights requests"},
            {"id": "a28_breach", "must_mention": ["breach"], "title": "Breach notification",
             "requirement": "The processor notifies the controller of personal data breaches without undue delay.",
             "query": "notify personal data breach without undue delay hours"},
            {"id": "a28_deletion", "must_mention": ["delete", "deletion", "return", "destroy", "erase"], "title": "Deletion or return at end",
             "requirement": "At the end of the services the processor deletes or returns all personal data.",
             "query": "delete or return personal data end of services termination"},
            {"id": "a28_audit", "must_mention": ["audit", "inspection", "inspect"], "title": "Audits and information",
             "requirement": "The processor makes information available and allows audits by the controller.",
             "query": "audit inspection rights information to demonstrate compliance records"},
        ],
    },
    "hipaa_baa": {
        "title": "HIPAA business associate agreement – 45 CFR 164.504(e)",
        "match": ["hipaa", "phi", "business associate", "baa", "health information", "covered entity"],
        "items": [
            {"id": "baa_permitted_uses", "must_mention": ["use", "disclos"], "title": "Permitted uses and disclosures",
             "requirement": "The agreement limits the business associate's uses and disclosures of PHI.",
             "query": "permitted uses and disclosures of protected health information"},
            {"id": "baa_safeguards", "must_mention": ["safeguard", "security"], "title": "Safeguards",
             "requirement": "The business associate uses appropriate safeguards to prevent unauthorised use or disclosure.",
             "query": "appropriate safeguards prevent use or disclosure security"},
            {"id": "baa_reporting", "must_mention": ["report", "breach", "notify"], "title": "Reporting of breaches",
             "requirement": "The business associate reports unauthorised uses, disclosures and breaches of unsecured PHI.",
             "query": "report breach unsecured protected health information unauthorised disclosure"},
            {"id": "baa_subcontractors", "must_mention": ["subcontract"], "title": "Subcontractors",
             "requirement": "Subcontractors that handle PHI agree to the same restrictions and conditions.",
             "query": "subcontractors agree same restrictions conditions"},
            {"id": "baa_access", "must_mention": ["access", "amend"], "title": "Individual access and amendment",
             "requirement": "The business associate makes PHI available for access and amendment by individuals.",
             "query": "access amendment individuals protected health information"},
            {"id": "baa_accounting", "must_mention": ["accounting"], "title": "Accounting of disclosures",
             "requirement": "The business associate provides information for an accounting of disclosures.",
             "query": "accounting of disclosures"},
            {"id": "baa_books", "must_mention": ["books", "records", "secretary"], "title": "Books and records to HHS",
             "requirement": "Internal practices, books and records are available to the Secretary of HHS.",
             "query": "books records available Secretary HHS"},
            {"id": "baa_termination", "must_mention": ["return", "destroy", "destruction"], "title": "Return or destruction at termination",
             "requirement": "At termination the business associate returns or destroys all PHI.",
             "query": "termination return or destroy protected health information"},
        ],
    },
}

DEFAULT_CHECKLIST = "gdpr_art28"
