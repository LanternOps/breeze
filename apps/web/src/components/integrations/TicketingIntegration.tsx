import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  CheckCircle2,
  ClipboardList,
  Loader2,
  PlugZap,
  RefreshCw,
  Save,
  Settings2,
  SlidersHorizontal,
  ArrowLeftRight
} from 'lucide-react';

type ProviderId = 'zendesk' | 'freshdesk' | 'servicenow';

type ProviderOption = {
  id: ProviderId;
  label: string;
  description: string;
};

type ProviderConfigs = {
  zendesk: {
    subdomain: string;
    email: string;
    apiToken: string;
  };
  freshdesk: {
    domain: string;
    apiKey: string;
  };
  servicenow: {
    instanceUrl: string;
    username: string;
    password: string;
  };
};

type FieldMapping = {
  id: string;
  breezeField: string;
  ticketField: string;
  required?: boolean;
};

type AutoTicketRuleId = 'critical' | 'high' | 'medium' | 'low' | 'offline' | 'slaBreach';
type AutoTicketRules = Record<AutoTicketRuleId, boolean>;

type SyncSettingId = 'status' | 'comments' | 'assignee' | 'resolution';
type SyncSettings = Record<SyncSettingId, boolean>;

type PriorityLevel = 'critical' | 'high' | 'medium' | 'low';
type PriorityMapping = Record<PriorityLevel, string>;

type TicketingSettingsPayload = {
  provider: ProviderId;
  configs: ProviderConfigs;
  fieldMappings: FieldMapping[];
  autoTicketRules: AutoTicketRules;
  syncSettings: SyncSettings;
  priorityMapping: PriorityMapping;
};

type StatusMessage = {
  status: 'success' | 'error';
  message: string;
};

const providerOptions: ProviderOption[] = [
  {
    id: 'zendesk',
    label: 'Zendesk',
    description: 'Classic ticketing with SLAs, macros, and automations.'
  },
  {
    id: 'freshdesk',
    label: 'Freshdesk',
    description: 'Omni-channel service desk with agent routing.'
  },
  {
    id: 'servicenow',
    label: 'ServiceNow',
    description: 'Enterprise ITSM with incident workflows.'
  }
];

const defaultProviderConfigs: ProviderConfigs = {
  zendesk: {
    subdomain: '',
    email: '',
    apiToken: ''
  },
  freshdesk: {
    domain: '',
    apiKey: ''
  },
  servicenow: {
    instanceUrl: '',
    username: '',
    password: ''
  }
};

const defaultFieldMappings: FieldMapping[] = [
  { id: 'title', breezeField: 'Alert title', ticketField: 'Subject', required: true },
  { id: 'summary', breezeField: 'Alert summary', ticketField: 'Description', required: true },
  { id: 'severity', breezeField: 'Alert severity', ticketField: 'Priority', required: true },
  { id: 'device', breezeField: 'Device name', ticketField: 'Configuration item' },
  { id: 'site', breezeField: 'Site', ticketField: 'Organization' },
  { id: 'link', breezeField: 'Alert URL', ticketField: 'Custom: Alert URL' }
];

const fieldOptions: Record<ProviderId, string[]> = {
  zendesk: [
    'Subject',
    'Description',
    'Priority',
    'Status',
    'Requester',
    'Assignee',
    'Organization',
    'Group',
    'Tags',
    'Configuration item',
    'Custom: Device ID',
    'Custom: Alert URL'
  ],
  freshdesk: [
    'Subject',
    'Description',
    'Priority',
    'Status',
    'Requester',
    'Agent',
    'Company',
    'Tags',
    'Configuration item',
    'Custom: Device ID',
    'Custom: Alert URL'
  ],
  servicenow: [
    'Short description',
    'Description',
    'Priority',
    'State',
    'Caller',
    'Assigned to',
    'Company',
    'Configuration item',
    'Assignment group',
    'Custom: Device ID',
    'Custom: Alert URL'
  ]
};

