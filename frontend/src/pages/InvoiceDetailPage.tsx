import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api } from '../api/client';
import type { ApprovalProgress, InvoiceDetail } from '../api/types';
import { useApi } from '../lib/useApi';
import {
  ApprovalMeter, ConfidenceEq, Empty, ErrorNote, Loading, StatusPill, StepPill, shortDate,
} from '../components/ui';
import {
  CORRECTABLE_FIELDS, DATE_FIELDS, FIELD_LABELS, MONEY_FIELDS, confidenceLevel,
} from '../lib/confidence';

const FIELD_ORDER = [
  'invoiceNumber', 'poNumber', 'referenceNumber', 'vendorName', 'vendorTaxId',
  'invoiceDate', 'supplyDate', 'dueDate', 'currency', 'subtotal', 'taxAmount', 'totalAmount',
];

export function InvoiceDetailPage() {
  const { id } = useParams<{ id: string }>();
  const invoice = useApi<InvoiceDetail>(() => api.getInvoice(id!), [id]);
  const progress = useApi<ApprovalProgress | null>(() => api.approvalProgress(id!), [id]);
  const [busy, setBusy] = useState(false);
  const [flash, setFlash] = useState<string | null>(null);

  if (invoice.loading) return <Loading what="invoice" />;
  if (invoice.error) return <ErrorNote message={invoice.error} />;
  const d = invoice.data;
  if (!d) return null;

  const confidence = d.fieldConfidence ?? {};
  const names = [
    ...FIELD_ORDER.filter((n) => n in confidence || n in d),
    ...Object.keys(confidence).filter((n) => !FIELD_ORDER.includes(n)),
  ];
  const flagged = names.filter((n) => confidenceLevel(confidence[n]) === 'low').length;

  async function revalidate() {
    setBusy(true);
    setFlash(null);
    try {
      const r = await api.revalidate(d!.id);
      setFlash(r.revalidated ? 'Re-validated — matching and duplicate checks ran again.' : `Not re-validated: ${r.reason}`);
      invoice.reload();
      progress.reload();
    } catch (err) {
      setFlash(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <div className="row-between">
        <div className="row">
          <h1>{d.invoiceNumber ?? 'Untitled invoice'}</h1>
          <StatusPill status={d.status} />
          {d.erpDocumentNumber && <span className="pill p-posted">ERP {d.erpDocumentNumber}</span>}
          <span className="mute small">
            {flagged > 0 ? `${flagged} field(s) need review` : 'all fields above threshold'}
          </span>
        </div>
        <div className="row">
          <button disabled={busy} onClick={() => void revalidate()}>{busy ? 'Working…' : 'Re-validate'}</button>
          <Link to="/invoices"><button className="ghost">← All invoices</button></Link>
        </div>
      </div>

      {flash && <div className="notice">{flash}</div>}

      {d.exceptions.length > 0 && (
        <div className="card">
          <div className="card-head"><h2>Exceptions</h2></div>
          {d.exceptions.map((e) => (
            <div className={`exc${e.resolvedAt ? ' resolved' : ''}`} key={e.id}>
              <span className="t">{e.type.replace(/_/g, ' ')}{e.resolvedAt ? ' · resolved' : ''}</span>
              <p className="small">{e.detail}</p>
              {e.suggestedFix && <p className="fix"><strong>Suggested fix:</strong> {e.suggestedFix}</p>}
            </div>
          ))}
        </div>
      )}

      {progress.data && (
        <div className="card">
          <div className="card-head">
            <h2>Approval</h2>
            <span className="lbl">{progress.data.workflowName}</span>
          </div>
          <div className="row">
            <ApprovalMeter given={progress.data.approvalsGiven} remaining={progress.data.approvalsRemaining} />
            <span className="mono small">
              {progress.data.completedAt
                ? `complete — ${progress.data.approvalsGiven} approval(s) given`
                : `${progress.data.approvalsGiven} given · ${progress.data.approvalsRemaining} still needed`}
            </span>
          </div>
          <div className="chain">
            {progress.data.steps.map((s) => (
              <div className="chain-step" key={s.id}>
                <span className={`dot${s.status === 'APPROVED' ? ' done' : s.status === 'PENDING' ? ' now' : s.status === 'REJECTED' ? ' rej' : ''}`} />
                <span className="stack" style={{ gap: '0.15rem' }}>
                  <span className="mono small">{s.nodeId}</span>
                  <span className="mute small">
                    approver {s.approverId?.slice(0, 8) ?? '—'}
                    {s.actedAt && ` · ${new Date(s.actedAt).toLocaleString()}`}
                    {s.comment && ` · “${s.comment}”`}
                  </span>
                </span>
                <StepPill status={s.status} />
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="card">
        <div className="card-head">
          <h2>Extracted fields</h2>
          <span className="lbl">confidence is per field — only flagged rows need a human</span>
        </div>
        <div className="fields">
          {names.map((name) => (
            <FieldRow
              key={name}
              name={name}
              value={readField(d, name)}
              meta={confidence[name]}
              onSaved={() => { invoice.reload(); progress.reload(); }}
              invoiceId={d.id}
            />
          ))}
        </div>
      </div>

      {d.matchResult && (
        <div className="card">
          <div className="card-head">
            <h2>Purchase order match <span className="mono mute">{d.poNumber}</span></h2>
            <span className={`pill ${d.matchResult.isClean ? 'p-clear' : 'p-review'}`}>
              {d.matchResult.isClean ? 'within tolerance' : 'variance found'}
            </span>
          </div>
          {d.matchResult.headerIssues.map((i) => <p key={i} className="small dim">{i}</p>)}
          <div className="tbl-wrap">
            <table>
              <thead>
                <tr><th>Line</th><th>PO line</th><th className="r">Billed</th><th className="r">Ordered</th><th className="r">Received</th><th className="r">Price var</th><th className="r">Qty var</th><th>Result</th></tr>
              </thead>
              <tbody>
                {d.matchResult.lines.map((l) => (
                  <tr key={l.invoiceLineId}>
                    <td className="wrap">{l.description}</td>
                    <td className="mute">{l.poLineNumber ?? 'none'}</td>
                    <td className="r">{l.billedQuantity}</td>
                    <td className="r">{l.orderedQuantity ?? '—'}</td>
                    <td className="r">{l.receivedQuantity ?? 'not recorded'}</td>
                    <td className="r">{l.priceVariancePct === null ? '—' : `${l.priceVariancePct > 0 ? '+' : ''}${l.priceVariancePct.toFixed(1)}%`}</td>
                    <td className="r">{l.quantityVariancePct === null ? '—' : `${l.quantityVariancePct > 0 ? '+' : ''}${l.quantityVariancePct.toFixed(1)}%`}</td>
                    <td><span className={`pill ${l.status === 'MATCHED' ? 'p-clear' : l.status === 'OVER_RECEIPT' || l.status === 'UNMATCHED' ? 'p-blocked' : 'p-review'}`}>{l.status.replace(/_/g, ' ')}</span></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <div className="card">
        <div className="card-head"><h2>Line items &amp; coding</h2></div>
        {d.lineItems.length === 0 ? <Empty>No line items extracted.</Empty> : (
          <div className="tbl-wrap">
            <table>
              <thead>
                <tr><th>Description</th><th className="r">Qty</th><th className="r">Unit</th><th className="r">Total</th><th>Tax</th><th>GL</th><th>Coded</th><th className="r">Confidence</th></tr>
              </thead>
              <tbody>
                {d.lineItems.map((l) => (
                  <tr key={l.id}>
                    <td className="wrap">{l.description}</td>
                    <td className="r">{Number(l.quantity)}</td>
                    <td className="r">{Number(l.unitPrice)}</td>
                    <td className="r">{l.lineTotal}</td>
                    <td className="mute">{l.taxCode ?? '—'}{l.taxRate !== null && ` ${l.taxRate}%`}</td>
                    <td className="mute">{l.glCode ?? '—'}</td>
                    <td>{l.glAccountId && l.costCenterId ? <span className="pill p-clear">coded</span> : <span className="pill p-review">uncoded</span>}</td>
                    <td className="r"><ConfidenceEq confidence={l.confidence} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <div className="row small"><Link to="/coding">Open cost assignment →</Link></div>
      </div>

      <div className="card">
        <div className="card-head"><h2>Document</h2></div>
        <div className="row small dim">
          <span><span className="lbl">Source</span> {d.sourceChannel}</span>
          <span><span className="lbl">Received</span> {new Date(d.createdAt).toLocaleString()}</span>
          {d.originalFilename && <span><span className="lbl">File</span> {d.originalFilename}</span>}
          {d.postedAt && <span><span className="lbl">Posted</span> {new Date(d.postedAt).toLocaleString()}</span>}
        </div>
        <a className="mono small" href={d.fileUrl} target="_blank" rel="noreferrer">{d.fileUrl}</a>
      </div>
    </>
  );
}

function readField(invoice: InvoiceDetail, name: string): string | null {
  const v = (invoice as unknown as Record<string, unknown>)[name];
  return v === null || v === undefined ? null : String(v);
}

function FieldRow({
  name, value, meta, invoiceId, onSaved,
}: {
  name: string;
  value: string | null;
  meta: { confidence: number; source: string } | undefined;
  invoiceId: string;
  onSaved: () => void;
}) {
  const level = confidenceLevel(meta as never);
  const editable = CORRECTABLE_FIELDS.has(name);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const shown = DATE_FIELDS.has(name) && value ? shortDate(value) : value;

  async function save() {
    setSaving(true);
    setError(null);
    try {
      await api.correctField(invoiceId, name, draft);
      setEditing(false);
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className={`field${level === 'low' ? ' low' : level === 'corrected' ? ' corrected' : ''}`}>
      <span className="k">{FIELD_LABELS[name] ?? name}</span>
      {editing ? (
        <span className="row" style={{ gridColumn: '2 / -1' }}>
          <input
            autoFocus
            type={DATE_FIELDS.has(name) ? 'date' : 'text'}
            inputMode={MONEY_FIELDS.has(name) ? 'decimal' : undefined}
            value={draft}
            disabled={saving}
            style={{ flex: 1 }}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') void save(); if (e.key === 'Escape') setEditing(false); }}
          />
          <button className="primary" disabled={saving} onClick={() => void save()}>{saving ? 'Saving…' : 'Save'}</button>
          <button disabled={saving} onClick={() => setEditing(false)}>Cancel</button>
        </span>
      ) : (
        <>
          <span className={shown ? 'v' : 'v empty'}>{shown || 'not extracted'}</span>
          <ConfidenceEq confidence={meta?.confidence ?? null} corrected={meta?.source === 'HUMAN_CORRECTED'} />
          <span className="pct">{meta ? `${Math.round(meta.confidence * 100)}%` : '—'}</span>
          <span>
            {editable && (
              <button className="ghost" onClick={() => { setDraft(DATE_FIELDS.has(name) ? shortDate(value) : value ?? ''); setEditing(true); }}>
                Edit
              </button>
            )}
          </span>
        </>
      )}
      {error && <span className="err">{error}</span>}
    </div>
  );
}
