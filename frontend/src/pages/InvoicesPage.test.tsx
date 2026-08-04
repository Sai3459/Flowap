import { describe, expect, it } from 'vitest';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { InvoicesPage } from './InvoicesPage';
import { fakeApi, nestError } from '../test-support/fake-api';
import { renderScreen, signIn } from '../test-support/render';
import { listItem } from '../test-support/fixtures';

/**
 * The invoice list. Filtering and search are client-side over the whole tenant's invoices,
 * which is a known limitation rather than a design — there is no pagination and no server-side
 * query. What is worth pinning is that the filters and the counts beside them agree, and that
 * the two at-a-glance indicators (confidence, PO match) do not overstate how clean a row is.
 */

const rowsOf = () => within(screen.getByRole('table')).getAllByRole('row').slice(1);

describe('filters', () => {
  const invoices = [
    listItem({ id: '1', invoiceNumber: 'A', status: 'NEEDS_REVIEW' }),
    listItem({ id: '2', invoiceNumber: 'B', status: 'EXCEPTION' }),
    listItem({ id: '3', invoiceNumber: 'C', status: 'PENDING_APPROVAL' }),
    listItem({ id: '4', invoiceNumber: 'D', status: 'POSTED' }),
  ];

  it('counts each filter against the whole list, not the visible one', async () => {
    // The count on a filter button has to answer "how many are there", not "how many of the
    // ones I can currently see" — otherwise every count reads 0 as soon as you filter.
    signIn();
    fakeApi({ 'GET /invoices': { body: invoices } });
    renderScreen(<InvoicesPage />);

    await screen.findByRole('table');
    await userEvent.click(screen.getByRole('button', { name: /Needs attention/ }));

    expect(rowsOf()).toHaveLength(2);
    expect(screen.getByRole('button', { name: /^All/ })).toHaveTextContent('4');
    expect(screen.getByRole('button', { name: /Approved \/ posted/ })).toHaveTextContent('1');
  });

  it('treats review and exception together as needing attention', async () => {
    signIn();
    fakeApi({ 'GET /invoices': { body: invoices } });
    renderScreen(<InvoicesPage />);

    await screen.findByRole('table');
    await userEvent.click(screen.getByRole('button', { name: /Needs attention/ }));
    const text = rowsOf().map((r) => r.textContent).join(' ');
    expect(text).toContain('A');
    expect(text).toContain('B');
    expect(text).not.toContain('PENDING APPROVAL');
  });
});

describe('search', () => {
  const invoices = [
    listItem({ id: '1', invoiceNumber: 'INV-100', vendorName: 'Northwind Traders', poNumber: 'PO-5000' }),
    listItem({ id: '2', invoiceNumber: 'INV-200', vendorName: 'Arena Media', poNumber: 'PO-6000' }),
  ];

  it('matches on the invoice number, the vendor and the PO alike', async () => {
    signIn();
    fakeApi({ 'GET /invoices': { body: invoices } });
    renderScreen(<InvoicesPage />);
    const box = await screen.findByPlaceholderText('Search invoice, vendor or PO…');

    for (const [term, expected] of [['arena', 'INV-200'], ['PO-5000', 'INV-100'], ['inv-2', 'INV-200']] as const) {
      await userEvent.clear(box);
      await userEvent.type(box, term);
      expect(rowsOf(), term).toHaveLength(1);
      expect(rowsOf()[0].textContent).toContain(expected);
    }
  });

  it('says nothing matched rather than showing an empty table', async () => {
    signIn();
    fakeApi({ 'GET /invoices': { body: invoices } });
    renderScreen(<InvoicesPage />);

    await userEvent.type(await screen.findByPlaceholderText('Search invoice, vendor or PO…'), 'zzz');
    expect(screen.getByText('No invoices match.')).toBeInTheDocument();
  });
});

describe('the at-a-glance indicators', () => {
  it('DOES NOT CALL A FLAGGED INVOICE CLEAN', async () => {
    signIn();
    fakeApi({
      'GET /invoices': {
        body: [listItem({ lowConfidenceFields: ['poNumber', 'taxAmount'] })],
      },
    });
    renderScreen(<InvoicesPage />);

    expect(await screen.findByText('2 flagged')).toBeInTheDocument();
    expect(screen.queryByText('clean')).not.toBeInTheDocument();
  });

  it('DOES NOT CALL A VARIANCE INVOICE IN TOLERANCE', async () => {
    // A variance invoice deliberately sits at PENDING_APPROVAL — the variance is a decision
    // someone is allowed to approve, not a block — so the list is where it is visible at all.
    signIn();
    fakeApi({
      'GET /invoices': {
        body: [listItem({ status: 'PENDING_APPROVAL', priceVariancePct: 15.2, quantityVariancePct: 0 })],
      },
    });
    renderScreen(<InvoicesPage />);

    expect(await screen.findByText('+15.2%')).toBeInTheDocument();
    expect(screen.queryByText('in tolerance')).not.toBeInTheDocument();
  });

  it('says PO matching does not apply to a non-PO invoice', async () => {
    signIn();
    fakeApi({ 'GET /invoices': { body: [listItem({ poNumber: null })] } });
    renderScreen(<InvoicesPage />);
    expect(await screen.findByText('n/a')).toBeInTheDocument();
  });

  it('reports a failed load rather than an empty list', async () => {
    signIn();
    fakeApi({ 'GET /invoices': nestError(403, 'Forbidden resource') });
    renderScreen(<InvoicesPage />);
    expect(await screen.findByText('Forbidden resource')).toBeInTheDocument();
    expect(screen.queryByText('No invoices match.')).not.toBeInTheDocument();
  });
});
