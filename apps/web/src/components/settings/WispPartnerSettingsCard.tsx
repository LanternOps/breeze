import { useEffect, useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Sparkles } from 'lucide-react';
import { useEntitlement } from '@/hooks/useEntitlement';
import { useJwtClaims } from '@/lib/authScope';
import { useWispEnabled } from '@/lib/wispVisibility';
import { getWispPartnerEnabled, setWispPartnerEnabled } from '@/lib/wispPartnerSettingsApi';
import { ActionError } from '@/lib/runAction';
import { showToast } from '@/components/shared/Toast';
import { useAuthStore } from '@/stores/auth';

/**
 * Settings → AI Agents → Wisp: the partner's "Wisp enabled" switch (W08, w00
 * A35, spec §17.2 (4)). Settings rule 9: home here, partner level only (no
 * org override, no snapshot), resolver `getPartnerSettings(partnerId).enabled`
 * (default on), configured in this one place. Governance, not the commercial
 * gate (entitlement) or the kill switch (BREEZE_WISP_ENABLED): off pauses
 * running delegations at their next check and blocks new ones; on resumes only
 * what this switch paused. Autosave with a toast (rule 7).
 *
 * Rendered only where Wisp exists for this viewer — server flag on, partner
 * token, entitlement — so with the flag off the page is unchanged.
 */
export default function WispPartnerSettingsCard() {
  const { t } = useTranslation('ai');
  const serverOn = useWispEnabled();
  const claims = useJwtClaims();
  const entitlement = useEntitlement('wisp');
  // The server is the authority (PUT is partner-admin only); this only avoids offering a control that can only 403.
  const canManage = useAuthStore((s) => s.user?.canManagePartnerWide === true);
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [saving, setSaving] = useState(false);
  const labelId = useId();

  const visible = serverOn && claims.status === 'resolved' && claims.claims.scope === 'partner' && entitlement.state === 'enabled';

  useEffect(() => {
    if (!visible) return;
    let live = true;
    getWispPartnerEnabled()
      .then((value) => { if (live) { setEnabled(value); setLoadFailed(false); } })
      .catch((err: unknown) => {
        console.error('[WispPartnerSettingsCard] reading the Wisp switch failed', err);
        if (live) setLoadFailed(true);
      });
    return () => { live = false; };
  }, [visible]);

  if (!visible) return null;

  const toggle = async () => {
    if (enabled === null || saving || !canManage) return;
    setSaving(true);
    try {
      setEnabled(await setWispPartnerEnabled(!enabled));
    } catch (err) {
      if (err instanceof ActionError && err.status === 401) return; // auth redirect handles it
      if (!(err instanceof ActionError)) showToast({ type: 'error', message: t('wisp.partnerSwitch.saveFailed') }); // ActionError already toasted
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="rounded-lg border bg-card p-4" data-testid="wisp-partner-switch-card" aria-labelledby={`${labelId}-title`}>
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0 space-y-1">
          <h2 id={`${labelId}-title`} className="flex items-center gap-1.5 text-sm font-semibold">
            <Sparkles className="h-4 w-4 text-primary" aria-hidden="true" />
            {t('wisp.title')}
          </h2>
          <p className="text-xs text-muted-foreground">{t('wisp.partnerSwitch.description')}</p>
        </div>
        {loadFailed ? (
          <p className="shrink-0 text-xs text-destructive" data-testid="wisp-partner-switch-load-error">{t('wisp.partnerSwitch.loadFailed')}</p>
        ) : enabled !== null && (
          <div className="flex shrink-0 items-center gap-2">
            <span id={labelId} className="text-xs font-medium">{t('wisp.partnerSwitch.label')}</span>
            <button
              type="button"
              role="switch"
              aria-checked={enabled}
              aria-labelledby={labelId}
              disabled={saving || !canManage}
              onClick={() => void toggle()}
              data-testid="wisp-partner-switch"
              className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full border transition focus:outline-hidden focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-60 ${
                enabled ? 'bg-emerald-500/80' : 'bg-muted'
              }`}
            >
              <span
                aria-hidden="true"
                className={`inline-block h-4 w-4 transform rounded-full bg-white shadow transition ${enabled ? 'translate-x-6' : 'translate-x-1'}`}
              />
            </button>
          </div>
        )}
      </div>
      {!canManage && enabled !== null && (
        <p className="mt-2 text-[11px] text-muted-foreground" data-testid="wisp-partner-switch-admin-only">{t('wisp.partnerSwitch.adminOnly')}</p>
      )}
    </section>
  );
}
