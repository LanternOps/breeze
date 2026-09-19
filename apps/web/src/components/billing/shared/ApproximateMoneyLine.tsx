import { useTranslation } from 'react-i18next';

import { selectApproxTotal } from '@/lib/reporting/approximateTotal';
import { useApproximateTotal } from '@/lib/useApproximateTotal';
import { formatMoney } from './format';

/** A partner whose book spans a dozen currencies must not push a one-line
 *  companion into a paragraph on seven surfaces. The overflow is COUNTED, never
 *  elided into an ellipsis: "and 4 more" still tells the reader how much they
 *  are not seeing, which a CSS truncation would not. */
const MAX_LISTED_CODES = 4;

/**
 * The optional "≈ X <partner currency>" companion line (multi-currency spec §8).
 *
 * It NEVER replaces the authoritative per-currency segmentation above it, and it
 * never shows a figure it cannot stand behind — a partial approximate total is
 * worse than none. All conversion and summation happened on the server; this
 * component only formats.
 *
 * What it does NOT do any more (#4415, the fourth hide-on-failure bug on this
 * surface): silently render nothing when the total could not be produced. A
 * suppressed FIGURE is not a suppressed LINE. `unavailable` and a failed request
 * both render an explicit, equally muted sentence naming what went wrong, so a
 * self-hoster with no exchange-rate feed learns why the total is absent instead
 * of seeing a line that never appears. Only two states render nothing, and both
 * are genuinely empty of information: the request is still in flight, and the
 * server answered `not-needed` because the book needs no conversion at all.
 */
export function ApproximateMoneyLine({ byCurrency, date, testId }: {
  byCurrency: readonly { code: string; amount: string | number }[];
  date?: string;
  testId?: string;
}) {
  const { t } = useTranslation('common');
  const { response, loading, failed } = useApproximateTotal(byCurrency, date);

  // Loading is the ONLY state that renders nothing on its own: a flash of
  // "unavailable" before the answer arrives would be its own kind of lie.
  if (loading) return null;

  const view = failed ? null : selectApproxTotal(response);
  if (view?.status === 'hidden') return null;

  const line = (state: string, text: string) => (
    <div
      className="text-xs text-muted-foreground"
      data-testid={testId ?? 'approximate-money-line'}
      data-approx-state={state}
    >
      {text}
    </div>
  );

  // A request that produced no answer at all: the server, the session or the
  // network is the problem, and there are no currency codes to name.
  if (!view) return line('failed', t('money.approximateFailed'));

  if (view.status === 'unavailable') {
    // Without codes or a target currency there is no pair to name, and the body
    // itself was unusable — say only what we actually know.
    if (view.currencyCodes.length === 0 || !view.targetCurrencyCode) {
      return line('unavailable', t('money.approximateFailed'));
    }
    const listed = view.currencyCodes.slice(0, MAX_LISTED_CODES).join(', ');
    const overflow = view.currencyCodes.length - MAX_LISTED_CODES;
    // `more`, not i18next's reserved `count`: this fragment has no plural forms
    // in any catalog, and passing `count` would send i18next hunting for
    // `_one`/`_other` keys that do not exist.
    const codes = overflow > 0
      ? t('money.approximateUnavailableCodesOverflow', { codes: listed, more: overflow })
      : listed;
    // Literal keys, deliberately — a lookup table would read as a dynamic key
    // and the `keyUsage` guard could no longer prove these three entries are
    // still in the catalogs.
    const vars = { codes, target: view.targetCurrencyCode };
    if (view.reason === 'missing') return line('unavailable', t('money.approximateUnavailableMissing', vars));
    if (view.reason === 'stale') return line('unavailable', t('money.approximateUnavailableStale', vars));
    return line('unavailable', t('money.approximateUnavailableMixed', vars));
  }

  return line('available', t('money.approximateTotal', {
    amount: formatMoney(view.amount, view.currencyCode),
    rateDate: view.rateDate,
  }));
}

export default ApproximateMoneyLine;
