import { useState, useEffect, useCallback } from 'react';
import { fetchWithAuth } from '../../stores/auth';
import { navigateTo } from '@/lib/navigation';

type IncidentSeverity = 'p1' | 'p2' | 'p3' | 'p4';
type IncidentStatus = 'detected' | 'analyzing' | 'contained' | 'recovering' | 'closed';
type DetailTab = 'timeline' | 'actions' | 'evidence';

interface Incident {
  id: string;
  title: string;
  severity: IncidentSeverity;
  status: IncidentStatus;
  classification: string | null;
  summary: string | null;
  detectedAt: string;
  containedAt: string | null;
  resolvedAt: string | null;
  closedAt: string | null;
}

interface TimelineEntry {
  at: string;
  type: string;
  actor: string | null;
  summary: string;
  metadata: Record<string, unknown> | null;
}

interface ActionEntry {
  id: string;
  actionType: string;
  description: string | null;
  executedBy: string | null;
  status: string;
  reversible: boolean;
  reversed: boolean;
  executedAt: string;
}

interface EvidenceEntry {
  id: string;
  evidenceType: string;
  description: string | null;
  collectedAt: string;
  collectedBy: string | null;
  hash: string | null;
  storagePath: string | null;
}

interface IncidentDetailProps {
  incidentId: string;
}

const severityColors: Record<IncidentSeverity, string> = {
  p1: 'bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-300',
  p2: 'bg-orange-100 text-orange-800 dark:bg-orange-900/30 dark:text-orange-300',
  p3: 'bg-yellow-100 text-yellow-800 dark:bg-yellow-900/30 dark:text-yellow-300',
  p4: 'bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-300',
};

const statusColors: Record<IncidentStatus, string> = {
  detected: 'bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-300',
  analyzing: 'bg-yellow-100 text-yellow-800 dark:bg-yellow-900/30 dark:text-yellow-300',
  contained: 'bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-300',
  recovering: 'bg-purple-100 text-purple-800 dark:bg-purple-900/30 dark:text-purple-300',
  closed: 'bg-gray-100 text-gray-800 dark:bg-gray-700/30 dark:text-gray-300',
};

export default function IncidentDetailPage({ incidentId }: IncidentDetailProps) {
  const [incident, setIncident] = useState<Incident | null>(null);
  const [timeline, setTimeline] = useState<TimelineEntry[]>([]);
  const [actions, setActions] = useState<ActionEntry[]>([]);
  const [evidence, setEvidence] = useState<EvidenceEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [activeTab, setActiveTab] = useState<DetailTab>('timeline');

  const fetchDetail = useCallback(async () => {
    try {
      setLoading(true);
      setError(undefined);
      const response = await fetchWithAuth(`/incidents/${incidentId}`);
      if (!response.ok) {
        if (response.status === 401) {
          void navigateTo('/login', { replace: true });
          return;
        }
        if (response.status === 404) {
          setError('Incident not found');
          return;
        }
        throw new Error('Failed to fetch incident');
      }
      const data = await response.json();
      setIncident(data.incident);
      setTimeline(data.timeline ?? []);
      setActions(data.actions ?? []);
      setEvidence(data.evidence ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An error occurred');
    } finally {
      setLoading(false);
    }
  }, [incidentId]);

  useEffect(() => {
    fetchDetail();
  }, [fetchDetail]);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <div className="text-center">
          <div className="h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent mx-auto" />
          <p className="mt-4 text-sm text-muted-foreground">Loading incident...</p>
        </div>
      </div>
    );
  }

  if (error || !incident) {
    return (
      <div className="space-y-4">
        <a
          href="/incidents"
          className="text-sm text-primary hover:underline"
        >
          &larr; Back to incidents
        </a>
        <div className="rounded-lg border border-destructive/40 bg-destructive/10 p-6 text-center">
          <p className="text-sm text-destructive">{error ?? 'Incident not found'}</p>
          <button
            type="button"
            onClick={() => fetchDetail()}
            className="mt-4 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90"
          >
            Try again
          </button>
        </div>
      </div>
    );
  }

  const dateFields: { label: string; value: string | null }[] = [
    { label: 'Detected', value: incident.detectedAt },
    { label: 'Contained', value: incident.containedAt },
    { label: 'Resolved', value: incident.resolvedAt },
    { label: 'Closed', value: incident.closedAt },
  ];
  const visibleDates = dateFields.filter((d) => d.value);

  const tabs: { key: DetailTab; label: string; count?: number }[] = [
    { key: 'timeline', label: 'Timeline' },
    { key: 'actions', label: 'Actions', count: actions.length },
    { key: 'evidence', label: 'Evidence', count: evidence.length },
  ];

  return (
    <div className="space-y-6">
      {/* Back link */}
      <a
        href="/incidents"
        className="text-sm text-primary hover:underline"
      >
        &larr; Back to incidents
      </a>

      {/* Header */}
      <div className="space-y-2">
        <h1 className="text-xl font-semibold tracking-tight">{incident.title}</h1>
        <div className="flex flex-wrap items-center gap-2">
          <span className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${severityColors[incident.severity]}`}>
            {incident.severity.toUpperCase()}
          </span>
          <span className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium capitalize ${statusColors[incident.status]}`}>
            {incident.status}
          </span>
          {incident.classification && (
            <span className="inline-flex items-center rounded-full bg-muted px-2.5 py-0.5 text-xs font-medium text-muted-foreground">
              {incident.classification}
            </span>
          )}
        </div>
      </div>

      {/* Summary */}
      {incident.summary && (
        <div className="rounded-lg border bg-card p-4">
          <h2 className="text-sm font-medium text-muted-foreground mb-1">Summary</h2>
          <p className="text-sm text-foreground">{incident.summary}</p>
        </div>
      )}

      {/* Key Dates */}
      {visibleDates.length > 0 && (
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
          {visibleDates.map((d) => (
            <div key={d.label} className="rounded-lg border bg-card p-3">
              <p className="text-xs font-medium text-muted-foreground">{d.label}</p>
              <p className="text-sm font-medium text-foreground mt-0.5">
                {new Date(d.value!).toLocaleString()}
              </p>
            </div>
          ))}
        </div>
      )}

      {/* Tab Navigation */}
      <div className="border-b">
        <nav className="flex gap-4">
          {tabs.map((tab) => (
            <button
              key={tab.key}
              type="button"
              onClick={() => setActiveTab(tab.key)}
              className={`pb-2 text-sm font-medium border-b-2 transition-colors ${
                activeTab === tab.key
                  ? 'border-primary text-primary'
                  : 'border-transparent text-muted-foreground hover:text-foreground hover:border-muted-foreground'
              }`}
            >
              {tab.label}
              {tab.count != null && (
                <span className="ml-1.5 inline-flex items-center rounded-full bg-muted px-2 py-0.5 text-xs">
                  {tab.count}
                </span>
              )}
            </button>
          ))}
        </nav>
      </div>

      {/* Tab Content */}
      {activeTab === 'timeline' && <TimelineView entries={timeline} />}
      {activeTab === 'actions' && <ActionsView entries={actions} />}
      {activeTab === 'evidence' && <EvidenceView entries={evidence} />}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Timeline Tab                                                        */
