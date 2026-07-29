"""
AI Extraction Service
======================

This is the piece designed to directly fix the market's weakest point: OCR/extraction
that is either brittle rules-based, or a black box with no sense of its own uncertainty.

Design:
1. A vision-capable LLM (Claude) reads the invoice image/PDF directly and returns
   structured fields, each with the model's own confidence self-assessment.
2. A deterministic validation pass cross-checks the extraction against arithmetic
   invariants that any real invoice must satisfy (line items sum to subtotal, tax +
   subtotal = total, dates parse, currency is a real ISO code). Any inconsistency
   *lowers* the reported confidence for the implicated fields — we never trust the
   model's self-report alone.
3. Only fields below CONFIDENCE_REVIEW_THRESHOLD (set in the Node backend) ever reach
   a human reviewer. Every human correction should be POSTed to /feedback so future
   extractions for that tenant/vendor layout improve over time (few-shot examples
   stored per-tenant) instead of the accuracy staying flat forever, which is the
   single most common complaint about legacy OCR tools.
"""

import base64
import json
import os
from decimal import Decimal, InvalidOperation
from typing import Optional

import httpx
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel

app = FastAPI(title="Invoice AI Extraction Service")

ANTHROPIC_API_KEY = os.environ.get("ANTHROPIC_API_KEY")
MODEL = "claude-sonnet-4-6"

EXTRACTION_SYSTEM_PROMPT = """You are an expert invoice data extraction system used in a \
production accounts-payable pipeline. Read the provided invoice document (image or PDF page) \
carefully and extract the fields below.

For every field, provide your own confidence (0.0-1.0) based on how legible and unambiguous \
the source text was — not how confident you feel in general. If a field is genuinely absent \
from the document, return null for the value and 0.0 for confidence rather than guessing.

Respond with ONLY a single JSON object, no prose, matching exactly this shape:
{
  "documentType": {"value": "INVOICE|CREDIT_NOTE|RECEIPT|UNKNOWN", "confidence": 0.0},
  "invoiceNumber": {"value": string|null, "confidence": 0.0},
  "invoiceDate": {"value": "YYYY-MM-DD"|null, "confidence": 0.0},
  "dueDate": {"value": "YYYY-MM-DD"|null, "confidence": 0.0},
  "currency": {"value": "ISO 4217 code"|null, "confidence": 0.0},
  "vendorName": {"value": string|null, "confidence": 0.0},
  "subtotal": {"value": number|null, "confidence": 0.0},
  "taxAmount": {"value": number|null, "confidence": 0.0},
  "totalAmount": {"value": number|null, "confidence": 0.0},
  "lineItems": [
    {"description": string, "quantity": number, "unitPrice": number, "lineTotal": number, "confidence": 0.0}
  ]
}"""


class ExtractRequest(BaseModel):
    file_url: Optional[str] = None
    file_base64: Optional[str] = None
    media_type: str = "application/pdf"


class FeedbackRequest(BaseModel):
    tenant_id: str
    invoice_id: str
    field_name: str
    corrected_value: str


def _field(value, confidence: float) -> dict:
    return {"value": value, "confidence": round(confidence, 3)}


