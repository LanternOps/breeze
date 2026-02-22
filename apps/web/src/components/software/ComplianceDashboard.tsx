import { useCallback, useEffect, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle,
  Pencil,
  Plus,
  ShieldCheck,
  Trash2,
  Wrench,
  X,
  XCircle,
} from 'lucide-react';
import { fetchWithAuth } from '../../stores/auth';
import PolicyForm, { type PolicyFormValues } from './PolicyForm';

type Policy = {
  id: string;
  name: string;
  description?: string;
  mode: 'allowlist' | 'blocklist' | 'audit';
  rules?: {
    software: Array<{
      name: string;
      vendor?: string;
      minVersion?: string;
      maxVersion?: string;
      reason?: string;
    }>;
    allowUnknown?: boolean;
  };
  isActive: boolean;
  enforceMode: boolean;
  remediationOptions?: {
    autoUninstall?: boolean;
    gracePeriod?: number;
  } | null;
  createdAt?: string;
  updatedAt?: string;
};

type ComplianceOverview = {
  total: number;
  compliant: number;
  violations: number;
  unknown: number;
};

type ViolationRow = {
  device: {
    id: string;
    hostname: string;
  };
  compliance: {
    policyId: string;
    violations?: Array<{ type: string }>;
    remediationStatus?: string;
    lastChecked: string;
  };
};

type ModalMode = 'closed' | 'create' | 'edit' | 'delete';

type Toast = {
  id: string;
  type: 'success' | 'error';
  message: string;
};

type ComplianceDashboardProps = {
  prefill?: { name: string; vendor?: string; mode?: string } | null;
};

function parsePolicyMode(value: string | null | undefined): Policy['mode'] | null {
  return value === 'allowlist' || value === 'blocklist' || value === 'audit' ? value : null;
}

