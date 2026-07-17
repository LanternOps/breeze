import '@/lib/i18n';
import { useState, useEffect, useCallback } from 'react';
import { Layers, Plus, Pencil, Trash2, Globe } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { fetchWithAuth } from '../../stores/auth';
import { useOrgStore } from '../../stores/orgStore';
import { useDefaultOwnerScope } from '@/hooks/useDefaultOwnerScope';
import { DETECTION_CLASSES, DATA_TYPE_COLORS } from './constants';
import { ConfirmDialog } from '../shared/ConfirmDialog';
import { showToast } from '../shared/Toast';

type Policy = {
  id: string;
  // null = partner-wide ("All organizations") policy (#2131)
  orgId: string | null;
  partnerId?: string | null;
  name: string;
  scope: Record<string, unknown>;
  detectionClasses: unknown;
  schedule: Record<string, unknown> | null;
  isActive: boolean;
  createdAt: string | null;
  updatedAt: string | null;
};

type FormState = {
  name: string;
  detectionClasses: string[];
  isActive: boolean;
  scheduleType: string;
  intervalMinutes: number;
  cron: string;
};

const defaultForm: FormState = {
  name: '',
  detectionClasses: ['credential'],
  isActive: true,
  scheduleType: 'manual',
  intervalMinutes: 60,
  cron: '',
};

