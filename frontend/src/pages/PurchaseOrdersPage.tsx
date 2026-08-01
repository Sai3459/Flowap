import { useState } from 'react';
import { api } from '../api/client';
import type { PurchaseOrder } from '../api/types';
import { useApi } from '../lib/useApi';
import { Empty, ErrorNote, Loading, Money } from '../components/ui';

/**
 * Purchase orders and goods receipts.
 *
 * Framed as ERP master data rather than something authored here — re-syncing the same PO
 * number updates the local copy. The create form exists because no ERP connector does, and
 * without any POs every invoice would fail matching.
 */
export function PurchaseOrdersPage() {
  const pos = useApi<PurchaseOrder[]>(() => api.purchaseOrders());
  const [openPo, setOpenPo] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);

  if (pos.loading) return <Loading what="purchase orders" />;
  if (pos.error) return <ErrorNote message={pos.error} />;
  const orders = pos.data ?? [];

  return (
    <>
      <div className="row-between">
        <p className="dim small">
          {orders.length} order(s). Invoices match against these — an invoice citing a PO that is
          not here is blocked as <span className="mono">MISSING_PO</span>.
        </p>
        <button className={showForm ? '' : 'primary'} onClick={() => setShowForm(!showForm)}>
          {showForm ? 'Close' : 'Sync a purchase order'}
        </button>
      </div>

      {showForm && <PoForm onCreated={() => { pos.reload(); setShowForm(false); }} />}

      {orders.length === 0 ? <Empty>No purchase orders yet.</Empty> : (
        <div className="stack">
          {orders.map((po) => {
            const received = po.receivedQty ?? {};
            return (
              <div className="card" key={po.id}>
                <div className="row-between">
                  <h2 className="mono">{po.poNumber}</h2>
                  <div className="row">
                    <span className="mono"><Money amount={po.totalAmount} currency={po.currency} /></span>
                    <span className="lbl">{po.lineItems.length} line(s)</span>
                    <button onClick={() => setOpenPo(openPo === po.id ? null : po.id)}>
                      {openPo === po.id ? 'Hide' : 'Lines & receipts'}
                    </button>
                  </div>
                </div>

                {openPo === po.id && (
                  <ReceiptEditor po={po} received={received} onSaved={() => pos.reload()} />
                )}
              </div>
            );
          })}
        </div>
      )}
    </>
  );
}

function ReceiptEditor({
  po, received, onSaved,
}: {
  po: PurchaseOrder;
  received: Record<string, number>;
  onSaved: () => void;
}) {
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    setSaving(true);
    setError(null);
    try {
      const payload: Record<string, number> = {};
      for (const [line, v] of Object.entries(draft)) {
        if (v.trim() !== '') payload[line] = Number(v);
      }
      if (Object.keys(payload).length > 0) await api.recordReceipt(po.poNumber, payload);
      setDraft({});
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      {error && <ErrorNote message={error} />}
      <div className="tbl-wrap">
        <table>
          <thead>
            <tr><th>#</th><th>Description</th><th className="r">Ordered</th><th className="r">Unit price</th><th className="r">Line total</th><th className="r">Received</th><th>Record receipt</th></tr>
          </thead>
          <tbody>
            {po.lineItems.map((l) => (
              <tr key={l.lineNumber}>
                <td className="mute">{l.lineNumber}</td>
                <td className="wrap">{l.description}</td>
                <td className="r">{l.quantity}{l.unit ? ` ${l.unit}` : ''}</td>
                <td className="r">{l.unitPrice}</td>
                <td className="r">{l.lineTotal}</td>
                <td className="r">
                  {received[String(l.lineNumber)] ?? <span className="mute">none</span>}
                </td>
                <td>
                  <input
                    type="number"
                    min="0"
                    style={{ width: '6rem' }}
                    placeholder="qty"
                    value={draft[String(l.lineNumber)] ?? ''}
                    onChange={(e) => setDraft({ ...draft, [String(l.lineNumber)]: e.target.value })}
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="row">
        <button className="primary" disabled={saving || Object.keys(draft).length === 0} onClick={() => void save()}>
          {saving ? 'Saving…' : 'Record receipts'}
        </button>
        <span className="mute small">
          Quantities are absolute totals, not increments. Recording a receipt re-checks any invoice
          that was blocked for billing more than had arrived.
        </span>
      </div>
    </>
  );
}

function PoForm({ onCreated }: { onCreated: () => void }) {
  const [poNumber, setPoNumber] = useState('');
  const [vendorName, setVendorName] = useState('');
  const [currency, setCurrency] = useState('USD');
  const [description, setDescription] = useState('');
  const [quantity, setQuantity] = useState('1');
  const [unitPrice, setUnitPrice] = useState('0');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const lineTotal = Number(quantity) * Number(unitPrice);

  async function submit() {
    setSaving(true);
    setError(null);
    try {
      await api.createPurchaseOrder({
        poNumber, vendorName, currency,
        totalAmount: lineTotal,
        lineItems: [{
          lineNumber: 1,
          description,
          quantity: Number(quantity),
          unitPrice: Number(unitPrice),
          lineTotal,
        }],
      });
      onCreated();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="card">
      <div className="card-head"><h2>Sync a purchase order</h2><span className="lbl">idempotent on PO number</span></div>
      {error && <ErrorNote message={error} />}
      <div className="grid g-3">
        <label className="stack" style={{ gap: '0.25rem' }}><span className="lbl">PO number</span>
          <input value={poNumber} onChange={(e) => setPoNumber(e.target.value)} placeholder="PO-5000" /></label>
        <label className="stack" style={{ gap: '0.25rem' }}><span className="lbl">Vendor</span>
          <input value={vendorName} onChange={(e) => setVendorName(e.target.value)} placeholder="Northwind Traders" /></label>
        <label className="stack" style={{ gap: '0.25rem' }}><span className="lbl">Currency</span>
          <input value={currency} onChange={(e) => setCurrency(e.target.value)} maxLength={3} /></label>
      </div>
      <div className="grid g-3">
        <label className="stack" style={{ gap: '0.25rem' }}><span className="lbl">Line description</span>
          <input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Consulting hours" /></label>
        <label className="stack" style={{ gap: '0.25rem' }}><span className="lbl">Quantity</span>
          <input type="number" value={quantity} onChange={(e) => setQuantity(e.target.value)} /></label>
        <label className="stack" style={{ gap: '0.25rem' }}><span className="lbl">Unit price</span>
          <input type="number" value={unitPrice} onChange={(e) => setUnitPrice(e.target.value)} /></label>
      </div>
      <div className="row">
        <span className="mono small">Total <Money amount={String(lineTotal)} currency={currency} /></span>
        <button
          className="primary"
          disabled={saving || !poNumber || !vendorName || !description}
          onClick={() => void submit()}
        >{saving ? 'Syncing…' : 'Sync order'}</button>
        <span className="mute small">
          The header total must equal the sum of the lines — a PO that disagrees with itself would
          show phantom variance on every invoice matched to it.
        </span>
      </div>
    </div>
  );
}
