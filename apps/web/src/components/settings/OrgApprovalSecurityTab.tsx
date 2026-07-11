import { useEffect, useState } from 'react';
import { Loader2, ShieldCheck } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import '@/lib/i18n';
import { DEFAULT_ASSURANCE_FLOOR, type RiskTier, type AssuranceLevel } from '@breeze/shared';
import {
  getAuthenticatorPolicy,
  putAuthenticatorPolicy,
  type AuthenticatorPolicy,
} from '../../stores/authenticatorPolicy';
import { runAction, ActionError } from '../../lib/runAction';
import { showToast } from '../shared/Toast';

const TIERS: RiskTier[] = ['low', 'medium', 'high', 'critical'];
const TIER_LABEL_KEYS: Record<RiskTier, string> = {
  low: 'orgApprovalSecurityTab.riskTiers.low',
  medium: 'orgApprovalSecurityTab.riskTiers.medium',
  high: 'orgApprovalSecurityTab.riskTiers.high',
  critical: 'orgApprovalSecurityTab.riskTiers.critical',
};
const LEVEL_LABEL_KEYS: Record<AssuranceLevel, string> = {
  1: 'orgApprovalSecurityTab.assuranceLevels.1',
  2: 'orgApprovalSecurityTab.assuranceLevels.2',
  3: 'orgApprovalSecurityTab.assuranceLevels.3',
  4: 'orgApprovalSecurityTab.assuranceLevels.4',
};
/**
 * Breeze Authenticator (Phase 4) — partner "Approval Security" admin tab. Sets
 * the per-tier required assurance floor (raise-only above the Breeze default),
 * whether enrollment is required to approve above L1, and the grace cutoff.
 */
export function OrgApprovalSecurityTab() {
  const { t } = useTranslation('settings');
  const [policy, setPolicy] = useState<AuthenticatorPolicy | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | undefined>();
  const [isSaving, setIsSaving] = useState(false);

  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const p = await getAuthenticatorPolicy();
        if (active) setPolicy(p);
      } catch {
        if (active) setLoadError(t('orgApprovalSecurityTab.errors.load'));
      } finally {
        if (active) setIsLoading(false);
      }
    })();
    return () => {
      active = false;
    };
  }, [t]);

  function setTierLevel(tier: RiskTier, level: AssuranceLevel) {
    setPolicy((prev) =>
      prev ? { ...prev, floorOverrides: { ...prev.floorOverrides, [tier]: level } } : prev,
    );
  }

  async function handleSave() {
    if (!policy) return;
    setIsSaving(true);
    try {
      await runAction({
        request: () => putAuthenticatorPolicy(policy),
        successMessage: t('orgApprovalSecurityTab.toasts.saved'),
        errorFallback: t('orgApprovalSecurityTab.errors.save'),
      });
    } catch (err) {
      if (!(err instanceof ActionError)) {
        showToast({ type: 'error', message: t('orgApprovalSecurityTab.errors.save') });
      }
    } finally {
      setIsSaving(false);
    }
  }

  if (isLoading) {
    return (
      <div className="flex items-center gap-2 p-6 text-muted-foreground" data-testid="approval-security-loading">
        <Loader2 className="h-4 w-4 animate-spin" /> {t('common:states.loading')}
      </div>
    );
  }
  if (loadError || !policy) {
    return (
      <div className="p-6 text-destructive" data-testid="approval-security-error">
        {loadError ?? t('orgApprovalSecurityTab.errors.unavailable')}
      </div>
    );
  }

  return (
    <div className="space-y-6 p-1" data-testid="approval-security-tab">
      <div className="flex items-start gap-3">
        <ShieldCheck className="mt-0.5 h-5 w-5 text-primary" />
        <div>
          <h3 className="text-lg font-semibold">{t('orgApprovalSecurityTab.title')}</h3>
          <p className="text-sm text-muted-foreground">
            {t('orgApprovalSecurityTab.description')}
          </p>
        </div>
      </div>

      <div className="space-y-3" data-testid="floor-overrides">
        {TIERS.map((tier) => {
          const floor = DEFAULT_ASSURANCE_FLOOR[tier];
          const current = policy.floorOverrides[tier] ?? floor;
          return (
            <div key={tier} className="flex items-center justify-between gap-4 rounded-md border p-3">
              <span className="text-sm font-medium capitalize">
                {t(/* i18n-dynamic */ TIER_LABEL_KEYS[tier])}
              </span>
              <select
                data-testid={`level-${tier}`}
                className="rounded-md border bg-background px-2 py-1 text-sm"
                value={current}
                onChange={(e) => setTierLevel(tier, Number(e.target.value) as AssuranceLevel)}
              >
                {/* raise-only: options below the Breeze floor are not offered */}
                {([1, 2, 3, 4] as AssuranceLevel[])
                  .filter((lvl) => lvl >= floor)
                  .map((lvl) => (
                    <option key={lvl} value={lvl}>
                      {t(/* i18n-dynamic */ LEVEL_LABEL_KEYS[lvl])}
                    </option>
                  ))}
              </select>
            </div>
          );
        })}
      </div>

      <label className="flex items-center gap-2 text-sm" data-testid="require-enrollment">
        <input
          type="checkbox"
          checked={policy.requireEnrollment}
          onChange={(e) => setPolicy({ ...policy, requireEnrollment: e.target.checked })}
        />
        {t('orgApprovalSecurityTab.requireEnrollment')}
      </label>

      <label className="block text-sm">
        <span className="mb-1 block text-muted-foreground">
          {t('orgApprovalSecurityTab.enforceFrom')}
        </span>
        <input
          type="date"
          data-testid="enforce-from"
          className="rounded-md border bg-background px-2 py-1"
          value={policy.enforceFrom ? policy.enforceFrom.slice(0, 10) : ''}
          onChange={(e) =>
            setPolicy({
              ...policy,
              enforceFrom: e.target.value ? new Date(e.target.value).toISOString() : null,
            })
          }
        />
      </label>

      <button
        type="button"
        data-testid="save-approval-security"
        onClick={handleSave}
        disabled={isSaving}
        className="inline-flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm text-primary-foreground disabled:opacity-60"
      >
        {isSaving && <Loader2 className="h-4 w-4 animate-spin" />}
        {t('common:actions.save')}
      </button>
    </div>
  );
}
