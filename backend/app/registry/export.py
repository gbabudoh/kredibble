"""Builds the registry consumed by the web client.

    cd backend && python -m app.registry.export          # write registry.json (both copies)
    cd backend && python -m app.registry.export --check  # fail if the committed copies are stale

The registry is non-sensitive configuration: schemas, checklists, intent metadata and
router weights. It is written to backend/app/registry/registry.json (served at
/api/v1/registry) and frontend/src/registry/registry.json (bundled, so the app works offline).
"""
import hashlib
import json
import sys
from pathlib import Path

from app.registry.checklists import CHECKLISTS, DEFAULT_CHECKLIST
from app.registry.intents import INTENTS, MAX_DOC_OVERLAP_FOR_GENERAL, MIN_CONFIDENCE, MIN_CONFIDENCE_GENERAL
from app.registry.schemas import json_schemas

BACKEND_COPY = Path(__file__).with_name("registry.json")
FRONTEND_COPY = Path(__file__).resolve().parents[3] / "frontend" / "src" / "registry" / "registry.json"
MIN_TEST_ACCURACY = 0.9


def build() -> tuple[dict, dict]:
    from app.registry.router import evaluate, export_router, train  # scikit-learn: dev only

    vectorizer, model = train()
    report = evaluate(vectorizer, model)
    registry = {
        "intents": {
            "descriptions": INTENTS,
            "min_confidence": MIN_CONFIDENCE,
            "min_confidence_general": MIN_CONFIDENCE_GENERAL,
            "max_doc_overlap_for_general": MAX_DOC_OVERLAP_FOR_GENERAL,
            "router": export_router(vectorizer, model),
            "test_accuracy": report["accuracy"],
        },
        "schemas": json_schemas(),
        "checklists": CHECKLISTS,
        "default_checklist": DEFAULT_CHECKLIST,
    }
    body = json.dumps(registry, sort_keys=True, ensure_ascii=False)
    registry["version"] = hashlib.sha256(body.encode()).hexdigest()[:12]
    return registry, report


def serialise(registry: dict) -> str:
    # No sort_keys: constrained decoding emits fields in schema order, so the Pydantic
    # declaration order (category, label, value, source, quote) is part of the design.
    return json.dumps(registry, ensure_ascii=False, separators=(",", ":")) + "\n"


def main(argv: list[str]) -> int:
    registry, report = build()
    print(f"router test accuracy: {report['accuracy']:.1%} on {report['n']} held-out examples")
    for err in report["errors"]:
        print(f"  miss: {err['text']!r} expected {err['expected']}, got {err['got']}")
    if report["accuracy"] < MIN_TEST_ACCURACY:
        print(f"FAIL: accuracy below {MIN_TEST_ACCURACY:.0%}; add training examples.")
        return 1

    text = serialise(registry)
    if "--check" in argv:
        stale = [p for p in (BACKEND_COPY, FRONTEND_COPY) if not p.exists() or p.read_text(encoding="utf-8") != text]
        for p in stale:
            print(f"STALE: {p} (run: python -m app.registry.export)")
        return 1 if stale else 0

    for path in (BACKEND_COPY, FRONTEND_COPY):
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text, encoding="utf-8")
        print(f"wrote {path} ({len(text) / 1024:.0f} KB, version {registry['version']})")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