export default function ComplianceDashboard({ prefill }: ComplianceDashboardProps = {}) {
  const [policies, setPolicies] = useState<Policy[]>([]);
  const [overview, setOverview] = useState<ComplianceOverview>({
    total: 0,
    compliant: 0,
    violations: 0,
    unknown: 0,
  });
  const [violations, setViolations] = useState<ViolationRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [modalMode, setModalMode] = useState<ModalMode>('closed');
  const [selectedPolicy, setSelectedPolicy] = useState<Policy | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [toasts, setToasts] = useState<Toast[]>([]);

  const showToast = useCallback((type: 'success' | 'error', message: string) => {
    const id = Date.now().toString();
    setToasts((prev) => [...prev, { id, type, message }]);
    setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id));
    }, 4000);
  }, []);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [policiesRes, overviewRes, violationsRes] = await Promise.all([
        fetchWithAuth('/software-policies?limit=100'),
        fetchWithAuth('/software-policies/compliance/overview'),
        fetchWithAuth('/software-policies/violations?limit=25'),
      ]);

      if (!policiesRes.ok || !overviewRes.ok || !violationsRes.ok) {
        throw new Error('Failed to load software policy data');
      }

      const [policiesData, overviewData, violationsData] = await Promise.all([
        policiesRes.json(),
        overviewRes.json(),
        violationsRes.json(),
      ]);

      setPolicies(Array.isArray(policiesData.data) ? policiesData.data : []);
      setOverview({
        total: Number(overviewData.total ?? 0),
        compliant: Number(overviewData.compliant ?? 0),
        violations: Number(overviewData.violations ?? 0),
        unknown: Number(overviewData.unknown ?? 0),
      });
      setViolations(Array.isArray(violationsData.data) ? violationsData.data : []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load software policy data');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  // Support prefill from prop or URL: ?prefill=1&name=...&vendor=...&mode=...
  useEffect(() => {
    let name = '';
    let prefillVendor = '';
    let mode: 'allowlist' | 'blocklist' | 'audit' | null = null;

    if (prefill?.name) {
      name = prefill.name;
      prefillVendor = prefill.vendor ?? '';
      mode = parsePolicyMode(prefill.mode);
    } else if (typeof window !== 'undefined') {
      const params = new URLSearchParams(window.location.search);
      if (params.get('prefill') !== '1') return;
      name = params.get('name') ?? '';
      prefillVendor = params.get('vendor') ?? '';
      mode = parsePolicyMode(params.get('mode'));
    }

    if (name) {
      setSelectedPolicy({
        id: '',
        name: `${name} Policy`,
        mode: mode ?? 'blocklist',
        rules: {
          software: [{ name, vendor: prefillVendor || undefined }],
        },
        isActive: true,
        enforceMode: false,
      });
      setModalMode('create');
      // Clean up the URL
      if (typeof window !== 'undefined') window.history.replaceState({}, '', window.location.pathname);
    }
  }, [prefill]);

  const handleCreate = () => {
    setSelectedPolicy(null);
    setModalMode('create');
  };

  const handleEdit = async (policy: Policy) => {
    try {
      const res = await fetchWithAuth(`/software-policies/${policy.id}`);
      if (res.ok) {
        const data = await res.json();
        setSelectedPolicy(data.data ?? policy);
      } else {
        console.warn(`[ComplianceDashboard] Failed to load policy ${policy.id}: ${res.status}`);
        showToast('error', 'Could not load latest policy details. Showing cached data.');
        setSelectedPolicy(policy);
      }
    } catch (err) {
      console.warn('[ComplianceDashboard] Error fetching policy for edit:', err);
      showToast('error', 'Could not load policy details. Showing cached data.');
      setSelectedPolicy(policy);
    }
    setModalMode('edit');
  };

  const handleFormSubmit = async (values: PolicyFormValues) => {
    setSubmitting(true);
    try {
      const body = {
        name: values.name,
        description: values.description || undefined,
        mode: values.mode,
        rules: {
          software: values.software.map((s) => ({
            name: s.name,
            vendor: s.vendor || undefined,
            minVersion: s.minVersion || undefined,
            maxVersion: s.maxVersion || undefined,
            reason: s.reason || undefined,
          })),
          allowUnknown: values.mode === 'allowlist' ? values.allowUnknown : undefined,
        },
        enforceMode: values.enforceMode,
        remediationOptions: values.enforceMode
          ? {
              autoUninstall: values.autoUninstall,
              gracePeriod: values.gracePeriod,
            }
          : undefined,
      };

      const isEdit = modalMode === 'edit' && selectedPolicy;
      const url = isEdit
        ? `/software-policies/${selectedPolicy.id}`
        : '/software-policies';
      const method = isEdit ? 'PATCH' : 'POST';

      const res = await fetchWithAuth(url, {
        method,
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error((data as { error?: string }).error || `Failed to ${isEdit ? 'update' : 'create'} policy`);
      }

      showToast('success', `Policy ${isEdit ? 'updated' : 'created'} successfully`);
      setModalMode('closed');
      setSelectedPolicy(null);
      await refresh();
    } catch (err) {
      showToast('error', err instanceof Error ? err.message : 'Failed to save policy');
    } finally {
      setSubmitting(false);
    }
  };

  const handleDelete = (policy: Policy) => {
    setSelectedPolicy(policy);
    setModalMode('delete');
  };

  const handleConfirmDelete = async () => {
    if (!selectedPolicy) return;
    setSubmitting(true);
    try {
      const res = await fetchWithAuth(`/software-policies/${selectedPolicy.id}`, {
        method: 'DELETE',
      });
      if (!res.ok) {
        throw new Error('Failed to deactivate policy');
      }
      showToast('success', `Policy "${selectedPolicy.name}" deactivated`);
      setModalMode('closed');
      setSelectedPolicy(null);
      await refresh();
    } catch (err) {
      showToast('error', err instanceof Error ? err.message : 'Failed to deactivate policy');
    } finally {
      setSubmitting(false);
    }
  };

  const handleCheckCompliance = async (policy: Policy) => {
    try {
      const res = await fetchWithAuth(`/software-policies/${policy.id}/check`, {
        method: 'POST',
        body: JSON.stringify({}),
      });
      if (!res.ok) {
        throw new Error('Failed to schedule compliance check');
      }
      const data = (await res.json()) as { jobId?: string };
      showToast('success', `Compliance check scheduled${data.jobId ? ` (Job: ${data.jobId})` : ''}`);
    } catch (err) {
      showToast('error', err instanceof Error ? err.message : 'Failed to schedule compliance check');
    }
  };

  const handleRemediate = async (policy: Policy) => {
    try {
      const res = await fetchWithAuth(`/software-policies/${policy.id}/remediate`, {
        method: 'POST',
        body: JSON.stringify({}),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error((data as { error?: string }).error || 'Failed to schedule remediation');
      }
      showToast('success', `Remediation scheduled for ${(data as { queued?: number }).queued ?? 0} device(s)`);
    } catch (err) {
      showToast('error', err instanceof Error ? err.message : 'Failed to schedule remediation');
    }
  };

  const closeModal = () => {
    setModalMode('closed');
    setSelectedPolicy(null);
  };

  const policyToFormDefaults = (policy: Policy): Partial<PolicyFormValues> => ({
    name: policy.name,
    description: policy.description ?? '',
    mode: policy.mode,
    software: policy.rules?.software?.map((s) => ({
      name: s.name,
      vendor: s.vendor ?? '',
      minVersion: s.minVersion ?? '',
      maxVersion: s.maxVersion ?? '',
      reason: s.reason ?? '',
    })) ?? [{ name: '', vendor: '', minVersion: '', maxVersion: '', reason: '' }],
    allowUnknown: policy.rules?.allowUnknown ?? false,
    enforceMode: policy.enforceMode,
    autoUninstall: policy.remediationOptions?.autoUninstall ?? false,
    gracePeriod: policy.remediationOptions?.gracePeriod ?? 24,
  });

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <div className="text-center">
          <div className="mx-auto h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent" />
          <p className="mt-3 text-sm text-muted-foreground">Loading software policy compliance...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Toast notifications */}
      {toasts.length > 0 && (
        <div className="fixed bottom-4 right-4 z-50 flex flex-col gap-2">
          {toasts.map((toast) => (
            <div
              key={toast.id}
              className={`flex items-center gap-2 rounded-lg px-4 py-3 shadow-lg ${
                toast.type === 'success'
                  ? 'bg-green-600 text-white'
                  : 'bg-destructive text-destructive-foreground'
              }`}
            >
              {toast.type === 'success' ? (
                <CheckCircle className="h-5 w-5" />
              ) : (
                <XCircle className="h-5 w-5" />
              )}
              <span className="text-sm font-medium">{toast.message}</span>
            </div>
          ))}
        </div>
      )}

      <div className="flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={refresh}
            className="inline-flex h-9 items-center gap-2 rounded-md border px-3 text-sm font-medium hover:bg-muted/40"
          >
            Refresh
          </button>
          <button
            type="button"
            onClick={handleCreate}
            className="inline-flex h-9 items-center gap-2 rounded-md bg-primary px-3 text-sm font-medium text-primary-foreground transition hover:opacity-90"
          >
            <Plus className="h-4 w-4" />
            Create Policy
          </button>
      </div>

      {error && (
        <div className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
          {error}
        </div>
      )}

      <div className="grid gap-4 sm:grid-cols-4">
        <div className="rounded-lg border bg-card p-4">
          <p className="text-sm text-muted-foreground">Policies</p>
          <p className="mt-2 text-2xl font-bold">{policies.length}</p>
        </div>
        <div className="rounded-lg border bg-card p-4">
          <p className="text-sm text-muted-foreground">Devices Checked</p>
          <p className="mt-2 text-2xl font-bold">{overview.total}</p>
        </div>
        <div className="rounded-lg border bg-card p-4">
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <ShieldCheck className="h-4 w-4 text-emerald-600" />
            Compliant
          </div>
          <p className="mt-2 text-2xl font-bold">{overview.compliant}</p>
        </div>
        <div className="rounded-lg border bg-card p-4">
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <AlertTriangle className="h-4 w-4 text-amber-600" />
            Violations
          </div>
          <p className="mt-2 text-2xl font-bold">{overview.violations}</p>
        </div>
      </div>

      <div className="rounded-lg border bg-card">
        <div className="border-b px-4 py-3">
          <h2 className="font-semibold">Policy Definitions</h2>
        </div>
        <div className="overflow-x-auto">
          <table className="min-w-full text-sm">
            <thead className="bg-muted/30 text-left text-xs uppercase tracking-wide text-muted-foreground">
              <tr>
                <th className="px-4 py-3">Name</th>
                <th className="px-4 py-3">Mode</th>
                <th className="px-4 py-3">Status</th>
                <th className="px-4 py-3 text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {policies.map((policy) => (
                <tr key={policy.id} className="border-t">
                  <td className="px-4 py-3 font-medium">{policy.name}</td>
                  <td className="px-4 py-3 capitalize">{policy.mode}</td>
                  <td className="px-4 py-3">
                    <span
                      className={`rounded-full px-2 py-1 text-xs font-medium ${
                        policy.isActive
                          ? 'bg-emerald-100 text-emerald-700'
                          : 'bg-muted text-muted-foreground'
                      }`}
                    >
                      {policy.isActive ? 'Active' : 'Inactive'}
                    </span>
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex items-center justify-end gap-1">
                      <button
                        type="button"
                        onClick={() => handleCheckCompliance(policy)}
                        className="inline-flex h-8 w-8 items-center justify-center rounded-md border hover:bg-muted"
                        title="Check Compliance"
                      >
                        <ShieldCheck className="h-4 w-4" />
                      </button>
                      {policy.mode !== 'audit' && (
                        <button
                          type="button"
                          onClick={() => handleRemediate(policy)}
                          className="inline-flex h-8 w-8 items-center justify-center rounded-md border hover:bg-muted"
                          title="Remediate"
                        >
                          <Wrench className="h-4 w-4" />
                        </button>
                      )}
                      <button
                        type="button"
                        onClick={() => handleEdit(policy)}
                        className="inline-flex h-8 w-8 items-center justify-center rounded-md border hover:bg-muted"
                        title="Edit"
                      >
                        <Pencil className="h-4 w-4" />
                      </button>
                      <button
                        type="button"
                        onClick={() => handleDelete(policy)}
                        className="inline-flex h-8 w-8 items-center justify-center rounded-md border text-destructive hover:bg-destructive/10"
                        title="Deactivate"
                      >
                        <Trash2 className="h-4 w-4" />
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
              {policies.length === 0 && (
                <tr>
                  <td colSpan={4} className="px-4 py-6 text-center text-muted-foreground">
                    No software policies found. Create one to get started.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      <div className="rounded-lg border bg-card">
        <div className="border-b px-4 py-3">
          <h2 className="font-semibold">Recent Violations</h2>
        </div>
        <div className="divide-y">
          {violations.length === 0 && (
            <p className="px-4 py-6 text-sm text-muted-foreground">No current software violations.</p>
          )}
          {violations.map((row) => (
            <div
              key={`${row.compliance.policyId}:${row.device.id}`}
              className="flex flex-col gap-2 px-4 py-3 text-sm sm:flex-row sm:items-center sm:justify-between"
            >
              <div>
                <p className="font-medium">{row.device.hostname}</p>
                <p className="text-xs text-muted-foreground">
                  {Array.isArray(row.compliance.violations) ? row.compliance.violations.length : 0}{' '}
                  violation(s)
                </p>
              </div>
              <div className="text-xs text-muted-foreground">
                Remediation: {row.compliance.remediationStatus ?? 'none'}
              </div>
              <div className="text-xs text-muted-foreground">
                Checked: {new Date(row.compliance.lastChecked).toLocaleString()}
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Create/Edit Modal */}
      {(modalMode === 'create' || modalMode === 'edit') && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 px-4">
          <div className="flex w-full max-w-3xl max-h-[calc(100vh-2rem)] flex-col rounded-lg border bg-card shadow-sm">
            <div className="flex items-center justify-between border-b px-6 py-4 shrink-0">
              <h2 className="text-lg font-semibold">
                {modalMode === 'create' ? 'Create Software Policy' : 'Edit Software Policy'}
              </h2>
              <button
                type="button"
                onClick={closeModal}
                className="flex h-8 w-8 items-center justify-center rounded-md hover:bg-muted"
              >
                <X className="h-5 w-5" />
              </button>
            </div>
            <div className="overflow-y-auto px-6 py-4">
              <PolicyForm
                key={selectedPolicy?.id ?? 'create'}
                onSubmit={handleFormSubmit}
                onCancel={closeModal}
                defaultValues={
                  modalMode === 'edit' && selectedPolicy
                    ? policyToFormDefaults(selectedPolicy)
                    : undefined
                }
                submitLabel={modalMode === 'create' ? 'Create Policy' : 'Update Policy'}
                loading={submitting}
              />
            </div>
          </div>
        </div>
      )}

      {/* Delete Confirmation Modal */}
      {modalMode === 'delete' && selectedPolicy && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 px-4 py-8">
          <div className="w-full max-w-md rounded-lg border bg-card p-6 shadow-sm">
            <h2 className="text-lg font-semibold">Deactivate Policy</h2>
            <p className="mt-2 text-sm text-muted-foreground">
              Are you sure you want to deactivate{' '}
              <span className="font-medium">{selectedPolicy.name}</span>? The policy will be marked
              inactive and compliance data will be cleared.
            </p>
            <div className="mt-6 flex justify-end gap-3">
              <button
                type="button"
                onClick={closeModal}
                className="h-10 rounded-md border px-4 text-sm font-medium text-muted-foreground transition hover:text-foreground"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleConfirmDelete}
                disabled={submitting}
                className="inline-flex h-10 items-center justify-center rounded-md bg-destructive px-4 text-sm font-medium text-destructive-foreground transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {submitting ? 'Deactivating...' : 'Deactivate'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
