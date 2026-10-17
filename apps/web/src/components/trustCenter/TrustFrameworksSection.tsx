// Owner: W02e (framework view picker). The publisher chooses which frameworks the public page maps its
// controls to. CIS v8 is gated by the deployment (BREEZE_TRUST_CIS_FRAMEWORK_VIEW, surfaced here as
// `available: false`); the partner's country can suggest one. null on the page = inherit.
import { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { FRAMEWORK_META, TRUST_FRAMEWORKS, type TrustFramework } from '@breeze/shared';
import { updateTrustPage, type TrustSectionProps } from '@/lib/api/trustPage';
import { handleActionError, runAction } from '@/lib/runAction';

export default function TrustFrameworksSection({ orgId, orgFetch, state, canWrite, onReload }: TrustSectionProps) {
  const { t } = useTranslation('organizations');
  const tr = useCallback(
    (key: string, vars?: Record<string, unknown>) => t(/* i18n-dynamic */ `orgRecord.trust.frameworks.${key}`, vars ?? {}),
    [t],
  );
  const [selection, setSelection] = useState<TrustFramework[]>(state.effective.values.frameworkView);
  const [busy, setBusy] = useState(false);
  const revision = state.page.publicationRevision;
  const inheriting = state.page.frameworkView === null;
  const source = state.effective.sources.frameworkView;

  const toggle = (fw: TrustFramework) => {
    setSelection((prev) => (prev.includes(fw) ? prev.filter((f) => f !== fw) : [...prev, fw]));
  };

  const save = async (frameworkView: TrustFramework[] | null) => {
    if (!canWrite) return;
    setBusy(true);
    try {
      await runAction({
        request: () => updateTrustPage(orgFetch, orgId, { frameworkView, expectedRevision: revision }),
        successMessage: tr('saved'),
        errorFallback: tr('saveFailed'),
        friendly: (code) => ({ REVISION_MISMATCH: tr('revisionChanged') } as Record<string, string>)[code],
      });
      await onReload();
    } catch (err) {
      handleActionError(err, tr('saveFailed'));
    } finally {
      setBusy(false);
    }
  };

  const options = TRUST_FRAMEWORKS.map((fw) => state.frameworkOptions.find((o) => o.framework === fw) ?? { framework: fw, available: fw !== 'cis_v8', suggested: false });

  return (
    <section className="space-y-4 rounded-lg border bg-card p-4" data-testid="trust-frameworks-section">
      <h3 className="text-base font-semibold">{tr('title')}</h3>
      <p className="text-sm text-muted-foreground">{tr('description')}</p>
      <p className="text-xs text-muted-foreground" data-testid="trust-frameworks-source">{tr(`source.${source}`)}</p>

      <ul className="space-y-2">
        {options.map((o) => (
          <li key={o.framework} className="flex flex-wrap items-center gap-2 text-sm">
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={selection.includes(o.framework) && o.available}
                disabled={!canWrite || !o.available}
                onChange={() => toggle(o.framework)}
                data-testid={`trust-frameworks-option-${o.framework}`}
              />
              <span>{FRAMEWORK_META[o.framework].name}</span>
            </label>
            {o.suggested && (
              <span className="rounded-full border px-2 py-0.5 text-xs" data-testid={`trust-frameworks-suggested-${o.framework}`}>
                {tr('suggested')}
              </span>
            )}
            {!o.available && o.framework === 'cis_v8' && (
              <span className="text-xs text-muted-foreground" data-testid="trust-frameworks-cis-hint">{tr('cisLocked')}</span>
            )}
          </li>
        ))}
      </ul>

      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          className="rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground disabled:opacity-60"
          disabled={!canWrite || busy}
          onClick={() => void save(TRUST_FRAMEWORKS.filter((fw) => selection.includes(fw) && options.find((o) => o.framework === fw)?.available))}
          data-testid="trust-frameworks-save"
        >
          {tr('save')}
        </button>
        <button
          type="button"
          className="rounded-md border px-3 py-2 text-sm disabled:opacity-60"
          disabled={!canWrite || busy || inheriting}
          onClick={() => void save(null)}
          data-testid="trust-frameworks-use-default"
        >
          {tr('useDefault')}
        </button>
      </div>
    </section>
  );
}
