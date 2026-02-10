import { useCallback, useEffect, useMemo, useState } from 'react';
import { KeyRound, Loader2, RefreshCcw, Router, Save, ShieldCheck, User, X } from 'lucide-react';
import { fetchWithAuth } from '../../stores/auth';

type SnmpVersion = 'v1' | 'v2c' | 'v3';

type TemplateOption = {
  id: string;
  name: string;
};

type DeviceFormState = {
  name: string;
  ipAddress: string;
  port: number;
  templateId: string;
  snmpVersion: SnmpVersion;
  pollingInterval: number;
  community: string;
  username: string;
  authProtocol: string;
  authPassword: string;
  privProtocol: string;
  privPassword: string;
};

type EditorMode = 'create' | 'edit';

type Props = {
  deviceId?: string;
  onSaved?: (deviceId: string) => void;
  onCancel?: () => void;
};

const authProtocols = ['MD5', 'SHA-1', 'SHA-256'];
const privProtocols = ['DES', 'AES-128', 'AES-256'];

const defaultFormState: DeviceFormState = {
  name: '',
  ipAddress: '',
  port: 161,
  templateId: '',
  snmpVersion: 'v2c',
  pollingInterval: 300,
  community: 'public',
  username: '',
  authProtocol: 'SHA-256',
  authPassword: '',
  privProtocol: 'AES-128',
  privPassword: ''
};

function toVersion(value: unknown): SnmpVersion {
  if (value === 'v1' || value === 'v3') return value;
  return 'v2c';
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;
}

function readErrorMessage(payload: unknown, fallback: string): string {
  const data = asRecord(payload);
  const apiError = data?.error;
  if (typeof apiError === 'string' && apiError.trim()) return apiError;
  return fallback;
}

function normalizeTemplate(raw: Record<string, unknown>): TemplateOption {
  return {
    id: String(raw.id ?? ''),
    name: String(raw.name ?? '')
  };
}

function normalizeDevice(raw: Record<string, unknown>): DeviceFormState {
  const template = asRecord(raw.template);

  return {
    name: String(raw.name ?? ''),
    ipAddress: String(raw.ipAddress ?? ''),
    port: Number(raw.port ?? 161),
    templateId: String(raw.templateId ?? template?.id ?? ''),
    snmpVersion: toVersion(raw.snmpVersion),
    pollingInterval: Number(raw.pollingInterval ?? 300),
    community: String(raw.community ?? 'public'),
    username: String(raw.username ?? ''),
    authProtocol: String(raw.authProtocol ?? 'SHA-256'),
    authPassword: String(raw.authPassword ?? ''),
    privProtocol: String(raw.privProtocol ?? 'AES-128'),
    privPassword: String(raw.privPassword ?? '')
  };
}

function parseTemplates(payload: unknown): TemplateOption[] {
  const root = asRecord(payload);
  const rows = Array.isArray(root?.data) ? root.data : Array.isArray(payload) ? payload : [];

  return rows
    .map((item) => {
      const row = asRecord(item);
      return row ? normalizeTemplate(row) : null;
    })
    .filter((item): item is TemplateOption => Boolean(item?.id && item.name));
}

function buildSubmitPayload(form: DeviceFormState): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    name: form.name.trim(),
    ipAddress: form.ipAddress.trim(),
    port: Number(form.port),
    snmpVersion: form.snmpVersion,
    pollingInterval: Number(form.pollingInterval)
  };

  if (form.templateId) {
    payload.templateId = form.templateId;
  }

  if (form.snmpVersion === 'v3') {
    if (form.username.trim()) payload.username = form.username.trim();
    if (form.authProtocol.trim()) payload.authProtocol = form.authProtocol.trim();
    if (form.authPassword.trim()) payload.authPassword = form.authPassword;
    if (form.privProtocol.trim()) payload.privProtocol = form.privProtocol.trim();
    if (form.privPassword.trim()) payload.privPassword = form.privPassword;
  } else {
    payload.community = form.community.trim() || 'public';
  }

  return payload;
}

