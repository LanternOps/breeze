import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Brain,
  CheckCircle,
  ChevronDown,
  ChevronRight,
  Clock,
  ExternalLink,
  FileText,
  Loader2,
  Pencil,
  RefreshCw,
  ThumbsDown,
  ThumbsUp,
  XCircle
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { runAction, handleActionError } from '../../lib/runAction';
import { fetchWithAuth } from '../../stores/auth';
import type { AlertSeverity, AlertStatus } from './AlertList';
import { navigateTo } from '@/lib/navigation';
import { showToast } from '../shared/Toast';
import { useMlFeatureFlags } from '../../hooks/useMlFeatureFlags';

type AlertItem = {
  id: string;
  title: string;
  severity: AlertSeverity;
  status: AlertStatus;
  device: string;
  triggeredAt?: string;
};

type AlertGroup = {
  id: string;
  rootCause: AlertItem;
  relatedCount: number;
  alerts: AlertItem[];
  correlationScore: number;
  noiseReductionPercent?: number;
  status?: AlertStatus | string;
  memberCount?: number;
  firstSeenAt?: string;
  lastSeenAt?: string;
};

type RcaEvidenceItem = {
  id: string;
  source: string;
  type: string;
  timestamp: string;
  title: string;
  summary: string;
  severity?: string;
};

type RcaCandidate = {
  summary: string;
  confidence: number;
  supportingEvidenceIds: string[];
};

type RcaSuggestedNextStep = {
  title: string;
  rationale: string;
  riskTier: 'low' | 'medium' | 'high';
  evidenceIds: string[];
};

type RcaResult = {
  groupId: string;
  timeline: RcaEvidenceItem[];
  rootCauseCandidates: RcaCandidate[];
  suggestedNextSteps?: RcaSuggestedNextStep[];
  gaps: string[];
  scope: {
    deviceIds: string[];
    alertIds: string[];
    windowStart: string;
    windowEnd: string;
  };
};

const severityStyles: Record<AlertSeverity, string> = {
  critical: 'bg-red-500/15 text-red-700 border-red-500/35',
  high: 'bg-orange-500/15 text-orange-700 border-orange-500/35',
  medium: 'bg-yellow-500/15 text-yellow-700 border-yellow-500/35',
  low: 'bg-blue-500/15 text-blue-700 border-blue-500/35',
  info: 'bg-gray-500/15 text-gray-700 border-gray-500/35'
};

const statusStyles: Partial<Record<AlertStatus | string, string>> = {
  active: 'bg-red-500/15 text-red-700 border-red-500/35',
  acknowledged: 'bg-yellow-500/15 text-yellow-700 border-yellow-500/35',
  resolved: 'bg-emerald-500/15 text-emerald-700 border-emerald-500/35',
  suppressed: 'bg-slate-500/15 text-slate-700 border-slate-500/35'
};

function formatPercent(value: number | undefined) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '0%';
  return `${Math.round(value)}%`;
}

function formatScore(value: number | undefined) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '0.00';
  return value.toFixed(2);
}

function formatDateTime(value: string | undefined) {
  if (!value) return 'Unknown';
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return 'Unknown';
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit'
  }).format(parsed);
}

function evidenceLabel(source: string) {
  return source.replace(/_/g, ' ');
}

