"""
Tests for the deterministic arithmetic pass.

This is the check that makes confidence mean something instead of being the model's opinion
of itself, and it is the extraction service's single most important piece of logic. CLAUDE.md
claimed it was unit-tested; it was not — it had been verified interactively in an earlier
session and never committed as a test, so nothing would have caught a regression in it.

Run:  .venv/bin/python -m pytest test_consistency.py -q
"""
import copy
import json

import pytest

from main import _apply_arithmetic_consistency_checks


def field(value, confidence=0.95):
    return {"value": value, "confidence": confidence}


def line(line_total, confidence=0.96):
    return {
        "description": "Widget",
        "quantity": 1,
        "unitPrice": line_total,
        "lineTotal": line_total,
        "taxCode": "V1",
        "taxRate": 8.0,
        "confidence": confidence,
    }


def extraction(subtotal, tax, total, lines=None, confidence=0.95):
    return {
        "subtotal": field(subtotal, confidence),
        "taxAmount": field(tax, confidence),
        "totalAmount": field(total, confidence),
        "lineItems": lines if lines is not None else [line(subtotal)],
    }


def test_consistent_invoice_keeps_its_confidence():
    result = _apply_arithmetic_consistency_checks(extraction(500.00, 40.00, 540.00))

    assert result["subtotal"]["confidence"] == 0.95
    assert result["totalAmount"]["confidence"] == 0.95
    assert "_consistency_warnings" not in result


def test_total_that_does_not_add_up_is_downgraded():
    # The case from the `inconsistent` fixture: 500 + 40 != 900.
    result = _apply_arithmetic_consistency_checks(extraction(500.00, 40.00, 900.00, lines=[line(500.00)]))

    assert result["subtotal"]["confidence"] == 0.4
    assert result["taxAmount"]["confidence"] == 0.4
    assert result["totalAmount"]["confidence"] == 0.4
    assert any("does not equal total" in w for w in result["_consistency_warnings"])


def test_downgrade_never_raises_an_already_low_confidence():
    result = _apply_arithmetic_consistency_checks(
        extraction(500.00, 40.00, 900.00, lines=[line(500.00)], confidence=0.2)
    )

    # min(), not assignment — a field the model was already unsure about must not be
    # "corrected" upwards to 0.4 by a failing check.
    assert result["subtotal"]["confidence"] == 0.2


def test_one_cent_rounding_is_tolerated():
    result = _apply_arithmetic_consistency_checks(extraction(100.00, 8.00, 108.01))

    assert result["totalAmount"]["confidence"] == 0.95
    assert "_consistency_warnings" not in result


def test_three_cent_discrepancy_is_not_tolerated():
    result = _apply_arithmetic_consistency_checks(extraction(100.00, 8.00, 108.03, lines=[line(100.00)]))

    assert result["totalAmount"]["confidence"] == 0.4


def test_line_items_that_do_not_sum_to_subtotal_downgrade_subtotal_and_lines():
    result = _apply_arithmetic_consistency_checks(
        extraction(500.00, 40.00, 540.00, lines=[line(200.00), line(150.00)])
    )

    assert result["subtotal"]["confidence"] == 0.5
    assert all(li["confidence"] == 0.6 for li in result["lineItems"])
    assert any("line items" in w for w in result["_consistency_warnings"])


def test_both_checks_can_fire_and_the_lower_downgrade_wins_on_subtotal():
    result = _apply_arithmetic_consistency_checks(
        extraction(500.00, 40.00, 900.00, lines=[line(200.00)])
    )

    # Check 1 sets 0.4, check 2 would set 0.5; min() must keep 0.4.
    assert result["subtotal"]["confidence"] == 0.4
    assert len(result["_consistency_warnings"]) == 2


@pytest.mark.parametrize("bad", [None, "n/a", "", "1,200.00 USD"])
def test_unparseable_amounts_do_not_raise(bad):
    # A field the model could not read must leave the pass inert rather than crashing
    # ingestion — the confidence gate is what catches it downstream.
    payload = extraction(500.00, 40.00, 540.00)
    payload["totalAmount"] = field(bad)

    result = _apply_arithmetic_consistency_checks(copy.deepcopy(payload))

    assert result["totalAmount"]["value"] == bad


def test_missing_line_items_key_is_tolerated():
    payload = extraction(500.00, 40.00, 540.00)
    del payload["lineItems"]

    result = _apply_arithmetic_consistency_checks(payload)

    assert result["subtotal"]["confidence"] == 0.95


def test_line_item_missing_line_total_does_not_raise():
    payload = extraction(500.00, 40.00, 540.00, lines=[{"description": "x", "confidence": 0.9}])

    result = _apply_arithmetic_consistency_checks(payload)

    # The KeyError is swallowed, so the line-item check simply does not run.
    assert result["subtotal"]["confidence"] == 0.95


# ---------------------------------------------------------------------------
# Code-fence stripping.
#
# Regression tests for a bug that only a real model call could reveal: the service
# returned 502 on every genuine document because the reply arrived fenced.
# ---------------------------------------------------------------------------
from main import strip_code_fence


def test_unfenced_json_passes_through():
    assert json.loads(strip_code_fence('{"a": 1}')) == {"a": 1}


def test_strips_a_json_fence():
    # The exact shape that broke the first real extraction.
    fenced = '```json\n{\n  "invoiceNumber": {"value": "2026001293", "confidence": 0.99}\n}\n```'
    assert json.loads(strip_code_fence(fenced))["invoiceNumber"]["value"] == "2026001293"


def test_strips_a_bare_fence():
    assert json.loads(strip_code_fence('```\n{"a": 1}\n```')) == {"a": 1}


def test_survives_prose_around_the_block():
    fenced = '```json\nHere is the extraction:\n{"a": 1}\nLet me know if you need more.\n```'
    assert json.loads(strip_code_fence(fenced)) == {"a": 1}


def test_does_not_repair_malformed_json():
    # A genuinely broken reply must still fail loudly. Silently "fixing" extraction output
    # would put invented values into an accounting pipeline.
    with pytest.raises(json.JSONDecodeError):
        json.loads(strip_code_fence('```json\n{"a": }\n```'))


def test_handles_nested_braces_and_trailing_newlines():
    fenced = '```json\n{"outer": {"inner": [1, 2]}}\n\n```\n'
    assert json.loads(strip_code_fence(fenced)) == {"outer": {"inner": [1, 2]}}
