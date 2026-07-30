import type { LineMatchStatus, PoMatchResult } from '../api/types';

const STATUS_TONE: Record<LineMatchStatus, string> = {
  MATCHED: 'badge-ok',
  PRICE_VARIANCE: 'badge-warn',
  QUANTITY_VARIANCE: 'badge-warn',
  OVER_RECEIPT: 'badge-danger',
  UNMATCHED: 'badge-danger',
};

const pct = (value: number | null) => (value === null ? '—' : `${value > 0 ? '+' : ''}${value.toFixed(1)}%`);

/**
 * The PO match, line by line. This is the "why is this invoice stuck" view: each line shows
 * what was billed against what was ordered and received, with the engine's own explanation
 * rather than a re-derived one.
 */
export function MatchPanel({ match, poNumber }: { match: PoMatchResult; poNumber: string | null }) {
  return (
    <div className="card">
      <div className="row-between">
        <h2 style={{ margin: 0 }}>Purchase order match {poNumber && <code>{poNumber}</code>}</h2>
        {match.isClean ? (
          <span className="badge badge-ok">matches within tolerance</span>
        ) : (
          <span className="badge badge-warn">variance found</span>
        )}
      </div>

      <div className="meta-list" style={{ margin: '0.6rem 0' }}>
        <span>
          <strong>Max price variance:</strong> {pct(match.maxPriceVariancePct)}
        </span>
        <span>
          <strong>Max quantity variance:</strong> {pct(match.maxQuantityVariancePct)}
        </span>
        <span>
          <strong>Net total variance:</strong>{' '}
          {match.totalVarianceAmount === null ? '—' : match.totalVarianceAmount.toFixed(2)}
        </span>
      </div>

      {match.headerIssues.length > 0 && (
        <div className="exception-block">
          <span className="type">HEADER</span>
          {match.headerIssues.map((issue) => (
            <p className="detail" key={issue}>
              {issue}
            </p>
          ))}
        </div>
      )}

      <div className="table-wrap" style={{ marginTop: '0.6rem' }}>
        <table>
          <thead>
            <tr>
              <th>Line</th>
              <th>PO line</th>
              <th className="num">Billed</th>
              <th className="num">Ordered</th>
              <th className="num">Received</th>
              <th className="num">Price var</th>
              <th className="num">Qty var</th>
              <th>Result</th>
            </tr>
          </thead>
          <tbody>
            {match.lines.map((line) => (
              <tr key={line.invoiceLineId}>
                <td>{line.description}</td>
                <td className="subtle">{line.poLineNumber ?? 'none'}</td>
                <td className="num">{line.billedQuantity}</td>
                <td className="num">{line.orderedQuantity ?? '—'}</td>
                <td className="num">{line.receivedQuantity ?? 'not recorded'}</td>
                <td className="num">{pct(line.priceVariancePct)}</td>
                <td className="num">{pct(line.quantityVariancePct)}</td>
                <td>
                  <span className={`badge ${STATUS_TONE[line.status]}`}>
                    {line.status.replace(/_/g, ' ')}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {match.lines.some((l) => l.explanation) && (
        <ul className="subtle" style={{ margin: '0.6rem 0 0', paddingLeft: '1.1rem' }}>
          {match.lines
            .filter((l) => l.explanation)
            .map((l) => (
              <li key={l.invoiceLineId}>{l.explanation}</li>
            ))}
        </ul>
      )}
    </div>
  );
}
