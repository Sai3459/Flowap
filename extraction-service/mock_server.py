"""
Mock extraction server for local end-to-end testing only.
Returns realistic Claude-vision-style output so the confidence-review, duplicate-detection
and PO-matching logic can be exercised without a live ANTHROPIC_API_KEY.

Scenarios are selected by a token in the requested file_url, e.g.
    https://example.com/pricevariance-1.pdf  ->  the "pricevariance" scenario
Anything unrecognised falls back to CLEAN_PO_MATCH.

The PO scenarios assume a purchase order seeded as:
    PO-5000, Northwind Traders, 20 x Consulting hours @ 60.00 USD = 1200.00, received 20
"""
from fastapi import FastAPI
from pydantic import BaseModel
from main import _apply_arithmetic_consistency_checks

app = FastAPI()


class ExtractRequest(BaseModel):
    file_url: str
    file_base64: str | None = None
    media_type: str = "application/pdf"


def field(value, confidence: float) -> dict:
    return {"value": value, "confidence": confidence}


def line(description, quantity, unit_price, line_total, confidence=0.96, tax_code="V1", tax_rate=8.0):
    return {
        "description": description,
        "quantity": quantity,
        "unitPrice": unit_price,
        "lineTotal": line_total,
        "taxCode": tax_code,
        "taxRate": tax_rate,
        "confidence": confidence,
    }


NORTHWIND_BANK = {"iban": "DE89370400440532013000", "accountNumber": None, "bic": "COBADEFFXXX", "bankName": "Commerzbank"}


def invoice(
    *,
    number,
    vendor,
    subtotal,
    tax,
    total,
    lines,
    po=None,
    reference=None,
    invoice_date="2026-07-15",
    due_date="2026-08-14",
    supply_date="2026-07-10",
    vendor_tax_id="DE123456789",
    bank=None,
    currency="USD",
    amount_confidence=0.97,
):
    """Assembles one extraction payload; only the interesting bits vary per scenario."""
    return {
        "documentType": field("INVOICE", 0.99),
        "invoiceNumber": field(number, 0.98),
        "poNumber": field(po, 0.95 if po else 0.0),
        "referenceNumber": field(reference, 0.9 if reference else 0.0),
        "invoiceDate": field(invoice_date, 0.96),
        "dueDate": field(due_date, 0.93),
        "supplyDate": field(supply_date, 0.92 if supply_date else 0.0),
        "currency": field(currency, 0.99),
        "vendorName": field(vendor, 0.97),
        "vendorTaxId": field(vendor_tax_id, 0.94 if vendor_tax_id else 0.0),
        "bankDetails": field(bank, 0.93 if bank else 0.0),
        "subtotal": field(subtotal, amount_confidence),
        "taxAmount": field(tax, amount_confidence),
        "totalAmount": field(total, amount_confidence),
        "lineItems": lines,
    }


def scenarios() -> dict:
    return {
        # Bills PO-5000 exactly as ordered: 20 @ 60.00.
        "cleanpo": invoice(
            number="INV-1001", vendor="Northwind Traders", po="PO-5000", reference="DN-77120",
            subtotal=1200.00, tax=96.00, total=1296.00, bank=NORTHWIND_BANK,
            lines=[line("Consulting hours", 20, 60, 1200.00)],
        ),
        # Same quantity, unit price 69 instead of 60 -> +15% price variance.
        "pricevariance": invoice(
            number="INV-3001", vendor="Northwind Traders", po="PO-5000",
            subtotal=1380.00, tax=110.40, total=1490.40, bank=NORTHWIND_BANK,
            lines=[line("Consulting hours", 20, 69, 1380.00)],
        ),
        # Correct price, bills 26 of 20 ordered -> +30% quantity variance, and more than
        # the 20 recorded as received, so this also trips the 3-way (GRN) check.
        "qtyvariance": invoice(
            number="INV-3002", vendor="Northwind Traders", po="PO-5000",
            subtotal=1560.00, tax=124.80, total=1684.80, bank=NORTHWIND_BANK,
            lines=[line("Consulting hours", 26, 60, 1560.00)],
        ),
        # Small overbill, inside a default 5% price tolerance -> should pass silently.
        "withintolerance": invoice(
            number="INV-3003", vendor="Northwind Traders", po="PO-5000",
            subtotal=1224.00, tax=97.92, total=1321.92, bank=NORTHWIND_BANK,
            lines=[line("Consulting hours", 20, 61.20, 1224.00)],
        ),
        # Cites a PO that does not exist in the system.
        "unknownpo": invoice(
            number="INV-4002", vendor="Northwind Traders", po="PO-DOESNOTEXIST",
            subtotal=1200.00, tax=96.00, total=1296.00, bank=NORTHWIND_BANK,
            lines=[line("Consulting hours", 20, 60, 1200.00)],
        ),
        # Right PO, wrong currency vs the order.
        "currencymismatch": invoice(
            number="INV-4003", vendor="Northwind Traders", po="PO-5000", currency="EUR",
            subtotal=1200.00, tax=96.00, total=1296.00, bank=NORTHWIND_BANK,
            lines=[line("Consulting hours", 20, 60, 1200.00)],
        ),
        # No order referenced at all — the non-PO path.
        "nopo": invoice(
            number="INV-4001", vendor="Office Supplies Co.", po=None, vendor_tax_id="DE987654321",
            subtotal=450.00, tax=36.00, total=486.00,
            lines=[line("Paper reams", 30, 15, 450.00)],
        ),
        # Retained from before: low amount, no PO, drives amount-based approval routing.
        "lowamount": invoice(
            number="INV-2001", vendor="Office Supplies Co.", po=None, vendor_tax_id="DE987654321",
            invoice_date="2026-07-20", due_date="2026-08-19",
            subtotal=450.00, tax=36.00, total=486.00,
            lines=[line("Paper reams", 30, 15, 450.00)],
        ),
        # Retained from before: total contradicts subtotal+tax, so the arithmetic pass
        # downgrades the amount confidences regardless of what the model claimed.
        "inconsistent": invoice(
            number="INV-9001", vendor="Acme Supplies Inc.", po=None, vendor_tax_id="DE555000111",
            invoice_date="2026-07-01", due_date="2026-07-31",
            subtotal=500.00, tax=40.00, total=900.00, amount_confidence=0.95,
            lines=[line("Widget A", 10, 50, 500.00, confidence=0.95)],
        ),
    }


@app.post("/extract")
async def extract(req: ExtractRequest):
    available = scenarios()
    url = req.file_url.lower()
    # Longest token first so "unknownpo" isn't shadowed by "nopo".
    match = next((k for k in sorted(available, key=len, reverse=True) if k in url), "cleanpo")
    return _apply_arithmetic_consistency_checks(available[match])


@app.post("/feedback")
async def feedback(payload: dict):
    return {"status": "recorded"}


@app.get("/health")
async def health():
    return {"status": "ok", "mode": "mock", "scenarios": sorted(scenarios())}
