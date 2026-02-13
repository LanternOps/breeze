import { useState } from 'react';
import { Loader2, X } from 'lucide-react';
import { fetchWithAuth } from '../../stores/auth';

type CreateMonitorFormProps = {
  orgId?: string;
  assetId?: string;
  defaultTarget?: string;
  onCreated: () => void;
  onCancel: () => void;
};

const monitorTypes = [
  { value: 'icmp_ping', label: 'ICMP Ping', description: 'Check if a host is reachable via ping' },
  { value: 'tcp_port', label: 'TCP Port', description: 'Check if a TCP port is open and responding' },
  { value: 'http_check', label: 'HTTP Check', description: 'Monitor HTTP/HTTPS endpoints' },
  { value: 'dns_check', label: 'DNS Check', description: 'Verify DNS records resolve correctly' }
] as const;

export default function CreateMonitorForm({ orgId, assetId, defaultTarget, onCreated, onCancel }: CreateMonitorFormProps) {
  const [monitorType, setMonitorType] = useState<string>('icmp_ping');
  const [name, setName] = useState('');
  const [target, setTarget] = useState(defaultTarget ?? '');
  const [pollingInterval, setPollingInterval] = useState(60);
  const [timeout, setTimeout_] = useState(5);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();

  // ICMP config
  const [pingCount, setPingCount] = useState(4);

  // TCP config
  const [tcpPort, setTcpPort] = useState(443);
  const [expectBanner, setExpectBanner] = useState('');

  // HTTP config
  const [httpUrl, setHttpUrl] = useState('');
  const [httpMethod, setHttpMethod] = useState('GET');
  const [expectedStatus, setExpectedStatus] = useState(200);
  const [expectedBody, setExpectedBody] = useState('');
  const [verifySsl, setVerifySsl] = useState(true);
  const [followRedirects, setFollowRedirects] = useState(true);

  // DNS config
  const [dnsHostname, setDnsHostname] = useState('');
  const [recordType, setRecordType] = useState('A');
  const [expectedValue, setExpectedValue] = useState('');
  const [nameserver, setNameserver] = useState('');

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(undefined);

    if (!name.trim()) { setError('Name is required'); return; }
    if (!target.trim() && monitorType !== 'http_check' && monitorType !== 'dns_check') {
      setError('Target is required');
      return;
    }

    setSaving(true);

    try {
      let config: Record<string, unknown> = {};
      let finalTarget = target;

      switch (monitorType) {
        case 'icmp_ping':
          config = { count: pingCount };
          break;
        case 'tcp_port':
          config = { port: tcpPort };
          if (expectBanner) config.expectBanner = expectBanner;
          break;
        case 'http_check':
          finalTarget = httpUrl || target;
          config = {
            url: finalTarget,
            method: httpMethod,
            expectedStatus,
            verifySsl,
            followRedirects
          };
          if (expectedBody) config.expectedBody = expectedBody;
          break;
        case 'dns_check':
          finalTarget = dnsHostname || target;
          config = { hostname: finalTarget, recordType };
          if (expectedValue) config.expectedValue = expectedValue;
          if (nameserver) config.nameserver = nameserver;
          break;
      }

      const payload: Record<string, unknown> = {
        name,
        monitorType,
        target: finalTarget,
        config,
        pollingInterval,
        timeout
      };

      if (orgId) payload.orgId = orgId;
      if (assetId) payload.assetId = assetId;

      const response = await fetchWithAuth('/monitors', {
        method: 'POST',
        body: JSON.stringify(payload)
      });

      if (!response.ok) {
        const data = await response.json().catch(() => null);
        throw new Error(data?.error ?? 'Failed to create monitor');
      }

      onCreated();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An error occurred');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 px-4 py-8">
      <div className="w-full max-w-2xl max-h-[90vh] overflow-y-auto rounded-lg border bg-card p-6 shadow-sm">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 className="text-lg font-semibold">Create Network Monitor</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              Set up a new monitoring check for a network target.
            </p>
          </div>
          <button
            type="button"
            onClick={onCancel}
            className="flex h-8 w-8 items-center justify-center rounded-md border hover:bg-muted"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="mt-6 space-y-5">
          {/* Monitor Type */}
          <div>
            <label className="block text-xs font-medium text-muted-foreground mb-2">Monitor Type</label>
            <div className="grid grid-cols-2 gap-2">
              {monitorTypes.map((type) => (
                <button
                  key={type.value}
                  type="button"
                  onClick={() => setMonitorType(type.value)}
                  className={`rounded-md border px-3 py-2 text-left transition ${
                    monitorType === type.value
                      ? 'border-primary bg-primary/5 ring-1 ring-primary'
                      : 'hover:bg-muted/50'
                  }`}
                >
                  <p className="text-sm font-medium">{type.label}</p>
                  <p className="text-xs text-muted-foreground">{type.description}</p>
                </button>
              ))}
            </div>
          </div>

          {/* Common Fields */}
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <label className="block text-xs font-medium text-muted-foreground mb-1">Name</label>
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                className="h-9 w-full rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                placeholder="e.g. Production Web Server"
              />
            </div>
            {monitorType !== 'http_check' && monitorType !== 'dns_check' && (
              <div>
                <label className="block text-xs font-medium text-muted-foreground mb-1">Target (IP/Hostname)</label>
                <input
                  type="text"
                  value={target}
                  onChange={(e) => setTarget(e.target.value)}
                  className="h-9 w-full rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                  placeholder="192.168.1.1 or server.example.com"
                />
              </div>
            )}
          </div>

          {/* Type-Specific Fields */}
          {monitorType === 'icmp_ping' && (
            <div>
              <label className="block text-xs font-medium text-muted-foreground mb-1">Ping Count</label>
              <input
                type="number"
                value={pingCount}
                onChange={(e) => setPingCount(Number(e.target.value))}
                min={1}
                max={20}
                className="h-9 w-full rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
              />
            </div>
          )}

          {monitorType === 'tcp_port' && (
            <div className="grid gap-4 sm:grid-cols-2">
              <div>
                <label className="block text-xs font-medium text-muted-foreground mb-1">Port</label>
                <input
                  type="number"
                  value={tcpPort}
                  onChange={(e) => setTcpPort(Number(e.target.value))}
                  min={1}
                  max={65535}
                  className="h-9 w-full rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-muted-foreground mb-1">Expected Banner (optional)</label>
                <input
                  type="text"
                  value={expectBanner}
                  onChange={(e) => setExpectBanner(e.target.value)}
                  className="h-9 w-full rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                  placeholder="e.g. SSH-"
                />
              </div>
            </div>
          )}

          {monitorType === 'http_check' && (
            <>
              <div>
                <label className="block text-xs font-medium text-muted-foreground mb-1">URL</label>
                <input
                  type="text"
                  value={httpUrl}
                  onChange={(e) => setHttpUrl(e.target.value)}
                  className="h-9 w-full rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                  placeholder="https://example.com/health"
                />
              </div>
              <div className="grid gap-4 sm:grid-cols-3">
                <div>
                  <label className="block text-xs font-medium text-muted-foreground mb-1">Method</label>
                  <select
                    value={httpMethod}
                    onChange={(e) => setHttpMethod(e.target.value)}
                    className="h-9 w-full rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                  >
                    <option value="GET">GET</option>
                    <option value="HEAD">HEAD</option>
                    <option value="POST">POST</option>
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-medium text-muted-foreground mb-1">Expected Status</label>
                  <input
                    type="number"
                    value={expectedStatus}
                    onChange={(e) => setExpectedStatus(Number(e.target.value))}
                    min={100}
                    max={599}
                    className="h-9 w-full rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                  />
                </div>
                <div className="flex items-end gap-4">
                  <label className="flex items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      checked={verifySsl}
                      onChange={(e) => setVerifySsl(e.target.checked)}
                      className="rounded border"
                    />
                    Verify SSL
                  </label>
                  <label className="flex items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      checked={followRedirects}
                      onChange={(e) => setFollowRedirects(e.target.checked)}
                      className="rounded border"
                    />
                    Follow Redirects
                  </label>
                </div>
              </div>
              <div>
                <label className="block text-xs font-medium text-muted-foreground mb-1">Expected Body Content (optional)</label>
                <input
                  type="text"
                  value={expectedBody}
                  onChange={(e) => setExpectedBody(e.target.value)}
                  className="h-9 w-full rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                  placeholder='e.g. "status":"ok"'
                />
              </div>
            </>
          )}

          {monitorType === 'dns_check' && (
            <>
              <div className="grid gap-4 sm:grid-cols-2">
                <div>
                  <label className="block text-xs font-medium text-muted-foreground mb-1">Hostname to Resolve</label>
                  <input
                    type="text"
                    value={dnsHostname}
                    onChange={(e) => setDnsHostname(e.target.value)}
                    className="h-9 w-full rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                    placeholder="example.com"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-muted-foreground mb-1">Record Type</label>
                  <select
                    value={recordType}
                    onChange={(e) => setRecordType(e.target.value)}
                    className="h-9 w-full rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                  >
                    <option value="A">A</option>
                    <option value="AAAA">AAAA</option>
                    <option value="MX">MX</option>
                    <option value="CNAME">CNAME</option>
                    <option value="TXT">TXT</option>
                    <option value="NS">NS</option>
                  </select>
                </div>
              </div>
              <div className="grid gap-4 sm:grid-cols-2">
                <div>
                  <label className="block text-xs font-medium text-muted-foreground mb-1">Expected Value (optional)</label>
                  <input
                    type="text"
                    value={expectedValue}
                    onChange={(e) => setExpectedValue(e.target.value)}
                    className="h-9 w-full rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                    placeholder="e.g. 93.184.216.34"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-muted-foreground mb-1">Custom Nameserver (optional)</label>
                  <input
                    type="text"
                    value={nameserver}
                    onChange={(e) => setNameserver(e.target.value)}
                    className="h-9 w-full rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                    placeholder="8.8.8.8"
                  />
                </div>
              </div>
            </>
          )}

          {/* Timing */}
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <label className="block text-xs font-medium text-muted-foreground mb-1">Polling Interval (seconds)</label>
              <input
                type="number"
                value={pollingInterval}
                onChange={(e) => setPollingInterval(Number(e.target.value))}
                min={10}
                max={86400}
                className="h-9 w-full rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-muted-foreground mb-1">Timeout (seconds)</label>
              <input
                type="number"
                value={timeout}
                onChange={(e) => setTimeout_(Number(e.target.value))}
                min={1}
                max={300}
                className="h-9 w-full rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
              />
            </div>
          </div>

          {error && (
            <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
              {error}
            </div>
          )}

          <div className="flex items-center gap-2 border-t pt-4">
            <button
              type="submit"
              disabled={saving}
              className="h-9 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:opacity-70 flex items-center gap-2"
            >
              {saving && <Loader2 className="h-3 w-3 animate-spin" />}
              {saving ? 'Creating...' : 'Create Monitor'}
            </button>
            <button
              type="button"
              onClick={onCancel}
              className="h-9 rounded-md border px-4 text-sm font-medium text-muted-foreground hover:text-foreground"
            >
              Cancel
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
