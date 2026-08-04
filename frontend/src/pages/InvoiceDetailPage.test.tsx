import { describe, expect, it } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Route, Routes } from 'react-router-dom';
import { InvoiceDetailPage } from './InvoiceDetailPage';
import { fakeApi, nestError } from '../test-support/fake-api';
import { renderScreen, signIn } from '../test-support/render';
import { approvalProgress, invoiceDetail, lineItem, step } from '../test-support/fixtures';

/**
 * The invoice detail screen, and the correction → re-validation path.
 *
 * A correction here is not a text edit. Correcting a field a check reads — the PO number, the
 * currency, the subtotal — **recalls the running approval instance and discards every approval
 * already cast**, then re-runs matching from scratch. So the screen has to show the state that
 * exists *after* that happened. A stale approval chain left on screen is the specific failure:
 * it shows approvals that have been thrown away as though they still stand.
 */

const routes = (detail = invoiceDetail(), progress = approvalProgress()) => ({
  'GET /invoices/inv-1': { body: detail },
  'GET /approvals/inv-1/progress': { body: progress },
});

const renderDetail = () =>
  renderScreen(
    <Routes>
      <Route path="/invoices/:id" element={<InvoiceDetailPage />} />
    </Routes>,
    { route: '/invoices/inv-1' },
  );

const editRow = async (label: string) => {
  const row = (await screen.findByText(label)).closest('.field')!;
  await userEvent.click(within(row as HTMLElement).getByRole('button', { name: 'Edit' }));
  return row as HTMLElement;
};

