import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ActionError, runAction } from '@/lib/runAction';
import { fetchWithAuth, handleSessionExpired } from '@/stores/auth';

/**
 * `organizations.ai_external_processing` — the per-org consent switch for
 * sandboxed analysis (execution-plane spec §8, §11 step 4).
 *
 * Opt-in, default OFF, and deliberately NOT inherited from the partner: this is
 * a data-residency consent flag, not a config policy. An org that never said
 * yes must not acquire external processing because someone changed a default
 * above it. It is enforced at run ADMISSION (`runService.ts`), not in the
 * process-memoized tool catalog — flipping it here takes effect on the next
 * run, with no deploy and no cache to wait out.
 *
 * The checkbox state reverts on failure. A switch that stays on after a refused
 * save tells an administrator their customer consented when they did not.
 */
export default function OrgAiProcessingToggle({
  orgId,
  value,
  onSaved,
}: {
  orgId: string;
  value: boolean;
  onSaved: () => void;
}) {
  const { t } = useTranslation('settings');
  const [checked, setChecked] = useState(value);
  const [busy, setBusy] = useState(false);

  const toggle = async (next: boolean) => {
    if (busy) return;
    setChecked(next);
    setBusy(true);
    try {
      await runAction({
        request: () =>
          fetchWithAuth(`/orgs/organizations/${orgId}`, {
            method: 'PATCH',
            body: JSON.stringify({ aiExternalProcessing: next }),
          }),
        successMessage: t('orgSettingsPage.ai.externalProcessingSaved'),
        errorFallback: t('orgSettingsPage.ai.externalProcessingSaveFailed'),
        onUnauthorized: handleSessionExpired,
      });
      onSaved();
    } catch (err) {
      setChecked(!next);
      if (!(err instanceof ActionError)) throw err;
    } finally {
      setBusy(false);
    }
  };

  return (
    <label className="flex items-start gap-3 rounded-md border bg-muted/30 p-3">
      <input
        type="checkbox"
        data-testid="org-ai-external-processing"
        checked={checked}
        disabled={busy}
        onChange={(e) => void toggle(e.target.checked)}
        className="mt-0.5"
      />
      <span>
        <span className="block text-sm font-medium">{t('orgSettingsPage.ai.externalProcessing')}</span>
        <span className="block text-xs text-muted-foreground">
          {t('orgSettingsPage.ai.externalProcessingDescription')}
        </span>
      </span>
    </label>
  );
}
