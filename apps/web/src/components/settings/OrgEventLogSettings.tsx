import { useEffect, useState } from 'react';
import { Database, Save, Key, Link, ScrollText, Info } from 'lucide-react';
import { useOrgStore } from '../../stores/orgStore';
import { fetchWithAuth } from '../../stores/auth';

type LogForwardingData = {
  enabled: boolean;
  elasticsearchUrl: string;
  elasticsearchApiKey?: string;
  elasticsearchUsername?: string;
  elasticsearchPassword?: string;
  indexPrefix: string;
};

type AuthMethod = 'apiKey' | 'basic';

type OrgEventLogSettingsProps = {
  onDirty?: () => void;
};

export default function OrgEventLogSettings({ onDirty }: OrgEventLogSettingsProps) {
  const { currentOrgId } = useOrgStore();

  const [enabled, setEnabled] = useState(false);
  const [elasticsearchUrl, setElasticsearchUrl] = useState('');
  const [authMethod, setAuthMethod] = useState<AuthMethod>('apiKey');
  const [elasticsearchApiKey, setElasticsearchApiKey] = useState('');
  const [elasticsearchUsername, setElasticsearchUsername] = useState('');
  const [elasticsearchPassword, setElasticsearchPassword] = useState('');
  const [indexPrefix, setIndexPrefix] = useState('breeze-logs');

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  const [success, setSuccess] = useState(false);

  useEffect(() => {
    if (!currentOrgId) return;

    const load = async () => {
      try {
        setLoading(true);
        const response = await fetchWithAuth(`/agents/org/${currentOrgId}/settings/log-forwarding`);
        if (!response.ok) {
          if (response.status === 401) {
            window.location.href = '/login';
            return;
          }
          throw new Error('Failed to load log forwarding settings');
        }
        const data = await response.json();
        const lf = data.settings?.logForwarding as LogForwardingData | undefined;
        if (lf) {
          setEnabled(lf.enabled ?? false);
          setElasticsearchUrl(lf.elasticsearchUrl || '');
          setIndexPrefix(lf.indexPrefix || 'breeze-logs');
          if (lf.elasticsearchUsername) {
            setAuthMethod('basic');
            setElasticsearchUsername(lf.elasticsearchUsername);
            setElasticsearchPassword(lf.elasticsearchPassword || '');
          } else {
            setAuthMethod('apiKey');
            setElasticsearchApiKey(lf.elasticsearchApiKey || '');
          }
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to load settings');
      } finally {
        setLoading(false);
      }
    };

    load();
  }, [currentOrgId]);

  const markDirty = () => {
    onDirty?.();
  };

  const handleSave = async () => {
    if (!currentOrgId) return;

    setSaving(true);
    setError(undefined);
    setSuccess(false);

    try {
      const body: Record<string, unknown> = {
        enabled,
        elasticsearchUrl,
        indexPrefix,
      };

      if (authMethod === 'apiKey') {
        body.elasticsearchApiKey = elasticsearchApiKey;
      } else {
        body.elasticsearchUsername = elasticsearchUsername;
        body.elasticsearchPassword = elasticsearchPassword;
      }

      const response = await fetchWithAuth(`/agents/org/${currentOrgId}/settings/log-forwarding`, {
        method: 'PATCH',
        body: JSON.stringify(body),
      });

      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data.error || 'Failed to save log forwarding settings');
      }

      setSuccess(true);
      setTimeout(() => setSuccess(false), 3000);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save settings');
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <div className="h-6 w-6 animate-spin rounded-full border-4 border-primary border-t-transparent" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Log Forwarding Section */}
      <section className="space-y-6 rounded-lg border bg-card p-6 shadow-sm">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <div className="flex items-center gap-2">
              <Database className="h-5 w-5" />
              <h2 className="text-lg font-semibold">Log Forwarding</h2>
            </div>
            <p className="mt-1 text-sm text-muted-foreground">
              Forward collected event logs to an external Elasticsearch instance for long-term storage and analysis.
            </p>
          </div>
          <button
            type="button"
            onClick={handleSave}
            disabled={saving}
            className="inline-flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition hover:opacity-90 disabled:opacity-50"
          >
            <Save className="h-4 w-4" />
            {saving ? 'Saving...' : 'Save settings'}
          </button>
        </div>

        {error ? (
          <div className="rounded-md border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-destructive">
            {error}
          </div>
        ) : null}

        {success ? (
          <div className="rounded-md border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-800 dark:border-emerald-800 dark:bg-emerald-950 dark:text-emerald-200">
            Log forwarding settings saved successfully.
          </div>
        ) : null}

        {/* Enable toggle */}
        <label className="flex items-center justify-between gap-3 rounded-md border bg-muted/40 px-4 py-3 text-sm">
          <div>
            <p className="font-medium">Enable log forwarding</p>
            <p className="text-xs text-muted-foreground">
              When enabled, event logs are forwarded to your Elasticsearch cluster on a recurring schedule.
            </p>
          </div>
          <input
            type="checkbox"
            checked={enabled}
            onChange={event => {
              setEnabled(event.target.checked);
              markDirty();
            }}
            className="h-4 w-4"
          />
        </label>

        {/* Connection fields — only shown when enabled */}
        {enabled ? (
          <div className="space-y-4">
            <div className="space-y-4 rounded-lg border bg-muted/40 p-4">
              <div className="flex items-center gap-2 text-sm font-medium">
                <Link className="h-4 w-4" />
                Connection
              </div>
              <div className="space-y-2">
                <label className="text-sm font-medium">Elasticsearch URL</label>
                <input
                  type="text"
                  value={elasticsearchUrl}
                  onChange={event => {
                    setElasticsearchUrl(event.target.value);
                    markDirty();
                  }}
                  placeholder="https://your-cluster.es.example.com:9200"
                  className="h-10 w-full rounded-md border bg-background px-3 text-sm"
                />
                <p className="text-xs text-muted-foreground">Must use HTTPS.</p>
              </div>

              <div className="space-y-2">
                <label className="text-sm font-medium">Index prefix</label>
                <input
                  type="text"
                  value={indexPrefix}
                  onChange={event => {
                    setIndexPrefix(event.target.value);
                    markDirty();
                  }}
                  placeholder="breeze-logs"
                  className="h-10 w-full rounded-md border bg-background px-3 text-sm"
                />
                <p className="text-xs text-muted-foreground">
                  Logs are written to indices named {indexPrefix ? `${indexPrefix}-YYYY.MM.DD` : 'breeze-logs-YYYY.MM.DD'}.
                </p>
              </div>
            </div>

            <div className="space-y-4 rounded-lg border bg-muted/40 p-4">
              <div className="flex items-center gap-2 text-sm font-medium">
                <Key className="h-4 w-4" />
                Authentication
              </div>

              <div className="flex gap-4">
                <label className="flex items-center gap-2 text-sm">
                  <input
                    type="radio"
                    name="authMethod"
                    checked={authMethod === 'apiKey'}
                    onChange={() => {
                      setAuthMethod('apiKey');
                      markDirty();
                    }}
                    className="h-4 w-4"
                  />
                  API Key
                </label>
                <label className="flex items-center gap-2 text-sm">
                  <input
                    type="radio"
                    name="authMethod"
                    checked={authMethod === 'basic'}
                    onChange={() => {
                      setAuthMethod('basic');
                      markDirty();
                    }}
                    className="h-4 w-4"
                  />
                  Username / Password
                </label>
              </div>

              {authMethod === 'apiKey' ? (
                <div className="space-y-2">
                  <label className="text-sm font-medium">API Key</label>
                  <input
                    type="password"
                    value={elasticsearchApiKey}
                    onChange={event => {
                      setElasticsearchApiKey(event.target.value);
                      markDirty();
                    }}
                    placeholder="Enter Elasticsearch API key"
                    className="h-10 w-full rounded-md border bg-background px-3 text-sm"
                  />
                </div>
              ) : (
                <div className="grid gap-4 md:grid-cols-2">
                  <div className="space-y-2">
                    <label className="text-sm font-medium">Username</label>
                    <input
                      type="text"
                      value={elasticsearchUsername}
                      onChange={event => {
                        setElasticsearchUsername(event.target.value);
                        markDirty();
                      }}
                      placeholder="elastic"
                      className="h-10 w-full rounded-md border bg-background px-3 text-sm"
                    />
                  </div>
                  <div className="space-y-2">
                    <label className="text-sm font-medium">Password</label>
                    <input
                      type="password"
                      value={elasticsearchPassword}
                      onChange={event => {
                        setElasticsearchPassword(event.target.value);
                        markDirty();
                      }}
                      placeholder="Enter password"
                      className="h-10 w-full rounded-md border bg-background px-3 text-sm"
                    />
                  </div>
                </div>
              )}

              <p className="text-xs text-muted-foreground">
                Credentials are stored encrypted. Existing credentials are masked when loaded.
              </p>
            </div>
          </div>
        ) : (
          <p className="text-xs text-muted-foreground">
            Enable log forwarding above to configure connection settings.
          </p>
        )}
      </section>

      {/* Event Log Collection Info */}
      <section className="rounded-lg border bg-card p-6 shadow-sm">
        <div className="flex items-start gap-3">
          <Info className="mt-0.5 h-5 w-5 text-muted-foreground" />
          <div className="space-y-2">
            <h3 className="text-base font-semibold">Event Log Collection</h3>
            <p className="text-sm text-muted-foreground">
              Collection settings such as log categories, retention periods, and collection rates are
              managed per-policy through Configuration Policies.
            </p>
            <a
              href="/configuration-policies"
              className="inline-flex items-center gap-1 text-sm font-medium text-primary hover:underline"
            >
              <ScrollText className="h-4 w-4" />
              Go to Configuration Policies
            </a>
          </div>
        </div>
      </section>
    </div>
  );
}