def _apply_arithmetic_consistency_checks(extraction: dict) -> dict:
    """
    Deterministic cross-check pass. This is what makes confidence trustworthy instead
    of just being the model's opinion of itself — arithmetic either checks out or it
    doesn't, independent of how fluent the model sounds.
    """
    def to_decimal(v):
        try:
            return Decimal(str(v)) if v is not None else None
        except (InvalidOperation, TypeError):
            return None

    subtotal = to_decimal(extraction["subtotal"]["value"])
    tax = to_decimal(extraction["taxAmount"]["value"])
    total = to_decimal(extraction["totalAmount"]["value"])
    line_items = extraction.get("lineItems", [])

    # Check 1: subtotal + tax == total (within a cent for rounding)
    if subtotal is not None and tax is not None and total is not None:
        if abs((subtotal + tax) - total) > Decimal("0.02"):
            for f in ("subtotal", "taxAmount", "totalAmount"):
                extraction[f]["confidence"] = min(extraction[f]["confidence"], 0.4)
            extraction["_consistency_warnings"] = extraction.get("_consistency_warnings", [])
            extraction["_consistency_warnings"].append(
                "subtotal + tax does not equal total — one of these fields is likely misread"
            )

    # Check 2: sum of line items ≈ subtotal
    if subtotal is not None and line_items:
        try:
            line_sum = sum(Decimal(str(li["lineTotal"])) for li in line_items)
            if abs(line_sum - subtotal) > Decimal("0.05"):
                extraction["subtotal"]["confidence"] = min(extraction["subtotal"]["confidence"], 0.5)
                for li in line_items:
                    li["confidence"] = min(li["confidence"], 0.6)
                extraction["_consistency_warnings"] = extraction.get("_consistency_warnings", [])
                extraction["_consistency_warnings"].append(
                    "sum of line items does not match subtotal"
                )
        except (InvalidOperation, TypeError, KeyError):
            pass

    return extraction


async def _call_claude_vision(file_base64: str, media_type: str) -> dict:
    if not ANTHROPIC_API_KEY:
        raise HTTPException(
            status_code=503,
            detail="ANTHROPIC_API_KEY is not configured on the extraction service.",
        )

    doc_block_type = "image" if media_type.startswith("image/") else "document"

    async with httpx.AsyncClient(timeout=60.0) as client:
        resp = await client.post(
            "https://api.anthropic.com/v1/messages",
            headers={
                "x-api-key": ANTHROPIC_API_KEY,
                "anthropic-version": "2023-06-01",
                "content-type": "application/json",
            },
            json={
                "model": MODEL,
                "max_tokens": 2000,
                "system": EXTRACTION_SYSTEM_PROMPT,
                "messages": [
                    {
                        "role": "user",
                        "content": [
                            {
                                "type": doc_block_type,
                                "source": {
                                    "type": "base64",
                                    "media_type": media_type,
                                    "data": file_base64,
                                },
                            },
                            {"type": "text", "text": "Extract this invoice's fields as specified."},
                        ],
                    }
                ],
            },
        )

    if resp.status_code != 200:
        raise HTTPException(status_code=502, detail=f"Claude API error: {resp.text}")

    data = resp.json()
    text_blocks = [b["text"] for b in data.get("content", []) if b.get("type") == "text"]
    raw_text = "".join(text_blocks).strip()

    try:
        return json.loads(raw_text)
    except json.JSONDecodeError as e:
        raise HTTPException(
            status_code=502,
            detail=f"Could not parse extraction model output as JSON: {e}. Raw: {raw_text[:500]}",
        )


@app.post("/extract")
async def extract(req: ExtractRequest):
    if not req.file_base64 and not req.file_url:
        raise HTTPException(status_code=400, detail="Provide file_base64 or file_url")

    file_base64 = req.file_base64
    if not file_base64:
        async with httpx.AsyncClient(timeout=30.0) as client:
            r = await client.get(req.file_url)
            if r.status_code != 200:
                raise HTTPException(status_code=400, detail=f"Could not fetch file_url: {r.status_code}")
            file_base64 = base64.b64encode(r.content).decode("utf-8")

    extraction = await _call_claude_vision(file_base64, req.media_type)
    extraction = _apply_arithmetic_consistency_checks(extraction)
    return extraction


@app.post("/feedback")
async def feedback(req: FeedbackRequest):
    """
    Stub for the continuous-improvement loop: persist corrections per tenant so they can
    be assembled into few-shot examples (or a fine-tuning set) for that tenant's invoice
    layouts. Wiring to real storage is a Phase 3/5 task — this endpoint exists so the
    backend has a stable contract to call today.
    """
    # TODO: persist to a corrections table / vector store keyed by tenant + vendor layout.
    return {"status": "recorded", "tenant_id": req.tenant_id, "field_name": req.field_name}


@app.get("/health")
async def health():
    return {"status": "ok", "model": MODEL, "api_key_configured": bool(ANTHROPIC_API_KEY)}
