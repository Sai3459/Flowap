import { useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api/client';
import type { InvoiceDetail } from '../api/types';
import { StatusPill } from '../components/ui';
import { rectOf, useEffectsApi } from '../components/Effects';
import { notifyInboxChanged } from '../lib/useInboxWatch';

/** What the pipeline decided, in one line, for the confirmation card. */
function outcomeOf(inv: InvoiceDetail): { title: string; tone: 'clear' | 'review' | 'blocked' } {
  if (inv.status === 'EXCEPTION') return { title: 'Received — blocked', tone: 'blocked' };
  if (inv.status === 'NEEDS_REVIEW') return { title: 'Received — needs review', tone: 'review' };
  return { title: 'Invoice received', tone: 'clear' };
}

/**
 * The inbound app. Until this existed the only way an invoice could enter was a developer
 * calling the API by hand — this is the screen that makes the pipeline usable by a person.
 *
 * The uploaded file is stored and then handed to the extractor *by URL*, exactly as a
 * connector-pushed document would be, so there is one path through the system rather than two.
 */
export function UploadPage() {
  const navigate = useNavigate();
  const { lift } = useEffectsApi();
  const inputRef = useRef<HTMLInputElement>(null);
  const dropRef = useRef<HTMLDivElement>(null);
  const [over, setOver] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [results, setResults] = useState<InvoiceDetail[]>([]);

  async function send(files: FileList | null) {
    if (!files || files.length === 0) return;
    setBusy(true);
    setError(null);
    // Captured before the first await: the dropzone does not move, but reading it up front
    // keeps this identical to the approve path, where the origin control does disappear.
    const from = rectOf(dropRef.current);
    const done: InvoiceDetail[] = [];
    try {
      // Sequential rather than parallel: ingestion runs the whole pipeline inline, and a
      // burst of concurrent extractions would just queue behind each other anyway.
      for (const file of Array.from(files)) {
        const invoice = await api.upload(file);
        done.push(invoice);
        const outcome = outcomeOf(invoice);
        lift({
          title: outcome.title,
          tone: outcome.tone,
          detail: invoice.vendorName ?? file.name,
          stamp: invoice.invoiceNumber ?? undefined,
          origin: from,
        });
      }
      setResults((prev) => [...done, ...prev]);
      // A document that cleared validation is already parked at an approval node — if that
      // node is the acting user's, their queue just changed.
      notifyInboxChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      if (done.length > 0) setResults((prev) => [...done, ...prev]);
    } finally {
      setBusy(false);
      if (inputRef.current) inputRef.current.value = '';
    }
  }

  return (
    <>
      <div
        ref={dropRef}
        className={`drop${over ? ' over' : ''}`}
        onDragOver={(e) => { e.preventDefault(); setOver(true); }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => { e.preventDefault(); setOver(false); void send(e.dataTransfer.files); }}
      >
        <span className="lbl">Inbound</span>
        <h2>Drop an invoice here</h2>
        <p className="dim small" style={{ maxWidth: '44ch' }}>
          PDF, PNG, JPEG or WebP, up to 20&nbsp;MB. The document is stored, then read by the
          extraction service and pushed straight through matching and approval routing.
        </p>
        <input
          ref={inputRef}
          type="file"
          multiple
          accept="application/pdf,image/png,image/jpeg,image/webp"
          style={{ display: 'none' }}
          onChange={(e) => void send(e.target.files)}
        />
        <button className="primary" disabled={busy} onClick={() => inputRef.current?.click()}>
          {busy ? 'Processing…' : 'Choose a file'}
        </button>
      </div>

      {error && <div className="notice error">{error}</div>}

      <div className="notice">
        <strong>Extraction currently runs against a mock.</strong> The file is genuinely stored and
        genuinely fetched, but the extractor returns fixed sample documents rather than reading your
        PDF — there is no <code className="mono">ANTHROPIC_API_KEY</code> configured. Set one and
        point <code className="mono">EXTRACTION_SERVICE_URL</code> at the real service to read the
        document you actually uploaded.
      </div>

      {results.length > 0 && (
        <div className="card">
          <div className="card-head"><h2>Just processed</h2><span className="lbl">{results.length} document(s)</span></div>
          <div className="tbl-wrap">
            <table>
              <thead>
                <tr><th>File</th><th>Invoice</th><th>Vendor</th><th className="r">Total</th><th>Status</th><th>Outcome</th></tr>
              </thead>
              <tbody>
                {results.map((r) => (
                  <tr key={r.id} className="clickable" onClick={() => navigate(`/invoices/${r.id}`)}>
                    <td className="mute">{r.originalFilename ?? '—'}</td>
                    <td>{r.invoiceNumber ?? '—'}</td>
                    <td>{r.vendorName ?? '—'}</td>
                    <td className="r">{r.totalAmount ?? '—'} {r.currency ?? ''}</td>
                    <td><StatusPill status={r.status} /></td>
                    <td className="wrap dim">
                      {r.exceptions.length > 0
                        ? r.exceptions.map((e) => e.type.replace(/_/g, ' ')).join(', ')
                        : 'Cleared automatically'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </>
  );
}
