import { useState, useEffect, useCallback } from 'react';
import { ArrowLeft, Eye, BarChart3, Play } from 'lucide-react';
import { cn } from '@/lib/utils';
import { fetchWithAuth } from '../../stores/auth';
import type { Baseline } from './BaselineFormModal';
import BaselineOverviewTab from './BaselineOverviewTab';
import BaselineComplianceTab from './BaselineComplianceTab';
import BaselineApplyTab from './BaselineApplyTab';

const tabs = [
  { id: 'overview', label: 'Overview', icon: Eye },
  { id: 'compliance', label: 'Compliance', icon: BarChart3 },
  { id: 'apply', label: 'Apply', icon: Play },
] as const;

type TabId = (typeof tabs)[number]['id'];

type Props = {
  baselineId?: string;
};

export default function BaselineDetailPage({ baselineId }: Props) {
  const [activeTab, setActiveTab] = useState<TabId>('overview');
  const [baseline, setBaseline] = useState<Baseline | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();

  const fetchBaseline = useCallback(async () => {
    if (!baselineId) return;
    try {
      setLoading(true);
      setError(undefined);
      const response = await fetchWithAuth(`/audit-baselines?id=${baselineId}`);
      if (!response.ok) throw new Error('Failed to fetch baseline');
      const data = await response.json();
      const items = Array.isArray(data.data) ? data.data : Array.isArray(data) ? data : [];
      const found = items.find((b: Baseline) => b.id === baselineId);
      if (!found) throw new Error('Baseline not found');
      setBaseline(found);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An error occurred');
    } finally {
      setLoading(false);
    }
  }, [baselineId]);

  useEffect(() => {
    fetchBaseline();
  }, [fetchBaseline]);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <div className="text-center">
          <div className="h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent mx-auto" />
          <p className="mt-4 text-sm text-muted-foreground">Loading baseline...</p>
        </div>
      </div>
    );
  }

  if (error || !baseline) {
    return (
      <div className="space-y-4">
        <a
          href="/audit-baselines"
          className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="h-4 w-4" />
          Back to Audit Baselines
        </a>
        <div className="rounded-lg border border-destructive/40 bg-destructive/10 p-6 text-center">
          <p className="text-sm text-destructive">{error ?? 'Baseline not found'}</p>
          <button
            type="button"
            onClick={fetchBaseline}
            className="mt-4 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90"
          >
            Try again
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <a
          href="/audit-baselines"
          className="hover:text-foreground"
        >
          Audit Baselines
        </a>
        <span>/</span>
        <span className="font-medium text-foreground">{baseline.name}</span>
      </div>

      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">{baseline.name}</h1>
          <div className="mt-1 flex items-center gap-3">
            <span
              className={cn(
                'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-medium',
                baseline.isActive
                  ? 'bg-green-500/15 text-green-700 border-green-500/30'
                  : 'bg-gray-500/15 text-gray-600 border-gray-500/30'
              )}
            >
              {baseline.isActive ? 'Active' : 'Inactive'}
            </span>
            <span className="text-sm text-muted-foreground">
              {baseline.osType} &middot; {baseline.profile}
            </span>
          </div>
        </div>
      </div>

      <div className="flex gap-1 rounded-lg border bg-muted/40 p-1">
        {tabs.map((tab) => {
          const Icon = tab.icon;
          const isActive = activeTab === tab.id;
          return (
            <button
              key={tab.id}
              type="button"
              onClick={() => setActiveTab(tab.id)}
              className={cn(
                'flex items-center gap-2 rounded-md px-4 py-2 text-sm font-medium transition-colors',
                isActive
                  ? 'bg-background text-foreground shadow-sm'
                  : 'text-muted-foreground hover:text-foreground'
              )}
            >
              <Icon className="h-4 w-4" />
              {tab.label}
            </button>
          );
        })}
      </div>

      {activeTab === 'overview' && (
        <BaselineOverviewTab baseline={baseline} onUpdated={fetchBaseline} />
      )}
      {activeTab === 'compliance' && (
        <BaselineComplianceTab baseline={baseline} />
      )}
      {activeTab === 'apply' && (
        <BaselineApplyTab baseline={baseline} />
      )}
    </div>
  );
}