const autoTicketRuleOptions: Array<{ id: AutoTicketRuleId; label: string; description: string }> = [
  { id: 'critical', label: 'Critical alerts', description: 'Create tickets for severity Critical.' },
  { id: 'high', label: 'High alerts', description: 'Create tickets for severity High.' },
  { id: 'medium', label: 'Medium alerts', description: 'Create tickets for severity Medium.' },
  { id: 'low', label: 'Low alerts', description: 'Create tickets for severity Low.' },
  { id: 'offline', label: 'Device offline', description: 'Create a ticket when a device drops offline.' },
  { id: 'slaBreach', label: 'SLA breach', description: 'Create a ticket on SLA threshold breaches.' }
];

const defaultAutoTicketRules: AutoTicketRules = {
  critical: true,
  high: true,
  medium: false,
  low: false,
  offline: true,
  slaBreach: true
};

const syncSettingOptions: Array<{ id: SyncSettingId; label: string; description: string }> = [
  { id: 'status', label: 'Sync status to Breeze', description: 'Update Breeze alert state when tickets change.' },
  { id: 'comments', label: 'Sync ticket comments', description: 'Copy ticket updates back into alert timelines.' },
  { id: 'assignee', label: 'Sync assignee', description: 'Reflect ticket ownership in Breeze.' },
  { id: 'resolution', label: 'Sync resolution notes', description: 'Capture close notes on Breeze alerts.' }
];

const defaultSyncSettings: SyncSettings = {
  status: true,
  comments: true,
  assignee: false,
  resolution: true
};

const priorityOptions: Record<ProviderId, string[]> = {
  zendesk: ['Urgent', 'High', 'Normal', 'Low'],
  freshdesk: ['Urgent', 'High', 'Medium', 'Low'],
  servicenow: ['Critical', 'High', 'Moderate', 'Low']
};

const defaultPriorityMapping: PriorityMapping = {
  critical: 'Urgent',
  high: 'High',
  medium: 'Normal',
  low: 'Low'
};

const severityLabels: Record<PriorityLevel, string> = {
  critical: 'Critical',
  high: 'High',
  medium: 'Medium',
  low: 'Low'
};

