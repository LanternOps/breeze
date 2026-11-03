// The proposal's opening: "Valid until" (quotes.expiry_date) and the intro notes
// (quotes.intro_notes). Both print on the customer document — the date in the
// header's dates column, the notes above the first section — so they sit at the
// top of the editor's blocks column, in document order (#9859).
//
// Presentational only: QuoteEditor owns the drafts and the blur-saves so they
// share runScoped's pending/failed bookkeeping (and with it the Send gate) with
// every other editor field.
import { useTranslation } from 'react-i18next';
import '../../../lib/i18n';
import { UnsavedBadge } from '../billingUi';
import { SrSaved, fieldRing } from './quoteEditorShared';

/** API limit for intro notes (updateQuoteSchema.introNotes). */
export const QUOTE_INTRO_NOTES_MAX = 5000;

/** Today's UTC calendar day (YYYY-MM-DD). The server expires a quote once the
 *  UTC day has moved past its expiry_date (apps/api/src/services/quoteExpiry.ts),
 *  so "has this date passed?" must be asked in UTC too, not local time. */
export function utcToday(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

interface FieldState<T> {
  value: T;
  dirty: boolean;
  saved: boolean;
  busy: boolean;
  onChange: (value: T) => void;
  onBlur: () => void;
}

interface Props {
  canWrite: boolean;
  /** YYYY-MM-DD, or '' for no expiry. */
  expiry: FieldState<string>;
  intro: FieldState<string>;
}

export function QuoteIntroFields({ canWrite, expiry, intro }: Props) {
  const { t } = useTranslation('billing');
  const today = utcToday();
  // ISO dates compare lexicographically in chronological order.
  const expiryPast = expiry.value !== '' && expiry.value < today;

  return (
    <div className="rounded-lg border bg-card p-4 shadow-xs" data-testid="quote-intro-fields">
      <div className="grid gap-4 sm:grid-cols-[minmax(0,12rem)_1fr]">
        <div>
          <div className="mb-1 flex items-center justify-between gap-2">
            <label htmlFor="quote-expiry-date" className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              {t('quotes.editor.intro.expiryLabel')}
            </label>
            <UnsavedBadge show={expiry.dirty} testId="quote-expiry-date-unsaved" />
          </div>
          <input
            id="quote-expiry-date"
            type="date"
            value={expiry.value}
            min={today}
            onChange={(e) => expiry.onChange(e.target.value)}
            onBlur={() => { if (canWrite) expiry.onBlur(); }}
            disabled={!canWrite || expiry.busy}
            aria-describedby="quote-expiry-date-help"
            data-testid="quote-expiry-date"
            className={`h-9 w-full rounded-md border bg-background px-3 text-sm transition-colors focus:outline-hidden focus:ring-2 focus:ring-ring disabled:opacity-60 ${fieldRing(expiry.dirty, expiry.saved)}`}
          />
          <p id="quote-expiry-date-help" className="mt-1 text-xs text-muted-foreground">
            {expiryPast ? (
              <span className="text-warning-foreground dark:text-warning" data-testid="quote-expiry-date-past">
                {t('quotes.editor.intro.expiryPast')}
              </span>
            ) : (
              t('quotes.editor.intro.expiryHelper')
            )}
          </p>
          <SrSaved show={expiry.saved} testId="quote-expiry-date-saved" />
        </div>

        <div className="min-w-0">
          <div className="mb-1 flex items-center justify-between gap-2">
            <label htmlFor="quote-intro-notes" className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              {t('quotes.editor.intro.notesLabel')}
            </label>
            <UnsavedBadge show={intro.dirty} testId="quote-intro-notes-unsaved" />
          </div>
          <textarea
            id="quote-intro-notes"
            value={intro.value}
            maxLength={QUOTE_INTRO_NOTES_MAX}
            rows={3}
            onChange={(e) => intro.onChange(e.target.value)}
            onBlur={() => { if (canWrite) intro.onBlur(); }}
            disabled={!canWrite || intro.busy}
            aria-describedby="quote-intro-notes-help"
            placeholder={t('quotes.editor.intro.notesPlaceholder')}
            data-testid="quote-intro-notes"
            className={`w-full rounded-md border bg-background px-3 py-2 text-sm transition-colors focus:outline-hidden focus:ring-2 focus:ring-ring disabled:opacity-60 ${fieldRing(intro.dirty, intro.saved)}`}
          />
          <p id="quote-intro-notes-help" className="mt-1 text-xs text-muted-foreground">
            {t('quotes.editor.intro.notesHelper')}
          </p>
          <SrSaved show={intro.saved} testId="quote-intro-notes-saved" />
        </div>
      </div>
    </div>
  );
}
