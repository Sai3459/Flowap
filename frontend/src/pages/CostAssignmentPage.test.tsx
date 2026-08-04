import { describe, expect, it } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CostAssignmentPage } from './CostAssignmentPage';
import { fakeApi, nestError } from '../test-support/fake-api';
import { renderScreen, signIn } from '../test-support/render';
import { invoiceDetail, lineItem } from '../test-support/fixtures';

/**
 * Cost assignment — the step that decides which budget an invoice lands on, and the gate on
 * posting: an invoice cannot post until every line is coded.
 *
 * The information is not on the document, so this is the one place the tool needs a person
 * rather than a checker. Which makes a *half*-coded line the failure to guard: a GL account
 * with no cost centre charges the company without charging anyone in it.
 */

const queueItem = (over = {}) => ({
  id: 'inv-1',
  invoiceNumber: 'INV-2026-0001',
  status: 'APPROVED' as const,
  totalAmount: '1296.00',
  currency: 'USD',
  poNumber: 'PO-5000',
  createdAt: '2026-05-04T09:00:00.000Z',
  coding: { totalLines: 2, codedLines: 0, isComplete: false },
  ...over,
});

const routes = (over: Record<string, unknown> = {}) => ({
  'GET /cost-assignment/queue': { body: [queueItem()] },
  'GET /gl-accounts': { body: [{ id: 'gl-1', code: '6000', name: 'Consulting', accountType: 'EXPENSE' }] },
  'GET /cost-centers': { body: [{ id: 'cc-1', code: 'CC100', name: 'Engineering', ownerId: null }] },
  'GET /invoices/inv-1': {
    body: invoiceDetail({
      lineItems: [
        lineItem({ id: 'line-1', description: 'Consulting hours', glAccountId: null, costCenterId: null }),
        lineItem({ id: 'line-2', description: 'Travel', glAccountId: null, costCenterId: null }),
      ],
    }),
  },
  'GET /invoices/inv-1/coding-suggestions': { body: [] },
  ...over,
});

const openEditor = async () => {
  await userEvent.click(await screen.findByRole('button', { name: 'Code lines' }));
  return (await screen.findByText('Consulting hours')).closest('tr') as HTMLElement;
};

describe('coding a line', () => {
  it('WILL NOT SAVE A LINE WITH ONLY HALF A CODING', async () => {
    // A GL account with no cost centre charges the company without charging anyone in it, and
    // the invoice would still read as coded on its way to posting.
    signIn();
    const fake = fakeApi({ ...routes(), 'PATCH /invoices/*/lines/*/code': { body: {} } });
    renderScreen(<CostAssignmentPage />);

    const row = await openEditor();
    expect(within(row).getByRole('button', { name: 'Assign' })).toBeDisabled();

    const [gl] = within(row).getAllByRole('combobox');
    await userEvent.selectOptions(gl, 'gl-1');
    expect(within(row).getByRole('button', { name: 'Assign' })).toBeDisabled();
    expect(fake.matching('PATCH /invoices/*/lines/*/code')).toHaveLength(0);
  });

  it('sends both ids once both are chosen', async () => {
    signIn();
    const fake = fakeApi({ ...routes(), 'PATCH /invoices/*/lines/*/code': { body: {} } });
    renderScreen(<CostAssignmentPage />);

    const row = await openEditor();
    const [gl, cc] = within(row).getAllByRole('combobox');
    await userEvent.selectOptions(gl, 'gl-1');
    await userEvent.selectOptions(cc, 'cc-1');
    await userEvent.click(within(row).getByRole('button', { name: 'Assign' }));

    expect(fake.only('PATCH /invoices/inv-1/lines/line-1/code').body).toEqual({
      glAccountId: 'gl-1',
      costCenterId: 'cc-1',
    });
  });

  it('refreshes the queue, because coding is what releases an invoice to posting', async () => {
    signIn();
    const fake = fakeApi({ ...routes(), 'PATCH /invoices/*/lines/*/code': { body: {} } });
    renderScreen(<CostAssignmentPage />);

    const row = await openEditor();
    const [gl, cc] = within(row).getAllByRole('combobox');
    await userEvent.selectOptions(gl, 'gl-1');
    await userEvent.selectOptions(cc, 'cc-1');
    await userEvent.click(within(row).getByRole('button', { name: 'Assign' }));

    await waitFor(() => expect(fake.matching('GET /cost-assignment/queue').length).toBeGreaterThan(1));
    expect(fake.matching('GET /invoices/inv-1').length).toBeGreaterThan(1);
  });

  it('surfaces a refusal instead of leaving the line looking coded', async () => {
    signIn();
    fakeApi({
      ...routes(),
      'PATCH /invoices/*/lines/*/code': nestError(409, 'Coding is frozen: this invoice has been posted'),
    });
    renderScreen(<CostAssignmentPage />);

    const row = await openEditor();
    const [gl, cc] = within(row).getAllByRole('combobox');
    await userEvent.selectOptions(gl, 'gl-1');
    await userEvent.selectOptions(cc, 'cc-1');
    await userEvent.click(within(row).getByRole('button', { name: 'Assign' }));

    expect(await screen.findByText(/Coding is frozen/)).toBeInTheDocument();
  });
});

