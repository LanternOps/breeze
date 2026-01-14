import { useEffect, useMemo, useState, type FormEvent } from 'react';

type PsaProvider = 'connectwise' | 'autotask' | 'halo';
type ConnectionStatus = 'connected' | 'needs-auth' | 'disconnected' | 'testing';

type TestResult = {
  success: boolean;
  message?: string;
  error?: string;
};

const providerOptions = [
  {
    id: 'connectwise',
    label: 'ConnectWise Manage',
    description: 'Use your company ID plus public and private API keys.'
  },
  {
    id: 'autotask',
    label: 'Datto Autotask',
    description: 'Authenticate with your API user, secret, and integration code.'
  },
  {
    id: 'halo',
    label: 'HaloPSA',
    description: 'Connect with an API URL, client ID, and client secret.'
  }
] as const;

const statusStyles: Record<
  ConnectionStatus,
  { label: string; className: string; dotClassName: string }
> = {
  connected: {
    label: 'Connected',
    className: 'border-emerald-200 bg-emerald-50 text-emerald-700',
    dotClassName: 'bg-emerald-500'
  },
  'needs-auth': {
    label: 'Needs auth',
    className: 'border-amber-200 bg-amber-50 text-amber-700',
    dotClassName: 'bg-amber-500'
  },
  disconnected: {
    label: 'Disconnected',
    className: 'border-slate-200 bg-slate-50 text-slate-600',
    dotClassName: 'bg-slate-400'
  },
  testing: {
    label: 'Testing',
    className: 'border-blue-200 bg-blue-50 text-blue-700',
    dotClassName: 'bg-blue-500'
  }
};

const isProvider = (value: string): value is PsaProvider =>
  value === 'connectwise' || value === 'autotask' || value === 'halo';

const statusNotes: Record<ConnectionStatus, string> = {
  connected: 'Ready to sync.',
  'needs-auth': 'Credentials need attention.',
  disconnected: 'Not connected.',
  testing: 'Testing connection...'
};

