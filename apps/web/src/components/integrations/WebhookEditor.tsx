import { useMemo, useState } from 'react';
import { Check, Plus, Trash2, TriangleAlert } from 'lucide-react';

type HeaderRow = { id: string; key: string; value: string };

let headerIdCounter = 0;
const createHeaderId = () => {
  headerIdCounter += 1;
  return `hdr-${headerIdCounter}`;
};

const availableEvents = [
  'device.offline',
  'device.online',
  'ticket.created',
  'ticket.updated',
  'patch.completed',
  'backup.failed',
  'security.alert',
  'user.signed_in'
];

const defaultHeaders: HeaderRow[] = [
  { id: 'hdr-1', key: 'X-Env', value: 'production' },
  { id: 'hdr-2', key: 'X-Region', value: 'us-east' }
];

type WebhookEditorProps = {
  onSave?: (payload: {
    name: string;
    url: string;
    events: string[];
    headers: HeaderRow[];
    secret: string;
    active: boolean;
  }) => void;
  onTest?: () => void;
};

export default function WebhookEditor({ onSave, onTest }: WebhookEditorProps) {
  const [name, setName] = useState('Ops Pager');
  const [url, setUrl] = useState('https://hooks.ops-pager.io/breeze/events');
  const [events, setEvents] = useState<string[]>(['device.offline', 'ticket.created']);
  const [headers, setHeaders] = useState<HeaderRow[]>(defaultHeaders);
  const [secret, setSecret] = useState('whsec_live_123456');
  const [active, setActive] = useState(true);
  const [touchedUrl, setTouchedUrl] = useState(false);

  const urlError = useMemo(() => {
    if (!touchedUrl) return '';
    try {
      const parsed = new URL(url);
      return parsed.protocol.startsWith('http') ? '' : 'URL must start with http or https';
    } catch {
      return 'Enter a valid URL';
    }
  }, [touchedUrl, url]);

  const toggleEvent = (eventName: string) => {
    setEvents(prev =>
      prev.includes(eventName) ? prev.filter(item => item !== eventName) : [...prev, eventName]
    );
  };

  const updateHeader = (id: string, field: 'key' | 'value', value: string) => {
    setHeaders(prev => prev.map(header => (header.id === id ? { ...header, [field]: value } : header)));
  };

  const addHeader = () => {
    setHeaders(prev => [...prev, { id: createHeaderId(), key: '', value: '' }]);
  };

  const removeHeader = (id: string) => {
    setHeaders(prev => prev.filter(header => header.id !== id));
  };

  const handleSave = () => {
    onSave?.({ name, url, events, headers, secret, active });
  };

  const handleTest = () => {
    onTest?.();
  };

  return (
    <div className="rounded-xl border bg-card p-6 shadow-sm">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold">Webhook editor</h2>
          <p className="text-sm text-muted-foreground">Configure delivery, security, and events.</p>
        </div>
        <button
          type="button"
          onClick={() => setActive(prev => !prev)}
          className={`inline-flex items-center gap-2 rounded-full border px-3 py-1 text-xs font-semibold ${
            active ? 'border-emerald-200 bg-emerald-50 text-emerald-700' : 'border-slate-200 bg-slate-50 text-slate-600'
          }`}
        >
          <span className={`h-2 w-2 rounded-full ${active ? 'bg-emerald-500' : 'bg-slate-400'}`} />
          {active ? 'Active' : 'Disabled'}
        </button>
      </div>

      <div className="mt-6 grid gap-6 lg:grid-cols-2">
        <div className="space-y-4">
          <div>
            <label className="text-sm font-medium">Name</label>
            <input
              type="text"
              value={name}
              onChange={event => setName(event.target.value)}
              className="mt-2 h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
            />
          </div>
          <div>
            <label className="text-sm font-medium">URL</label>
            <input
              type="url"
              value={url}
              onBlur={() => setTouchedUrl(true)}
              onChange={event => setUrl(event.target.value)}
              className={`mt-2 h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring ${
                urlError ? 'border-destructive/60' : ''
              }`}
            />
            {urlError && (
              <p className="mt-2 inline-flex items-center gap-2 text-xs text-destructive">
                <TriangleAlert className="h-3.5 w-3.5" />
                {urlError}
              </p>
            )}
          </div>
          <div>
            <label className="text-sm font-medium">Signing secret</label>
            <input
              type="password"
              value={secret}
              onChange={event => setSecret(event.target.value)}
              className="mt-2 h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
            />
            <p className="mt-2 text-xs text-muted-foreground">
              Use the shared secret to verify signatures on incoming events.
            </p>
          </div>
        </div>

        <div>
          <label className="text-sm font-medium">Events</label>
          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            {availableEvents.map(eventName => (
              <label key={eventName} className="flex items-center gap-2 rounded-md border bg-background px-3 py-2 text-sm">
                <input
                  type="checkbox"
                  checked={events.includes(eventName)}
                  onChange={() => toggleEvent(eventName)}
                  className="h-4 w-4 rounded border-muted text-primary focus:ring-primary"
                />
                <span>{eventName}</span>
              </label>
            ))}
          </div>
          <p className="mt-3 text-xs text-muted-foreground">{events.length} selected</p>
        </div>
      </div>

      <div className="mt-8">
        <div className="flex items-center justify-between">
          <div>
            <h3 className="text-sm font-semibold">Headers</h3>
            <p className="text-xs text-muted-foreground">Send additional metadata with each request.</p>
          </div>
          <button
            type="button"
            onClick={addHeader}
            className="inline-flex items-center gap-2 rounded-md border px-3 py-1 text-xs font-semibold text-foreground hover:bg-muted"
          >
            <Plus className="h-3.5 w-3.5" />
            Add header
          </button>
        </div>
        <div className="mt-4 space-y-3">
          {headers.map(header => (
            <div key={header.id} className="grid gap-2 md:grid-cols-[1fr_1fr_auto]">
              <input
                type="text"
                placeholder="Header key"
                value={header.key}
                onChange={event => updateHeader(header.id, 'key', event.target.value)}
                className="h-10 rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
              />
              <input
                type="text"
                placeholder="Header value"
                value={header.value}
                onChange={event => updateHeader(header.id, 'value', event.target.value)}
                className="h-10 rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
              />
              <button
                type="button"
                onClick={() => removeHeader(header.id)}
                className="flex h-10 w-10 items-center justify-center rounded-md border text-muted-foreground hover:bg-muted"
              >
                <Trash2 className="h-4 w-4" />
              </button>
            </div>
          ))}
        </div>
      </div>

      <div className="mt-8 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-end">
        <button
          type="button"
          onClick={handleTest}
          className="inline-flex h-10 items-center justify-center gap-2 rounded-md border px-4 text-sm font-medium hover:bg-muted"
        >
          <Check className="h-4 w-4" />
          Test webhook
        </button>
        <button
          type="button"
          onClick={handleSave}
          className="inline-flex h-10 items-center justify-center gap-2 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground hover:opacity-90"
        >
          Save changes
        </button>
      </div>
    </div>
  );
}