export default function PoliciesTab() {
  const { t } = useTranslation('security');
  const [policies, setPolicies] = useState<Policy[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();

  // Edit/Create state
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<FormState>(defaultForm);
  const [showForm, setShowForm] = useState(false);
  const [saving, setSaving] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<Policy | null>(null);
  const [deleting, setDeleting] = useState(false);

  // Ownership axis (#2131, mirrors software PolicyForm #2126): partner-scope
  // creators may own the policy partner-wide ("all orgs"). Gate on the JWT
  // scope; default to partner-wide when viewing All orgs. Create-only.
  const currentOrgId = useOrgStore((s) => s.currentOrgId);
  const { isPartnerScope, defaultOwnerScope } = useDefaultOwnerScope();
  const [ownerScope, setOwnerScope] = useState<'organization' | 'partner'>('organization');

  const fetchPolicies = useCallback(async () => {
    try {
      setLoading(true);
      setError(undefined);
      const res = await fetchWithAuth('/sensitive-data/policies');
      if (!res.ok) {
        throw new Error(
          t('sensitiveDataPoliciesTab.errors.fetchPolicies', {
            defaultValue: 'Failed to fetch policies',
          }),
        );
      }
      const json = await res.json();
      setPolicies(json.data ?? []);
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : t('sensitiveDataPoliciesTab.errors.generic', { defaultValue: 'An error occurred' }),
      );
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    fetchPolicies();
  }, [fetchPolicies]);

  const openCreate = () => {
    setEditingId(null);
    setForm(defaultForm);
    setOwnerScope(defaultOwnerScope);
    setShowForm(true);
  };

  const openEdit = (policy: Policy) => {
    const classes = Array.isArray(policy.detectionClasses) ? policy.detectionClasses as string[] : ['credential'];
    const schedule = policy.schedule as Record<string, unknown> | null;
    setEditingId(policy.id);
    setForm({
      name: policy.name,
      detectionClasses: classes,
      isActive: policy.isActive,
      scheduleType: typeof schedule?.type === 'string' ? schedule.type : 'manual',
      intervalMinutes: typeof schedule?.intervalMinutes === 'number' ? schedule.intervalMinutes : 60,
      cron: typeof schedule?.cron === 'string' ? schedule.cron : '',
    });
    setShowForm(true);
  };

  const toggleClass = (cls: string) => {
    setForm((prev) => {
      const current = prev.detectionClasses;
      if (current.includes(cls)) {
        return current.length > 1 ? { ...prev, detectionClasses: current.filter((c) => c !== cls) } : prev;
      }
      return { ...prev, detectionClasses: [...current, cls] };
    });
  };

  const handleSave = async () => {
    if (!form.name.trim()) return;
    setSaving(true);
    setError(undefined);
    try {
      const schedule: Record<string, unknown> = { type: form.scheduleType };
      if (form.scheduleType === 'interval') schedule.intervalMinutes = form.intervalMinutes;
      if (form.scheduleType === 'cron') schedule.cron = form.cron;

      const body = {
        name: form.name,
        detectionClasses: form.detectionClasses,
        isActive: form.isActive,
        schedule,
        // Create-only: updates never move a policy between ownership axes.
        ...(editingId ? {} : isPartnerScope ? { ownerScope } : {}),
      };

      const url = editingId ? `/sensitive-data/policies/${editingId}` : '/sensitive-data/policies';
      const method = editingId ? 'PUT' : 'POST';

      const res = await fetchWithAuth(url, { method, body: JSON.stringify(body) });
      if (!res.ok) {
        const json = await res.json().catch(() => ({}));
        throw new Error(
          json.error ||
            t('sensitiveDataPoliciesTab.errors.savePolicy', {
              defaultValue: 'Failed to save policy',
            }),
        );
      }

      setShowForm(false);
      await fetchPolicies();
      showToast({
        message: editingId
          ? t('sensitiveDataPoliciesTab.toasts.policyUpdated', { defaultValue: 'Policy updated' })
          : t('sensitiveDataPoliciesTab.toasts.policyCreated', { defaultValue: 'Policy created' }),
        type: 'success',
      });
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : t('sensitiveDataPoliciesTab.errors.saveFailed', { defaultValue: 'Save failed' }),
      );
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = (policy: Policy) => {
    setDeleteTarget(policy);
  };

  const handleConfirmDelete = async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      const res = await fetchWithAuth(`/sensitive-data/policies/${deleteTarget.id}`, { method: 'DELETE' });
      if (!res.ok) {
        throw new Error(
          t('sensitiveDataPoliciesTab.errors.deletePolicy', {
            defaultValue: 'Failed to delete policy',
          }),
        );
      }
      const deletedName = deleteTarget.name;
      setDeleteTarget(null);
      await fetchPolicies();
      showToast({
        message: t('sensitiveDataPoliciesTab.toasts.policyDeleted', {
          defaultValue: 'Policy "{{name}}" deleted',
          name: deletedName,
        }),
        type: 'success',
      });
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : t('sensitiveDataPoliciesTab.errors.deleteFailed', { defaultValue: 'Delete failed' }),
      );
    } finally {
      setDeleting(false);
    }
  };

  const handleToggleActive = async (policy: Policy) => {
    try {
      const res = await fetchWithAuth(`/sensitive-data/policies/${policy.id}`, {
        method: 'PUT',
        body: JSON.stringify({ isActive: !policy.isActive }),
      });
      if (!res.ok) {
        throw new Error(
          t('sensitiveDataPoliciesTab.errors.updatePolicy', {
            defaultValue: 'Failed to update policy',
          }),
        );
      }
      await fetchPolicies();
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : t('sensitiveDataPoliciesTab.errors.updateFailed', { defaultValue: 'Update failed' }),
      );
    }
  };

  return (
    <>
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold">
            {t('sensitiveDataPoliciesTab.heading', { defaultValue: 'Scan Policies' })}
          </h2>
          <p className="text-sm text-muted-foreground">
            {t('sensitiveDataPoliciesTab.descriptionPrefix', {
              defaultValue: 'Manage sensitive data scan policies. For hierarchical assignment, use',
            })}{' '}
            <a href="/configuration-policies" className="text-primary underline underline-offset-2">
              {t('sensitiveDataPoliciesTab.configurationPoliciesLink', {
                defaultValue: 'Configuration Policies',
              })}
            </a>.
          </p>
        </div>
        <button
          type="button"
          onClick={openCreate}
          className="inline-flex h-9 items-center gap-2 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground hover:opacity-90"
        >
          <Plus className="h-4 w-4" /> {t('sensitiveDataPoliciesTab.actions.newPolicy', { defaultValue: 'New Policy' })}
        </button>
      </div>

      {error && (
        <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</div>
      )}

      {/* Inline form */}
      {showForm && (
        <div className="rounded-lg border bg-card p-5 shadow-xs">
          <h3 className="text-sm font-semibold">
            {editingId
              ? t('sensitiveDataPoliciesTab.form.editPolicy', { defaultValue: 'Edit Policy' })
              : t('sensitiveDataPoliciesTab.form.createPolicy', { defaultValue: 'Create Policy' })}
          </h3>
          <div className="mt-4 grid gap-4">
            {/* Ownership scope — partner-scope creators only, create-only (#2131) */}
            {!editingId && isPartnerScope && (
              <fieldset className="space-y-2 rounded-md border p-4" data-testid="sensitive-policy-owner">
                <legend className="px-1 text-xs font-medium uppercase text-muted-foreground">
                  {t('sensitiveDataPoliciesTab.form.scope', { defaultValue: 'Scope' })}
                </legend>
                <label className="flex items-center gap-2 text-sm">
                  <input
                    type="radio"
                    checked={ownerScope === 'partner'}
                    onChange={() => setOwnerScope('partner')}
                    data-testid="sensitive-policy-owner-partner"
                  />
                  {t('sensitiveDataPoliciesTab.form.allOrganizations', {
                    defaultValue: 'All organizations',
                  })}{' '}
                  <span className="text-muted-foreground">
                    {t('sensitiveDataPoliciesTab.form.partnerWidePolicyParenthetical', {
                      defaultValue: '(partner-wide policy)',
                    })}
                  </span>
                </label>
                <label className="flex items-center gap-2 text-sm">
                  <input
                    type="radio"
                    checked={ownerScope === 'organization'}
                    onChange={() => setOwnerScope('organization')}
                    data-testid="sensitive-policy-owner-org"
                  />
                  {t('sensitiveDataPoliciesTab.form.thisOrganizationOnly', {
                    defaultValue: 'This organization only',
                  })}
                </label>
              </fieldset>
            )}
            <div>
              <label className="text-sm font-medium">{t('sensitiveDataPoliciesTab.form.name', { defaultValue: 'Name' })}</label>
              <input
                value={form.name}
                onChange={(e) => setForm((prev) => ({ ...prev, name: e.target.value }))}
                placeholder={t('sensitiveDataPoliciesTab.form.policyNamePlaceholder', {
                  defaultValue: 'Policy name',
                })}
                className="mt-1 h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
              />
            </div>
            <div>
              <label className="text-sm font-medium">
                {t('sensitiveDataPoliciesTab.form.detectionClasses', {
                  defaultValue: 'Detection Classes',
                })}
              </label>
              <div className="mt-2 flex flex-wrap gap-2">
                {DETECTION_CLASSES.map((cls) => (
                  <button
                    key={cls.value}
                    type="button"
                    onClick={() => toggleClass(cls.value)}
                    className={`rounded-full border px-3 py-1 text-xs font-medium transition ${
                      form.detectionClasses.includes(cls.value)
                        ? 'border-primary bg-primary/10 text-primary'
                        : 'hover:bg-muted'
                    }`}
                  >
                    {cls.label}
                  </button>
                ))}
              </div>
            </div>
            <div className="grid gap-4 sm:grid-cols-3">
              <div>
                <label className="text-sm font-medium">
                  {t('sensitiveDataPoliciesTab.form.scheduleType', { defaultValue: 'Schedule Type' })}
                </label>
                <select
                  value={form.scheduleType}
                  onChange={(e) => setForm((prev) => ({ ...prev, scheduleType: e.target.value }))}
                  className="mt-1 h-10 w-full rounded-md border bg-background px-3 text-sm"
                >
                  <option value="manual">{t('sensitiveDataPoliciesTab.schedule.manual', { defaultValue: 'Manual' })}</option>
                  <option value="interval">{t('sensitiveDataPoliciesTab.schedule.interval', { defaultValue: 'Interval' })}</option>
                  <option value="cron">{t('sensitiveDataPoliciesTab.schedule.cron', { defaultValue: 'Cron' })}</option>
                </select>
              </div>
              {form.scheduleType === 'interval' && (
                <div>
                  <label className="text-sm font-medium">
                    {t('sensitiveDataPoliciesTab.form.intervalMinutes', {
                      defaultValue: 'Interval (minutes)',
                    })}
                  </label>
                  <input
                    type="number"
                    min={5}
                    max={10080}
                    value={form.intervalMinutes}
                    onChange={(e) => setForm((prev) => ({ ...prev, intervalMinutes: Number(e.target.value) }))}
                    className="mt-1 h-10 w-full rounded-md border bg-background px-3 text-sm"
                  />
                </div>
              )}
              {form.scheduleType === 'cron' && (
                <div>
                  <label className="text-sm font-medium">
                    {t('sensitiveDataPoliciesTab.form.cronExpression', {
                      defaultValue: 'Cron Expression',
                    })}
                  </label>
                  <input
                    value={form.cron}
                    onChange={(e) => setForm((prev) => ({ ...prev, cron: e.target.value }))}
                    placeholder={t('sensitiveDataPoliciesTab.form.cronPlaceholder', {
                      defaultValue: '0 2 * * *',
                    })}
                    className="mt-1 h-10 w-full rounded-md border bg-background px-3 text-sm"
                  />
                </div>
              )}
            </div>
          </div>
          <div className="mt-4 flex justify-end gap-2">
            <button type="button" onClick={() => setShowForm(false)} className="h-9 rounded-md border px-4 text-sm font-medium hover:bg-muted">
              {t('common:actions.cancel', { defaultValue: 'Cancel' })}
            </button>
            <button
              type="button"
              onClick={handleSave}
              disabled={saving || !form.name.trim()}
              className="h-9 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50"
            >
              {saving
                ? t('sensitiveDataPoliciesTab.actions.saving', { defaultValue: 'Saving...' })
                : editingId
                  ? t('sensitiveDataPoliciesTab.actions.update', { defaultValue: 'Update' })
                  : t('common:actions.create', { defaultValue: 'Create' })}
            </button>
          </div>
        </div>
      )}

      {/* Table */}
      <div className="overflow-x-auto rounded-lg border">
        <table className="min-w-full divide-y">
          <thead className="bg-muted/40">
            <tr className="text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              <th className="px-4 py-3">{t('sensitiveDataPoliciesTab.table.name', { defaultValue: 'Name' })}</th>
              <th className="px-4 py-3">{t('sensitiveDataPoliciesTab.table.detectionClasses', { defaultValue: 'Detection Classes' })}</th>
              <th className="px-4 py-3">{t('sensitiveDataPoliciesTab.table.schedule', { defaultValue: 'Schedule' })}</th>
              <th className="px-4 py-3">{t('sensitiveDataPoliciesTab.table.active', { defaultValue: 'Active' })}</th>
              <th className="px-4 py-3 text-right">{t('sensitiveDataPoliciesTab.table.actions', { defaultValue: 'Actions' })}</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {loading && (
              <tr>
                <td colSpan={5} className="px-4 py-8 text-center">
                  <div className="mx-auto h-6 w-6 animate-spin rounded-full border-4 border-primary border-t-transparent" />
                </td>
              </tr>
            )}
            {!loading && policies.length === 0 && (
              <tr>
                <td colSpan={5} className="px-4 py-8 text-center text-sm text-muted-foreground">
                  {t('sensitiveDataPoliciesTab.empty', {
                    defaultValue: 'No policies yet. Create one to get started.',
                  })}
                </td>
              </tr>
            )}
            {!loading && policies.map((policy) => {
              const classes = Array.isArray(policy.detectionClasses) ? policy.detectionClasses as string[] : [];
              const schedule = policy.schedule as Record<string, unknown> | null;
              const scheduleLabel = schedule?.type === 'interval'
                ? t('sensitiveDataPoliciesTab.schedule.everyMinutes', {
                    defaultValue: 'Every {{minutes}}m',
                    minutes: schedule.intervalMinutes,
                  })
                : schedule?.type === 'cron'
                  ? String(schedule.cron ?? 'cron')
                  : t('sensitiveDataPoliciesTab.schedule.manual', { defaultValue: 'Manual' });

              return (
                <tr key={policy.id} className="text-sm hover:bg-muted/20">
                  <td className="px-4 py-3 font-medium">
                    <div className="flex items-center gap-2">
                      <span>{policy.name}</span>
                      {policy.orgId === null && (
                        <span
                          className="inline-flex items-center gap-1 rounded-full border border-primary/30 bg-primary/10 px-2 py-0.5 text-xs font-medium text-primary"
                          title={t('sensitiveDataPoliciesTab.badges.partnerWideTitle', {
                            defaultValue:
                              'Partner-wide policy — scans devices in every organization',
                          })}
                          data-testid="sensitive-policy-partner-wide-badge"
                        >
                          <Layers className="h-3 w-3" />
                          {t('sensitiveDataPoliciesTab.badges.allOrgs', { defaultValue: 'All orgs' })}
                        </span>
                      )}
                    </div>
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex flex-wrap gap-1">
                      {classes.map((cls) => (
                        <span
                          key={cls}
                          className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium ${DATA_TYPE_COLORS[cls] ?? ''}`}
                        >
                          {cls}
                        </span>
                      ))}
                    </div>
                  </td>
                  <td className="px-4 py-3 text-xs text-muted-foreground">{scheduleLabel}</td>
                  <td className="px-4 py-3">
                    <button
                      type="button"
                      onClick={() => handleToggleActive(policy)}
                      className={`relative inline-flex h-6 w-11 items-center rounded-full border transition ${policy.isActive ? 'bg-emerald-500/80' : 'bg-muted'}`}
                    >
                      <span className={`inline-block h-5 w-5 rounded-full bg-white transition ${policy.isActive ? 'translate-x-5' : 'translate-x-1'}`} />
                    </button>
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex justify-end gap-1">
                      <button
                        type="button"
                        onClick={() => openEdit(policy)}
                        className="inline-flex h-8 w-8 items-center justify-center rounded-md border hover:bg-muted"
                      >
                        <Pencil className="h-4 w-4" />
                      </button>
                      <button
                        type="button"
                        onClick={() => handleDelete(policy)}
                        className="inline-flex h-8 w-8 items-center justify-center rounded-md border text-destructive hover:bg-destructive/10"
                      >
                        <Trash2 className="h-4 w-4" />
                      </button>
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
    <ConfirmDialog
      open={deleteTarget !== null}
      onClose={() => setDeleteTarget(null)}
      onConfirm={handleConfirmDelete}
      title={t('sensitiveDataPoliciesTab.deleteDialog.title', { defaultValue: 'Delete Scan Policy' })}
      message={t('sensitiveDataPoliciesTab.deleteDialog.message', {
        defaultValue:
          'Are you sure you want to delete "{{name}}"? This action cannot be undone and any scheduled scans under this policy will stop.',
        name: deleteTarget?.name,
      })}
      confirmLabel={t('sensitiveDataPoliciesTab.deleteDialog.confirm', { defaultValue: 'Delete Policy' })}
      variant="destructive"
      isLoading={deleting}
    />
    </>
  );
}
