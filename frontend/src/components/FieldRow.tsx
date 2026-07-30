import { useState } from 'react';
import type { FieldConfidence } from '../api/types';
import {
  confidenceLevel,
  CORRECTABLE_FIELDS,
  DATE_FIELDS,
  FIELD_LABELS,
  formatConfidence,
  MONEY_FIELDS,
} from '../lib/confidence';

interface FieldRowProps {
  fieldName: string;
  value: string | null;
  meta: FieldConfidence | undefined;
  /** Resolves when the correction has been persisted; rejects with a message to display. */
  onSave: (fieldName: string, correctedValue: string) => Promise<void>;
}

/** `<input type="date">` needs yyyy-MM-dd; the API returns full ISO timestamps. */
function toDateInputValue(value: string | null): string {
  if (!value) return '';
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? '' : parsed.toISOString().slice(0, 10);
}

function displayValue(fieldName: string, value: string | null): string {
  if (value === null || value === '') return '';
  if (DATE_FIELDS.has(fieldName)) {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? value : parsed.toISOString().slice(0, 10);
  }
  return value;
}

/**
 * One extracted field with its confidence, and — for allowlisted fields — inline editing
 * wired to PATCH /invoices/:id/correct-field. Low-confidence fields are highlighted so a
 * reviewer can go straight to the one field that needs them instead of re-reading the
 * whole document.
 */
export function FieldRow({ fieldName, value, meta, onSave }: FieldRowProps) {
  const level = confidenceLevel(meta);
  const editable = CORRECTABLE_FIELDS.has(fieldName);

  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function startEditing() {
    setDraft(DATE_FIELDS.has(fieldName) ? toDateInputValue(value) : (value ?? ''));
    setError(null);
    setEditing(true);
  }

  async function save() {
    setSaving(true);
    setError(null);
    try {
      await onSave(fieldName, draft);
      setEditing(false);
    } catch (err) {
      // Keep the row in edit mode so the entered value isn't lost on a validation error.
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  const shown = displayValue(fieldName, value);

  return (
    <div className={`field-row level-${level}`}>
      <span className="field-label">{FIELD_LABELS[fieldName] ?? fieldName}</span>

      {editing ? (
        <div className="edit-row">
          <input
            autoFocus
            type={DATE_FIELDS.has(fieldName) ? 'date' : 'text'}
            inputMode={MONEY_FIELDS.has(fieldName) ? 'decimal' : undefined}
            value={draft}
            disabled={saving}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void save();
              if (e.key === 'Escape') setEditing(false);
            }}
          />
          <button className="primary" onClick={() => void save()} disabled={saving}>
            {saving ? 'Saving…' : 'Save'}
          </button>
          <button onClick={() => setEditing(false)} disabled={saving}>
            Cancel
          </button>
        </div>
      ) : (
        <span className={shown ? 'field-value' : 'field-value empty'}>{shown || 'not extracted'}</span>
      )}

      <span className="confidence-cell">{formatConfidence(meta)}</span>

      <span className="field-actions">
        {meta?.source === 'HUMAN_CORRECTED' && <span className="badge badge-corrected">corrected</span>}
        {meta?.source === 'AI_EXTRACTED' && level === 'low' && (
          <span className="badge badge-danger">low</span>
        )}
        {!editing && editable && (
          <button className="link" onClick={startEditing}>
            Edit
          </button>
        )}
      </span>

      {error && <span className="field-error">{error}</span>}
    </div>
  );
}
