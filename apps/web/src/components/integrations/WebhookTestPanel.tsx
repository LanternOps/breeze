import { useMemo, useState } from 'react';
import { Send } from 'lucide-react';

let historyIdCounter = 0;
const createHistoryId = () => {
  historyIdCounter += 1;
  return `hst-${historyIdCounter}`;
};

let requestIdCounter = 0;
const createRequestId = () => {
  requestIdCounter += 1;
  return `req_${requestIdCounter.toString(36).padStart(4, '0')}`;
};

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
  body:
    | { received: true; deliveredAt: string }
    | { received: false; error: string };
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

const initialHistory: TestHistoryItem[] = [
  { id: 'hst-1', event: 'device.offline', status: 200, timestamp: '6m ago' },
  { id: 'hst-2', event: 'ticket.created', status: 200, timestamp: '18m ago' },
  { id: 'hst-3', event: 'backup.failed', status: 500, timestamp: '1h ago' }
];

export default function WebhookTestPanel() {
  const [eventType, setEventType] = useState(eventTypes[0]);
  const [history, setHistory] = useState<TestHistoryItem[]>(initialHistory);
  const [response, setResponse] = useState<WebhookResponse>({
    status: 200,
    statusText: 'OK',
    headers: {
      'content-type': 'application/json',
      'x-request-id': 'req_9c21'
    },
    body: { received: true, deliveredAt: '2024-01-12T16:22:32Z' }
  });

  const payloadPreview = useMemo(
    () => JSON.stringify(samplePayloads[eventType], null, 2),
    [eventType]
  );

  const handleSendTest = () => {
    const isFailure = eventType === 'backup.failed' || eventType === 'security.alert';
    const status = isFailure ? 500 : 200;
    const statusText = isFailure ? 'Internal Server Error' : 'OK';
    const nextHistory = [
      {
        id: createHistoryId(),
        event: eventType,
        status,
        timestamp: 'Just now'
      },
      ...history
    ].slice(0, 5);

    setHistory(nextHistory);
    setResponse({
      status,
      statusText,
      headers: {
        'content-type': 'application/json',
        'x-request-id': createRequestId()
      },
      body: isFailure
        ? { received: false, error: 'Destination failed to process payload.' }
        : { received: true, deliveredAt: '2024-01-15T12:00:00.000Z' }
    });
  };

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
          className="inline-flex h-10 items-center justify-center gap-2 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground hover:opacity-90"
        >
          <Send className="h-4 w-4" />
          Send test
        </button>
      </div>

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
              <span
                className={`rounded-full border px-2.5 py-1 text-xs ${
                  response.status >= 400
                    ? 'border-rose-200 bg-rose-50 text-rose-700'
                    : 'border-emerald-200 bg-emerald-50 text-emerald-700'
                }`}
              >
                {response.status} {response.statusText}
              </span>
            </div>
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
          </div>

          <div className="rounded-lg border bg-background p-4">
            <h3 className="text-sm font-semibold">Recent tests</h3>
            <div className="mt-3 space-y-3 text-sm">
              {history.map(item => (
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
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
