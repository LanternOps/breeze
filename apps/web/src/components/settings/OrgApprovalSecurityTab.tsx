import { useEffect, useState } from 'react';
import { Loader2, ShieldCheck } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import '@/lib/i18n';
import {
  DEFAULT_ASSURANCE_FLOOR,
  MAX_REACHABLE_ASSURANCE,
  type RiskTier,
  type AssuranceLevel,
} from '@breeze/shared';
import {
  getAuthenticatorPolicyState,
  putAuthenticatorPolicy,
  type AuthenticatorPolicy,
  type AuthenticatorPolicyState,
} from '../../stores/authenticatorPolicy';
import { ApproverAssuranceDefaultNotice, formatPolicyDate } from '../approvals/ApproverAssuranceNotice';
import { runAction, ActionError } from '../../lib/runAction';
import { showToast } from '../shared/Toast';
import { useStableT } from '@/lib/i18n/useStableT';

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
type EnforcementChoice = 'inherit' | 'required' | 'not_required';

function choiceOf(requireEnrollment: boolean | null): EnforcementChoice {
  if (requireEnrollment === null) return 'inherit';
  return requireEnrollment ? 'required' : 'not_required';
}
const REQUIRE_ENROLLMENT_FOR: Record<EnforcementChoice, boolean | null> = {
  inherit: null,
  required: true,
  not_required: false,
};

/**
 * Breeze Authenticator (Phase 4) — partner "Approval Security" admin tab. Sets
 * the per-tier required assurance floor (raise-only above the Breeze default),
 * whether an approver device is required (Platform default / Required / Not
 * required), and the grace cutoff for an explicit Required choice. The
 * Platform default choice shows the inherited value and where it comes from.
 */
export function OrgApprovalSecurityTab() {
  const { t, i18n } = useTranslation('settings');
  const stableT = useStableT(t); // #3632: effect-safe translator; JSX keeps `t`
  const [policy, setPolicy] = useState<AuthenticatorPolicy | null>(null);
  const [serverState, setServerState] = useState<AuthenticatorPolicyState | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | undefined>();
  const [isSaving, setIsSaving] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const state = await getAuthenticatorPolicyState();
        if (active) {
          setServerState(state);
          setPolicy(state.policy);
        }
      } catch {
        if (active) setLoadError(stableT('orgApprovalSecurityTab.errors.load'));
      } finally {
        if (active) setIsLoading(false);
      }
    })();
    return () => {
      active = false;
    };
  }, [stableT, reloadKey]);

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
        request: () =>
          putAuthenticatorPolicy({
            ...policy,
            // Only an explicit Required choice carries its own date.
            enforceFrom: policy.requireEnrollment === true ? policy.enforceFrom : null,
          }),
        successMessage: t('orgApprovalSecurityTab.toasts.saved'),
        errorFallback: t('orgApprovalSecurityTab.errors.save'),
      });
      // Reload so the inherited value / notice reflect what was saved.
      setReloadKey((k) => k + 1);
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

  const choice = choiceOf(policy.requireEnrollment);
  const platformDefaultDate = serverState?.platformDefault.enforceFrom
    ? formatPolicyDate(serverState.platformDefault.enforceFrom, i18n.language)
    : null;

  return (
    <div className="space-y-6 p-1" data-testid="approval-security-tab">
      {serverState && <ApproverAssuranceDefaultNotice effective={serverState.effective} />}

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
                    // Levels an approver device cannot produce for this tier
                    // are shown but disabled; the server refuses them too.
                    <option key={lvl} value={lvl} disabled={lvl > MAX_REACHABLE_ASSURANCE[tier]}>
                      {t(/* i18n-dynamic */ LEVEL_LABEL_KEYS[lvl])}
                    </option>
                  ))}
              </select>
            </div>
          );
        })}
        <p className="text-xs text-muted-foreground" data-testid="floor-unreachable-hint">
          {t('orgApprovalSecurityTab.unreachableLevelHint')}
        </p>
      </div>

      <div className="space-y-2">
        <label className="block text-sm">
          <span className="mb-1 block font-medium">{t('orgApprovalSecurityTab.requireEnrollment')}</span>
          <select
            data-testid="enforcement-choice"
            className="rounded-md border bg-background px-2 py-1 text-sm"
            value={choice}
            onChange={(e) =>
              setPolicy({
                ...policy,
                requireEnrollment: REQUIRE_ENROLLMENT_FOR[e.target.value as EnforcementChoice],
              })
            }
          >
            <option value="inherit">{t('orgApprovalSecurityTab.enforcement.inherit')}</option>
            <option value="required">{t('orgApprovalSecurityTab.enforcement.required')}</option>
            <option value="not_required">{t('orgApprovalSecurityTab.enforcement.notRequired')}</option>
          </select>
        </label>
        {choice === 'inherit' && platformDefaultDate && (
          <div className="rounded-md bg-muted/50 p-3 text-sm" data-testid="enforcement-inherited">
            <p>{t('orgApprovalSecurityTab.enforcement.inheritedValue', { date: platformDefaultDate })}</p>
            <p className="text-muted-foreground">{t('orgApprovalSecurityTab.enforcement.inheritedSource')}</p>
          </div>
        )}
        {choice === 'required' && (
          <p className="text-sm text-muted-foreground">{t('orgApprovalSecurityTab.enforcement.requiredHint')}</p>
        )}
        {choice === 'not_required' && (
          <p className="text-sm text-muted-foreground">{t('orgApprovalSecurityTab.enforcement.notRequiredHint')}</p>
        )}
      </div>

      {choice === 'required' && (
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
          <span className="mt-1 block text-xs text-muted-foreground">
            {t('orgApprovalSecurityTab.enforceFromHint')}
          </span>
        </label>
      )}

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
