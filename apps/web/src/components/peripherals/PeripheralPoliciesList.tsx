import { useState, useEffect, useCallback } from 'react';
import { Plus, RefreshCw } from 'lucide-react';
import { fetchWithAuth } from '../../stores/auth';
import PeripheralPolicyForm from './PeripheralPolicyForm';

type PeripheralPolicy = {
  id: string;
  name: string;
  deviceClass: string;
  action: string;
  targetType: string;
  isActive: boolean;
  exceptions?: Array<Record<string, unknown>>;
  createdAt?: string;
};

const deviceClassBadge: Record<string, string> = {
  storage: 'bg-blue-500/20 text-blue-700 border-blue-500/40',
  all_usb: 'bg-purple-500/20 text-purple-700 border-purple-500/40',
  bluetooth: 'bg-indigo-500/20 text-indigo-700 border-indigo-500/40',
  thunderbolt: 'bg-amber-500/20 text-amber-700 border-amber-500/40',
};

const actionBadge: Record<string, string> = {
  allow: 'bg-green-500/20 text-green-700 border-green-500/40',
  block: 'bg-red-500/20 text-red-700 border-red-500/40',
  read_only: 'bg-yellow-500/20 text-yellow-700 border-yellow-500/40',
  alert: 'bg-orange-500/20 text-orange-700 border-orange-500/40',
};

export default function PeripheralPoliciesList() {
  const [policies, setPolicies] = useState<PeripheralPolicy[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [showForm, setShowForm] = useState(false);
  const [editingPolicy, setEditingPolicy] = useState<PeripheralPolicy | null>(null);

  // Filters
  const [filterClass, setFilterClass] = useState('');
  const [filterAction, setFilterAction] = useState('');
  const [filterActive, setFilterActive] = useState('');
  const [filterTarget, setFilterTarget] = useState('');

  const fetchPolicies = useCallback(async () => {
    setLoading(true);
    setError(undefined);
    try {
      const params = new URLSearchParams();
      if (filterClass) params.set('deviceClass', filterClass);
      if (filterAction) params.set('action', filterAction);
      if (filterActive) params.set('isActive', filterActive);
      if (filterTarget) params.set('targetType', filterTarget);
      const qs = params.toString();
      const response = await fetchWithAuth(`/peripherals/policies${qs ? `?${qs}` : ''}`);
      if (!response.ok) throw new Error('Failed to fetch policies');
      const json = await response.json();
      setPolicies(Array.isArray(json.data) ? json.data : Array.isArray(json) ? json : []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An error occurred');
    } finally {
      setLoading(false);
    }
  }, [filterClass, filterAction, filterActive, filterTarget]);

  useEffect(() => {
    fetchPolicies();
  }, [fetchPolicies]);

  const handleFormClose = (refresh?: boolean) => {
    setShowForm(false);
    setEditingPolicy(null);
    if (refresh) fetchPolicies();
  };

  const handleRowClick = (policy: PeripheralPolicy) => {
    setEditingPolicy(policy);
    setShowForm(true);
  };

  return (
    <div className="space-y-4">
      {/* Filter bar */}
      <div className="flex flex-wrap items-center gap-3">
        <select
          value={filterClass}
          onChange={(e) => setFilterClass(e.target.value)}
          className="h-9 rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
        >
          <option value="">All Classes</option>
          <option value="storage">Storage</option>
          <option value="all_usb">All USB</option>
          <option value="bluetooth">Bluetooth</option>
          <option value="thunderbolt">Thunderbolt</option>
        </select>
        <select
          value={filterAction}
          onChange={(e) => setFilterAction(e.target.value)}
          className="h-9 rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
        >
          <option value="">All Actions</option>
          <option value="allow">Allow</option>
          <option value="block">Block</option>
          <option value="read_only">Read Only</option>
          <option value="alert">Alert</option>
        </select>
        <select
          value={filterActive}
          onChange={(e) => setFilterActive(e.target.value)}
          className="h-9 rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
        >
          <option value="">All Status</option>
          <option value="true">Active</option>
          <option value="false">Inactive</option>
        </select>
        <select
          value={filterTarget}
          onChange={(e) => setFilterTarget(e.target.value)}
          className="h-9 rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
        >
          <option value="">All Targets</option>
          <option value="organization">Organization</option>
          <option value="site">Site</option>
          <option value="group">Group</option>
          <option value="device">Device</option>
        </select>
        <div className="ml-auto flex gap-2">
          <button
            type="button"
            onClick={() => fetchPolicies()}
            className="inline-flex h-9 items-center gap-2 rounded-md border px-3 text-sm font-medium hover:bg-muted"
          >
            <RefreshCw className="h-4 w-4" />
          </button>
          <button
            type="button"
            onClick={() => { setEditingPolicy(null); setShowForm(true); }}
            className="inline-flex h-9 items-center gap-2 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground hover:opacity-90"
          >
            <Plus className="h-4 w-4" />
            Create Policy
          </button>
        </div>
      </div>

      {error && (
        <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </div>
      )}

      {/* Table */}
      <div className="rounded-lg border bg-card shadow-sm">
        {loading ? (
          <div className="flex items-center justify-center py-12">
            <div className="h-6 w-6 animate-spin rounded-full border-4 border-primary border-t-transparent" />
          </div>
        ) : policies.length === 0 ? (
          <div className="py-12 text-center text-sm text-muted-foreground">
            No peripheral policies found. Create one to get started.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="min-w-full divide-y">
              <thead className="bg-muted/40">
                <tr className="text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  <th className="px-4 py-3">Name</th>
                  <th className="px-4 py-3">Device Class</th>
                  <th className="px-4 py-3">Action</th>
                  <th className="px-4 py-3">Target Type</th>
                  <th className="px-4 py-3">Active</th>
                  <th className="px-4 py-3">Exceptions</th>
                  <th className="px-4 py-3">Created</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {policies.map((policy) => (
                  <tr
                    key={policy.id}
                    className="cursor-pointer text-sm hover:bg-muted/30 transition"
                    onClick={() => handleRowClick(policy)}
                  >
                    <td className="px-4 py-3 font-medium">{policy.name}</td>
                    <td className="px-4 py-3">
                      <span className={`inline-flex items-center rounded-full border px-2.5 py-1 text-xs font-medium ${deviceClassBadge[policy.deviceClass] ?? 'bg-muted text-muted-foreground'}`}>
                        {policy.deviceClass.replace('_', ' ')}
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      <span className={`inline-flex items-center rounded-full border px-2.5 py-1 text-xs font-medium ${actionBadge[policy.action] ?? 'bg-muted text-muted-foreground'}`}>
                        {policy.action.replace('_', ' ')}
                      </span>
                    </td>
                    <td className="px-4 py-3 capitalize text-muted-foreground">{policy.targetType}</td>
                    <td className="px-4 py-3">
                      <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium ${policy.isActive ? 'bg-green-500/20 text-green-700 border-green-500/40' : 'bg-gray-500/20 text-gray-700 border-gray-500/40'}`}>
                        {policy.isActive ? 'Yes' : 'No'}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-muted-foreground">
                      {policy.exceptions?.length ?? 0}
                    </td>
                    <td className="px-4 py-3 text-xs text-muted-foreground">
                      {policy.createdAt ? new Date(policy.createdAt).toLocaleDateString() : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {showForm && (
        <PeripheralPolicyForm
          policy={editingPolicy}
          onClose={handleFormClose}
        />
      )}
    </div>
  );
}
