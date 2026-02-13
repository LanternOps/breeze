import { useState, useEffect, useCallback } from 'react';
import { RefreshCw, Loader2, BrainCircuit } from 'lucide-react';
import { fetchWithAuth } from '../../stores/auth';
import { TierOverviewMatrix } from './TierOverviewMatrix';
import { ToolExecutionAnalytics } from './ToolExecutionAnalytics';
import { ApprovalHistoryFeed } from './ApprovalHistoryFeed';
import { RateLimitStatus } from './RateLimitStatus';
import { RejectionDenialLog } from './RejectionDenialLog';

type TimeRange = '24h' | '7d' | '30d';

interface ToolExecSummary {
  total: number;
  byStatus: Record<string, number>;
  byTool: Array<{ toolName: string; count: number; avgDurationMs: number | null; successRate: number }>;
}

interface TimeSeriesPoint {
  date: string;
  completed: number;
  failed: number;
  rejected: number;
}

export interface ToolExecution {
  id: string;
  sessionId: string;
  toolName: string;
  status: string;
  toolInput: unknown;
  approvedBy: string | null;
  approvedAt: string | null;
  durationMs: number | null;
  errorMessage: string | null;
  createdAt: string;
  completedAt: string | null;
}

export interface SecurityEvent {
  id: string;
  timestamp: string;
  actorType: string;
  actorEmail: string | null;
  action: string;
  resourceType: string | null;
  resourceId: string | null;
  result: string | null;
  errorMessage: string | null;
  details: unknown;
}

export interface ToolExecData {
  summary: ToolExecSummary;
  timeSeries: TimeSeriesPoint[];
  executions: ToolExecution[];
}

const TIME_RANGES: { label: string; value: TimeRange }[] = [
  { label: '24h', value: '24h' },
  { label: '7d', value: '7d' },
  { label: '30d', value: '30d' },
];

function getSinceDate(range: TimeRange): string {
  const ms = { '24h': 86400000, '7d': 604800000, '30d': 2592000000 }[range];
  return new Date(Date.now() - ms).toISOString();
}

export default function AiRiskDashboard() {
  const [timeRange, setTimeRange] = useState<TimeRange>('7d');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const [execData, setExecData] = useState<ToolExecData | null>(null);
  const [securityEvents, setSecurityEvents] = useState<SecurityEvent[]>([]);

  const fetchData = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      const since = getSinceDate(timeRange);

      const [execResult, secResult] = await Promise.allSettled([
        fetchWithAuth(`/ai/admin/tool-executions?since=${since}&limit=200`),
        fetchWithAuth(`/ai/admin/security-events?since=${since}&limit=100`),
      ]);

      if (execResult.status === 'fulfilled' && execResult.value.ok) {
        setExecData(await execResult.value.json());
      } else {
        throw new Error('Failed to load tool executions');
      }

      if (secResult.status === 'fulfilled' && secResult.value.ok) {
        const secJson = await secResult.value.json();
        setSecurityEvents(secJson.data ?? []);
      } else {
        setSecurityEvents([]);
        setError('Security events could not be loaded. Denial data may be incomplete.');
      }

      setLastUpdated(new Date());
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load data');
    } finally {
      setLoading(false);
    }
  }, [timeRange]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-3">
          <div className="rounded-lg border bg-primary/10 p-2">
            <BrainCircuit className="h-6 w-6 text-primary" />
          </div>
          <div>
            <h1 className="text-2xl font-bold">AI Risk Engine</h1>
            <p className="text-sm text-muted-foreground">
              Tool execution guardrails, approval history, and analytics
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2">
          {/* Time range selector */}
          <div className="flex rounded-lg border bg-card">
            {TIME_RANGES.map((r) => (
              <button
                key={r.value}
                onClick={() => setTimeRange(r.value)}
                className={`px-3 py-1.5 text-sm font-medium transition-colors ${
                  timeRange === r.value
                    ? 'bg-primary text-primary-foreground'
                    : 'text-muted-foreground hover:text-foreground'
                } ${r.value === '24h' ? 'rounded-l-lg' : ''} ${r.value === '30d' ? 'rounded-r-lg' : ''}`}
              >
                {r.label}
              </button>
            ))}
          </div>

          <button
            onClick={fetchData}
            disabled={loading}
            className="inline-flex items-center gap-1.5 rounded-lg border bg-card px-3 py-1.5 text-sm font-medium text-muted-foreground hover:text-foreground disabled:opacity-50"
          >
            {loading ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <RefreshCw className="h-4 w-4" />
            )}
            Refresh
          </button>

          {lastUpdated && (
            <span className="text-xs text-muted-foreground">
              Updated {lastUpdated.toLocaleTimeString()}
            </span>
          )}
        </div>
      </div>

      {/* Error state */}
      {error && (
        <div className="rounded-lg border border-red-500/30 bg-red-500/10 p-4 text-sm text-red-700">
          {error}
        </div>
      )}

      {/* Section 1: Tier Overview Matrix */}
      <TierOverviewMatrix />

      {/* Section 2: Tool Execution Analytics */}
      <ToolExecutionAnalytics data={execData} loading={loading} />

      {/* Section 3: Approval History Feed */}
      <ApprovalHistoryFeed
        executions={execData?.executions ?? []}
        loading={loading}
      />

      {/* Section 4: Rate Limit Status */}
      <RateLimitStatus />

      {/* Section 5: Rejection & Denial Log */}
      <RejectionDenialLog
        executions={execData?.executions ?? []}
        securityEvents={securityEvents}
        loading={loading}
      />
    </div>
  );
}
