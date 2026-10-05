"""Structured-output schemas for on-device generation.

These Pydantic models are the single source of truth. `python -m app.registry.export`
turns them into JSON Schema, which the web client passes to WebLLM's constrained decoder
(`response_format: {type: "json_object", schema}`) so the model can only produce valid JSON.

Keep them small and flat: 1.5B–3B models follow short schemas far more reliably, and
every field must be something the client can check against the source text.
"""
from enum import Enum
from typing import List

from pydantic import BaseModel, Field


class ExtractionCategory(str, Enum):
    party = "party"
    date = "date"
    amount = "amount"
    duration = "duration"
    obligation = "obligation"
    other = "other"


class ExtractedItem(BaseModel):
    category: ExtractionCategory
    label: str = Field(description="What this item is, e.g. 'Liability cap' or 'Payment deadline'.")
    value: str = Field(description="The value exactly as written, e.g. '£2,500,000' or 'forty-five (45) days'.")
    source: str = Field(description="Label of the source it came from, e.g. 'S2'.")
    quote: str = Field(description="Short verbatim quote from that source containing the value.")


class ExtractionResult(BaseModel):
    items: List[ExtractedItem]


class ComplianceStatus(str, Enum):
    addressed = "addressed"
    partial = "partial"
    not_found = "not_found"


class ComplianceFinding(BaseModel):
    # Field order is generation order: the quote first, then the verdict, so the model
    # commits to evidence before it can claim the requirement is addressed. The client
    # re-derives `source` from whichever passage actually contains the quote: in testing,
    # a 1.5B model copied quotes accurately but labelled their source unreliably.
    quote: str = Field(description="Short verbatim quote from the sources, or '' if none addresses the requirement.")
    source: str = Field(description="Label of the source the quote came from, or 'none'.")
    status: ComplianceStatus
    note: str = Field(description="One short sentence explaining the status.")


SCHEMAS = {
    "extraction": ExtractionResult,
    "compliance_finding": ComplianceFinding,
}


def _inline_refs(schema: dict) -> dict:
    """Replaces $ref/$defs with inline definitions; simpler for grammar compilers."""
    defs = schema.pop("$defs", {})

    def resolve(node):
        if isinstance(node, dict):
            if "$ref" in node:
                return resolve(defs[node["$ref"].split("/")[-1]])
            # Pydantic's auto-generated "title" strings only cost prompt tokens; drop them.
            return {k: resolve(v) for k, v in node.items() if not (k == "title" and isinstance(v, str))}
        if isinstance(node, list):
            return [resolve(v) for v in node]
        return node

    return resolve(schema)


def json_schemas() -> dict:
    return {name: _inline_refs(model.model_json_schema()) for name, model in SCHEMAS.items()}