describe('suggestions from history', () => {
  it('APPLIES TO EVERY LINE WITHOUT SAVING ANY OF THEM', async () => {
    // The suggestion is a draft, not a decision — it fills the selects and still requires the
    // person to press Assign per line. Auto-saving a frequency count over past invoices would
    // charge a budget nobody chose.
    signIn();
    const fake = fakeApi({
      ...routes({
        'GET /invoices/inv-1/coding-suggestions': {
          body: [{ glAccountId: 'gl-1', costCenterId: 'cc-1', label: '6000 / CC100', reason: 'used on 4 of 5 previous invoices' }],
        },
      }),
      'PATCH /invoices/*/lines/*/code': { body: {} },
    });
    renderScreen(<CostAssignmentPage />);
    await openEditor();

    await userEvent.click(screen.getByRole('button', { name: /6000 \/ CC100/ }));

    for (const select of screen.getAllByRole('combobox')) {
      expect((select as HTMLSelectElement).value).not.toBe('');
    }
    expect(fake.matching('PATCH /invoices/*/lines/*/code')).toHaveLength(0);
  });

  it('shows why it is suggesting that, not just what', async () => {
    // Evidence-based is the point: "used on 4 of 5 previous invoices" is checkable, a bare
    // recommendation is not.
    signIn();
    fakeApi(routes({
      'GET /invoices/inv-1/coding-suggestions': {
        body: [{ glAccountId: 'gl-1', costCenterId: 'cc-1', label: '6000 / CC100', reason: 'used on 4 of 5 previous invoices' }],
      },
    }));
    renderScreen(<CostAssignmentPage />);
    await openEditor();

    expect(screen.getByText(/used on 4 of 5 previous invoices/)).toBeInTheDocument();
  });
});

describe('the queue', () => {
  it('says how many lines are still uncoded and what that blocks', async () => {
    signIn();
    fakeApi(routes());
    renderScreen(<CostAssignmentPage />);

    expect(await screen.findByText('0/2 lines coded')).toBeInTheDocument();
    expect(screen.getByText(/cannot post until all of its lines are coded/)).toBeInTheDocument();
  });

  it('says so plainly when there is nothing left to code', async () => {
    signIn();
    fakeApi(routes({ 'GET /cost-assignment/queue': { body: [] } }));
    renderScreen(<CostAssignmentPage />);
    expect(await screen.findByText('Nothing to code.')).toBeInTheDocument();
  });

  it('reports a failed load rather than an empty queue', async () => {
    signIn();
    fakeApi(routes({ 'GET /cost-assignment/queue': nestError(403, 'Forbidden resource') }));
    renderScreen(<CostAssignmentPage />);
    expect(await screen.findByText('Forbidden resource')).toBeInTheDocument();
    expect(screen.queryByText('Nothing to code.')).not.toBeInTheDocument();
  });
});
