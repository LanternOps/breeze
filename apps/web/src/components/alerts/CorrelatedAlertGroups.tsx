import { useState } from 'react';
import { CheckCircle, ChevronDown, ChevronRight, XCircle } from 'lucide-react';
import { cn } from '@/lib/utils';
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

const mockGroups: AlertGroup[] = [
  {
    id: 'group-1',
    rootCause: {
      id: 'alert-1',
      title: 'Core switch CPU saturation',
      severity: 'critical',
      status: 'active',
      device: 'Core-SW-01'
    },
    relatedCount: 4,
    alerts: [
      {
        id: 'alert-2',
        title: 'WAN latency spike - West',
        severity: 'high',
        status: 'active',
        device: 'WAN-Gateway-07'
      },
      {
        id: 'alert-3',
        title: 'VPN tunnel packet loss',
        severity: 'medium',
        status: 'acknowledged',
        device: 'VPN-Edge-03'
      },
      {
        id: 'alert-4',
        title: 'Monitoring duplicate alert',
        severity: 'low',
        status: 'resolved',
        device: 'Monitor-02'
      },
      {
        id: 'alert-5',
        title: 'Route flapping detected',
        severity: 'high',
        status: 'active',
        device: 'Core-SW-02'
      }
    ]
  },
  {
    id: 'group-2',
    rootCause: {
      id: 'alert-6',
      title: 'Storage latency on DB cluster',
      severity: 'high',
      status: 'active',
      device: 'DB-Primary-02'
    },
    relatedCount: 3,
    alerts: [
      {
        id: 'alert-7',
        title: 'Replication lag exceeded',
        severity: 'medium',
        status: 'active',
        device: 'DB-Replica-01'
      },
      {
        id: 'alert-8',
        title: 'Backup job failed',
        severity: 'low',
        status: 'acknowledged',
        device: 'Backup-Server-05'
      },
      {
        id: 'alert-9',
        title: 'Disk IO queue depth high',
        severity: 'high',
        status: 'active',
        device: 'Storage-Array-2'
      }
    ]
  }
];

export default function CorrelatedAlertGroups() {
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set(['group-1']));

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

  return (
    <div className="space-y-6">
      <div className="rounded-lg border bg-card p-6 shadow-sm">
        <div className="flex flex-col gap-2">
          <h2 className="text-lg font-semibold">Correlated Alert Groups</h2>
          <p className="text-sm text-muted-foreground">Cluster alerts by probable root cause.</p>
        </div>

        <div className="mt-6 space-y-4">
          {mockGroups.map(group => {
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
                      className="inline-flex h-8 items-center gap-2 rounded-md border px-3 text-xs font-medium hover:bg-muted"
                    >
                      <CheckCircle className="h-3.5 w-3.5" />
                      Acknowledge group
                    </button>
                    <button
                      type="button"
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
          })}
        </div>
      </div>
    </div>
  );
}