/* ------------------------------------------------------------------ */
function TimelineView({ entries }: { entries: TimelineEntry[] }) {
  if (entries.length === 0) {
    return <p className="text-sm text-muted-foreground py-4">No timeline entries yet.</p>;
  }

  return (
    <div className="relative pl-6">
      {/* Vertical line */}
      <div className="absolute left-2.5 top-1 bottom-1 w-px bg-border" />

      <div className="space-y-6">
        {entries.map((entry, i) => (
          <div key={i} className="relative">
            {/* Dot */}
            <div className="absolute -left-6 top-1.5 h-2 w-2 rounded-full bg-primary ring-2 ring-background" />
            <div>
              <p className="text-sm text-foreground">{entry.summary}</p>
              <div className="flex items-center gap-2 mt-1">
                <span className="text-xs text-muted-foreground">
                  {new Date(entry.at).toLocaleString()}
                </span>
                {entry.actor && (
                  <>
                    <span className="text-xs text-muted-foreground">&middot;</span>
                    <span className="text-xs text-muted-foreground">{entry.actor}</span>
                  </>
                )}
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Actions Tab                                                         */
/* ------------------------------------------------------------------ */
function ActionsView({ entries }: { entries: ActionEntry[] }) {
  if (entries.length === 0) {
    return <p className="text-sm text-muted-foreground py-4">No actions recorded.</p>;
  }

  return (
    <div className="overflow-x-auto rounded-lg border">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b bg-muted/50">
            <th className="px-4 py-3 text-left font-medium text-muted-foreground">Action</th>
            <th className="px-4 py-3 text-left font-medium text-muted-foreground">Status</th>
            <th className="px-4 py-3 text-left font-medium text-muted-foreground">By</th>
            <th className="px-4 py-3 text-left font-medium text-muted-foreground">When</th>
          </tr>
        </thead>
        <tbody>
          {entries.map((action) => (
            <tr key={action.id} className="border-b">
              <td className="px-4 py-3 font-medium text-foreground capitalize">
                {action.actionType.replace(/_/g, ' ')}
              </td>
              <td className="px-4 py-3">
                <span className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium capitalize ${
                  action.status === 'completed'
                    ? 'bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300'
                    : action.status === 'failed'
                      ? 'bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-300'
                      : 'bg-gray-100 text-gray-800 dark:bg-gray-700/30 dark:text-gray-300'
                }`}>
                  {action.status}
                </span>
              </td>
              <td className="px-4 py-3 text-muted-foreground">
                {action.executedBy ?? '-'}
              </td>
              <td className="px-4 py-3 text-muted-foreground">
                {new Date(action.executedAt).toLocaleString()}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Evidence Tab                                                        */
/* ------------------------------------------------------------------ */
function EvidenceView({ entries }: { entries: EvidenceEntry[] }) {
  if (entries.length === 0) {
    return <p className="text-sm text-muted-foreground py-4">No evidence collected.</p>;
  }

  return (
    <div className="overflow-x-auto rounded-lg border">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b bg-muted/50">
            <th className="px-4 py-3 text-left font-medium text-muted-foreground">Type</th>
            <th className="px-4 py-3 text-left font-medium text-muted-foreground">Description</th>
            <th className="px-4 py-3 text-left font-medium text-muted-foreground">Collected By</th>
            <th className="px-4 py-3 text-left font-medium text-muted-foreground">When</th>
            <th className="px-4 py-3 text-left font-medium text-muted-foreground">Hash</th>
          </tr>
        </thead>
        <tbody>
          {entries.map((ev) => (
            <tr key={ev.id} className="border-b">
              <td className="px-4 py-3 font-medium text-foreground capitalize">
                {ev.evidenceType.replace(/_/g, ' ')}
              </td>
              <td className="px-4 py-3 text-muted-foreground max-w-xs truncate">
                {ev.description ?? '-'}
              </td>
              <td className="px-4 py-3 text-muted-foreground">
                {ev.collectedBy ?? '-'}
              </td>
              <td className="px-4 py-3 text-muted-foreground">
                {new Date(ev.collectedAt).toLocaleString()}
              </td>
              <td className="px-4 py-3 text-muted-foreground font-mono text-xs">
                {ev.hash ? ev.hash.substring(0, 12) + '...' : '-'}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