export default function TicketingIntegration() {
  const [activeProvider, setActiveProvider] = useState<ProviderId>('zendesk');
  const [providerConfigs, setProviderConfigs] = useState<ProviderConfigs>(defaultProviderConfigs);
  const [fieldMappings, setFieldMappings] = useState<FieldMapping[]>(defaultFieldMappings);
  const [autoTicketRules, setAutoTicketRules] = useState<AutoTicketRules>(defaultAutoTicketRules);
  const [syncSettings, setSyncSettings] = useState<SyncSettings>(defaultSyncSettings);
  const [priorityMapping, setPriorityMapping] = useState<PriorityMapping>(defaultPriorityMapping);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string>();
  const [testing, setTesting] = useState(false);
  const [testStatus, setTestStatus] = useState<StatusMessage | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveStatus, setSaveStatus] = useState<StatusMessage | null>(null);

  const activeProviderOption = providerOptions.find(option => option.id === activeProvider) ?? providerOptions[0];

  const configComplete = useMemo(() => {
    if (activeProvider === 'zendesk') {
      const { subdomain, email, apiToken } = providerConfigs.zendesk;
      return subdomain.trim().length > 0 && email.trim().length > 0 && apiToken.trim().length > 0;
    }
    if (activeProvider === 'freshdesk') {
      const { domain, apiKey } = providerConfigs.freshdesk;
      return domain.trim().length > 0 && apiKey.trim().length > 0;
    }
    const { instanceUrl, username, password } = providerConfigs.servicenow;
    return instanceUrl.trim().length > 0 && username.trim().length > 0 && password.trim().length > 0;
  }, [activeProvider, providerConfigs]);

  const buildPayload = useCallback(
    (): TicketingSettingsPayload => ({
      provider: activeProvider,
      configs: providerConfigs,
      fieldMappings,
      autoTicketRules,
      syncSettings,
      priorityMapping
    }),
    [activeProvider, providerConfigs, fieldMappings, autoTicketRules, syncSettings, priorityMapping]
  );

  useEffect(() => {
    const loadSettings = async () => {
      try {
        setLoading(true);
        setLoadError(undefined);
        const response = await fetch('/api/integrations/ticketing');
        if (!response.ok) {
          throw new Error('Failed to load ticketing settings');
        }
        const data = await response.json();
        const payload = data.data ?? data;
        if (payload.provider && providerOptions.some(option => option.id === payload.provider)) {
          setActiveProvider(payload.provider);
        }
        if (payload.configs) {
          setProviderConfigs((prev) => ({
            ...prev,
            ...payload.configs
          }));
        }
        if (Array.isArray(payload.fieldMappings)) {
          setFieldMappings(payload.fieldMappings);
        }
        if (payload.autoTicketRules) {
          setAutoTicketRules((prev) => ({
            ...prev,
            ...payload.autoTicketRules
          }));
        }
        if (payload.syncSettings) {
          setSyncSettings((prev) => ({
            ...prev,
            ...payload.syncSettings
          }));
        }
        if (payload.priorityMapping) {
          setPriorityMapping((prev) => ({
            ...prev,
            ...payload.priorityMapping
          }));
        }
      } catch (err) {
        setLoadError(err instanceof Error ? err.message : 'Failed to load ticketing settings');
      } finally {
        setLoading(false);
      }
    };

    loadSettings();
  }, []);

  const updateProviderConfig = (provider: ProviderId, key: string, value: string) => {
    setProviderConfigs((prev) => ({
      ...prev,
      [provider]: {
        ...(prev[provider] as Record<string, string>),
        [key]: value
      }
    }));
  };

  const updateFieldMapping = (id: string, ticketField: string) => {
    setFieldMappings(prev => prev.map(mapping => (mapping.id === id ? { ...mapping, ticketField } : mapping)));
  };

  const toggleAutoRule = (ruleId: AutoTicketRuleId) => {
    setAutoTicketRules(prev => ({
      ...prev,
      [ruleId]: !prev[ruleId]
    }));
  };

  const updateSyncSetting = (settingId: SyncSettingId, value: boolean) => {
    setSyncSettings(prev => ({
      ...prev,
      [settingId]: value
    }));
  };

  const updatePriorityMapping = (severity: PriorityLevel, value: string) => {
    setPriorityMapping(prev => ({
      ...prev,
      [severity]: value
    }));
  };

  const handleTestConnection = async () => {
    setTesting(true);
    setTestStatus(null);
    setSaveStatus(null);
    try {
      const response = await fetch('/api/integrations/ticketing/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(buildPayload())
      });
      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(errorData.error || 'Connection test failed');
      }
      const data = await response.json().catch(() => ({}));
      setTestStatus({
        status: 'success',
        message: data.message || 'Connection successful. Credentials validated.'
      });
    } catch (err) {
      setTestStatus({
        status: 'error',
        message: err instanceof Error ? err.message : 'Connection test failed'
      });
    } finally {
      setTesting(false);
    }
  };

  const handleSave = async () => {
    setSaving(true);
    setSaveStatus(null);
    try {
      const response = await fetch('/api/integrations/ticketing', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(buildPayload())
      });
      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(errorData.error || 'Failed to save ticketing settings');
      }
      const data = await response.json().catch(() => ({}));
      setSaveStatus({
        status: 'success',
        message: data.message || 'Ticketing settings saved.'
      });
    } catch (err) {
      setSaveStatus({
        status: 'error',
        message: err instanceof Error ? err.message : 'Failed to save ticketing settings'
      });
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <div className="text-center">
          <div className="mx-auto h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent" />
          <p className="mt-4 text-sm text-muted-foreground">Loading ticketing settings...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Ticketing integration</h1>
          <p className="text-sm text-muted-foreground">
            Connect Breeze alerts to your ticketing system and keep statuses in sync.
          </p>
        </div>
        <div className="rounded-lg border bg-card px-4 py-3 shadow-sm">
          <p className="text-xs font-semibold uppercase text-muted-foreground">Active provider</p>
          <p className="text-sm font-semibold">{activeProviderOption.label}</p>
          <p className="text-xs text-muted-foreground">{activeProviderOption.description}</p>
        </div>
      </div>

      {loadError && (
        <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {loadError}
        </div>
      )}

      <div className="rounded-xl border bg-card p-6 shadow-sm">
        <div className="flex items-center gap-3 text-sm font-semibold text-muted-foreground">
          <PlugZap className="h-4 w-4 text-primary" />
          Provider credentials
        </div>
        <div className="mt-4 flex flex-wrap gap-3">
          {providerOptions.map(option => (
            <button
              key={option.id}
              type="button"
              onClick={() => setActiveProvider(option.id)}
              className={`rounded-full border px-4 py-2 text-sm transition ${
                activeProvider === option.id
                  ? 'border-primary bg-primary/10 text-primary'
                  : 'border-border bg-background text-muted-foreground hover:text-foreground'
              }`}
            >
              {option.label}
            </button>
          ))}
        </div>

        <div className="mt-6 rounded-lg border bg-background p-5">
          <div className="flex flex-col gap-2">
            <h3 className="text-base font-semibold">{activeProviderOption.label} configuration</h3>
            <p className="text-sm text-muted-foreground">{activeProviderOption.description}</p>
          </div>

          {activeProvider === 'zendesk' && (
            <div className="mt-5 grid gap-4 md:grid-cols-2">
              <div>
                <label className="text-sm font-medium">Subdomain</label>
                <input
                  type="text"
                  placeholder="acme"
                  value={providerConfigs.zendesk.subdomain}
                  onChange={event => updateProviderConfig('zendesk', 'subdomain', event.target.value)}
                  className="mt-2 h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                />
                <p className="mt-2 text-xs text-muted-foreground">Used for https://acme.zendesk.com</p>
              </div>
              <div>
                <label className="text-sm font-medium">Agent email</label>
                <input
                  type="email"
                  placeholder="alerts@acme.com"
                  value={providerConfigs.zendesk.email}
                  onChange={event => updateProviderConfig('zendesk', 'email', event.target.value)}
                  className="mt-2 h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                />
              </div>
              <div className="md:col-span-2">
                <label className="text-sm font-medium">API token</label>
                <input
                  type="password"
                  placeholder="zd_token_****"
                  value={providerConfigs.zendesk.apiToken}
                  onChange={event => updateProviderConfig('zendesk', 'apiToken', event.target.value)}
                  className="mt-2 h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                />
              </div>
            </div>
          )}

          {activeProvider === 'freshdesk' && (
            <div className="mt-5 grid gap-4 md:grid-cols-2">
              <div>
                <label className="text-sm font-medium">Domain</label>
                <input
                  type="text"
                  placeholder="acme.freshdesk.com"
                  value={providerConfigs.freshdesk.domain}
                  onChange={event => updateProviderConfig('freshdesk', 'domain', event.target.value)}
                  className="mt-2 h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                />
              </div>
              <div>
                <label className="text-sm font-medium">API key</label>
                <input
                  type="password"
                  placeholder="fd_api_****"
                  value={providerConfigs.freshdesk.apiKey}
                  onChange={event => updateProviderConfig('freshdesk', 'apiKey', event.target.value)}
                  className="mt-2 h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                />
              </div>
            </div>
          )}

          {activeProvider === 'servicenow' && (
            <div className="mt-5 grid gap-4 md:grid-cols-2">
              <div>
                <label className="text-sm font-medium">Instance URL</label>
                <input
                  type="url"
                  placeholder="https://acme.service-now.com"
                  value={providerConfigs.servicenow.instanceUrl}
                  onChange={event => updateProviderConfig('servicenow', 'instanceUrl', event.target.value)}
                  className="mt-2 h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                />
              </div>
              <div>
                <label className="text-sm font-medium">Username</label>
                <input
                  type="text"
                  placeholder="breeze.integration"
                  value={providerConfigs.servicenow.username}
                  onChange={event => updateProviderConfig('servicenow', 'username', event.target.value)}
                  className="mt-2 h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                />
              </div>
              <div className="md:col-span-2">
                <label className="text-sm font-medium">Password</label>
                <input
                  type="password"
                  placeholder="********"
                  value={providerConfigs.servicenow.password}
                  onChange={event => updateProviderConfig('servicenow', 'password', event.target.value)}
                  className="mt-2 h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                />
              </div>
            </div>
          )}

          <div className="mt-6 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="text-xs text-muted-foreground">
              {configComplete ? 'Credentials ready for validation.' : 'Complete credentials to enable testing.'}
            </div>
            <button
              type="button"
              onClick={handleTestConnection}
              disabled={!configComplete || testing}
              className="inline-flex h-10 items-center justify-center gap-2 rounded-md border px-4 text-sm font-medium hover:bg-muted disabled:cursor-not-allowed disabled:opacity-60"
            >
              {testing ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
              Test connection
            </button>
          </div>

          {testStatus && (
            <div
              className={`mt-4 rounded-lg border px-4 py-3 text-sm ${
                testStatus.status === 'success'
                  ? 'border-emerald-200 bg-emerald-50 text-emerald-700'
                  : 'border-rose-200 bg-rose-50 text-rose-700'
              }`}
            >
              {testStatus.message}
            </div>
          )}
        </div>
      </div>

      <div className="rounded-xl border bg-card p-6 shadow-sm">
        <div className="flex items-center gap-3 text-sm font-semibold text-muted-foreground">
          <ClipboardList className="h-4 w-4 text-primary" />
          Ticket field mapping
        </div>
        <p className="mt-2 text-sm text-muted-foreground">
          Map Breeze alert fields to ticket fields for consistent ticket creation.
        </p>
        <div className="mt-4 overflow-hidden rounded-lg border">
          <table className="min-w-full divide-y text-sm">
            <thead className="bg-muted/40 text-xs uppercase text-muted-foreground">
              <tr>
                <th className="px-4 py-3 text-left font-semibold">Breeze field</th>
                <th className="px-4 py-3 text-left font-semibold">Ticket field</th>
                <th className="px-4 py-3 text-left font-semibold">Required</th>
              </tr>
            </thead>
            <tbody className="divide-y bg-background">
            {fieldMappings.map(mapping => {
              const options = fieldOptions[activeProvider];
              const resolvedOptions = options.includes(mapping.ticketField)
                ? options
                : [mapping.ticketField, ...options];

              return (
                <tr key={mapping.id}>
                  <td className="px-4 py-3">{mapping.breezeField}</td>
                  <td className="px-4 py-3">
                    <select
                      value={mapping.ticketField}
                      onChange={event => updateFieldMapping(mapping.id, event.target.value)}
                      className="h-9 w-full rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                    >
                      {resolvedOptions.map(option => (
                        <option key={option} value={option}>
                          {option}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td className="px-4 py-3 text-xs text-muted-foreground">
                    {mapping.required ? 'Yes' : 'Optional'}
                  </td>
                </tr>
              );
            })}
            </tbody>
          </table>
        </div>
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <div className="rounded-xl border bg-card p-6 shadow-sm">
          <div className="flex items-center gap-3 text-sm font-semibold text-muted-foreground">
            <Settings2 className="h-4 w-4 text-primary" />
            Auto-ticket creation rules
          </div>
          <p className="mt-2 text-sm text-muted-foreground">
            Choose which alert events should create a ticket automatically.
          </p>
          <div className="mt-4 space-y-3">
            {autoTicketRuleOptions.map(rule => (
              <label
                key={rule.id}
                className="flex items-start justify-between gap-4 rounded-lg border bg-background p-4 text-sm"
              >
                <div>
                  <p className="font-medium">{rule.label}</p>
                  <p className="text-xs text-muted-foreground">{rule.description}</p>
                </div>
                <input
                  type="checkbox"
                  checked={autoTicketRules[rule.id]}
                  onChange={() => toggleAutoRule(rule.id)}
                  className="mt-1 h-4 w-4 rounded border-muted text-primary focus:ring-primary"
                />
              </label>
            ))}
          </div>
        </div>

        <div className="rounded-xl border bg-card p-6 shadow-sm">
          <div className="flex items-center gap-3 text-sm font-semibold text-muted-foreground">
            <ArrowLeftRight className="h-4 w-4 text-primary" />
            Bi-directional sync
          </div>
          <p className="mt-2 text-sm text-muted-foreground">
            Keep ticket updates synced back to Breeze alert timelines.
          </p>
          <div className="mt-4 space-y-3">
            {syncSettingOptions.map(setting => (
              <label
                key={setting.id}
                className="flex items-start justify-between gap-4 rounded-lg border bg-background p-4 text-sm"
              >
                <div>
                  <p className="font-medium">{setting.label}</p>
                  <p className="text-xs text-muted-foreground">{setting.description}</p>
                </div>
                <input
                  type="checkbox"
                  checked={syncSettings[setting.id]}
                  onChange={event => updateSyncSetting(setting.id, event.target.checked)}
                  className="mt-1 h-4 w-4 rounded border-muted text-primary focus:ring-primary"
                />
              </label>
            ))}
          </div>
        </div>
      </div>

      <div className="rounded-xl border bg-card p-6 shadow-sm">
        <div className="flex items-center gap-3 text-sm font-semibold text-muted-foreground">
          <SlidersHorizontal className="h-4 w-4 text-primary" />
          Priority mapping
        </div>
        <p className="mt-2 text-sm text-muted-foreground">
          Map Breeze alert severity to ticket priority levels.
        </p>
        <div className="mt-4 overflow-hidden rounded-lg border">
          <table className="min-w-full divide-y text-sm">
            <thead className="bg-muted/40 text-xs uppercase text-muted-foreground">
              <tr>
                <th className="px-4 py-3 text-left font-semibold">Alert severity</th>
                <th className="px-4 py-3 text-left font-semibold">Ticket priority</th>
                <th className="px-4 py-3 text-left font-semibold">Default</th>
              </tr>
            </thead>
            <tbody className="divide-y bg-background">
              {(Object.keys(severityLabels) as PriorityLevel[]).map(severity => {
                const options = priorityOptions[activeProvider];
                const currentValue = priorityMapping[severity];
                const resolvedOptions = options.includes(currentValue)
                  ? options
                  : [currentValue, ...options];

                return (
                  <tr key={severity}>
                    <td className="px-4 py-3">{severityLabels[severity]}</td>
                    <td className="px-4 py-3">
                      <select
                        value={currentValue}
                        onChange={event => updatePriorityMapping(severity, event.target.value)}
                        className="h-9 w-full rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                      >
                        {resolvedOptions.map(option => (
                          <option key={option} value={option}>
                            {option}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td className="px-4 py-3 text-xs text-muted-foreground">
                      {defaultPriorityMapping[severity]}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      <div className="rounded-xl border bg-card p-6 shadow-sm">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center gap-3 text-sm font-semibold text-muted-foreground">
            <CheckCircle2 className="h-4 w-4 text-primary" />
            Save configuration
          </div>
          <button
            type="button"
            onClick={handleSave}
            disabled={!configComplete || saving}
            className="inline-flex h-10 items-center justify-center gap-2 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
            {saving ? 'Saving...' : 'Save settings'}
          </button>
        </div>
        <p className="mt-2 text-sm text-muted-foreground">
          Save settings to enable ticket creation and sync policies for {activeProviderOption.label}.
        </p>
        {saveStatus && (
          <div
            className={`mt-4 rounded-lg border px-4 py-3 text-sm ${
              saveStatus.status === 'success'
                ? 'border-emerald-200 bg-emerald-50 text-emerald-700'
                : 'border-rose-200 bg-rose-50 text-rose-700'
            }`}
          >
            {saveStatus.message}
          </div>
        )}
      </div>
    </div>
  );
}
