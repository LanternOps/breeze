import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { i18n } from '@/lib/i18n';
import { ActionError, runAction } from '@/lib/runAction';
import { fetchWithAuth } from '../../../stores/auth';
import { showToast } from '../../shared/Toast';
import type { PolicyStatus } from './PolicyHeader';

export type PolicyDetails = { name: string; description: string; status: PolicyStatus };

type PolicyDetailsFormProps = {
  policyId: string;
  /** The saved values. The form starts from them each time it opens. */
  initial: PolicyDetails;
  onSaved: (next: PolicyDetails) => void;
  onCancel: () => void;
  /** Reports whether the form differs from `initial`, for the unsaved-changes guard. */
  onDirtyChange?: (dirty: boolean) => void;
};

const inputClass =
  'mt-2 h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring';

/**
 * The policy's name, description and status, with Save and Cancel
 * (spec "Save model": a small details form). It replaces the Overview tab.
 * Status stays here until Activate and Deactivate replace it (W03c).
 */
export default function PolicyDetailsForm({ policyId, initial, onSaved, onCancel, onDirtyChange }: PolicyDetailsFormProps) {
  useTranslation(['policies', 'common']);
  const [name, setName] = useState(initial.name);
  const [description, setDescription] = useState(initial.description);
  const [status, setStatus] = useState<PolicyStatus>(initial.status);
  const [saving, setSaving] = useState(false);

  const dirty = name !== initial.name || description !== initial.description || status !== initial.status;
  useEffect(() => {
    onDirtyChange?.(dirty);
  }, [dirty, onDirtyChange]);

  const save = async () => {
    const next: PolicyDetails = { name: name.trim(), description, status };
    setSaving(true);
    try {
      await runAction({
        request: () =>
          fetchWithAuth(`/configuration-policies/${policyId}`, {
            method: 'PATCH',
            body: JSON.stringify({
              name: next.name,
              description: next.description || undefined,
              status: next.status,
            }),
          }),
        errorFallback: i18n.t('policies:configurationPolicies.configPolicyDetailPage.failedToUpdatePolicy'),
        successMessage: i18n.t('policies:configurationPolicies.configPolicyDetailPage.detailsSaved'),
      });
      onSaved(next);
    } catch (err) {
      if (err instanceof ActionError && err.status === 401) return; // auth redirect handles it
      if (!(err instanceof ActionError)) {
        showToast({
          type: 'error',
          message: i18n.t('policies:configurationPolicies.configPolicyDetailPage.failedToUpdatePolicy'),
        });
      }
    } finally {
      setSaving(false);
    }
  };

  const cancel = () => {
    setName(initial.name);
    setDescription(initial.description);
    setStatus(initial.status);
    onDirtyChange?.(false);
    onCancel();
  };

  return (
    <form
      data-testid="config-policy-details-form"
      className="rounded-lg border bg-card p-6 shadow-xs"
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <h2 className="text-lg font-semibold">
        {i18n.t('policies:configurationPolicies.configPolicyDetailPage.policyDetails')}
      </h2>
      <div className="mt-4 grid gap-4">
        <div>
          <label htmlFor="config-policy-name" className="text-sm font-medium">
            {i18n.t('common:labels.name')}
          </label>
          <input id="config-policy-name" value={name} onChange={(e) => setName(e.target.value)} className={inputClass} />
        </div>
        <div>
          <label htmlFor="config-policy-description" className="text-sm font-medium">
            {i18n.t('common:labels.description')}
          </label>
          <textarea
            id="config-policy-description"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            className="mt-2 h-20 w-full rounded-md border bg-background px-3 py-2 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
          />
        </div>
        <div>
          <label htmlFor="config-policy-status" className="text-sm font-medium">
            {i18n.t('common:labels.status')}
          </label>
          <select
            id="config-policy-status"
            value={status}
            onChange={(e) => setStatus(e.target.value as PolicyStatus)}
            className={`${inputClass} sm:w-48`}
          >
            <option value="active">{i18n.t('common:states.active')}</option>
            <option value="inactive">{i18n.t('common:states.inactive')}</option>
            <option value="archived">{i18n.t('policies:configurationPolicies.configPolicyDetailPage.archived2')}</option>
          </select>
        </div>
      </div>
      <div className="mt-6 flex justify-end gap-3">
        <button
          type="button"
          onClick={cancel}
          disabled={saving}
          data-testid="config-policy-details-cancel"
          className="h-10 rounded-md border px-4 text-sm font-medium transition hover:bg-muted disabled:opacity-50"
        >
          {i18n.t('common:actions.cancel')}
        </button>
        <button
          type="submit"
          disabled={saving || name.trim() === ''}
          data-testid="config-policy-details-save"
          className="h-10 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground transition hover:opacity-90 disabled:opacity-50"
        >
          {saving
            ? i18n.t('policies:configurationPolicies.configPolicyDetailPage.saving')
            : i18n.t('policies:configurationPolicies.configPolicyDetailPage.saveChanges')}
        </button>
      </div>
    </form>
  );
}
