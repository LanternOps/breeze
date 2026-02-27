import { useState, useEffect, useCallback } from 'react';
import { Plus, Pencil, Trash2 } from 'lucide-react';
import { fetchWithAuth } from '../../stores/auth';
import { DETECTION_CLASSES, DATA_TYPE_COLORS } from './constants';

type Policy = {
  id: string;
  orgId: string;
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
  const [policies, setPolicies] = useState<Policy[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();

  // Edit/Create state
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<FormState>(defaultForm);
  const [showForm, setShowForm] = useState(false);
  const [saving, setSaving] = useState(false);

  const fetchPolicies = useCallback(async () => {
    try {
      setLoading(true);
      setError(undefined);
      const res = await fetchWithAuth('/sensitive-data/policies');
      if (!res.ok) throw new Error('Failed to fetch policies');
      const json = await res.json();
      setPolicies(json.data ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An error occurred');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchPolicies();
  }, [fetchPolicies]);

  const openCreate = () => {
    setEditingId(null);
    setForm(defaultForm);
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
      };

      const url = editingId ? `/sensitive-data/policies/${editingId}` : '/sensitive-data/policies';
      const method = editingId ? 'PUT' : 'POST';

      const res = await fetchWithAuth(url, { method, body: JSON.stringify(body) });
      if (!res.ok) {
        const json = await res.json().catch(() => ({}));
        throw new Error(json.error || 'Failed to save policy');
      }

      setShowForm(false);
      await fetchPolicies();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Save failed');
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (id: string) => {
    if (!confirm('Delete this policy? This cannot be undone.')) return;
    try {
      const res = await fetchWithAuth(`/sensitive-data/policies/${id}`, { method: 'DELETE' });
      if (!res.ok) throw new Error('Failed to delete policy');
      await fetchPolicies();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Delete failed');
    }
  };

  const handleToggleActive = async (policy: Policy) => {
    try {
      const res = await fetchWithAuth(`/sensitive-data/policies/${policy.id}`, {
        method: 'PUT',
        body: JSON.stringify({ isActive: !policy.isActive }),
      });
      if (!res.ok) throw new Error('Failed to update policy');
      await fetchPolicies();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Update failed');
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold">Scan Policies</h2>
          <p className="text-sm text-muted-foreground">
            Manage sensitive data scan policies. For hierarchical assignment, use{' '}
            <a href="/configuration-policies" className="text-primary underline underline-offset-2">Configuration Policies</a>.
          </p>
        </div>
        <button
          type="button"
          onClick={openCreate}
          className="inline-flex h-9 items-center gap-2 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground hover:opacity-90"
        >
          <Plus className="h-4 w-4" /> New Policy
        </button>
      </div>

      {error && (
        <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</div>
      )}

      {/* Inline form */}
      {showForm && (
        <div className="rounded-lg border bg-card p-5 shadow-sm">
          <h3 className="text-sm font-semibold">{editingId ? 'Edit Policy' : 'Create Policy'}</h3>
          <div className="mt-4 grid gap-4">
            <div>
              <label className="text-sm font-medium">Name</label>
              <input
                value={form.name}
                onChange={(e) => setForm((prev) => ({ ...prev, name: e.target.value }))}
                placeholder="Policy name"
                className="mt-1 h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
              />
            </div>
            <div>
              <label className="text-sm font-medium">Detection Classes</label>
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
                <label className="text-sm font-medium">Schedule Type</label>
                <select
                  value={form.scheduleType}
                  onChange={(e) => setForm((prev) => ({ ...prev, scheduleType: e.target.value }))}
                  className="mt-1 h-10 w-full rounded-md border bg-background px-3 text-sm"
                >
                  <option value="manual">Manual</option>
                  <option value="interval">Interval</option>
                  <option value="cron">Cron</option>
                </select>
              </div>
              {form.scheduleType === 'interval' && (
                <div>
                  <label className="text-sm font-medium">Interval (minutes)</label>
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
                  <label className="text-sm font-medium">Cron Expression</label>
                  <input
                    value={form.cron}
                    onChange={(e) => setForm((prev) => ({ ...prev, cron: e.target.value }))}
                    placeholder="0 2 * * *"
                    className="mt-1 h-10 w-full rounded-md border bg-background px-3 text-sm"
                  />
                </div>
              )}
            </div>
          </div>
          <div className="mt-4 flex justify-end gap-2">
            <button type="button" onClick={() => setShowForm(false)} className="h-9 rounded-md border px-4 text-sm font-medium hover:bg-muted">
              Cancel
            </button>
            <button
              type="button"
              onClick={handleSave}
              disabled={saving || !form.name.trim()}
              className="h-9 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50"
            >
              {saving ? 'Saving...' : editingId ? 'Update' : 'Create'}
            </button>
          </div>
        </div>
      )}

      {/* Table */}
      <div className="overflow-hidden rounded-lg border">
        <table className="min-w-full divide-y">
          <thead className="bg-muted/40">
            <tr className="text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              <th className="px-4 py-3">Name</th>
              <th className="px-4 py-3">Detection Classes</th>
              <th className="px-4 py-3">Schedule</th>
              <th className="px-4 py-3">Active</th>
              <th className="px-4 py-3 text-right">Actions</th>
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
                  No policies yet. Create one to get started.
                </td>
              </tr>
            )}
            {!loading && policies.map((policy) => {
              const classes = Array.isArray(policy.detectionClasses) ? policy.detectionClasses as string[] : [];
              const schedule = policy.schedule as Record<string, unknown> | null;
              const scheduleLabel = schedule?.type === 'interval'
                ? `Every ${schedule.intervalMinutes}m`
                : schedule?.type === 'cron'
                  ? String(schedule.cron ?? 'cron')
                  : 'Manual';

              return (
                <tr key={policy.id} className="text-sm hover:bg-muted/20">
                  <td className="px-4 py-3 font-medium">{policy.name}</td>
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
                        onClick={() => handleDelete(policy.id)}
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
  );
}
