import { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, ShieldCheck } from 'lucide-react';
import { fetchWithAuth } from '../../stores/auth';

type Policy = {
  id: string;
  name: string;
  mode: 'allowlist' | 'blocklist' | 'audit';
  targetType: string;
  priority: number;
  isActive: boolean;
  enforceMode: boolean;
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

export default function ComplianceDashboard() {
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
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-bold">Software Policies</h1>
          <p className="text-sm text-muted-foreground">
            Enforce allowlist and blocklist controls across managed endpoints.
          </p>
        </div>
        <button
          type="button"
          onClick={refresh}
          className="inline-flex h-10 items-center gap-2 rounded-md border px-4 text-sm font-medium hover:bg-muted/40"
        >
          Refresh
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
                <th className="px-4 py-3">Target</th>
                <th className="px-4 py-3">Priority</th>
                <th className="px-4 py-3">Status</th>
              </tr>
            </thead>
            <tbody>
              {policies.map((policy) => (
                <tr key={policy.id} className="border-t">
                  <td className="px-4 py-3 font-medium">{policy.name}</td>
                  <td className="px-4 py-3 capitalize">{policy.mode}</td>
                  <td className="px-4 py-3">{policy.targetType}</td>
                  <td className="px-4 py-3">{policy.priority}</td>
                  <td className="px-4 py-3">
                    <span className={`rounded-full px-2 py-1 text-xs font-medium ${policy.isActive ? 'bg-emerald-100 text-emerald-700' : 'bg-muted text-muted-foreground'}`}>
                      {policy.isActive ? 'Active' : 'Inactive'}
                    </span>
                  </td>
                </tr>
              ))}
              {policies.length === 0 && (
                <tr>
                  <td colSpan={5} className="px-4 py-6 text-center text-muted-foreground">
                    No software policies found.
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
            <div key={`${row.compliance.policyId}:${row.device.id}`} className="flex flex-col gap-2 px-4 py-3 text-sm sm:flex-row sm:items-center sm:justify-between">
              <div>
                <p className="font-medium">{row.device.hostname}</p>
                <p className="text-xs text-muted-foreground">
                  {Array.isArray(row.compliance.violations) ? row.compliance.violations.length : 0} violation(s)
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
    </div>
  );
}
