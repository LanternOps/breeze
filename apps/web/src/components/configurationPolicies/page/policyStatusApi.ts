import { i18n } from '@/lib/i18n';
import { runAction } from '@/lib/runAction';
import { navigateTo } from '@/lib/navigation';
import { fetchWithAuth } from '../../../stores/auth';
import type { PolicyStatus } from './PolicyHeader';

const EXECUTE_REQUIRED = 'oem_updates_execute_required';

function successMessage(next: PolicyStatus, from: PolicyStatus): string {
  if (next === 'active') return i18n.t('policies:configurationPolicies.policyStateActions.activatedToast');
  if (next === 'archived') return i18n.t('policies:configurationPolicies.policyStateActions.archivedToast');
  if (from === 'archived') return i18n.t('policies:configurationPolicies.policyStateActions.restoredToast');
  return i18n.t('policies:configurationPolicies.policyStateActions.deactivatedToast');
}

/**
 * The existing status PATCH (no new endpoint), through runAction. The
 * server's OEM-updates arming gate on activation is the only gate; its
 * refusal comes back as readable copy. Throws the ActionError runAction
 * raised (already toasted).
 */
export async function changePolicyStatus(policyId: string, next: PolicyStatus, from: PolicyStatus): Promise<void> {
  await runAction({
    request: () =>
      fetchWithAuth(`/configuration-policies/${policyId}`, {
        method: 'PATCH',
        body: JSON.stringify({ status: next }),
      }),
    errorFallback: i18n.t('policies:configurationPolicies.policyStateActions.changeFailed'),
    friendly: (code) =>
      code === EXECUTE_REQUIRED
        ? i18n.t('policies:configurationPolicies.policyStateActions.activateExecuteRequired')
        : undefined,
    successMessage: successMessage(next, from),
    onUnauthorized: () => void navigateTo('/login', { replace: true }),
  });
}
