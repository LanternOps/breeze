import { useState, useEffect, useCallback } from 'react';
import { cn } from '@/lib/utils';
import { fetchWithAuth } from '../../stores/auth';
import { useOrgStore } from '../../stores/orgStore';
import type { Baseline } from './BaselineFormModal';

type ComplianceSummary = {
  totalDevices: number;
  compliant: number;
  nonCompliant: number;
  averageScore: number;
  baselines: Array<{
    baselineId: string;
    baselineName: string;
    osType: string;
    total: number;
    compliant: number;
    nonCompliant: number;
    averageScore: number;
  }>;
};

type Props = {
  baseline: Baseline;
};

function scoreColor(score: number): string {
  if (score >= 90) return 'text-green-600';
  if (score >= 70) return 'text-yellow-600';
  return 'text-red-600';
}

export default function BaselineComplianceTab({ baseline }: Props) {
  const currentOrgId = useOrgStore((s) => s.currentOrgId);
  const [summary, setSummary] = useState<ComplianceSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [filter, setFilter] = useState<'all' | 'compliant' | 'non-compliant'>('all');

  const fetchResults = useCallback(async () => {
    try {
      setLoading(true);
      setError(undefined);
      const params = new URLSearchParams();
      params.set('baselineId', baseline.id);
      if (currentOrgId) params.set('orgId', currentOrgId);
      const response = await fetchWithAuth(`/audit-baselines/compliance?${params.toString()}`);
      if (!response.ok) throw new Error('Failed to fetch compliance data');
      const data: ComplianceSummary = await response.json();
      setSummary(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An error occurred');
    } finally {
      setLoading(false);
    }
  }, [baseline.id, currentOrgId]);

  useEffect(() => {
    fetchResults();
  }, [fetchResults]);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <div className="text-center">
          <div className="h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent mx-auto" />
          <p className="mt-4 text-sm text-muted-foreground">Loading compliance results...</p>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="rounded-lg border border-destructive/40 bg-destructive/10 p-6 text-center">
        <p className="text-sm text-destructive">{error}</p>
        <button
          type="button"
          onClick={fetchResults}
          className="mt-4 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90"
        >
          Try again
        </button>
      </div>
    );
  }

  const baselineSummary = summary?.baselines.find((b) => b.baselineId === baseline.id);

  if (!summary || !baselineSummary || baselineSummary.total === 0) {
    return (
      <div className="rounded-lg border bg-card p-8 text-center shadow-sm">
        <h3 className="text-sm font-semibold">No compliance results</h3>
        <p className="mt-1 text-sm text-muted-foreground">
          No devices have been evaluated against this baseline yet.
          {!baseline.isActive && ' Activate this baseline to begin drift evaluation.'}
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="grid gap-4 sm:grid-cols-3">
        <div className="rounded-lg border bg-card p-4 shadow-sm">
          <p className="text-xs text-muted-foreground">Devices Evaluated</p>
          <p className="mt-1 text-xl font-semibold">{baselineSummary.total}</p>
        </div>
        <div className="rounded-lg border bg-card p-4 shadow-sm">
          <p className="text-xs text-muted-foreground">Compliant</p>
          <p className="mt-1 text-xl font-semibold text-green-600">
            {baselineSummary.compliant}
            <span className="ml-1 text-sm font-normal text-muted-foreground">
              ({baselineSummary.total > 0
                ? Math.round((baselineSummary.compliant / baselineSummary.total) * 100)
                : 0}%)
            </span>
          </p>
        </div>
        <div className="rounded-lg border bg-card p-4 shadow-sm">
          <p className="text-xs text-muted-foreground">Average Score</p>
          <p className={cn('mt-1 text-xl font-semibold', scoreColor(baselineSummary.averageScore))}>
            {baselineSummary.averageScore}
          </p>
        </div>
      </div>

      <div className="rounded-lg border bg-card p-6 shadow-sm">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-semibold">Device Results</h3>
          <div className="flex gap-1 rounded-md border bg-muted/40 p-0.5">
            {(['all', 'compliant', 'non-compliant'] as const).map((f) => (
              <button
                key={f}
                type="button"
                onClick={() => setFilter(f)}
                className={cn(
                  'rounded px-2.5 py-1 text-xs font-medium transition',
                  filter === f
                    ? 'bg-background text-foreground shadow-sm'
                    : 'text-muted-foreground hover:text-foreground'
                )}
              >
                {f === 'all' ? 'All' : f === 'compliant' ? 'Compliant' : 'Non-Compliant'}
              </button>
            ))}
          </div>
        </div>

        <p className="mt-4 text-sm text-muted-foreground">
          Summary shows {baselineSummary.compliant} compliant and{' '}
          {baselineSummary.nonCompliant} non-compliant devices.
          Click a device in the Devices page to see per-device audit baseline details.
        </p>
      </div>
    </div>
  );
}
