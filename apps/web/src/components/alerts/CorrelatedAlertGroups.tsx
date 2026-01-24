import { useState, useEffect, useCallback } from 'react';
import { CheckCircle, ChevronDown, ChevronRight, XCircle } from 'lucide-react';
import { cn } from '@/lib/utils';
import { fetchWithAuth } from '../../stores/auth';
import type { AlertSeverity } from './AlertList';

type AlertItem = {
  id: string;
  title: string;
  severity: AlertSeverity;
  status: 'active' | 'acknowledged' | 'resolved';
  device: string;
};

type AlertGroup = {
  id: string;
  rootCause: AlertItem;
  relatedCount: number;
  alerts: AlertItem[];
};

const severityStyles: Record<AlertSeverity, string> = {
  critical: 'bg-red-500/20 text-red-700 border-red-500/40',
  high: 'bg-orange-500/20 text-orange-700 border-orange-500/40',
  medium: 'bg-yellow-500/20 text-yellow-700 border-yellow-500/40',
  low: 'bg-blue-500/20 text-blue-700 border-blue-500/40',
  info: 'bg-gray-500/20 text-gray-700 border-gray-500/40'
};

const statusStyles: Record<AlertItem['status'], string> = {
  active: 'bg-red-500/20 text-red-700 border-red-500/40',
  acknowledged: 'bg-yellow-500/20 text-yellow-700 border-yellow-500/40',
  resolved: 'bg-emerald-500/20 text-emerald-700 border-emerald-500/40'
};

export default function CorrelatedAlertGroups() {
  const [groups, setGroups] = useState<AlertGroup[]>([]);
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set());
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchGroups = useCallback(async () => {
    setIsLoading(true);
    setError(null);

    try {
      const response = await fetchWithAuth('/alerts/correlations');

      if (response.status === 401) {
        window.location.href = '/login';
        return;
      }

      if (!response.ok) {
        throw new Error('Failed to fetch correlated alert groups');
      }

      const data = await response.json();
      setGroups(data.groups || []);
      // Auto-expand first group if available
      if (data.groups?.length > 0) {
        setExpandedGroups(new Set([data.groups[0].id]));
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load alert groups');
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchGroups();
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

  const handleAcknowledgeGroup = async (groupId: string) => {
    try {
      const response = await fetchWithAuth(`/alerts/correlations/${groupId}/acknowledge`, {
        method: 'POST'
      });

      if (response.status === 401) {
        window.location.href = '/login';
        return;
      }

      if (response.ok) {
        fetchGroups();
      }
    } catch {
      // Handle error silently or show notification
    }
  };

  const handleResolveGroup = async (groupId: string) => {
    try {
      const response = await fetchWithAuth(`/alerts/correlations/${groupId}/resolve`, {
        method: 'POST'
      });

      if (response.status === 401) {
        window.location.href = '/login';
        return;
      }

      if (response.ok) {
        fetchGroups();
      }
    } catch {
      // Handle error silently or show notification
    }
  };

  if (isLoading) {
    return (
      <div className="space-y-6">
        <div className="rounded-lg border bg-card p-6 shadow-sm">
          <div className="flex h-48 items-center justify-center">
            <div className="h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent" />
          </div>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="space-y-6">
        <div className="rounded-lg border bg-card p-6 shadow-sm">
          <div className="flex h-48 flex-col items-center justify-center gap-2 text-muted-foreground">
            <p>{error}</p>
            <button
              type="button"
              onClick={fetchGroups}
              className="text-sm text-primary hover:underline"
            >
              Try again
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="rounded-lg border bg-card p-6 shadow-sm">
        <div className="flex flex-col gap-2">
          <h2 className="text-lg font-semibold">Correlated Alert Groups</h2>
          <p className="text-sm text-muted-foreground">Cluster alerts by probable root cause.</p>
        </div>

        <div className="mt-6 space-y-4">
          {groups.length === 0 ? (
            <div className="py-8 text-center text-muted-foreground">
              No correlated alert groups found.
            </div>
          ) : (
            groups.map(group => {
              const isExpanded = expandedGroups.has(group.id);
              return (
                <div key={group.id} className="rounded-md border">
                  <button
                    type="button"
                    onClick={() => toggleGroup(group.id)}
                    className="flex w-full items-center justify-between gap-4 px-4 py-3 text-left"
                  >
                    <div className="flex items-start gap-3">
                      {isExpanded ? (
                        <ChevronDown className="mt-1 h-4 w-4 text-muted-foreground" />
                      ) : (
                        <ChevronRight className="mt-1 h-4 w-4 text-muted-foreground" />
                      )}
                      <div>
                        <p className="text-sm font-medium">{group.rootCause.title}</p>
                        <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                          <span
                            className={cn(
                              'rounded-full border px-2 py-0.5 font-medium',
                              severityStyles[group.rootCause.severity]
                            )}
                          >
                            {group.rootCause.severity}
                          </span>
                          <span>Root cause: {group.rootCause.device}</span>
                          <span>·</span>
                          <span>{group.relatedCount} related alerts</span>
                        </div>
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          handleAcknowledgeGroup(group.id);
                        }}
                        className="inline-flex h-8 items-center gap-2 rounded-md border px-3 text-xs font-medium hover:bg-muted"
                      >
                        <CheckCircle className="h-3.5 w-3.5" />
                        Acknowledge group
                      </button>
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          handleResolveGroup(group.id);
                        }}
                        className="inline-flex h-8 items-center gap-2 rounded-md border border-destructive/40 px-3 text-xs font-medium text-destructive hover:bg-destructive/10"
                      >
                        <XCircle className="h-3.5 w-3.5" />
                        Resolve group
                      </button>
                    </div>
                  </button>

                  {isExpanded && (
                    <div className="border-t bg-muted/30 px-4 py-3">
                      <div className="space-y-2">
                        {group.alerts.map(alert => (
                          <div
                            key={alert.id}
                            className="flex flex-wrap items-center justify-between gap-3 rounded-md border bg-background px-3 py-2"
                          >
                            <div>
                              <p className="text-sm font-medium">{alert.title}</p>
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
                                  statusStyles[alert.status]
                                )}
                              >
                                {alert.status}
                              </span>
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}
