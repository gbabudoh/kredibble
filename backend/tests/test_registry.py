from fastapi.testclient import TestClient

from app.main import app
from app.registry import export
from app.registry.checklists import CHECKLISTS, DEFAULT_CHECKLIST
from app.registry.intents import INTENTS, MIN_CONFIDENCE_GENERAL, TEST, TRAIN
from app.registry.router import evaluate, train
from app.registry.schemas import SCHEMAS, ComplianceFinding, ExtractionResult, json_schemas


def test_committed_registry_is_up_to_date():
    """Fails when schemas, checklists or training data changed without re-exporting."""
    assert export.main(["--check"]) == 0


def test_router_meets_accuracy_bar():
    vectorizer, model = train()
    report = evaluate(vectorizer, model)
    assert report["accuracy"] >= export.MIN_TEST_ACCURACY, report["errors"]


def test_router_never_confidently_sends_document_questions_to_general():
    """Safety property: 'general' skips the document, so no held-out document question may reach the bar."""
    vectorizer, model = train()
    general = list(model.classes_).index("general")
    doc_questions = [q for intent, qs in TEST.items() if intent != "general" for q in qs]
    probs = model.predict_proba(vectorizer.transform(doc_questions))
    leaks = [(q, round(p[general], 2)) for q, p in zip(doc_questions, probs) if p[general] >= MIN_CONFIDENCE_GENERAL]
    assert leaks == []


def test_training_data_covers_every_intent_without_overlap():
    assert set(TRAIN) == set(TEST) == set(INTENTS)
    train_texts = {t.lower() for ts in TRAIN.values() for t in ts}
    assert not train_texts & {t.lower() for ts in TEST.values() for t in ts}


def test_schema_field_order_puts_evidence_before_verdict():
    schemas = json_schemas()
    assert list(schemas["compliance_finding"]["properties"]) == ["quote", "source", "status", "note"]
    item = schemas["extraction"]["properties"]["items"]["items"]
    assert list(item["properties"]) == ["category", "label", "value", "source", "quote"]
    assert "$defs" not in str(schemas) and "$ref" not in str(schemas)


def test_schemas_validate_expected_model_output():
    ExtractionResult.model_validate({"items": [
        {"category": "amount", "label": "Liability cap", "value": "£2,500,000", "source": "S1", "quote": "shall not exceed £2,500,000"},
    ]})
    ComplianceFinding.model_validate({"quote": "within twenty-four (24) hours", "source": "S2", "status": "addressed", "note": "Breach notice is required."})
    assert set(SCHEMAS) == {"extraction", "compliance_finding"}


def test_checklists_are_well_formed():
    assert DEFAULT_CHECKLIST in CHECKLISTS
    for key, checklist in CHECKLISTS.items():
        ids = [item["id"] for item in checklist["items"]]
        assert len(ids) == len(set(ids)), key
        for item in checklist["items"]:
            assert item["title"] and item["requirement"] and item["query"], item
            assert item["must_mention"] and all(t == t.lower() for t in item["must_mention"]), item


def test_registry_endpoint_serves_committed_copy():
    response = TestClient(app).get("/api/v1/registry")
    assert response.status_code == 200
    data = response.json()
    assert data["version"] == export.build()[0]["version"]
    assert {"intents", "schemas", "checklists"} <= set(data)
