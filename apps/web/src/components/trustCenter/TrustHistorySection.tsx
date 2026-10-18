// Owner: W02f (controls-met history toggle). Autosaves with a toast (settings rule 7). The value shown is the
// EFFECTIVE one (page → partner template → default) with its source; flipping it writes the page's own value.
import { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { updateTrustPage, type TrustSectionProps } from '@/lib/api/trustPage';
import { handleActionError, runAction } from '@/lib/runAction';

export default function TrustHistorySection({ orgId, orgFetch, state, canWrite, onReload }: TrustSectionProps) {
  const { t } = useTranslation('organizations');
  const tr = useCallback(
    (key: string) => t(/* i18n-dynamic */ `orgRecord.trust.history.${key}`),
    [t],
  );
  const [busy, setBusy] = useState(false);
  const checked = state.effective.values.showHistory;
  const source = state.effective.sources.showHistory;

  const toggle = async (next: boolean) => {
    if (!canWrite || busy) return;
    setBusy(true);
    try {
      await runAction({
        request: () => updateTrustPage(orgFetch, orgId, { showHistory: next, expectedRevision: state.page.publicationRevision }),
        successMessage: tr('saved'),
        errorFallback: tr('saveFailed'),
      });
      await onReload();
    } catch (err) {
      handleActionError(err, tr('saveFailed'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="space-y-3 rounded-lg border bg-card p-4" data-testid="trust-history-section">
      <h3 className="text-base font-semibold">{tr('title')}</h3>
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          role="switch"
          checked={checked}
          disabled={!canWrite || busy}
          onChange={(e) => void toggle(e.target.checked)}
          data-testid="trust-history-toggle"
        />
        <span>{tr('toggle')}</span>
        <span className="rounded border px-1.5 py-0.5 text-xs text-muted-foreground" data-testid="trust-history-source" data-source={source}>
          {tr(`source.${source}`)}
        </span>
      </label>
      <p className="text-xs text-muted-foreground">{tr('description')}</p>
    </section>
  );
}
