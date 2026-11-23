import { useCallback } from 'react';
import { i18n } from '@/lib/i18n';
import { ActionError } from '@/lib/runAction';
import { showToast } from '../../shared/Toast';
import { applyAssignments } from '../appliesTo/appliesToApi';
import type { ApplyPayload } from '../appliesTo/appliesToDraft';
import type { EnsurePolicyResult } from '../featureTabs/policyCreateContext';
import { changePolicyStatus } from './policyStatusApi';

type Options = {
  /** The policy's id, creating it (inactive) when it does not exist yet. */
  ensurePolicy: (opts?: { successMessage?: string }) => Promise<EnsurePolicyResult>;
  /** Activate committed: the targets were applied and the status PATCH succeeded. */
  onActivated: (policyId: string) => void;
  /** The targets were applied but the activation was refused: the page re-reads where it applies. */
  onAppliedOnly: (policyId: string) => void;
  /** Don't apply yet: the policy exists, inactive and applied nowhere. */
  onLeftInactive: (policyId: string, created: boolean) => void;
};

const errorText = (err: unknown): string =>
  err instanceof Error && err.message ? err.message : i18n.t('policies:configurationPolicies.policyStateActions.changeFailed');

/**
 * Activate with an explicit applies-to decision (plan W03d C3; spec "Create:
 * inactive until activated"). Activate runs, in this order: create (if the
 * policy does not exist yet), Apply the staged targets, then the status
 * PATCH. A step that fails stops the sequence, so a failed Apply never
 * activates the policy. Each call resolves to an error message, '' when the
 * login redirect handles it, or null on success.
 */
export function usePolicyActivation({ ensurePolicy, onActivated, onAppliedOnly, onLeftInactive }: Options) {
  const onActivate = useCallback(
    async (payload: ApplyPayload): Promise<string | null> => {
      const ensured = await ensurePolicy();
      if (!ensured.ok) return ensured.message ?? '';
      const policyId = ensured.id;
      try {
        await applyAssignments(policyId, payload, { silentSuccess: true, toastConflict: true });
      } catch (err) {
        if (err instanceof ActionError && err.status === 401) return '';
        if (!(err instanceof ActionError)) {
          showToast({ type: 'error', message: i18n.t('policies:configurationPolicies.activation.applyFailedStaysInactive') });
        }
        return i18n.t('policies:configurationPolicies.activation.applyFailedStaysInactive');
      }
      try {
        await changePolicyStatus(policyId, 'active', 'inactive');
      } catch (err) {
        onAppliedOnly(policyId);
        if (err instanceof ActionError && err.status === 401) return '';
        if (!(err instanceof ActionError)) {
          showToast({ type: 'error', message: i18n.t('policies:configurationPolicies.policyStateActions.changeFailed') });
        }
        return i18n.t('policies:configurationPolicies.activation.activateFailedAfterApply', { reason: errorText(err) });
      }
      onActivated(policyId);
      return null;
    },
    [ensurePolicy, onActivated, onAppliedOnly],
  );

  const onDontApply = useCallback(async (): Promise<string | null> => {
    const ensured = await ensurePolicy({
      successMessage: i18n.t('policies:configurationPolicies.policyCreate.savedInactiveToast'),
    });
    if (!ensured.ok) return ensured.message ?? '';
    onLeftInactive(ensured.id, ensured.created);
    return null;
  }, [ensurePolicy, onLeftInactive]);

  return { onActivate, onDontApply };
}
