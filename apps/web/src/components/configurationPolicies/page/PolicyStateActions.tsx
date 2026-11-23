import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Archive, Pause, Play, RotateCcw } from 'lucide-react';
import { i18n } from '@/lib/i18n';
import { ActionError, runAction } from '@/lib/runAction';
import { navigateTo } from '@/lib/navigation';
import { fetchWithAuth } from '../../../stores/auth';
import { showToast } from '../../shared/Toast';
import { ConfirmDialog } from '../../shared/ConfirmDialog';
import type { ConfigPolicyReach } from '../appliesTo/appliesToApi';
import type { PolicyStatus } from './PolicyHeader';
import { deviceCountPhrase, policyCountPhrase, reachPhrase } from './ReachLine';

type PolicyStateActionsProps = {
  policyId: string;
  status: PolicyStatus;
  /** null = unknown: the actions state no count. */
  reach: ConfigPolicyReach | null;
  /** Policies based on this one that the caller can see. */
  childPolicyCount: number;
  /** A read-only viewer gets no control at all. */
  readOnly: boolean;
  /** The PATCH succeeded; the page shows the new status and re-reads the policy. */
  onChanged: (next: PolicyStatus) => void;
};

const EXECUTE_REQUIRED = 'oem_updates_execute_required';

const btn =
  'inline-flex h-8 items-center gap-1.5 rounded-md border px-3 text-sm font-medium transition disabled:opacity-50';

/**
 * Activate and Deactivate (spec "Save model": state is an explicit action that
 * states its reach; plan W03c F3). They are the existing status PATCH, through
 * runAction: no new endpoint, and no client-side arming check. The server's
 * OEM-updates arming gate on activation stays the only gate, and its refusal
 * is shown here, not swallowed.
 *
 * The count is the policy's DIRECT reach: that is what changes on devices. A
 * parent is never inert, so the policies based on it keep its settings
 * whatever its status; Deactivate says so.
 *
 * Status used to sit in the details form; this is now its one home, so
 * Archive (from Inactive) and Restore (to Inactive) live here too.
 */
export default function PolicyStateActions({
  policyId,
  status,
  reach,
  childPolicyCount,
  readOnly,
  onChanged,
}: PolicyStateActionsProps) {
  useTranslation('policies');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmDeactivate, setConfirmDeactivate] = useState(false);

  if (readOnly) return null;

  const directReach = reach
    ? reachPhrase({ kind: 'reaches', devices: reach.direct, partial: reach.partial === true })
    : null;

  const successMessage = (next: PolicyStatus, from: PolicyStatus): string => {
    if (next === 'active') return i18n.t('policies:configurationPolicies.policyStateActions.activatedToast');
    if (next === 'archived') return i18n.t('policies:configurationPolicies.policyStateActions.archivedToast');
    if (from === 'archived') return i18n.t('policies:configurationPolicies.policyStateActions.restoredToast');
    return i18n.t('policies:configurationPolicies.policyStateActions.deactivatedToast');
  };

  const change = async (next: PolicyStatus) => {
    setBusy(true);
    setError(null);
    let changed = false;
    try {
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
        successMessage: successMessage(next, status),
        onUnauthorized: () => void navigateTo('/login', { replace: true }),
      });
      changed = true;
    } catch (err) {
      if (err instanceof ActionError && err.status === 401) return; // auth redirect handles it
      if (!(err instanceof ActionError)) {
        console.error('[configuration policies] status change failed', err);
        showToast({
          type: 'error',
          message: i18n.t('policies:configurationPolicies.policyStateActions.changeFailed'),
        });
      }
      // Shown beside the actions too, so a refused Activate (the arming gate)
      // is still readable after the toast has gone.
      setError(
        err instanceof Error && err.message
          ? err.message
          : i18n.t('policies:configurationPolicies.policyStateActions.changeFailed'),
      );
    } finally {
      setBusy(false);
    }
    if (!changed) return;
    try {
      onChanged(next);
    } catch (err) {
      console.error('[configuration policies] after the status change', err);
    }
  };

  const deactivateMessage = () => {
    const parts = [i18n.t('policies:configurationPolicies.policyStateActions.deactivateConfirmMessage')];
    if (reach) {
      if (reach.direct === 0 && reach.partial !== true) {
        parts.push(i18n.t('policies:configurationPolicies.policyStateActions.deactivateImpactNoneVisible'));
      } else {
        parts.push(
          i18n.t('policies:configurationPolicies.policyStateActions.deactivateImpactDirect', {
            devices: deviceCountPhrase(reach.direct, reach.partial === true),
          }),
        );
      }
      if (childPolicyCount > 0) {
        parts.push(
          i18n.t('policies:configurationPolicies.policyStateActions.deactivateImpactChildren', {
            policies: policyCountPhrase(childPolicyCount),
            devices: deviceCountPhrase(reach.throughChildren, reach.partial === true),
          }),
        );
      }
    }
    return parts.join(' ');
  };

  return (
    <div className="flex flex-wrap items-center gap-2" data-testid="config-policy-state-actions">
      {status !== 'active' && (
        <button
          type="button"
          data-testid="config-policy-activate"
          disabled={busy}
          onClick={() => void change('active')}
          className={`${btn} border-primary/40 bg-primary text-primary-foreground hover:opacity-90`}
        >
          <Play className="h-3.5 w-3.5" aria-hidden="true" />
          {directReach
            ? i18n.t('policies:configurationPolicies.policyStateActions.activateWithReach', { reach: directReach })
            : i18n.t('policies:configurationPolicies.policyStateActions.activateAction')}
        </button>
      )}
      {status === 'active' && (
        <button
          type="button"
          data-testid="config-policy-deactivate"
          disabled={busy}
          onClick={() => setConfirmDeactivate(true)}
          className={`${btn} hover:bg-muted`}
        >
          <Pause className="h-3.5 w-3.5" aria-hidden="true" />
          {i18n.t('policies:configurationPolicies.policyStateActions.deactivateAction')}
        </button>
      )}
      {status === 'inactive' && (
        <button
          type="button"
          data-testid="config-policy-archive"
          disabled={busy}
          onClick={() => void change('archived')}
          className={`${btn} hover:bg-muted`}
        >
          <Archive className="h-3.5 w-3.5" aria-hidden="true" />
          {i18n.t('policies:configurationPolicies.policyStateActions.archiveAction')}
        </button>
      )}
      {status === 'archived' && (
        <button
          type="button"
          data-testid="config-policy-restore"
          disabled={busy}
          title={i18n.t('policies:configurationPolicies.policyStateActions.restoreHint')}
          onClick={() => void change('inactive')}
          className={`${btn} hover:bg-muted`}
        >
          <RotateCcw className="h-3.5 w-3.5" aria-hidden="true" />
          {i18n.t('policies:configurationPolicies.policyStateActions.restoreAction')}
        </button>
      )}
      {error && (
        <p role="alert" data-testid="config-policy-state-error" className="basis-full text-sm text-destructive">
          {error}
        </p>
      )}
      <ConfirmDialog
        open={confirmDeactivate}
        onClose={() => setConfirmDeactivate(false)}
        onConfirm={() => {
          setConfirmDeactivate(false);
          void change('inactive');
        }}
        title={i18n.t('policies:configurationPolicies.policyStateActions.deactivateConfirmTitle')}
        message={deactivateMessage()}
        confirmLabel={i18n.t('policies:configurationPolicies.policyStateActions.deactivateAction')}
        variant="warning"
        confirmTestId="config-policy-deactivate-confirm"
      />
    </div>
  );
}
