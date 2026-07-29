"""
Mock extraction server for local end-to-end testing only.
Returns realistic Claude-vision-style output (including one deliberately inconsistent
invoice) so we can verify the confidence-review and duplicate-detection logic without
needing a live ANTHROPIC_API_KEY in this sandbox.
"""
from fastapi import FastAPI
from pydantic import BaseModel
from main import _apply_arithmetic_consistency_checks

app = FastAPI()


class ExtractRequest(BaseModel):
    file_url: str
    file_base64: str | None = None
    media_type: str = "application/pdf"


@app.post("/extract")
async def extract(req: ExtractRequest):
    if "inconsistent" in req.file_url:
        raw = {
            "documentType": {"value": "INVOICE", "confidence": 0.99},
            "invoiceNumber": {"value": "INV-9001", "confidence": 0.96},
            "invoiceDate": {"value": "2026-07-01", "confidence": 0.94},
            "dueDate": {"value": "2026-07-31", "confidence": 0.9},
            "currency": {"value": "USD", "confidence": 0.98},
            "vendorName": {"value": "Acme Supplies Inc.", "confidence": 0.97},
            "subtotal": {"value": 500.00, "confidence": 0.95},
            "taxAmount": {"value": 40.00, "confidence": 0.95},
            "totalAmount": {"value": 900.00, "confidence": 0.95},  # inconsistent on purpose
            "lineItems": [
                {"description": "Widget A", "quantity": 10, "unitPrice": 50, "lineTotal": 500.00, "confidence": 0.95}
            ],
        }
    else:
        raw = {
            "documentType": {"value": "INVOICE", "confidence": 0.99},
            "invoiceNumber": {"value": "INV-1001", "confidence": 0.98},
            "invoiceDate": {"value": "2026-07-15", "confidence": 0.96},
            "dueDate": {"value": "2026-08-14", "confidence": 0.93},
            "currency": {"value": "USD", "confidence": 0.99},
            "vendorName": {"value": "Northwind Traders", "confidence": 0.97},
            "subtotal": {"value": 1200.00, "confidence": 0.97},
            "taxAmount": {"value": 96.00, "confidence": 0.97},
            "totalAmount": {"value": 1296.00, "confidence": 0.97},
            "lineItems": [
                {"description": "Consulting hours", "quantity": 20, "unitPrice": 60, "lineTotal": 1200.00, "confidence": 0.96}
            ],
        }
    return _apply_arithmetic_consistency_checks(raw)


@app.post("/feedback")
async def feedback(payload: dict):
    return {"status": "recorded"}


@app.get("/health")
async def health():
    return {"status": "ok", "mode": "mock"}
