import { useCallback, useEffect, useMemo, useState } from 'react';
import { Send } from 'lucide-react';
import { fetchWithAuth } from '../../stores/auth';

type TestHistoryItem = {
  id: string;
  event: string;
  status: number;
  timestamp: string;
};

type WebhookResponse = {
  status: number;
  statusText: string;
  headers: Record<string, string>;
  body: unknown;
};

const eventTypes = [
  'device.offline',
  'ticket.created',
  'patch.completed',
  'backup.failed',
  'security.alert'
];

const samplePayloads: Record<string, Record<string, unknown>> = {
  'device.offline': {
    id: 'evt_0123',
    type: 'device.offline',
    device: { id: 'dev_045', name: 'NYC-FW-01' },
    occurredAt: '2024-01-12T16:22:00Z'
  },
  'ticket.created': {
    id: 'evt_0456',
    type: 'ticket.created',
    ticket: { id: 'TCK-1092', priority: 'P2', subject: 'VPN outage' },
    occurredAt: '2024-01-12T16:30:00Z'
  },
  'patch.completed': {
    id: 'evt_0789',
    type: 'patch.completed',
    device: { id: 'dev_992', name: 'ATL-APP-02' },
    summary: { succeeded: 24, failed: 1 }
  },
  'backup.failed': {
    id: 'evt_1011',
    type: 'backup.failed',
    job: { id: 'job_77', name: 'Nightly NAS backup' },
    reason: 'Snapshot timeout'
  },
  'security.alert': {
    id: 'evt_2233',
    type: 'security.alert',
    severity: 'high',
    details: { rule: 'Impossible travel', user: 'tina@breeze.dev' }
  }
};

type WebhookTestPanelProps = {
  webhookId: string;
};

export default function WebhookTestPanel({ webhookId }: WebhookTestPanelProps) {
  const [eventType, setEventType] = useState(eventTypes[0]);
  const [history, setHistory] = useState<TestHistoryItem[]>([]);
  const [response, setResponse] = useState<WebhookResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string>();

  const payloadPreview = useMemo(
    () => JSON.stringify(samplePayloads[eventType], null, 2),
    [eventType]
  );

  const fetchHistory = useCallback(async () => {
    try {
      setLoading(true);
      setError(undefined);
      const response = await fetchWithAuth(`/webhooks/${webhookId}/deliveries?limit=5`);
      if (!response.ok) {
        throw new Error('Failed to fetch test history');
      }
      const data = await response.json();
      const deliveries = data.deliveries ?? data ?? [];
      setHistory(
        deliveries.map((delivery: { id: string; event?: string; statusCode?: number; createdAt?: string }) => ({
          id: delivery.id,
          event: delivery.event || 'unknown',
          status: delivery.statusCode || 0,
          timestamp: delivery.createdAt ? new Date(delivery.createdAt).toLocaleString() : 'Unknown'
        }))
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load test history');
    } finally {
      setLoading(false);
    }
  }, [webhookId]);

  useEffect(() => {
    fetchHistory();
  }, [fetchHistory]);

  const handleSendTest = async () => {
    setSending(true);
    setError(undefined);

    try {
      const apiResponse = await fetchWithAuth(`/webhooks/${webhookId}/test`, {
        method: 'POST',
        body: JSON.stringify({
          event: eventType,
          payload: samplePayloads[eventType]
        })
      });

      const data = await apiResponse.json().catch(() => ({}));

      if (!apiResponse.ok) {
        throw new Error(data.error || 'Test failed');
      }

      setResponse({
        status: data.statusCode || apiResponse.status,
        statusText: data.statusText || (apiResponse.ok ? 'OK' : 'Error'),
        headers: data.responseHeaders || {},
        body: data.responseBody || { received: true }
      });

      // Refresh history after test
      await fetchHistory();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Test failed');
      setResponse({
        status: 500,
        statusText: 'Error',
        headers: {},
        body: { error: err instanceof Error ? err.message : 'Test failed' }
      });
    } finally {
      setSending(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <div className="text-center">
          <div className="mx-auto h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent" />
          <p className="mt-4 text-sm text-muted-foreground">Loading test history...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="rounded-xl border bg-card p-6 shadow-sm">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
        <div>
          <h2 className="text-lg font-semibold">Webhook testing</h2>
          <p className="text-sm text-muted-foreground">Send sample events and inspect responses.</p>
        </div>
        <button
          type="button"
          onClick={handleSendTest}
          disabled={sending}
          className="inline-flex h-10 items-center justify-center gap-2 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
        >
          <Send className="h-4 w-4" />
          {sending ? 'Sending...' : 'Send test'}
        </button>
      </div>

      {error && (
        <div className="mt-4 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </div>
      )}

      <div className="mt-6 grid gap-6 lg:grid-cols-[1.2fr_0.8fr]">
        <div className="space-y-4">
          <div>
            <label className="text-sm font-medium">Event type</label>
            <select
              value={eventType}
              onChange={event => setEventType(event.target.value)}
              className="mt-2 h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
            >
              {eventTypes.map(type => (
                <option key={type} value={type}>
                  {type}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="text-sm font-medium">Sample payload</label>
            <pre className="mt-2 max-h-64 overflow-auto rounded-lg border bg-muted/40 p-4 text-xs">
              {payloadPreview}
            </pre>
          </div>
        </div>

        <div className="space-y-4">
          <div className="rounded-lg border bg-background p-4">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-semibold">Response</h3>
              {response && (
                <span
                  className={`rounded-full border px-2.5 py-1 text-xs ${
                    response.status >= 400
                      ? 'border-rose-200 bg-rose-50 text-rose-700'
                      : 'border-emerald-200 bg-emerald-50 text-emerald-700'
                  }`}
                >
                  {response.status} {response.statusText}
                </span>
              )}
            </div>
            {response ? (
              <div className="mt-3 text-xs text-muted-foreground">
                <p className="font-semibold text-foreground">Headers</p>
                <pre className="mt-2 rounded-md bg-muted/40 p-3 text-xs">
                  {JSON.stringify(response.headers, null, 2)}
                </pre>
                <p className="mt-3 font-semibold text-foreground">Body</p>
                <pre className="mt-2 rounded-md bg-muted/40 p-3 text-xs">
                  {JSON.stringify(response.body, null, 2)}
                </pre>
              </div>
            ) : (
              <p className="mt-3 text-xs text-muted-foreground">
                Send a test to see the response.
              </p>
            )}
          </div>

          <div className="rounded-lg border bg-background p-4">
            <h3 className="text-sm font-semibold">Recent tests</h3>
            <div className="mt-3 space-y-3 text-sm">
              {history.length > 0 ? (
                history.map(item => (
                  <div key={item.id} className="flex items-center justify-between">
                    <div>
                      <p className="font-medium">{item.event}</p>
                      <p className="text-xs text-muted-foreground">{item.timestamp}</p>
                    </div>
                    <span
                      className={`rounded-full border px-2.5 py-1 text-xs ${
                        item.status >= 400
                          ? 'border-rose-200 bg-rose-50 text-rose-700'
                          : 'border-emerald-200 bg-emerald-50 text-emerald-700'
                      }`}
                    >
                      {item.status}
                    </span>
                  </div>
                ))
              ) : (
                <p className="text-xs text-muted-foreground">No test history yet.</p>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