export default function SNMPDeviceEditor({ deviceId, onSaved, onCancel }: Props) {
  const mode: EditorMode = deviceId ? 'edit' : 'create';
  const [templates, setTemplates] = useState<TemplateOption[]>([]);
  const [form, setForm] = useState<DeviceFormState>(defaultFormState);
  const [loading, setLoading] = useState(mode === 'edit');
  const [templatesLoading, setTemplatesLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testingConnection, setTestingConnection] = useState(false);
  const [error, setError] = useState<string>();
  const [saveMessage, setSaveMessage] = useState<string>();
  const [testMessage, setTestMessage] = useState<string>();

  const isBusy = loading || templatesLoading || saving || testingConnection;

  const selectedTemplateLabel = useMemo(() => {
    if (!form.templateId) return 'No template assigned';
    return templates.find((template) => template.id === form.templateId)?.name ?? 'Unknown template';
  }, [form.templateId, templates]);

  const loadTemplates = useCallback(async () => {
    try {
      setTemplatesLoading(true);
      const response = await fetchWithAuth('/snmp/templates');
      if (response.status === 401) {
        window.location.href = '/login';
        return;
      }
      if (!response.ok) {
        const payload = await response.json().catch(() => ({}));
        throw new Error(readErrorMessage(payload, 'Failed to load SNMP templates'));
      }

      const payload = await response.json();
      setTemplates(parseTemplates(payload));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load SNMP templates');
    } finally {
      setTemplatesLoading(false);
    }
  }, []);

  const loadDevice = useCallback(async () => {
    if (!deviceId) return;

    try {
      setLoading(true);
      const response = await fetchWithAuth(`/snmp/devices/${deviceId}`);
      if (response.status === 401) {
        window.location.href = '/login';
        return;
      }
      if (!response.ok) {
        const payload = await response.json().catch(() => ({}));
        throw new Error(readErrorMessage(payload, 'Failed to load SNMP device'));
      }

      const payload = await response.json();
      const root = asRecord(payload);
      const device = asRecord(root?.data);
      if (!device) {
        throw new Error('SNMP device payload was invalid');
      }
      setForm(normalizeDevice(device));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load SNMP device');
    } finally {
      setLoading(false);
    }
  }, [deviceId]);

  useEffect(() => {
    void loadTemplates();
    void loadDevice();
  }, [loadTemplates, loadDevice]);

  const validate = useCallback(() => {
    if (!form.name.trim() || !form.ipAddress.trim()) {
      return 'Name and IP address are required.';
    }
    if (!Number.isFinite(form.port) || Number(form.port) <= 0) {
      return 'Port must be a positive number.';
    }
    if (!Number.isFinite(form.pollingInterval) || Number(form.pollingInterval) <= 0) {
      return 'Polling interval must be a positive number.';
    }
    if ((form.snmpVersion === 'v1' || form.snmpVersion === 'v2c') && !form.community.trim()) {
      return 'Community string is required for SNMP v1/v2c.';
    }
    if (form.snmpVersion === 'v3' && !form.username.trim()) {
      return 'Username is required for SNMP v3.';
    }
    return null;
  }, [form]);

  const handleSave = useCallback(async () => {
    const validationError = validate();
    if (validationError) {
      setError(validationError);
      return;
    }

    setSaving(true);
    setError(undefined);
    setSaveMessage(undefined);
    setTestMessage(undefined);

    try {
      const body = buildSubmitPayload(form);
      const endpoint = mode === 'edit' ? `/snmp/devices/${deviceId}` : '/snmp/devices';
      const method = mode === 'edit' ? 'PATCH' : 'POST';

      const response = await fetchWithAuth(endpoint, {
        method,
        body: JSON.stringify(body)
      });
      if (response.status === 401) {
        window.location.href = '/login';
        return;
      }
      if (!response.ok) {
        const payload = await response.json().catch(() => ({}));
        throw new Error(readErrorMessage(payload, `Failed to ${mode} SNMP device`));
      }

      const payload = await response.json().catch(() => ({}));
      const root = asRecord(payload);
      const saved = asRecord(root?.data);
      const savedId = String(saved?.id ?? deviceId ?? '');

      setSaveMessage(mode === 'edit' ? 'Device updated.' : 'Device created.');
      if (savedId) onSaved?.(savedId);
    } catch (err) {
      setError(err instanceof Error ? err.message : `Failed to ${mode} SNMP device`);
    } finally {
      setSaving(false);
    }
  }, [validate, form, mode, deviceId, onSaved]);

  const handleConnectionTest = useCallback(async () => {
    if (!deviceId) {
      setError('Save the device before running a connection test.');
      return;
    }

    setTestingConnection(true);
    setError(undefined);
    setTestMessage(undefined);
    try {
      const response = await fetchWithAuth(`/snmp/devices/${deviceId}/test`, { method: 'POST' });
      if (response.status === 401) {
        window.location.href = '/login';
        return;
      }
      if (!response.ok) {
        const payload = await response.json().catch(() => ({}));
        throw new Error(readErrorMessage(payload, 'Connection test failed'));
      }

      const payload = await response.json().catch(() => ({}));
      const root = asRecord(payload);
      const data = asRecord(root?.data);
      const status = String(data?.status ?? '');
      const testError = typeof data?.error === 'string' ? data.error : '';

      if (status === 'queued') {
        setTestMessage('Connection test queued.');
      } else if (testError) {
        setTestMessage(`Connection test failed: ${testError}`);
      } else {
        setTestMessage('Connection test completed.');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Connection test failed');
    } finally {
      setTestingConnection(false);
    }
  }, [deviceId]);

  return (
    <div className="space-y-6">
      <div className="rounded-lg border bg-card p-6 shadow-sm">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <div className="flex h-11 w-11 items-center justify-center rounded-md bg-muted">
              <Router className="h-5 w-5 text-muted-foreground" />
            </div>
            <div>
              <h3 className="text-lg font-semibold">{mode === 'edit' ? 'Edit SNMP device' : 'Create SNMP device'}</h3>
              <p className="text-sm text-muted-foreground">Configure polling, template, and SNMP authentication.</p>
            </div>
          </div>
          {onCancel && (
            <button
              type="button"
              onClick={onCancel}
              className="rounded-md border p-1.5 text-muted-foreground hover:bg-muted"
              aria-label="Close editor"
            >
              <X className="h-4 w-4" />
            </button>
          )}
        </div>

        {(error || saveMessage || testMessage) && (
          <div className={`mt-4 rounded-md border px-3 py-2 text-sm ${error ? 'border-destructive/40 bg-destructive/10 text-destructive' : 'border-border bg-muted/30 text-muted-foreground'}`}>
            {error ?? saveMessage ?? testMessage}
          </div>
        )}

        {loading ? (
          <div className="mt-6 flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            Loading SNMP device...
          </div>
        ) : (
          <div className="mt-5 grid gap-4 lg:grid-cols-3">
            <div className="space-y-4 lg:col-span-2">
              <div className="rounded-md border bg-background p-4">
                <h4 className="text-sm font-semibold">Basic information</h4>
                <div className="mt-3 grid gap-3 sm:grid-cols-2">
                  <div>
                    <label htmlFor="snmp-device-name" className="text-sm font-medium">Device name</label>
                    <input
                      id="snmp-device-name"
                      type="text"
                      value={form.name}
                      onChange={(event) => setForm((current) => ({ ...current, name: event.target.value }))}
                      placeholder="Core-Switch-01"
                      className="mt-1.5 w-full rounded-md border bg-background px-3 py-2 text-sm"
                    />
                  </div>
                  <div>
                    <label htmlFor="snmp-device-ip" className="text-sm font-medium">IP address</label>
                    <input
                      id="snmp-device-ip"
                      type="text"
                      value={form.ipAddress}
                      onChange={(event) => setForm((current) => ({ ...current, ipAddress: event.target.value }))}
                      placeholder="10.0.0.10"
                      className="mt-1.5 w-full rounded-md border bg-background px-3 py-2 text-sm"
                    />
                  </div>
                  <div>
                    <label htmlFor="snmp-device-port" className="text-sm font-medium">Port</label>
                    <input
                      id="snmp-device-port"
                      type="number"
                      value={form.port}
                      onChange={(event) => setForm((current) => ({ ...current, port: Number(event.target.value) }))}
                      className="mt-1.5 w-full rounded-md border bg-background px-3 py-2 text-sm"
                    />
                  </div>
                  <div>
                    <label htmlFor="snmp-device-template" className="text-sm font-medium">Template</label>
                    <select
                      id="snmp-device-template"
                      value={form.templateId}
                      onChange={(event) => setForm((current) => ({ ...current, templateId: event.target.value }))}
                      className="mt-1.5 w-full rounded-md border bg-background px-3 py-2 text-sm"
                      disabled={templatesLoading}
                    >
                      <option value="">No template</option>
                      {templates.map((template) => (
                        <option key={template.id} value={template.id}>{template.name}</option>
                      ))}
                    </select>
                    <p className="mt-1 text-xs text-muted-foreground">{selectedTemplateLabel}</p>
                  </div>
                </div>
              </div>

              <div className="rounded-md border bg-background p-4">
                <h4 className="text-sm font-semibold">SNMP configuration</h4>
                <div className="mt-3">
                  <label className="text-sm font-medium">Version</label>
                  <div className="mt-2 flex flex-wrap gap-2">
                    {(['v1', 'v2c', 'v3'] as const).map((item) => (
                      <button
                        key={item}
                        type="button"
                        onClick={() => setForm((current) => ({ ...current, snmpVersion: item }))}
                        className={`rounded-md border px-3 py-1.5 text-sm font-medium ${
                          form.snmpVersion === item
                            ? 'border-primary bg-primary/10 text-primary'
                            : 'border-muted-foreground/30 text-muted-foreground'
                        }`}
                        disabled={isBusy}
                      >
                        {item.toUpperCase()}
                      </button>
                    ))}
                  </div>
                </div>

                {(form.snmpVersion === 'v1' || form.snmpVersion === 'v2c') && (
                  <div className="mt-4">
                    <label htmlFor="snmp-device-community" className="text-sm font-medium">Community string</label>
                    <div className="mt-1.5 flex items-center gap-2">
                      <KeyRound className="h-4 w-4 text-muted-foreground" />
                      <input
                        id="snmp-device-community"
                        type="password"
                        value={form.community}
                        onChange={(event) => setForm((current) => ({ ...current, community: event.target.value }))}
                        className="w-full rounded-md border bg-background px-3 py-2 text-sm"
                      />
                    </div>
                  </div>
                )}

                {form.snmpVersion === 'v3' && (
                  <div className="mt-4 space-y-3">
                    <div>
                      <label htmlFor="snmp-device-username" className="text-sm font-medium">Username</label>
                      <div className="mt-1.5 flex items-center gap-2">
                        <User className="h-4 w-4 text-muted-foreground" />
                        <input
                          id="snmp-device-username"
                          type="text"
                          value={form.username}
                          onChange={(event) => setForm((current) => ({ ...current, username: event.target.value }))}
                          className="w-full rounded-md border bg-background px-3 py-2 text-sm"
                        />
                      </div>
                    </div>
                    <div className="grid gap-3 sm:grid-cols-2">
                      <div>
                        <label htmlFor="snmp-device-auth-protocol" className="text-sm font-medium">Auth protocol</label>
                        <select
                          id="snmp-device-auth-protocol"
                          value={form.authProtocol}
                          onChange={(event) => setForm((current) => ({ ...current, authProtocol: event.target.value }))}
                          className="mt-1.5 w-full rounded-md border bg-background px-3 py-2 text-sm"
                        >
                          {authProtocols.map((protocol) => (
                            <option key={protocol} value={protocol}>{protocol}</option>
                          ))}
                        </select>
                      </div>
                      <div>
                        <label htmlFor="snmp-device-auth-password" className="text-sm font-medium">Auth password</label>
                        <input
                          id="snmp-device-auth-password"
                          type="password"
                          value={form.authPassword}
                          onChange={(event) => setForm((current) => ({ ...current, authPassword: event.target.value }))}
                          className="mt-1.5 w-full rounded-md border bg-background px-3 py-2 text-sm"
                        />
                      </div>
                      <div>
                        <label htmlFor="snmp-device-privacy-protocol" className="text-sm font-medium">Privacy protocol</label>
                        <select
                          id="snmp-device-privacy-protocol"
                          value={form.privProtocol}
                          onChange={(event) => setForm((current) => ({ ...current, privProtocol: event.target.value }))}
                          className="mt-1.5 w-full rounded-md border bg-background px-3 py-2 text-sm"
                        >
                          {privProtocols.map((protocol) => (
                            <option key={protocol} value={protocol}>{protocol}</option>
                          ))}
                        </select>
                      </div>
                      <div>
                        <label htmlFor="snmp-device-privacy-password" className="text-sm font-medium">Privacy password</label>
                        <input
                          id="snmp-device-privacy-password"
                          type="password"
                          value={form.privPassword}
                          onChange={(event) => setForm((current) => ({ ...current, privPassword: event.target.value }))}
                          className="mt-1.5 w-full rounded-md border bg-background px-3 py-2 text-sm"
                        />
                      </div>
                    </div>
                  </div>
                )}
              </div>
            </div>

            <div className="space-y-4">
              <div className="rounded-md border bg-background p-4">
                <h4 className="text-sm font-semibold">Polling interval</h4>
                <input
                  id="snmp-device-polling-interval"
                  type="number"
                  min={15}
                  value={form.pollingInterval}
                  onChange={(event) => setForm((current) => ({ ...current, pollingInterval: Number(event.target.value) }))}
                  className="mt-2 w-full rounded-md border bg-background px-3 py-2 text-sm"
                />
                <p className="mt-1 text-xs text-muted-foreground">Polling frequency in seconds.</p>
              </div>

              <div className="rounded-md border bg-background p-4">
                <h4 className="text-sm font-semibold">Connection test</h4>
                <p className="mt-2 text-xs text-muted-foreground">
                  {mode === 'edit'
                    ? 'Queue a live SNMP test for this saved device.'
                    : 'Available after creating the device.'}
                </p>
                <button
                  type="button"
                  className="mt-3 inline-flex w-full items-center justify-center gap-2 rounded-md border px-3 py-2 text-sm font-medium disabled:opacity-60"
                  onClick={() => {
                    void handleConnectionTest();
                  }}
                  disabled={mode !== 'edit' || testingConnection || saving}
                >
                  {testingConnection ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCcw className="h-4 w-4" />}
                  {testingConnection ? 'Testing...' : 'Test connection'}
                </button>
              </div>

              <div className="rounded-md border bg-background p-4">
                <h4 className="text-sm font-semibold">Save changes</h4>
                <button
                  type="button"
                  onClick={() => {
                    void handleSave();
                  }}
                  disabled={saving || loading}
                  className="mt-3 inline-flex w-full items-center justify-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-60"
                >
                  {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
                  {mode === 'edit' ? (saving ? 'Saving...' : 'Save changes') : (saving ? 'Creating...' : 'Create device')}
                </button>
                <div className="mt-3 flex items-center gap-2 text-xs text-muted-foreground">
                  <ShieldCheck className="h-4 w-4" />
                  SNMP credentials are persisted securely by the API.
                </div>
                {onCancel && (
                  <button
                    type="button"
                    onClick={onCancel}
                    className="mt-3 inline-flex w-full items-center justify-center rounded-md border px-4 py-2 text-sm font-medium"
                  >
                    Cancel
                  </button>
                )}
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
