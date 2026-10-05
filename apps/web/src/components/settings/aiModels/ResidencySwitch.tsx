import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { AiResidencyImpactDto } from '@breeze/shared';
import { fetchWithAuth } from '../../../stores/auth';
import { runAction, ActionError } from '../../../lib/runAction';
import { showToast } from '../../shared/Toast';
import { navigateTo } from '@/lib/navigation';
import { Dialog } from '../../shared/Dialog';
import { SURFACE_LABEL_KEYS, registryFriendly } from './surfaceLabels';

const onUnauthorized = () => { void navigateTo('/login', { replace: true }); };

function hasImpact(impact: AiResidencyImpactDto): boolean {
  return impact.unavailableSurfaces.length > 0 || impact.affectedOrgOverrides.length > 0;
}

/** The impact the server attached to a 409 not_eligible, when it is well-formed. */
function impactFromError(err: unknown): AiResidencyImpactDto | null {
  if (!(err instanceof ActionError) || err.code !== 'not_eligible') return null;
  const details = (err.body as { details?: Partial<AiResidencyImpactDto> } | undefined)?.details;
  if (!details || !Array.isArray(details.unavailableSurfaces) || !Array.isArray(details.affectedOrgOverrides)) return null;
  return { unavailableSurfaces: details.unavailableSurfaces, affectedOrgOverrides: details.affectedOrgOverrides };
}

/** Partner "require EU/regional data residency" switch: autosave + toast (settings rule 7). */
export default function ResidencySwitch({ required, onSaved }: { required: boolean; onSaved: () => void | Promise<void> }) {
  const { t } = useTranslation('settings');
  const [checked, setChecked] = useState(required);
  const [busy, setBusy] = useState(false);
  const [impact, setImpact] = useState<AiResidencyImpactDto | null>(null);

  // The parent reloads the snapshot after a save; follow it.
  useEffect(() => { setChecked(required); }, [required]);

  const save = async (next: boolean, acknowledgeImpact: boolean) => {
    setChecked(next);
    setBusy(true);
    try {
      await runAction({
        request: () => fetchWithAuth('/ai/models/residency', {
          method: 'PUT',
          body: JSON.stringify(acknowledgeImpact ? { required: next, acknowledgeImpact: true } : { required: next }),
        }),
        successMessage: next ? t('aiModels.residency.savedOn') : t('aiModels.residency.savedOff'),
        errorFallback: t('aiModels.residency.saveFailed'),
        friendly: registryFriendly(t),
        onUnauthorized,
      });
      setImpact(null);
      await onSaved();
    } catch (err) {
      setChecked(!next);
      if (err instanceof ActionError && err.status === 401) return;
      // The preview raced a change: the server knows an impact we did not show. Ask again with it.
      const serverImpact = next && !acknowledgeImpact ? impactFromError(err) : null;
      if (serverImpact) { setImpact(serverImpact); return; }
      setImpact(null);
      if (!(err instanceof ActionError)) showToast({ type: 'error', message: t('aiModels.residency.saveFailed') });
      // non-401 ActionError already toasted by runAction
    } finally {
      setBusy(false);
    }
  };

  const onToggle = async (next: boolean) => {
    if (busy) return;
    if (!next) { await save(false, false); return; }
    setBusy(true);
    let preview: AiResidencyImpactDto;
    try {
      const res = await fetchWithAuth('/ai/models/residency/preview');
      if (res.status === 401) { onUnauthorized(); return; }
      if (!res.ok) throw new Error(`preview ${res.status}`);
      preview = (await res.json()) as AiResidencyImpactDto;
    } catch {
      // Never turn residency on without knowing what it breaks.
      showToast({ type: 'error', message: t('aiModels.residency.previewFailed') });
      return;
    } finally {
      setBusy(false);
    }
    if (hasImpact(preview)) setImpact(preview);
    else await save(true, false);
  };

  return (
    <>
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          data-testid="ai-residency-switch"
          checked={checked}
          disabled={busy}
          onChange={(e) => { void onToggle(e.target.checked); }}
        />
        <span>{t('aiModels.residency.label')}</span>
      </label>
      <Dialog
        open={impact !== null}
        onClose={() => { if (!busy) setImpact(null); }}
        title={t('aiModels.residency.confirmTitle')}
        maxWidth="md"
        className="p-6"
      >
        {impact && (
          <div data-testid="ai-residency-confirm" className="space-y-3 text-sm">
            <p>{t('aiModels.residency.confirmBody')}</p>
            <ul data-testid="ai-residency-confirm-surfaces" className="list-disc pl-5">
              {impact.unavailableSurfaces.map((s) => <li key={s}>{t(/* i18n-dynamic */ SURFACE_LABEL_KEYS[s])}</li>)}
            </ul>
            {impact.affectedOrgOverrides.length > 0 && (
              <ul data-testid="ai-residency-confirm-orgs" className="list-disc pl-5">
                {impact.affectedOrgOverrides.map((o) => (
                  <li key={`${o.orgId}/${o.surface}`}>
                    {t('aiModels.residency.orgOverride', { org: o.orgName ?? o.orgId, surface: t(/* i18n-dynamic */ SURFACE_LABEL_KEYS[o.surface]) })}
                  </li>
                ))}
              </ul>
            )}
            <div className="flex justify-end gap-2">
              <button
                type="button"
                data-testid="ai-residency-confirm-cancel"
                onClick={() => setImpact(null)}
                disabled={busy}
                className="rounded-md border px-3 py-1.5 font-medium transition-colors hover:bg-muted disabled:opacity-50"
              >
                {t('common:actions.cancel')}
              </button>
              <button
                type="button"
                data-testid="ai-residency-confirm-submit"
                onClick={() => { void save(true, true); }}
                disabled={busy}
                className="rounded-md bg-primary px-3 py-1.5 font-medium text-primary-foreground transition hover:opacity-90 disabled:opacity-50"
              >
                {t('aiModels.residency.confirmSubmit')}
              </button>
            </div>
          </div>
        )}
      </Dialog>
    </>
  );
}
