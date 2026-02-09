import { useState, useEffect } from 'react';
import { Loader2 } from 'lucide-react';
import { fetchWithAuth } from '../../stores/auth';
import CreateMonitorForm from '../monitors/CreateMonitorForm';

type SNMPTemplate = {
  id: string;
  name: string;
  vendor?: string;
  deviceType?: string;
};

type EnableMonitoringFormProps = {
  assetId: string;
  ipAddress?: string;
  onEnabled: () => void;
  onCancel: () => void;
};

export default function EnableMonitoringForm({
  assetId,
  ipAddress,
  onEnabled,
  onCancel
}: EnableMonitoringFormProps) {
  const [snmpVersion, setSnmpVersion] = useState<'v1' | 'v2c' | 'v3'>('v2c');
  const [community, setCommunity] = useState('public');
  const [username, setUsername] = useState('');
  const [authProtocol, setAuthProtocol] = useState('sha');
  const [authPassword, setAuthPassword] = useState('');
  const [privProtocol, setPrivProtocol] = useState('aes');
  const [privPassword, setPrivPassword] = useState('');
  const [templateId, setTemplateId] = useState('');
  const [pollingInterval, setPollingInterval] = useState(300);
  const [templates, setTemplates] = useState<SNMPTemplate[]>([]);
  const [templateError, setTemplateError] = useState<string>();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  const [showNetworkMonitorForm, setShowNetworkMonitorForm] = useState(false);

  useEffect(() => {
    fetchWithAuth('/snmp/templates')
      .then(async (res) => {
        if (res.ok) {
          const data = await res.json();
          setTemplates(data.data ?? data.templates ?? data ?? []);
        } else {
          setTemplateError('Failed to load templates');
        }
      })
      .catch(() => {
        setTemplateError('Failed to load templates');
      });
  }, []);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(undefined);

    if ((snmpVersion === 'v1' || snmpVersion === 'v2c') && !community.trim()) {
      setError('Community string is required for SNMP v1/v2c');
      return;
    }
    if (snmpVersion === 'v3' && !username.trim()) {
      setError('Username is required for SNMP v3');
      return;
    }

    setSaving(true);

    try {
      const payload: Record<string, unknown> = {
        snmpVersion,
        pollingInterval
      };

      if (snmpVersion === 'v1' || snmpVersion === 'v2c') {
        payload.community = community;
      } else {
        payload.username = username;
        payload.authProtocol = authProtocol;
        payload.authPassword = authPassword;
        payload.privProtocol = privProtocol;
        payload.privPassword = privPassword;
      }

      if (templateId) {
        payload.templateId = templateId;
      }

      const response = await fetchWithAuth(`/discovery/assets/${assetId}/enable-monitoring`, {
        method: 'POST',
        body: JSON.stringify(payload)
      });

      if (!response.ok) {
        const data = await response.json().catch(() => null);
        throw new Error(data?.error ?? 'Failed to enable monitoring');
      }

      onEnabled();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An error occurred');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-4">
      <div className="rounded-md border bg-muted/20 p-3">
        <p className="text-xs text-muted-foreground">
          Monitoring supports SNMP polling and network checks (Ping/TCP/HTTP/DNS). You can configure either or both.
        </p>
      </div>

      <form onSubmit={handleSubmit} className="space-y-4 rounded-md border p-4">
        <h4 className="text-sm font-semibold">SNMP Device Monitoring</h4>

        <div>
          <label className="block text-xs font-medium text-muted-foreground mb-1">SNMP Version</label>
          <select
            value={snmpVersion}
            onChange={(e) => setSnmpVersion(e.target.value as 'v1' | 'v2c' | 'v3')}
            className="h-9 w-full rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
          >
            <option value="v1">v1</option>
            <option value="v2c">v2c</option>
            <option value="v3">v3</option>
          </select>
        </div>

        {(snmpVersion === 'v1' || snmpVersion === 'v2c') && (
          <div>
            <label className="block text-xs font-medium text-muted-foreground mb-1">Community String</label>
            <input
              type="text"
              value={community}
              onChange={(e) => setCommunity(e.target.value)}
              className="h-9 w-full rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
              placeholder="public"
            />
          </div>
        )}

        {snmpVersion === 'v3' && (
          <>
            <div>
              <label className="block text-xs font-medium text-muted-foreground mb-1">Username</label>
              <input
                type="text"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                className="h-9 w-full rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-medium text-muted-foreground mb-1">Auth Protocol</label>
                <select
                  value={authProtocol}
                  onChange={(e) => setAuthProtocol(e.target.value)}
                  className="h-9 w-full rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                >
                  <option value="md5">MD5</option>
                  <option value="sha">SHA</option>
                  <option value="sha256">SHA-256</option>
                </select>
              </div>
              <div>
                <label className="block text-xs font-medium text-muted-foreground mb-1">Auth Password</label>
                <input
                  type="password"
                  value={authPassword}
                  onChange={(e) => setAuthPassword(e.target.value)}
                  className="h-9 w-full rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-medium text-muted-foreground mb-1">Privacy Protocol</label>
                <select
                  value={privProtocol}
                  onChange={(e) => setPrivProtocol(e.target.value)}
                  className="h-9 w-full rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                >
                  <option value="des">DES</option>
                  <option value="aes">AES</option>
                  <option value="aes256">AES-256</option>
                </select>
              </div>
              <div>
                <label className="block text-xs font-medium text-muted-foreground mb-1">Privacy Password</label>
                <input
                  type="password"
                  value={privPassword}
                  onChange={(e) => setPrivPassword(e.target.value)}
                  className="h-9 w-full rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                />
              </div>
            </div>
          </>
        )}

        <div>
          <label className="block text-xs font-medium text-muted-foreground mb-1">Template</label>
          {templateError ? (
            <p className="text-xs text-yellow-600">{templateError}</p>
          ) : (
            <select
              value={templateId}
              onChange={(e) => setTemplateId(e.target.value)}
              className="h-9 w-full rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
            >
              <option value="">No template</option>
              {templates.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}{t.vendor ? ` (${t.vendor})` : ''}
                </option>
              ))}
            </select>
          )}
        </div>

        <div>
          <label className="block text-xs font-medium text-muted-foreground mb-1">Polling Interval (seconds)</label>
          <input
            type="number"
            value={pollingInterval}
            onChange={(e) => setPollingInterval(Number(e.target.value))}
            min={30}
            max={86400}
            className="h-9 w-full rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
          />
        </div>

        {error && (
          <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
            {error}
          </div>
        )}

        <div className="flex items-center gap-2">
          <button
            type="submit"
            disabled={saving}
            className="h-9 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:opacity-70 flex items-center gap-2"
          >
            {saving && <Loader2 className="h-3 w-3 animate-spin" />}
            {saving ? 'Enabling...' : 'Enable SNMP Monitoring'}
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

      <div className="rounded-md border p-4">
        <h4 className="text-sm font-semibold">Network Checks</h4>
        <p className="mt-1 text-xs text-muted-foreground">
          Add ping, TCP, HTTP, or DNS monitors for this asset.
        </p>
        <button
          type="button"
          onClick={() => setShowNetworkMonitorForm(true)}
          className="mt-3 h-9 rounded-md border px-4 text-sm font-medium hover:bg-muted"
        >
          Add Network Monitor
        </button>
      </div>

      {showNetworkMonitorForm && (
        <CreateMonitorForm
          assetId={assetId}
          defaultTarget={ipAddress}
          onCreated={() => {
            setShowNetworkMonitorForm(false);
            onEnabled();
          }}
          onCancel={() => setShowNetworkMonitorForm(false)}
        />
      )}
    </div>
  );
}