describe('correcting a field', () => {
  it('SENDS THE FIELD NAME AND THE TYPED VALUE', async () => {
    signIn();
    const fake = fakeApi({ ...routes(), 'PATCH /invoices/*/correct-field': { body: invoiceDetail() } });
    renderDetail();

    const row = await editRow('PO number');
    await userEvent.clear(within(row).getByRole('textbox'));
    await userEvent.type(within(row).getByRole('textbox'), 'PO-5000');
    await userEvent.click(within(row).getByRole('button', { name: 'Save' }));

    expect(fake.only('PATCH /invoices/inv-1/correct-field').body).toEqual({
      fieldName: 'poNumber',
      correctedValue: 'PO-5000',
    });
  });

  it('REFETCHES THE APPROVAL CHAIN, NOT JUST THE INVOICE', async () => {
    // This is the load-bearing one. Correcting `poNumber` recalls the in-flight approval and
    // starts a fresh instance, so every step shown a moment ago is now history. Refetching the
    // invoice alone would leave the old chain on screen — an operator reading "approved by the
    // controller" for approvals that were discarded when they pressed Save.
    signIn();
    const fake = fakeApi({ ...routes(), 'PATCH /invoices/*/correct-field': { body: invoiceDetail() } });
    renderDetail();

    const row = await editRow('PO number');
    await userEvent.type(within(row).getByRole('textbox'), 'PO-6000');
    await userEvent.click(within(row).getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(fake.matching('GET /invoices/inv-1').length).toBeGreaterThan(1));
    expect(fake.matching('GET /approvals/inv-1/progress').length).toBeGreaterThan(1);
  });

  it('shows the discarded and the fresh approvals as the server reports them', async () => {
    // The end-to-end consequence of the refetch above, asserted on what a person sees.
    signIn();
    const fake = fakeApi({
      ...routes(
        invoiceDetail({ status: 'PENDING_APPROVAL' }),
        approvalProgress({
          approvalsGiven: 1,
          approvalsRemaining: 0,
          steps: [step({ id: 's1', nodeId: 'controller', status: 'APPROVED' })],
        }),
      ),
      'PATCH /invoices/*/correct-field': { body: invoiceDetail({ status: 'PENDING_APPROVAL' }) },
    });
    renderDetail();
    expect(await screen.findByText('controller')).toBeInTheDocument();
    expect(await screen.findByText('1 given · 0 still needed')).toBeInTheDocument();

    // The recall: the old instance is superseded and a fresh one starts at node one.
    fake.set('GET /approvals/inv-1/progress', {
      body: approvalProgress({
        approvalsGiven: 0,
        approvalsRemaining: 1,
        steps: [step({ id: 's2', nodeId: 'ap-manager', status: 'PENDING' })],
      }),
    });

    const row = await editRow('PO number');
    await userEvent.type(within(row).getByRole('textbox'), 'PO-6000');
    await userEvent.click(within(row).getByRole('button', { name: 'Save' }));

    expect(await screen.findByText('0 given · 1 still needed')).toBeInTheDocument();
    expect(screen.getByText('ap-manager')).toBeInTheDocument();
    expect(screen.queryByText('controller')).not.toBeInTheDocument();
  });

  it('KEEPS THE EDIT OPEN AND EXPLAINS WHY WHEN THE CORRECTION IS REFUSED', async () => {
    // A clerk may not correct a check-feeding field while an approval is running, because the
    // correction would silently undo a controller's decision. The refusal has to be legible —
    // and the typed value must survive it, or the person retypes it and hits the same wall.
    signIn();
    fakeApi({
      ...routes(),
      'PATCH /invoices/*/correct-field': nestError(
        403,
        'An approval is already running on this invoice. Correcting subtotal would withdraw it and discard the approvals already given; ask an AP manager or controller.',
      ),
    });
    renderDetail();

    const row = await editRow('PO number');
    await userEvent.clear(within(row).getByRole('textbox'));
    await userEvent.type(within(row).getByRole('textbox'), 'PO-9999');
    await userEvent.click(within(row).getByRole('button', { name: 'Save' }));

    expect(await within(row).findByText(/discard the approvals already given/)).toBeInTheDocument();
    expect(within(row).getByRole('textbox')).toHaveValue('PO-9999');
  });

  it('explains a posted invoice differently from a role refusal', async () => {
    // Different situations with different remedies: this one needs a credit note or an
    // ERP-side reversal, which this tool cannot request.
    signIn();
    fakeApi({
      ...routes(invoiceDetail({ status: 'POSTED', erpDocumentNumber: '5106040049' })),
      'PATCH /invoices/*/correct-field': nestError(
        409,
        'This invoice has been posted to the ERP. Correct it with a credit note or an ERP-side reversal.',
      ),
    });
    renderDetail();

    const row = await editRow('PO number');
    await userEvent.type(within(row).getByRole('textbox'), 'PO-1');
    await userEvent.click(within(row).getByRole('button', { name: 'Save' }));
    expect(await within(row).findByText(/credit note or an ERP-side reversal/)).toBeInTheDocument();
  });

  it('abandons an edit on Cancel without sending anything', async () => {
    signIn();
    const fake = fakeApi({ ...routes(), 'PATCH /invoices/*/correct-field': { body: invoiceDetail() } });
    renderDetail();

    const row = await editRow('PO number');
    await userEvent.type(within(row).getByRole('textbox'), 'typo');
    await userEvent.click(within(row).getByRole('button', { name: 'Cancel' }));

    expect(fake.matching('PATCH /invoices/*/correct-field')).toHaveLength(0);
    expect(within(row).queryByRole('textbox')).not.toBeInTheDocument();
  });
});

describe('which fields can be corrected', () => {
  it('OFFERS NO EDIT ON THE VENDOR NAME', async () => {
    // It carries a confidence score like every other field, so the absence is deliberate:
    // correcting a vendor means re-linking a Vendor row, and vendor identity is what
    // duplicate detection keys on. Writing it as a column would point the check at nothing.
    signIn();
    fakeApi(routes(invoiceDetail({
      fieldConfidence: { vendorName: { confidence: 0.6, source: 'AI_EXTRACTED' } },
    })));
    renderDetail();

    const row = (await screen.findByText('Vendor')).closest('.field')!;
    expect(within(row as HTMLElement).queryByRole('button', { name: 'Edit' })).not.toBeInTheDocument();
    expect(within(row as HTMLElement).getByText('60%')).toBeInTheDocument();
  });

  it('renders a date field as a date input and money as a decimal one', async () => {
    // A European reviewer typing 04/05/2026 into a text box is exactly the ambiguity the
    // backend's day-first parser exists to contain; a date picker removes the question.
    signIn();
    fakeApi(routes());
    renderDetail();

    const dateRow = await editRow('Invoice date');
    expect(dateRow.querySelector('input')).toHaveAttribute('type', 'date');

    const moneyRow = await editRow('Total (gross)');
    expect(moneyRow.querySelector('input')).toHaveAttribute('inputmode', 'decimal');
  });
});