export default function CorrelatedAlertGroups() {
  const mlFlags = useMlFeatureFlags();
  const [groups, setGroups] = useState<AlertGroup[]>([]);
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set());
  const [rcaByGroup, setRcaByGroup] = useState<Record<string, RcaResult | undefined>>({});
  const [loadingRcaGroupId, setLoadingRcaGroupId] = useState<string | null>(null);
  const [busyGroupId, setBusyGroupId] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const summary = useMemo(() => {
    const incidentCount = groups.length;
    const memberCount = groups.reduce((sum, group) => sum + (group.memberCount ?? group.alerts.length), 0);
    const suppressedAlerts = Math.max(memberCount - incidentCount, 0);
    const avgReduction = groups.length === 0
      ? 0
      : groups.reduce((sum, group) => sum + (group.noiseReductionPercent ?? 0), 0) / groups.length;
    return { incidentCount, memberCount, suppressedAlerts, avgReduction };
  }, [groups]);
  const rcaDisabled = mlFlags.isDisabled('ml.rca.enabled');

  const fetchGroups = useCallback(async () => {
    setIsLoading(true);
    setError(null);

    try {
      const response = await fetchWithAuth('/alerts/correlations');

      if (response.status === 401) {
        void navigateTo('/login', { replace: true });
        return;
      }

      if (!response.ok) {
        throw new Error('Failed to fetch correlated alert groups');
      }

      const data = await response.json();
      const nextGroups = (data.groups ?? data.data ?? []) as AlertGroup[];
      setGroups(nextGroups);
      setExpandedGroups((previous) => {
        const stillValid = new Set([...previous].filter((id) => nextGroups.some((group) => group.id === id)));
        if (stillValid.size === 0 && nextGroups[0]) stillValid.add(nextGroups[0].id);
        return stillValid;
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load alert groups');
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchGroups();
  }, [fetchGroups]);

  const toggleGroup = (groupId: string) => {
    setExpandedGroups(prev => {
      const next = new Set(prev);
      if (next.has(groupId)) {
        next.delete(groupId);
      } else {
        next.add(groupId);
      }
      return next;
    });
  };

  const handleAcknowledgeGroup = async (group: AlertGroup) => {
    setBusyGroupId(group.id);
    try {
      await runAction({
        request: () => fetchWithAuth(`/alerts/correlations/${group.id}/acknowledge`, { method: 'POST' }),
        errorFallback: 'Failed to acknowledge alert group',
        successMessage: 'Alert group acknowledged',
        onUnauthorized: () => void navigateTo('/login', { replace: true })
      });
      await fetchGroups();
    } catch (err) {
      handleActionError(err, 'Failed to acknowledge alert group');
    } finally {
      setBusyGroupId(null);
    }
  };

  const handleResolveGroup = async (group: AlertGroup) => {
    setBusyGroupId(group.id);
    try {
      await runAction({
        request: () => fetchWithAuth(`/alerts/correlations/${group.id}/resolve`, { method: 'POST' }),
        errorFallback: 'Failed to resolve alert group',
        successMessage: 'Alert group resolved',
        onUnauthorized: () => void navigateTo('/login', { replace: true })
      });
      await fetchGroups();
    } catch (err) {
      handleActionError(err, 'Failed to resolve alert group');
    } finally {
      setBusyGroupId(null);
    }
  };

  const handleExplainGroup = async (group: AlertGroup) => {
    if (rcaDisabled) return;

    setLoadingRcaGroupId(group.id);
    try {
      const result = await runAction<{ data?: RcaResult; rca?: RcaResult }>({
        request: () => fetchWithAuth(`/alerts/correlations/${group.id}/explain`, {
          method: 'POST',
          body: JSON.stringify({ windowHours: 6, maxEvidenceItems: 30 })
        }),
        errorFallback: 'Failed to explain incident',
        onUnauthorized: () => void navigateTo('/login', { replace: true })
      });
      const rca = result.data ?? result.rca;
      if (!rca) {
        showToast({ message: 'RCA response was empty', type: 'error' });
        return;
      }
      setRcaByGroup((prev) => ({ ...prev, [group.id]: rca }));
      setExpandedGroups((prev) => new Set(prev).add(group.id));
    } catch (err) {
      handleActionError(err, 'Failed to explain incident');
    } finally {
      setLoadingRcaGroupId(null);
    }
  };

  const sendRcaFeedback = async (group: AlertGroup, eventType: 'rca.helpful' | 'rca.not_helpful' | 'rca.edited' | 'rca.used_in_ticket') => {
    const outcome = eventType.replace('rca.', '') as 'helpful' | 'not_helpful' | 'edited' | 'used_in_ticket';
    try {
      const rca = rcaByGroup[group.id];
      await runAction({
        request: () => fetchWithAuth(`/alerts/correlations/${group.id}/rca-feedback`, {
          method: 'POST',
          body: JSON.stringify({
            eventType,
            outcome,
            metadata: {
              source: 'correlated_alert_groups_ui',
              candidateCount: rca?.rootCauseCandidates.length ?? null,
              evidenceCount: rca?.timeline.length ?? null,
              gapCount: rca?.gaps.length ?? null,
            }
          })
        }),
        errorFallback: 'Failed to record RCA feedback',
        successMessage: 'RCA feedback recorded',
        onUnauthorized: () => void navigateTo('/login', { replace: true })
      });
    } catch (err) {
      handleActionError(err, 'Failed to record RCA feedback');
    }
  };

  const sendCorrelationFeedback = async (group: AlertGroup, eventType: 'correlation.split' | 'correlation.dismissed') => {
    const outcome = eventType.replace('correlation.', '') as 'split' | 'dismissed';
    const isSplit = eventType === 'correlation.split';
    setBusyGroupId(group.id);
    try {
      await runAction({
        request: () => fetchWithAuth(`/alerts/correlations/${group.id}/feedback`, {
          method: 'POST',
          body: JSON.stringify({
            eventType,
            outcome,
            alertIds: isSplit ? group.alerts.map((alert) => alert.id) : [],
            metadata: {
              source: 'correlated_alert_groups_ui',
              memberCount: group.memberCount ?? group.alerts.length,
              correlationScore: group.correlationScore,
              noiseReductionPercent: group.noiseReductionPercent ?? null,
            }
          })
        }),
        errorFallback: 'Failed to record correlation feedback',
        successMessage: isSplit ? 'Marked group as incorrect' : 'Dismissed correlation group',
        onUnauthorized: () => void navigateTo('/login', { replace: true })
      });
    } catch (err) {
      handleActionError(err, 'Failed to record correlation feedback');
    } finally {
      setBusyGroupId(null);
    }
  };

  if (isLoading) {
    return (
      <div className="rounded-lg border bg-card p-6 shadow-sm">
        <div className="flex h-48 items-center justify-center">
          <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="rounded-lg border bg-card p-6 shadow-sm">
        <div className="flex h-48 flex-col items-center justify-center gap-2 text-muted-foreground">
          <p>{error}</p>
          <button
            type="button"
            onClick={() => void fetchGroups()}
            className="inline-flex h-9 items-center gap-2 rounded-md border px-3 text-sm font-medium hover:bg-muted"
          >
            <RefreshCw className="h-4 w-4" />
            Retry
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <div className="grid gap-3 sm:grid-cols-4">
        <div className="rounded-md border bg-card px-4 py-3">
          <p className="text-xs text-muted-foreground">Incidents</p>
          <p className="mt-1 text-xl font-semibold">{summary.incidentCount}</p>
        </div>
        <div className="rounded-md border bg-card px-4 py-3">
          <p className="text-xs text-muted-foreground">Grouped alerts</p>
          <p className="mt-1 text-xl font-semibold">{summary.memberCount}</p>
        </div>
        <div className="rounded-md border bg-card px-4 py-3">
          <p className="text-xs text-muted-foreground">Inbox reduction</p>
          <p className="mt-1 text-xl font-semibold">{summary.suppressedAlerts}</p>
        </div>
        <div className="rounded-md border bg-card px-4 py-3">
          <p className="text-xs text-muted-foreground">Avg noise cut</p>
          <p className="mt-1 text-xl font-semibold">{formatPercent(summary.avgReduction)}</p>
        </div>
      </div>

      <div className="rounded-lg border bg-card shadow-sm">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b px-6 py-4">
          <div>
            <h2 className="text-lg font-semibold">Correlated Alert Groups</h2>
            <p className="text-sm text-muted-foreground">Cluster alerts by likely incident and shared evidence.</p>
          </div>
          <button
            type="button"
            onClick={() => void fetchGroups()}
            className="inline-flex h-9 items-center gap-2 rounded-md border px-3 text-sm font-medium hover:bg-muted"
          >
            <RefreshCw className="h-4 w-4" />
            Refresh
          </button>
        </div>

        <div className="divide-y">
          {groups.length === 0 ? (
            <div className="py-12 text-center text-muted-foreground">
              No correlated alert groups found.
            </div>
          ) : (
            groups.map(group => {
              const isExpanded = expandedGroups.has(group.id);
              const groupRca = rcaByGroup[group.id];
              const isBusy = busyGroupId === group.id;
              const isExplaining = loadingRcaGroupId === group.id;
              return (
                <section key={group.id}>
                  <div className="flex flex-col gap-3 px-4 py-3 lg:flex-row lg:items-start lg:justify-between">
                    <button
                      type="button"
                      onClick={() => toggleGroup(group.id)}
                      className="flex min-w-0 flex-1 items-start gap-3 text-left"
                    >
                      {isExpanded ? (
                        <ChevronDown className="mt-1 h-4 w-4 shrink-0 text-muted-foreground" />
                      ) : (
                        <ChevronRight className="mt-1 h-4 w-4 shrink-0 text-muted-foreground" />
                      )}
                      <div className="min-w-0">
                        <p className="truncate text-sm font-medium">{group.rootCause.title}</p>
                        <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                          <span
                            className={cn(
                              'rounded-full border px-2 py-0.5 font-medium',
                              severityStyles[group.rootCause.severity]
                            )}
                          >
                            {group.rootCause.severity}
                          </span>
                          {group.status && (
                            <span
                              className={cn(
                                'rounded-full border px-2 py-0.5 font-medium',
                                statusStyles[group.status] ?? 'bg-muted text-muted-foreground border-border'
                              )}
                            >
                              {group.status}
                            </span>
                          )}
                          <span>{group.rootCause.device}</span>
                          <span>{group.relatedCount} related</span>
                          <span>score {formatScore(group.correlationScore)}</span>
                          <span>{formatPercent(group.noiseReductionPercent)} noise cut</span>
                        </div>
                      </div>
                    </button>

                    <div className="flex flex-wrap items-center gap-2 lg:justify-end">
                      <button
                        type="button"
                        onClick={() => void handleExplainGroup(group)}
                        disabled={isBusy || isExplaining || rcaDisabled}
                        title={rcaDisabled ? 'RCA is disabled for this organization' : undefined}
                        className="inline-flex h-8 items-center gap-2 rounded-md border px-3 text-xs font-medium hover:bg-muted disabled:opacity-50"
                      >
                        {isExplaining ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Brain className="h-3.5 w-3.5" />}
                        {rcaDisabled ? 'RCA disabled' : 'Explain incident'}
                      </button>
                      <button
                        type="button"
                        onClick={() => void handleAcknowledgeGroup(group)}
                        disabled={isBusy || isExplaining}
                        className="inline-flex h-8 items-center gap-2 rounded-md border px-3 text-xs font-medium hover:bg-muted disabled:opacity-50"
                      >
                        {isBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <CheckCircle className="h-3.5 w-3.5" />}
                        Acknowledge group
                      </button>
                      <button
                        type="button"
                        onClick={() => void handleResolveGroup(group)}
                        disabled={isBusy || isExplaining}
                        className="inline-flex h-8 items-center gap-2 rounded-md border border-destructive/40 px-3 text-xs font-medium text-destructive hover:bg-destructive/10 disabled:opacity-50"
                      >
                        {isBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <XCircle className="h-3.5 w-3.5" />}
                        Resolve group
                      </button>
                      <button
                        type="button"
                        onClick={() => void sendCorrelationFeedback(group, 'correlation.split')}
                        disabled={isBusy || isExplaining}
                        className="inline-flex h-8 items-center gap-2 rounded-md border px-3 text-xs font-medium hover:bg-muted disabled:opacity-50"
                      >
                        {isBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ThumbsDown className="h-3.5 w-3.5" />}
                        Mark wrong group
                      </button>
                      <button
                        type="button"
                        onClick={() => void sendCorrelationFeedback(group, 'correlation.dismissed')}
                        disabled={isBusy || isExplaining}
                        className="inline-flex h-8 items-center gap-2 rounded-md border px-3 text-xs font-medium hover:bg-muted disabled:opacity-50"
                      >
                        {isBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <XCircle className="h-3.5 w-3.5" />}
                        Dismiss grouping
                      </button>
                    </div>
                  </div>

                  {isExpanded && (
                    <div className="border-t bg-muted/20 px-4 py-4">
                      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(320px,0.9fr)]">
                        <div className="space-y-3">
                          <div className="grid gap-2 sm:grid-cols-3">
                            <div className="rounded-md border bg-background px-3 py-2">
                              <p className="text-xs text-muted-foreground">First seen</p>
                              <p className="text-sm font-medium">{formatDateTime(group.firstSeenAt ?? group.rootCause.triggeredAt)}</p>
                            </div>
                            <div className="rounded-md border bg-background px-3 py-2">
                              <p className="text-xs text-muted-foreground">Last seen</p>
                              <p className="text-sm font-medium">{formatDateTime(group.lastSeenAt)}</p>
                            </div>
                            <div className="rounded-md border bg-background px-3 py-2">
                              <p className="text-xs text-muted-foreground">Members</p>
                              <p className="text-sm font-medium">{group.memberCount ?? group.alerts.length}</p>
                            </div>
                          </div>

                          <div className="space-y-2">
                            {group.alerts.map(alert => (
                              <div
                                key={alert.id}
                                className="flex flex-wrap items-center justify-between gap-3 rounded-md border bg-background px-3 py-2"
                              >
                                <div className="min-w-0">
                                  <a href={`/alerts/${alert.id}`} className="inline-flex max-w-full items-center gap-1 text-sm font-medium hover:underline">
                                    <span className="truncate">{alert.title}</span>
                                    <ExternalLink className="h-3 w-3 shrink-0" />
                                  </a>
                                  <p className="text-xs text-muted-foreground">{alert.device}</p>
                                </div>
                                <div className="flex items-center gap-2">
                                  <span
                                    className={cn(
                                      'rounded-full border px-2 py-0.5 text-[11px] font-medium',
                                      severityStyles[alert.severity]
                                    )}
                                  >
                                    {alert.severity}
                                  </span>
                                  <span
                                    className={cn(
                                      'rounded-full border px-2 py-0.5 text-[11px] font-medium',
                                      statusStyles[alert.status] ?? 'bg-muted text-muted-foreground border-border'
                                    )}
                                  >
                                    {alert.status}
                                  </span>
                                </div>
                              </div>
                            ))}
                          </div>
                        </div>

                        <div className="rounded-md border bg-background">
                          <div className="flex items-center justify-between gap-3 border-b px-4 py-3">
                            <div>
                              <h3 className="text-sm font-semibold">Incident RCA</h3>
                              <p className="text-xs text-muted-foreground">Evidence is gathered on demand.</p>
                            </div>
                            {groupRca && (
                              <div className="flex items-center gap-1">
                                <button
                                  type="button"
                                  onClick={() => void sendRcaFeedback(group, 'rca.helpful')}
                                  className="flex h-8 w-8 items-center justify-center rounded-md hover:bg-muted"
                                  aria-label="Mark RCA helpful"
                                >
                                  <ThumbsUp className="h-4 w-4" />
                                </button>
                                <button
                                  type="button"
                                  onClick={() => void sendRcaFeedback(group, 'rca.not_helpful')}
                                  className="flex h-8 w-8 items-center justify-center rounded-md hover:bg-muted"
                                  aria-label="Mark RCA not helpful"
                                >
                                  <ThumbsDown className="h-4 w-4" />
                                </button>
                              </div>
                            )}
                          </div>

                          {!groupRca ? (
                            <div className="flex min-h-48 flex-col items-center justify-center gap-3 px-4 py-8 text-center text-sm text-muted-foreground">
                              <Brain className="h-8 w-8" />
                              <button
                                type="button"
                                onClick={() => void handleExplainGroup(group)}
                                disabled={isExplaining || rcaDisabled}
                                title={rcaDisabled ? 'RCA is disabled for this organization' : undefined}
                                className="inline-flex h-9 items-center gap-2 rounded-md bg-primary px-3 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50"
                              >
                                {isExplaining ? <Loader2 className="h-4 w-4 animate-spin" /> : <Brain className="h-4 w-4" />}
                                {rcaDisabled ? 'RCA disabled' : 'Explain incident'}
                              </button>
                            </div>
                          ) : (
                            <div className="space-y-4 p-4">
                              <div className="space-y-2">
                                {groupRca.rootCauseCandidates.length === 0 ? (
                                  <p className="text-sm text-muted-foreground">No likely cause candidates were found.</p>
                                ) : (
                                  groupRca.rootCauseCandidates.map((candidate, index) => (
                                    <div key={`${candidate.summary}-${index}`} className="rounded-md border bg-muted/20 px-3 py-2">
                                      <div className="flex items-center justify-between gap-3">
                                        <p className="text-sm font-medium">Candidate {index + 1}</p>
                                        <span className="rounded-full border bg-background px-2 py-0.5 text-xs">
                                          {formatPercent(candidate.confidence * 100)} confidence
                                        </span>
                                      </div>
                                      <p className="mt-1 text-sm text-muted-foreground">{candidate.summary}</p>
                                    </div>
                                  ))
                                )}
                              </div>

                              {groupRca.suggestedNextSteps && groupRca.suggestedNextSteps.length > 0 && (
                                <div>
                                  <div className="mb-2 flex items-center gap-2 text-sm font-medium">
                                    <FileText className="h-4 w-4" />
                                    Suggested next steps
                                  </div>
                                  <div className="space-y-2">
                                    {groupRca.suggestedNextSteps.map((step) => (
                                      <div key={step.title} className="rounded-md border bg-muted/20 px-3 py-2">
                                        <div className="flex flex-wrap items-center justify-between gap-2">
                                          <p className="text-sm font-medium">{step.title}</p>
                                          <span className="rounded-full border bg-background px-2 py-0.5 text-[11px] capitalize text-muted-foreground">
                                            {step.riskTier} risk
                                          </span>
                                        </div>
                                        <p className="mt-1 text-xs text-muted-foreground">{step.rationale}</p>
                                      </div>
                                    ))}
                                  </div>
                                </div>
                              )}

                              <div>
                                <div className="mb-2 flex items-center gap-2 text-sm font-medium">
                                  <Clock className="h-4 w-4" />
                                  Evidence timeline
                                </div>
                                <div className="max-h-72 space-y-2 overflow-y-auto pr-1">
                                  {groupRca.timeline.map((item) => (
                                    <div key={item.id} className="rounded-md border px-3 py-2">
                                      <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                                        <span>{formatDateTime(item.timestamp)}</span>
                                        <span className="rounded-full border bg-muted px-2 py-0.5">{evidenceLabel(item.source)}</span>
                                        <span>{item.type}</span>
                                      </div>
                                      <p className="mt-1 text-sm font-medium">{item.title}</p>
                                      <p className="mt-0.5 text-xs text-muted-foreground">{item.summary}</p>
                                    </div>
                                  ))}
                                </div>
                              </div>

                              {groupRca.gaps.length > 0 && (
                                <div className="rounded-md border border-warning/40 bg-warning/10 px-3 py-2">
                                  <p className="text-sm font-medium">Evidence gaps</p>
                                  <ul className="mt-1 space-y-1 text-xs text-muted-foreground">
                                    {groupRca.gaps.map((gap) => <li key={gap}>{gap}</li>)}
                                  </ul>
                                </div>
                              )}

                              <button
                                type="button"
                                onClick={() => void sendRcaFeedback(group, 'rca.used_in_ticket')}
                                className="inline-flex h-9 items-center gap-2 rounded-md border px-3 text-sm font-medium hover:bg-muted"
                              >
                                <FileText className="h-4 w-4" />
                                Used in ticket
                              </button>
                              <button
                                type="button"
                                onClick={() => void sendRcaFeedback(group, 'rca.edited')}
                                className="inline-flex h-9 items-center gap-2 rounded-md border px-3 text-sm font-medium hover:bg-muted"
                              >
                                <Pencil className="h-4 w-4" />
                                Mark edited
                              </button>
                            </div>
                          )}
                        </div>
                      </div>
                    </div>
                  )}
                </section>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}