export default function PSAIntegration() {
  const [selectedProvider, setSelectedProvider] = useState<PsaProvider>('connectwise');
  const [connectwise, setConnectwise] = useState({
    baseUrl: '',
    companyId: '',
    publicKey: '',
    privateKey: ''
  });
  const [autotask, setAutotask] = useState({
    username: '',
    secret: '',
    integrationCode: ''
  });
  const [halo, setHalo] = useState({
    baseUrl: '',
    clientId: '',
    clientSecret: ''
  });
  const [ticketSync, setTicketSync] = useState({
    createTicketsOnAlert: true,
    syncStatus: true
  });
  const [mapping, setMapping] = useState({
    companyMatch: 'name',
    contactMatch: 'email',
    createMissingCompanies: true,
    createMissingContacts: true
  });
  const [assetSync, setAssetSync] = useState({
    syncDevices: true,
    deviceType: 'configuration',
    includeNetworkDevices: false
  });
  const [connectionStatus, setConnectionStatus] = useState<ConnectionStatus>('disconnected');
  const [statusNote, setStatusNote] = useState<string>();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string>();
  const [successMessage, setSuccessMessage] = useState<string>();
  const [testResult, setTestResult] = useState<TestResult | null>(null);
  const [hasConfig, setHasConfig] = useState(false);

  const activeProviderConfig = useMemo(() => {
    switch (selectedProvider) {
      case 'connectwise':
        return connectwise;
      case 'autotask':
        return autotask;
      case 'halo':
        return halo;
      default:
        return connectwise;
    }
  }, [selectedProvider, connectwise, autotask, halo]);

  useEffect(() => {
    let isMounted = true;

    const loadConfig = async () => {
      try {
        setLoading(true);
        const response = await fetch('/api/integrations/psa');
        if (response.status === 404) {
          return;
        }
        if (!response.ok) {
          throw new Error('Failed to load PSA configuration');
        }
        const payload = await response.json().catch(() => ({}));
        if (!isMounted) return;
        const config = payload?.data ?? payload ?? {};

        const providerValue =
          typeof config.provider === 'string' && isProvider(config.provider)
            ? (config.provider as PsaProvider)
            : null;
        if (providerValue) {
          setSelectedProvider(providerValue);
        }

        const providersData = config.providers ?? {};
        if (providersData.connectwise) {
          setConnectwise(prev => ({ ...prev, ...providersData.connectwise }));
        }
        if (providersData.autotask) {
          setAutotask(prev => ({ ...prev, ...providersData.autotask }));
        }
        if (providersData.halo) {
          setHalo(prev => ({ ...prev, ...providersData.halo }));
        }

        if (providerValue && config.settings) {
          if (providerValue === 'connectwise') {
            setConnectwise(prev => ({ ...prev, ...config.settings }));
          }
          if (providerValue === 'autotask') {
            setAutotask(prev => ({ ...prev, ...config.settings }));
          }
          if (providerValue === 'halo') {
            setHalo(prev => ({ ...prev, ...config.settings }));
          }
        }

        if (config.ticketSync) {
          setTicketSync(prev => ({ ...prev, ...config.ticketSync }));
        }
        if (config.mapping) {
          setMapping(prev => ({ ...prev, ...config.mapping }));
        }
        if (config.assetSync) {
          setAssetSync(prev => ({ ...prev, ...config.assetSync }));
        }

        if (config.status && statusStyles[config.status as ConnectionStatus]) {
          setConnectionStatus(config.status as ConnectionStatus);
        }
        if (config.statusMessage) {
          setStatusNote(config.statusMessage);
        }
        if (Object.keys(config).length > 0) {
          setHasConfig(true);
        }
      } catch (error) {
        if (isMounted) {
          setErrorMessage(error instanceof Error ? error.message : 'Failed to load PSA configuration');
        }
      } finally {
        if (isMounted) {
          setLoading(false);
        }
      }
    };

    loadConfig();

    return () => {
      isMounted = false;
    };
  }, []);

  const handleProviderSelect = (value: string) => {
    if (!isProvider(value)) return;
    setSelectedProvider(value);
    setTestResult(null);
    setConnectionStatus('disconnected');
    setStatusNote(undefined);
  };

  const handleSave = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setErrorMessage(undefined);
    setSuccessMessage(undefined);
    setSaving(true);

    const payload = {
      provider: selectedProvider,
      providers: {
        connectwise,
        autotask,
        halo
      },
      ticketSync,
      mapping,
      assetSync
    };

    try {
      const response = await fetch('/api/integrations/psa', {
        method: hasConfig ? 'PUT' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      const data = await response.json().catch(() => ({}));

      if (!response.ok) {
        throw new Error(data.error || 'Failed to save configuration');
      }

      setHasConfig(true);
      setSuccessMessage('PSA configuration saved.');

      const nextStatus = data.status ?? data.data?.status;
      if (nextStatus && statusStyles[nextStatus as ConnectionStatus]) {
        setConnectionStatus(nextStatus as ConnectionStatus);
      }
      const nextNote = data.statusMessage ?? data.data?.statusMessage;
      if (nextNote) {
        setStatusNote(nextNote);
      }
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : 'Failed to save configuration');
    } finally {
      setSaving(false);
    }
  };

  const handleTestConnection = async () => {
    setErrorMessage(undefined);
    setSuccessMessage(undefined);
    setTesting(true);
    setTestResult(null);
    setConnectionStatus('testing');
    setStatusNote(statusNotes.testing);

    try {
      const response = await fetch('/api/integrations/psa/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          provider: selectedProvider,
          settings: activeProviderConfig
        })
      });
      const data = await response.json().catch(() => ({}));

      if (!response.ok || data.success === false) {
        throw new Error(data.error || 'Connection test failed');
      }

      setTestResult({
        success: true,
        message: data.message || 'Connection successful.'
      });
      setConnectionStatus('connected');
      setStatusNote(data.message || 'Connection verified.');
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Connection test failed';
      setTestResult({ success: false, error: message });
      setConnectionStatus('needs-auth');
      setStatusNote(statusNotes['needs-auth']);
    } finally {
      setTesting(false);
    }
  };

  const status = statusStyles[connectionStatus];
  const statusHint = statusNote ?? statusNotes[connectionStatus];
  const providerMeta = providerOptions.find(option => option.id === selectedProvider);

  return (
    <form onSubmit={handleSave} className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold">PSA integration settings</h1>
          <p className="text-muted-foreground">
            Connect your PSA to sync tickets, companies, and device data.
          </p>
        </div>
        <div className="flex flex-col items-start gap-1 text-left sm:items-end sm:text-right">
          <span className={`inline-flex items-center gap-2 rounded-full border px-3 py-1 text-xs ${status.className}`}>
            <span className={`h-2 w-2 rounded-full ${status.dotClassName}`} />
            {status.label}
          </span>
          <span className="text-xs text-muted-foreground">{statusHint}</span>
        </div>
      </div>

      {errorMessage && (
        <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {errorMessage}
        </div>
      )}

      {successMessage && (
        <div className="rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-700">
          {successMessage}
        </div>
      )}

      {loading ? (
        <div className="flex items-center justify-center py-12">
          <div className="text-center">
            <div className="mx-auto h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent" />
            <p className="mt-4 text-sm text-muted-foreground">Loading PSA settings...</p>
          </div>
        </div>
      ) : (
        <>
          <div className="rounded-xl border bg-card p-6 shadow-sm">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <h2 className="text-lg font-semibold">Provider configuration</h2>
                <p className="text-sm text-muted-foreground">
                  Choose your PSA provider and enter the credentials to connect.
                </p>
              </div>
              <button
                type="button"
                onClick={handleTestConnection}
                disabled={testing || saving}
                className="inline-flex h-10 items-center justify-center gap-2 rounded-md border px-4 text-sm font-medium hover:bg-muted disabled:cursor-not-allowed disabled:opacity-60"
              >
                {testing ? 'Testing...' : 'Test connection'}
              </button>
            </div>

            <div className="mt-6 space-y-4">
              <div className="sm:hidden">
                <label htmlFor="psa-provider" className="text-sm font-medium">
                  Provider
                </label>
                <select
                  id="psa-provider"
                  value={selectedProvider}
                  onChange={event => handleProviderSelect(event.target.value)}
                  className="mt-2 h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                >
                  {providerOptions.map(provider => (
                    <option key={provider.id} value={provider.id}>
                      {provider.label}
                    </option>
                  ))}
                </select>
                {providerMeta && (
                  <p className="mt-2 text-xs text-muted-foreground">{providerMeta.description}</p>
                )}
              </div>

              <div className="hidden gap-3 sm:grid sm:grid-cols-3" role="tablist" aria-label="PSA provider">
                {providerOptions.map(provider => {
                  const isActive = selectedProvider === provider.id;
                  return (
                    <button
                      key={provider.id}
                      type="button"
                      role="tab"
                      aria-selected={isActive}
                      onClick={() => handleProviderSelect(provider.id)}
                      className={`rounded-lg border px-4 py-3 text-left transition ${
                        isActive ? 'border-primary bg-primary/5' : 'border-border hover:border-primary/40'
                      }`}
                    >
                      <span className="text-sm font-semibold">{provider.label}</span>
                      <span className="mt-1 block text-xs text-muted-foreground">
                        {provider.description}
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>

            <div className="mt-6 rounded-lg border bg-background p-6">
              <h3 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
                {providerMeta?.label ?? 'Provider'} credentials
              </h3>

              {selectedProvider === 'connectwise' && (
                <div className="mt-4 grid gap-4 md:grid-cols-2">
                  <div className="space-y-2 md:col-span-2">
                    <label htmlFor="cw-url" className="text-sm font-medium">
                      ConnectWise API URL
                    </label>
                    <input
                      id="cw-url"
                      type="url"
                      value={connectwise.baseUrl}
                      onChange={event =>
                        setConnectwise(prev => ({ ...prev, baseUrl: event.target.value }))
                      }
                      placeholder="https://api-na.myconnectwise.net"
                      className="h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                    />
                  </div>
                  <div className="space-y-2">
                    <label htmlFor="cw-company-id" className="text-sm font-medium">
                      Company ID
                    </label>
                    <input
                      id="cw-company-id"
                      value={connectwise.companyId}
                      onChange={event =>
                        setConnectwise(prev => ({ ...prev, companyId: event.target.value }))
                      }
                      placeholder="Your company ID"
                      className="h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                    />
                  </div>
                  <div className="space-y-2">
                    <label htmlFor="cw-public-key" className="text-sm font-medium">
                      Public key
                    </label>
                    <input
                      id="cw-public-key"
                      value={connectwise.publicKey}
                      onChange={event =>
                        setConnectwise(prev => ({ ...prev, publicKey: event.target.value }))
                      }
                      placeholder="Public key"
                      className="h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                    />
                  </div>
                  <div className="space-y-2">
                    <label htmlFor="cw-private-key" className="text-sm font-medium">
                      Private key
                    </label>
                    <input
                      id="cw-private-key"
                      type="password"
                      value={connectwise.privateKey}
                      onChange={event =>
                        setConnectwise(prev => ({ ...prev, privateKey: event.target.value }))
                      }
                      placeholder="Private key"
                      className="h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                    />
                  </div>
                </div>
              )}

              {selectedProvider === 'autotask' && (
                <div className="mt-4 grid gap-4 md:grid-cols-2">
                  <div className="space-y-2 md:col-span-2">
                    <label htmlFor="autotask-username" className="text-sm font-medium">
                      API username
                    </label>
                    <input
                      id="autotask-username"
                      value={autotask.username}
                      onChange={event =>
                        setAutotask(prev => ({ ...prev, username: event.target.value }))
                      }
                      placeholder="api-user@example.com"
                      className="h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                    />
                  </div>
                  <div className="space-y-2">
                    <label htmlFor="autotask-secret" className="text-sm font-medium">
                      API secret
                    </label>
                    <input
                      id="autotask-secret"
                      type="password"
                      value={autotask.secret}
                      onChange={event =>
                        setAutotask(prev => ({ ...prev, secret: event.target.value }))
                      }
                      placeholder="Secret"
                      className="h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                    />
                  </div>
                  <div className="space-y-2">
                    <label htmlFor="autotask-code" className="text-sm font-medium">
                      Integration code
                    </label>
                    <input
                      id="autotask-code"
                      value={autotask.integrationCode}
                      onChange={event =>
                        setAutotask(prev => ({ ...prev, integrationCode: event.target.value }))
                      }
                      placeholder="Integration code"
                      className="h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                    />
                  </div>
                </div>
              )}

              {selectedProvider === 'halo' && (
                <div className="mt-4 grid gap-4 md:grid-cols-2">
                  <div className="space-y-2 md:col-span-2">
                    <label htmlFor="halo-url" className="text-sm font-medium">
                      HaloPSA API URL
                    </label>
                    <input
                      id="halo-url"
                      type="url"
                      value={halo.baseUrl}
                      onChange={event => setHalo(prev => ({ ...prev, baseUrl: event.target.value }))}
                      placeholder="https://api.haloPSA.com"
                      className="h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                    />
                  </div>
                  <div className="space-y-2">
                    <label htmlFor="halo-client-id" className="text-sm font-medium">
                      Client ID
                    </label>
                    <input
                      id="halo-client-id"
                      value={halo.clientId}
                      onChange={event => setHalo(prev => ({ ...prev, clientId: event.target.value }))}
                      placeholder="Client ID"
                      className="h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                    />
                  </div>
                  <div className="space-y-2">
                    <label htmlFor="halo-client-secret" className="text-sm font-medium">
                      Client secret
                    </label>
                    <input
                      id="halo-client-secret"
                      type="password"
                      value={halo.clientSecret}
                      onChange={event =>
                        setHalo(prev => ({ ...prev, clientSecret: event.target.value }))
                      }
                      placeholder="Client secret"
                      className="h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                    />
                  </div>
                </div>
              )}
            </div>

            {testResult && (
              <div
                className={`mt-4 rounded-md border px-3 py-2 text-sm ${
                  testResult.success
                    ? 'border-emerald-200 bg-emerald-50 text-emerald-700'
                    : 'border-destructive/40 bg-destructive/10 text-destructive'
                }`}
              >
                {testResult.success
                  ? testResult.message || 'Connection successful.'
                  : testResult.error || 'Unable to connect to the PSA provider.'}
              </div>
            )}
          </div>

          <div className="rounded-xl border bg-card p-6 shadow-sm">
            <div>
              <h2 className="text-lg font-semibold">Ticket sync settings</h2>
              <p className="text-sm text-muted-foreground">
                Define when Breeze should create or update PSA tickets.
              </p>
            </div>
            <div className="mt-6 grid gap-4 md:grid-cols-2">
              <label className="flex items-center justify-between rounded-lg border bg-background p-4 text-sm">
                <div>
                  <p className="font-medium">Create tickets on alert</p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    Open a PSA ticket automatically when an alert triggers.
                  </p>
                </div>
                <input
                  type="checkbox"
                  checked={ticketSync.createTicketsOnAlert}
                  onChange={event =>
                    setTicketSync(prev => ({
                      ...prev,
                      createTicketsOnAlert: event.target.checked
                    }))
                  }
                  className="h-4 w-4 rounded border-muted text-primary focus:ring-primary"
                />
              </label>
              <label className="flex items-center justify-between rounded-lg border bg-background p-4 text-sm">
                <div>
                  <p className="font-medium">Sync ticket status</p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    Keep Breeze and PSA status updates aligned.
                  </p>
                </div>
                <input
                  type="checkbox"
                  checked={ticketSync.syncStatus}
                  onChange={event =>
                    setTicketSync(prev => ({ ...prev, syncStatus: event.target.checked }))
                  }
                  className="h-4 w-4 rounded border-muted text-primary focus:ring-primary"
                />
              </label>
            </div>
          </div>

          <div className="rounded-xl border bg-card p-6 shadow-sm">
            <div>
              <h2 className="text-lg font-semibold">Company and contact mapping</h2>
              <p className="text-sm text-muted-foreground">
                Map Breeze accounts and contacts to PSA fields.
              </p>
            </div>
            <div className="mt-6 grid gap-4 md:grid-cols-2">
              <div className="space-y-2">
                <label htmlFor="company-match" className="text-sm font-medium">
                  Company matching rule
                </label>
                <select
                  id="company-match"
                  value={mapping.companyMatch}
                  onChange={event =>
                    setMapping(prev => ({ ...prev, companyMatch: event.target.value }))
                  }
                  className="h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                >
                  <option value="name">Company name</option>
                  <option value="externalId">External ID</option>
                  <option value="domain">Primary domain</option>
                </select>
                <p className="text-xs text-muted-foreground">
                  Used to match Breeze organizations to PSA companies.
                </p>
              </div>
              <div className="space-y-2">
                <label htmlFor="contact-match" className="text-sm font-medium">
                  Contact matching rule
                </label>
                <select
                  id="contact-match"
                  value={mapping.contactMatch}
                  onChange={event =>
                    setMapping(prev => ({ ...prev, contactMatch: event.target.value }))
                  }
                  className="h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                >
                  <option value="email">Email address</option>
                  <option value="username">Username</option>
                  <option value="externalId">External ID</option>
                </select>
                <p className="text-xs text-muted-foreground">
                  Used to link alert contacts to PSA records.
                </p>
              </div>
            </div>
            <div className="mt-6 grid gap-4 md:grid-cols-2">
              <label className="flex items-center justify-between rounded-lg border bg-background p-4 text-sm">
                <div>
                  <p className="font-medium">Create missing companies</p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    Create PSA companies if they do not exist yet.
                  </p>
                </div>
                <input
                  type="checkbox"
                  checked={mapping.createMissingCompanies}
                  onChange={event =>
                    setMapping(prev => ({
                      ...prev,
                      createMissingCompanies: event.target.checked
                    }))
                  }
                  className="h-4 w-4 rounded border-muted text-primary focus:ring-primary"
                />
              </label>
              <label className="flex items-center justify-between rounded-lg border bg-background p-4 text-sm">
                <div>
                  <p className="font-medium">Create missing contacts</p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    Add PSA contacts automatically when they are missing.
                  </p>
                </div>
                <input
                  type="checkbox"
                  checked={mapping.createMissingContacts}
                  onChange={event =>
                    setMapping(prev => ({
                      ...prev,
                      createMissingContacts: event.target.checked
                    }))
                  }
                  className="h-4 w-4 rounded border-muted text-primary focus:ring-primary"
                />
              </label>
            </div>
          </div>

          <div className="rounded-xl border bg-card p-6 shadow-sm">
            <div>
              <h2 className="text-lg font-semibold">Asset sync configuration</h2>
              <p className="text-sm text-muted-foreground">
                Control how devices and assets flow into the PSA.
              </p>
            </div>
            <div className="mt-6 grid gap-4 md:grid-cols-2">
              <label className="flex items-center justify-between rounded-lg border bg-background p-4 text-sm">
                <div>
                  <p className="font-medium">Sync devices to PSA</p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    Keep PSA configuration items aligned with Breeze devices.
                  </p>
                </div>
                <input
                  type="checkbox"
                  checked={assetSync.syncDevices}
                  onChange={event =>
                    setAssetSync(prev => ({ ...prev, syncDevices: event.target.checked }))
                  }
                  className="h-4 w-4 rounded border-muted text-primary focus:ring-primary"
                />
              </label>
              <label className="flex items-center justify-between rounded-lg border bg-background p-4 text-sm">
                <div>
                  <p className="font-medium">Include network devices</p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    Sync switches, firewalls, and wireless hardware.
                  </p>
                </div>
                <input
                  type="checkbox"
                  checked={assetSync.includeNetworkDevices}
                  onChange={event =>
                    setAssetSync(prev => ({
                      ...prev,
                      includeNetworkDevices: event.target.checked
                    }))
                  }
                  className="h-4 w-4 rounded border-muted text-primary focus:ring-primary"
                />
              </label>
              <div className="space-y-2 md:col-span-2">
                <label htmlFor="asset-type" className="text-sm font-medium">
                  PSA device type mapping
                </label>
                <select
                  id="asset-type"
                  value={assetSync.deviceType}
                  onChange={event =>
                    setAssetSync(prev => ({ ...prev, deviceType: event.target.value }))
                  }
                  className="h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                >
                  <option value="configuration">Configuration item</option>
                  <option value="asset">Asset record</option>
                  <option value="device">Device</option>
                </select>
                <p className="text-xs text-muted-foreground">
                  Choose the PSA object used for synced devices.
                </p>
              </div>
            </div>
          </div>

          <div className="flex flex-wrap justify-end gap-3">
            <button
              type="submit"
              disabled={saving}
              className="inline-flex h-10 items-center justify-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {saving ? 'Saving...' : 'Save configuration'}
            </button>
          </div>
        </>
      )}
    </form>
  );
}