describe('re-validation on demand', () => {
  it('is reachable from the screen', async () => {
    // The only route out for an invoice held by a low-confidence *line item*, since line items
    // are not correctable. Before this button existed the endpoint was API-only.
    signIn();
    const fake = fakeApi({
      ...routes(),
      'POST /invoices/*/revalidate': { body: { revalidated: true, reason: 'ok', invoice: invoiceDetail() } },
    });
    renderDetail();

    await userEvent.click(await screen.findByRole('button', { name: 'Re-validate' }));

    expect(fake.only('POST /invoices/inv-1/revalidate').body).toBeUndefined();
    expect(await screen.findByText(/matching and duplicate checks ran again/)).toBeInTheDocument();
    await waitFor(() => expect(fake.matching('GET /approvals/inv-1/progress').length).toBeGreaterThan(1));
  });

  it('says why when the server declines to re-validate', async () => {
    signIn();
    fakeApi({
      ...routes(),
      'POST /invoices/*/revalidate': {
        body: { revalidated: false, reason: 'invoice is POSTED', invoice: invoiceDetail() },
      },
    });
    renderDetail();

    await userEvent.click(await screen.findByRole('button', { name: 'Re-validate' }));
    expect(await screen.findByText('Not re-validated: invoice is POSTED')).toBeInTheDocument();
  });

  it('surfaces a refusal rather than reporting success', async () => {
    signIn();
    fakeApi({ ...routes(), 'POST /invoices/*/revalidate': nestError(403, 'Forbidden resource') });
    renderDetail();

    await userEvent.click(await screen.findByRole('button', { name: 'Re-validate' }));
    expect(await screen.findByText('Forbidden resource')).toBeInTheDocument();
    expect(screen.queryByText(/ran again/)).not.toBeInTheDocument();
  });
});

describe('what the screen says about the document', () => {
  it('counts the fields below the confidence threshold', async () => {
    // The per-field design's whole claim: a 98%-confident header with one shaky field surfaces
    // that one field, not the whole document.
    signIn();
    fakeApi(routes(invoiceDetail({
      fieldConfidence: {
        invoiceNumber: { confidence: 0.98, source: 'AI_EXTRACTED' },
        poNumber: { confidence: 0.75, source: 'AI_EXTRACTED' },
        totalAmount: { confidence: 0.99, source: 'AI_EXTRACTED' },
      },
    })));
    renderDetail();
    expect(await screen.findByText('1 field(s) need review')).toBeInTheDocument();
  });

  it('does not count a field a human already corrected', async () => {
    signIn();
    fakeApi(routes(invoiceDetail({
      fieldConfidence: { poNumber: { confidence: 0.2, source: 'HUMAN_CORRECTED' } },
    })));
    renderDetail();
    expect(await screen.findByText('all fields above threshold')).toBeInTheDocument();
  });

  it('shows an exception with its suggested fix', async () => {
    signIn();
    fakeApi(routes(invoiceDetail({
      status: 'EXCEPTION',
      exceptions: [{
        id: 'e1',
        invoiceId: 'inv-1',
        type: 'MISSING_PO',
        detail: 'No purchase order PO-9999 exists for this tenant.',
        suggestedFix: 'Check the PO number on the document, or sync the order from the ERP.',
        resolvedAt: null,
        createdAt: '2026-05-04T09:00:00.000Z',
      }],
    })));
    renderDetail();

    expect(await screen.findByText('MISSING PO')).toBeInTheDocument();
    expect(screen.getByText(/sync the order from the ERP/)).toBeInTheDocument();
  });

  it('marks an uncoded line as uncoded', async () => {
    signIn();
    fakeApi(routes(invoiceDetail({
      lineItems: [lineItem({ glAccountId: null, costCenterId: null })],
    })));
    renderDetail();
    expect(await screen.findByText('uncoded')).toBeInTheDocument();
  });

  it('reports a failed load rather than rendering an empty invoice', async () => {
    signIn();
    fakeApi({ ...routes(), 'GET /invoices/inv-1': nestError(404, 'Invoice not found') });
    renderDetail();
    expect(await screen.findByText('Invoice not found')).toBeInTheDocument();
  });
});
