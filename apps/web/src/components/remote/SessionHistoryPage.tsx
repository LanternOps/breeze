import { useState, useCallback } from 'react';
import { History, X } from 'lucide-react';
import SessionHistory, { normalizeRemoteSession, type RemoteSession, type RemoteSessionApi } from './SessionHistory';
import { fetchWithAuth } from '@/stores/auth';

type SessionHistoryPageProps = {
  limit?: number;
};

export default function SessionHistoryPage({ limit }: SessionHistoryPageProps) {
  const [selectedSession, setSelectedSession] = useState<RemoteSession | null>(null);

  const handleViewDetails = useCallback((session: RemoteSession) => {
    setSelectedSession(session);
  }, []);

  const handleExport = useCallback(async () => {
    try {
      const sessions: RemoteSession[] = [];
      const pageSize = 100;
      let page = 1;
      let total = Number.POSITIVE_INFINITY;

      while (sessions.length < total) {
        const response = await fetchWithAuth(`/remote/sessions/history?limit=${pageSize}&page=${page}`);

        if (!response.ok) {
          throw new Error('Failed to fetch sessions for export');
        }

        const data = await response.json();
        const batch = (data.data ?? []).map((session: RemoteSessionApi) => normalizeRemoteSession(session));
        sessions.push(...batch);

        if (typeof data.pagination?.total === 'number') {
          total = data.pagination.total;
        } else {
          total = sessions.length;
        }

        if (batch.length === 0) {
          break;
        }

        page += 1;
      }

      // Create CSV content
      const csvHeaders = ['ID', 'Device', 'User', 'Type', 'Status', 'Started', 'Ended', 'Duration (s)', 'Bytes Transferred'];
      const rows = sessions.map((s: RemoteSession) => [
        s.id,
        s.deviceHostname,
        s.userName,
        s.type,
        s.status,
        s.startedAt || s.createdAt,
        s.endedAt || '',
        s.durationSeconds || '',
        s.bytesTransferred || ''
      ]);

      const csvContent = [
        csvHeaders.join(','),
        ...rows.map((row: (string | number)[]) => row.map(cell => `"${cell}"`).join(','))
      ].join('\n');

      // Download CSV
      const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
      const link = document.createElement('a');
      const url = URL.createObjectURL(blob);
      link.setAttribute('href', url);
      link.setAttribute('download', `session-history-${new Date().toISOString().split('T')[0]}.csv`);
      link.style.visibility = 'hidden';
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
    } catch (error) {
      console.error('Export failed:', error);
    }
  }, []);

  const formatDateTime = (dateString?: string) => {
    if (!dateString) return '-';
    return new Date(dateString).toLocaleString();
  };

  const formatDuration = (seconds?: number) => {
    if (!seconds) return '-';
    if (seconds < 60) return `${seconds}s`;
    if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
    const hours = Math.floor(seconds / 3600);
    const mins = Math.floor((seconds % 3600) / 60);
    return `${hours}h ${mins}m`;
  };

  const formatBytes = (bytes?: number) => {
    if (!bytes) return '-';
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-4">
        <div className="flex h-12 w-12 items-center justify-center rounded-lg bg-muted">
          <History className="h-6 w-6 text-muted-foreground" />
        </div>
        <div>
          <h1 className="text-2xl font-bold">Session History</h1>
          <p className="text-muted-foreground">View and audit remote access sessions</p>
        </div>
      </div>

      <SessionHistory
        onViewDetails={handleViewDetails}
        onExport={handleExport}
        limit={limit}
      />

      {/* Session Details Modal */}
      {selectedSession && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
          <div className="w-full max-w-2xl max-h-[90vh] overflow-auto rounded-lg border bg-card shadow-lg">
            <div className="flex items-center justify-between border-b p-4">
              <h3 className="text-lg font-semibold">Session Details</h3>
              <button
                type="button"
                onClick={() => setSelectedSession(null)}
                className="flex h-8 w-8 items-center justify-center rounded-md hover:bg-muted"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            <div className="p-6 space-y-6">
              {/* Session Info */}
              <div>
                <h4 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide mb-3">
                  Session Information
                </h4>
                <dl className="grid gap-3 sm:grid-cols-2">
                  <div>
                    <dt className="text-sm text-muted-foreground">Session ID</dt>
                    <dd className="font-mono text-sm">{selectedSession.id}</dd>
                  </div>
                  <div>
                    <dt className="text-sm text-muted-foreground">Type</dt>
                    <dd className="text-sm capitalize">{selectedSession.type.replace('_', ' ')}</dd>
                  </div>
                  <div>
                    <dt className="text-sm text-muted-foreground">Status</dt>
                    <dd className="text-sm capitalize">{selectedSession.status}</dd>
                  </div>
                  <div>
                    <dt className="text-sm text-muted-foreground">Duration</dt>
                    <dd className="text-sm">{formatDuration(selectedSession.durationSeconds)}</dd>
                  </div>
                </dl>
              </div>

              {/* Device Info */}
              <div>
                <h4 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide mb-3">
                  Device
                </h4>
                <dl className="grid gap-3 sm:grid-cols-2">
                  <div>
                    <dt className="text-sm text-muted-foreground">Hostname</dt>
                    <dd className="text-sm font-medium">{selectedSession.deviceHostname}</dd>
                  </div>
                  <div>
                    <dt className="text-sm text-muted-foreground">OS</dt>
                    <dd className="text-sm capitalize">{selectedSession.deviceOsType}</dd>
                  </div>
                  <div>
                    <dt className="text-sm text-muted-foreground">Device ID</dt>
                    <dd className="font-mono text-xs">{selectedSession.deviceId}</dd>
                  </div>
                </dl>
              </div>

              {/* User Info */}
              <div>
                <h4 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide mb-3">
                  User
                </h4>
                <dl className="grid gap-3 sm:grid-cols-2">
                  <div>
                    <dt className="text-sm text-muted-foreground">Name</dt>
                    <dd className="text-sm font-medium">{selectedSession.userName}</dd>
                  </div>
                  <div>
                    <dt className="text-sm text-muted-foreground">Email</dt>
                    <dd className="text-sm">{selectedSession.userEmail}</dd>
                  </div>
                  <div>
                    <dt className="text-sm text-muted-foreground">User ID</dt>
                    <dd className="font-mono text-xs">{selectedSession.userId}</dd>
                  </div>
                </dl>
              </div>

              {/* Timeline */}
              <div>
                <h4 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide mb-3">
                  Timeline
                </h4>
                <dl className="grid gap-3 sm:grid-cols-2">
                  <div>
                    <dt className="text-sm text-muted-foreground">Created</dt>
                    <dd className="text-sm">{formatDateTime(selectedSession.createdAt)}</dd>
                  </div>
                  <div>
                    <dt className="text-sm text-muted-foreground">Started</dt>
                    <dd className="text-sm">{formatDateTime(selectedSession.startedAt)}</dd>
                  </div>
                  <div>
                    <dt className="text-sm text-muted-foreground">Ended</dt>
                    <dd className="text-sm">{formatDateTime(selectedSession.endedAt)}</dd>
                  </div>
                  <div>
                    <dt className="text-sm text-muted-foreground">Data Transferred</dt>
                    <dd className="text-sm">{formatBytes(selectedSession.bytesTransferred)}</dd>
                  </div>
                </dl>
              </div>

              {/* Recording */}
              {selectedSession.recordingUrl && (
                <div>
                  <h4 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide mb-3">
                    Recording
                  </h4>
                  <a
                    href={selectedSession.recordingUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90"
                  >
                    View Recording
                  </a>
                </div>
              )}
            </div>

            <div className="flex justify-end gap-3 border-t p-4">
              <button
                type="button"
                onClick={() => {
                  // Navigate to device page
                  window.location.href = `/devices/${selectedSession.deviceId}`;
                }}
                className="rounded-md border px-4 py-2 text-sm font-medium hover:bg-muted"
              >
                View Device
              </button>
              <button
                type="button"
                onClick={() => setSelectedSession(null)}
                className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90"
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
