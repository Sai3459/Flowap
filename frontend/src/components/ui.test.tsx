import { describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { ApprovalMeter, ConfidenceEq, Money, StatusPill, StepPill, shortDate } from './ui';

/**
 * The small shared components. Two of them carry more weight than their size suggests:
 * `Money` renders every amount in the product, and `ConfidenceEq` is the visual form of the
 * per-field confidence design — the thing that decides whether a reviewer looks at a field.
 */

describe('Money', () => {
  const show = (amount: string | null, currency?: string | null) => {
    cleanup();
    render(<Money amount={amount} currency={currency} />);
    return document.body.textContent;
  };

  it('ALWAYS SHOWS TWO DECIMAL PLACES', () => {
    // The backend stores numeric(18,2) and hands amounts over as strings. Dropping a trailing
    // zero turns 1296.10 into "1,296.1", which reads as a different number at a glance and
    // does not match what the document says.
    expect(show('1296.10')).toBe('1,296.10');
    expect(show('1200')).toBe('1,200.00');
    expect(show('0.50')).toBe('0.50');
  });

  it('does not round cents away', () => {
    expect(show('1296.99')).toBe('1,296.99');
    expect(show('0.01')).toBe('0.01');
  });

  it('names the currency, because an amount without one is not an amount', () => {
    // A €10,000 approval limit is not a $10,000 approval limit, and the same is true of the
    // invoice it is being compared against.
    expect(show('1296.00', 'EUR')).toBe('1,296.00 EUR');
    expect(show('1296.00', 'USD')).toBe('1,296.00 USD');
  });

  it('shows a missing amount as missing rather than as zero', () => {
    // Zero sails under every approval ceiling. An unknown amount must never look like one.
    expect(show(null)).toBe('—');
  });

  it('passes through anything it cannot parse instead of rendering NaN', () => {
    expect(show('not-a-number')).toBe('not-a-number');
  });
});

describe('ConfidenceEq', () => {
  const segments = () => [...document.querySelectorAll('.eq i')];
  const lit = () => segments().filter((s) => s.classList.contains('on')).length;

  it('bands a field below the threshold away from one above it', () => {
    render(<ConfidenceEq confidence={0.75} />);
    expect(document.querySelector('.eq')).toHaveClass('b-review');

    cleanup();
    render(<ConfidenceEq confidence={0.95} />);
    expect(document.querySelector('.eq')).toHaveClass('b-clear');
  });

  it('treats exactly the threshold as clear, matching the backend comparison', () => {
    render(<ConfidenceEq confidence={0.9} />);
    expect(document.querySelector('.eq')).toHaveClass('b-clear');
  });

  it('marks a very low score as blocked rather than merely amber', () => {
    render(<ConfidenceEq confidence={0.4} />);
    expect(document.querySelector('.eq')).toHaveClass('b-blocked');
  });

  it('shows a corrected field as corrected whatever the score says', () => {
    render(<ConfidenceEq confidence={0.2} corrected />);
    expect(document.querySelector('.eq')).toHaveClass('b-corrected');
  });

  it('never shows an empty bar for a real score', () => {
    // A 2%-confident field with nothing lit is indistinguishable from a field that was not
    // extracted at all, and those need different responses from a reviewer.
    render(<ConfidenceEq confidence={0.02} />);
    expect(lit()).toBe(1);
  });

  it('reads the score out for a screen reader', () => {
    render(<ConfidenceEq confidence={0.75} />);
    expect(screen.getByLabelText('confidence 75%')).toBeInTheDocument();
    cleanup();
    render(<ConfidenceEq confidence={null} />);
    expect(screen.getByLabelText('not extracted')).toBeInTheDocument();
  });
});

describe('ApprovalMeter', () => {
  it('shows how many approvals are given and how many remain', () => {
    render(<ApprovalMeter given={1} remaining={2} />);
    expect(screen.getByLabelText('1 of 3 approvals given')).toBeInTheDocument();
    expect(document.querySelectorAll('.meter i')).toHaveLength(3);
    expect(document.querySelectorAll('.meter i.done')).toHaveLength(1);
    expect(document.querySelectorAll('.meter i.now')).toHaveLength(1);
  });

  it('marks nothing as current once the chain is complete', () => {
    render(<ApprovalMeter given={2} remaining={0} />);
    expect(document.querySelectorAll('.meter i.now')).toHaveLength(0);
    expect(document.querySelectorAll('.meter i.done')).toHaveLength(2);
  });
});

describe('status pills', () => {
  it('separates the four signals: clear, review, blocked and in-flight', () => {
    const tone = (status: Parameters<typeof StatusPill>[0]['status']) => {
      cleanup();
      render(<StatusPill status={status} />);
      return document.querySelector('.pill')!.className;
    };
    expect(tone('APPROVED')).toContain('p-clear');
    expect(tone('NEEDS_REVIEW')).toContain('p-review');
    expect(tone('EXCEPTION')).toContain('p-blocked');
    expect(tone('REJECTED')).toContain('p-blocked');
    expect(tone('PENDING_APPROVAL')).toContain('p-flight');
    expect(tone('POSTED')).toContain('p-posted');
  });

  it('does not colour a delegated step as decided', () => {
    // DELEGATED and SKIPPED are excluded from node-outcome evaluation on the server; showing
    // either in the "approved" colour would misreport where an invoice stands.
    render(<StepPill status="DELEGATED" />);
    expect(document.querySelector('.pill')!.className).toContain('p-review');
  });
});

describe('shortDate', () => {
  it('renders a timestamp as a plain date', () => {
    expect(shortDate('2026-05-04T09:00:00.000Z')).toBe('2026-05-04');
  });

  it('leaves an unparseable value alone rather than showing Invalid Date', () => {
    expect(shortDate('not a date')).toBe('not a date');
    expect(shortDate(null)).toBe('—');
  });
});
