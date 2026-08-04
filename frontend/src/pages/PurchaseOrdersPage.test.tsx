import { describe, expect, it } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { PurchaseOrdersPage } from './PurchaseOrdersPage';
import { fakeApi, nestError } from '../test-support/fake-api';
import { renderScreen, signIn } from '../test-support/render';

/**
 * Purchase orders and goods receipts.
 *
 * Receipt quantities drive the third leg of the three-way match, and over-receipt is a **hard
 * stop** — an invoice billing more than arrived is blocked outright. So a wrong quantity here
 * does not produce a warning, it blocks a correct invoice or releases an incorrect one. The
 * tests below are mostly about not sending a number the person did not type.
 */

const po = (over = {}) => ({
  id: 'po-1',
  poNumber: 'PO-5000',
  vendorId: 'v-1',
  currency: 'USD',
  totalAmount: '1200.00',
  lineItems: [
    { lineNumber: 1, description: 'Consulting hours', quantity: 20, unitPrice: 60, lineTotal: 1200, unit: 'HUR' },
    { lineNumber: 2, description: 'Travel', quantity: 1, unitPrice: 200, lineTotal: 200 },
  ],
  receivedQty: null as Record<string, number> | null,
  ...over,
});

const open = async () => {
  await userEvent.click(await screen.findByRole('button', { name: 'Lines & receipts' }));
  return screen.getByRole('table');
};

describe('recording a goods receipt', () => {
  it('SENDS ONLY THE LINES A QUANTITY WAS TYPED AGAINST', async () => {
    // Quantities are absolute totals, not increments, so an empty box must mean "leave this
    // line alone" — never zero. The dangerous shape is a box that was typed into and then
    // cleared: it still holds a draft entry, `Number('')` is 0, and sending that would erase a
    // recorded delivery. An invoice against that line then looks like over-receipt, which is a
    // hard stop, so a correct invoice gets blocked by a keystroke nobody kept.
    signIn();
    const fake = fakeApi({
      'GET /purchase-orders': { body: [po({ receivedQty: { '2': 1 } })] },
      'POST /purchase-orders/*/receipts': { body: po() },
    });
    renderScreen(<PurchaseOrdersPage />);

    const table = await open();
    const [first, second] = within(table).getAllByPlaceholderText('qty');
    await userEvent.type(first, '20');
    await userEvent.type(second, '5');
    await userEvent.clear(second);
    await userEvent.click(screen.getByRole('button', { name: 'Record receipts' }));

    expect(fake.only('POST /purchase-orders/PO-5000/receipts').body).toEqual({ receivedQty: { '1': 20 } });
  });

  it('sends numbers, not the strings the inputs hold', async () => {
    signIn();
    const fake = fakeApi({
      'GET /purchase-orders': { body: [po()] },
      'POST /purchase-orders/*/receipts': { body: po() },
    });
    renderScreen(<PurchaseOrdersPage />);

    const table = await open();
    const [first] = within(table).getAllByPlaceholderText('qty');
    await userEvent.type(first, '20');
    await userEvent.click(screen.getByRole('button', { name: 'Record receipts' }));

    const body = fake.only('POST /purchase-orders/PO-5000/receipts').body as { receivedQty: Record<string, unknown> };
    expect(typeof body.receivedQty['1']).toBe('number');
  });

  it('cannot be fired with nothing entered', async () => {
    signIn();
    fakeApi({ 'GET /purchase-orders': { body: [po()] }, 'POST /purchase-orders/*/receipts': { body: po() } });
    renderScreen(<PurchaseOrdersPage />);

    await open();
    expect(screen.getByRole('button', { name: 'Record receipts' })).toBeDisabled();
  });

  it('refreshes the orders, so the recorded quantity is read back from the server', async () => {
    signIn();
    const fake = fakeApi({
      'GET /purchase-orders': { body: [po()] },
      'POST /purchase-orders/*/receipts': { body: po() },
    });
    renderScreen(<PurchaseOrdersPage />);

    const table = await open();
    await userEvent.type(within(table).getAllByPlaceholderText('qty')[0], '20');
    await userEvent.click(screen.getByRole('button', { name: 'Record receipts' }));

    await waitFor(() => expect(fake.matching('GET /purchase-orders').length).toBeGreaterThan(1));
  });

  it('surfaces a refusal instead of appearing to record it', async () => {
    signIn();
    fakeApi({
      'GET /purchase-orders': { body: [po()] },
      'POST /purchase-orders/*/receipts': nestError(400, 'Line 1 does not exist on PO-5000'),
    });
    renderScreen(<PurchaseOrdersPage />);

    const table = await open();
    await userEvent.type(within(table).getAllByPlaceholderText('qty')[0], '20');
    await userEvent.click(screen.getByRole('button', { name: 'Record receipts' }));

    expect(await screen.findByText('Line 1 does not exist on PO-5000')).toBeInTheDocument();
  });

  it('distinguishes "nothing received" from "received zero"', async () => {
    signIn();
    fakeApi({ 'GET /purchase-orders': { body: [po({ receivedQty: { '1': 20 } })] } });
    renderScreen(<PurchaseOrdersPage />);

    const table = await open();
    const rows = within(table).getAllByRole('row').slice(1);
    expect(rows[0]).toHaveTextContent('20');
    expect(rows[1]).toHaveTextContent('none');
  });
});

describe('syncing a purchase order', () => {
  it('SENDS A HEADER TOTAL THAT AGREES WITH ITS OWN LINE', async () => {
    // The backend rejects a PO whose header total disagrees with its lines, because such an
    // order produces phantom total variance on *every* invoice matched to it. The form has to
    // compute the total rather than take a second number from the user.
    signIn();
    const fake = fakeApi({
      'GET /purchase-orders': { body: [] },
      'POST /purchase-orders': { body: po() },
    });
    renderScreen(<PurchaseOrdersPage />);

    await userEvent.click(await screen.findByRole('button', { name: 'Sync a purchase order' }));
    const form = screen.getByText('Sync a purchase order', { selector: 'h2' }).closest('.card') as HTMLElement;
    const [poNumber, vendor, , description] = within(form).getAllByRole('textbox');
    await userEvent.type(poNumber, 'PO-7000');
    await userEvent.type(vendor, 'Northwind Traders');
    await userEvent.type(description, 'Consulting hours');

    const numbers = within(form).getAllByRole('spinbutton');
    await userEvent.clear(numbers[0]);
    await userEvent.type(numbers[0], '20');
    await userEvent.clear(numbers[1]);
    await userEvent.type(numbers[1], '60');
    await userEvent.click(within(form).getByRole('button', { name: /Sync/ }));

    const body = fake.only('POST /purchase-orders').body as {
      poNumber: string; totalAmount: number; lineItems: { lineTotal: number }[];
    };
    expect(body.poNumber).toBe('PO-7000');
    expect(body.totalAmount).toBe(1200);
    expect(body.lineItems[0].lineTotal).toBe(1200);
    expect(body.totalAmount).toBe(body.lineItems.reduce((a, l) => a + l.lineTotal, 0));
  });

  it('explains what a missing purchase order does to an invoice', async () => {
    signIn();
    fakeApi({ 'GET /purchase-orders': { body: [] } });
    renderScreen(<PurchaseOrdersPage />);
    expect(await screen.findByText(/MISSING_PO/)).toBeInTheDocument();
    expect(screen.getByText('No purchase orders yet.')).toBeInTheDocument();
  });
});
