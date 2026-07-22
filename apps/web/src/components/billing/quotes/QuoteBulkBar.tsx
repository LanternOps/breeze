// The quote editor's bulk-edit action bar (Task D). Renders only while at
// least one line is selected; QuoteEditor mounts it inside the same sticky
// viewport-bottom wrapper as the mobile totals strip, so the two bars stack
// instead of colliding. Purely presentational + local input state — the apply
// mechanics (one PATCH per line through the existing editLine commit path)
// live in QuoteEditor.
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import '../../../lib/i18n';
import { filterMoneyChars, filterPercentChars } from './QuoteLineRows';

export function QuoteBulkBar({ count, busy, onSetMarkup, onSetCost, onSetTaxable, onClear }: {
  count: number;
  /** True while a bulk apply is running — disables the actions (the per-line
   *  pending keys already disable the affected row inputs). */
  busy: boolean;
  onSetMarkup: (pct: number) => void;
  onSetCost: (cost: number) => void;
  onSetTaxable: (taxable: boolean) => void;
  onClear: () => void;
}) {
  const { t } = useTranslation('billing');
  // Which inline value editor is open ('markup' | 'cost'), its draft, and an
  // inline validation error — the same input vocabulary as the row fields
  // (filterPercentChars allows a leading '-', money chars don't).
  const [input, setInput] = useState<'markup' | 'cost' | null>(null);
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<string | null>(null);
  const markupBtnRef = useRef<HTMLButtonElement>(null);
  const costBtnRef = useRef<HTMLButtonElement>(null);
  const valueRef = useRef<HTMLInputElement>(null);
  useEffect(() => { if (input) valueRef.current?.focus(); }, [input]);

  const openInput = (which: 'markup' | 'cost') => {
    setInput((cur) => (cur === which ? null : which));
    setDraft('');
    setError(null);
  };
  const closeInput = () => {
    const trigger = input === 'markup' ? markupBtnRef : costBtnRef;
    setInput(null);
    setError(null);
    trigger.current?.focus();
  };
  const apply = () => {
    if (!input) return;
    const n = Number(draft);
    if (draft.trim() === '' || !Number.isFinite(n) || (input === 'cost' && n < 0)) {
      setError(input === 'cost' ? t('quotes.editor.errors.costZeroOrMore') : t('quotes.editor.bulk.invalidMarkup'));
      return;
    }
    (input === 'markup' ? onSetMarkup : onSetCost)(n);
    setInput(null);
    setDraft('');
    setError(null);
  };

  const actionBtn = 'inline-flex h-7 items-center rounded-md border px-2 text-xs font-medium hover:bg-muted focus:outline-hidden focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50';

  return (
    <div
      role="region"
      aria-label={t('quotes.editor.bulk.barAria')}
      data-testid="quote-bulk-bar"
      onKeyDown={(e) => {
        if (e.key !== 'Escape') return;
        e.stopPropagation();
        // Escape steps out gradually: first closes an open value editor
        // (back to its trigger), then clears the selection entirely.
        if (input) closeInput();
        else onClear();
      }}
      className="rounded-lg border bg-card px-4 py-2 text-sm shadow-md"
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        {/* role=status: a screen reader hears the count move as rows are
            (de)selected without re-reading the whole bar. */}
        <span role="status" className="text-xs font-medium tabular-nums" data-testid="quote-bulk-count">
          {t('quotes.editor.bulk.selectedCount', { count })}
        </span>
        <div className="ml-auto flex flex-wrap items-center gap-1.5">
          <button
            ref={markupBtnRef}
            type="button"
            onClick={() => openInput('markup')}
            aria-expanded={input === 'markup'}
            disabled={busy}
            data-testid="quote-bulk-set-markup"
            className={`${actionBtn} ${input === 'markup' ? 'border-primary/40 bg-primary/10 text-primary' : ''}`}
          >
            {t('quotes.editor.bulk.setMarkup')}
          </button>
          <button
            ref={costBtnRef}
            type="button"
            onClick={() => openInput('cost')}
            aria-expanded={input === 'cost'}
            disabled={busy}
            data-testid="quote-bulk-set-cost"
            className={`${actionBtn} ${input === 'cost' ? 'border-primary/40 bg-primary/10 text-primary' : ''}`}
          >
            {t('quotes.editor.bulk.setCost')}
          </button>
          <button
            type="button"
            onClick={() => onSetTaxable(true)}
            disabled={busy}
            data-testid="quote-bulk-taxable-on"
            className={actionBtn}
          >
            {t('quotes.editor.bulk.taxableOn')}
          </button>
          <button
            type="button"
            onClick={() => onSetTaxable(false)}
            disabled={busy}
            data-testid="quote-bulk-taxable-off"
            className={actionBtn}
          >
            {t('quotes.editor.bulk.taxableOff')}
          </button>
          <button
            type="button"
            onClick={onClear}
            data-testid="quote-bulk-clear"
            className="inline-flex h-7 items-center rounded-md px-2 text-xs font-medium text-muted-foreground hover:text-foreground focus:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
          >
            {t('quotes.editor.bulk.clearSelection')}
          </button>
        </div>
      </div>
      {input && (
        <div className="mt-2 flex flex-wrap items-center gap-2 border-t pt-2">
          <label htmlFor="quote-bulk-value" className="text-xs text-muted-foreground">
            {input === 'markup' ? t('quotes.editor.line.markup') : t('quotes.editor.line.cost')}
          </label>
          <span className="flex items-center gap-1">
            <input
              id="quote-bulk-value"
              ref={valueRef}
              type="text"
              inputMode="decimal"
              value={draft}
              onChange={(e) => {
                setDraft((input === 'markup' ? filterPercentChars : filterMoneyChars)(e.target.value));
                setError(null);
              }}
              onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); apply(); } }}
              disabled={busy}
              aria-invalid={error ? true : undefined}
              aria-describedby={error ? 'quote-bulk-value-error' : undefined}
              data-testid="quote-bulk-value"
              className={`h-8 w-24 rounded-md border bg-background px-2 text-right text-sm tabular-nums focus:outline-hidden focus:ring-2 focus:ring-ring disabled:opacity-60 ${error ? 'border-destructive' : ''}`}
            />
            {input === 'markup' && <span className="text-xs text-muted-foreground">{t('quotes.editor.symbols.percent')}</span>}
          </span>
          <button
            type="button"
            onClick={apply}
            disabled={busy}
            data-testid="quote-bulk-apply"
            className="inline-flex h-8 items-center rounded-md bg-primary px-3 text-xs font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50"
          >
            {t('quotes.editor.bulk.apply')}
          </button>
          <button
            type="button"
            onClick={closeInput}
            disabled={busy}
            data-testid="quote-bulk-value-cancel"
            className="inline-flex h-8 items-center rounded-md border px-2 text-xs font-medium text-muted-foreground hover:bg-muted disabled:opacity-50"
          >
            {t('quotes.editor.actions.cancel')}
          </button>
          {error && (
            <p id="quote-bulk-value-error" className="w-full text-xs text-destructive" data-testid="quote-bulk-value-error">
              {error}
            </p>
          )}
          {/* Markup needs a cost base — say so up front rather than only in the
              post-apply "skipped" toast. */}
          {input === 'markup' && !error && (
            <p className="w-full text-xs text-muted-foreground" data-testid="quote-bulk-markup-hint">
              {t('quotes.editor.bulk.markupHint')}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
