import { useId, useState } from 'react';
import { fetchWithAuth } from '../../stores/auth';
import { runAction, ActionError } from '../../lib/runAction';
import { navigateTo } from '@/lib/navigation';
import { Dialog } from '../shared/Dialog';

/**
 * Supported provider IDs. Mirrors the wire-format `dns_provider` enum,
 * but only lists providers that have working sync (umbrella, cloudflare,
 * dnsfilter, pihole, adguard_home). opendns and quad9 exist in the enum
 * but throw "not yet supported" server-side, so we hide them from the
 * picker rather than showing broken options. See
 * apps/api/src/services/dnsProviders/index.ts.
 */
type SupportedProvider =
  | 'umbrella'
  | 'cloudflare'
  | 'dnsfilter'
  | 'pihole'
  | 'adguard_home';

interface ProviderFieldSpec {
  label: string;
  helpText: string;
  apiKey: { label: string; placeholder: string };
  apiSecret?: { label: string; placeholder: string };
  configFields?: Array<{
    key: 'organizationId' | 'accountId' | 'apiEndpoint';
    label: string;
    placeholder: string;
    type?: 'text' | 'url';
  }>;
}

const PROVIDERS: Record<SupportedProvider, ProviderFieldSpec> = {
  umbrella: {
    label: 'Cisco Umbrella',
    helpText: 'API key + secret from the Umbrella Reporting API; organizationId from your Umbrella dashboard URL.',
    apiKey: { label: 'API key', placeholder: 'reporting-api-key' },
    apiSecret: { label: 'API secret', placeholder: 'reporting-api-secret' },
    configFields: [
      { key: 'organizationId', label: 'Organization ID', placeholder: '1234567' },
    ],
  },
  cloudflare: {
    label: 'Cloudflare Gateway',
    helpText: 'API token with Zero Trust → Gateway → Read scope.',
    apiKey: { label: 'API token', placeholder: 'cf-api-token' },
    configFields: [
      { key: 'accountId', label: 'Account ID', placeholder: '32-char hex from the Cloudflare dashboard' },
    ],
  },
  dnsfilter: {
    label: 'DNSFilter',
    helpText: 'API key from your DNSFilter account settings; account ID required only for multi-tenant scopes.',
    apiKey: { label: 'API key', placeholder: 'dnsfilter-api-key' },
    configFields: [
      { key: 'accountId', label: 'Account ID (optional)', placeholder: 'leave blank for single-tenant' },
    ],
  },
  pihole: {
    label: 'Pi-hole',
    helpText: 'Pi-hole API endpoint + API key. Use the LAN-routable hostname.',
    apiKey: { label: 'API key', placeholder: 'pihole api key from /admin' },
    configFields: [
      { key: 'apiEndpoint', label: 'API endpoint', placeholder: 'http://pihole.local', type: 'url' },
    ],
  },
  adguard_home: {
    label: 'AdGuard Home',
    helpText: 'API endpoint + HTTP Basic auth username (apiKey) + password (apiSecret).',
    apiKey: { label: 'HTTP Basic username', placeholder: 'admin' },
    apiSecret: { label: 'HTTP Basic password', placeholder: 'password' },
    configFields: [
      { key: 'apiEndpoint', label: 'API endpoint', placeholder: 'https://adguard.client.local', type: 'url' },
    ],
  },
};

type ConfigPayload = {
  organizationId?: string;
  accountId?: string;
  apiEndpoint?: string;
};

interface AddDnsIntegrationModalProps {
  onClose: () => void;
  onCreated: () => void;
}

export default function AddDnsIntegrationModal({ onClose, onCreated }: AddDnsIntegrationModalProps) {
  const [provider, setProvider] = useState<SupportedProvider>('cloudflare');
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [apiSecret, setApiSecret] = useState('');
  const [config, setConfig] = useState<ConfigPayload>({});
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const spec = PROVIDERS[provider];

  const updateConfig = (key: keyof ConfigPayload, value: string) => {
    setConfig((prev) => ({ ...prev, [key]: value }));
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (submitting) return;
    setSubmitting(true);
    setError(null);

    // Trim string-empty values so we don't send them — the server treats
    // empty strings as set, which breaks the provider-specific refinements
    // (e.g. cloudflare config.accountId empty string ≠ undefined).
    const trimmedConfig: ConfigPayload = {};
    if (config.organizationId?.trim()) trimmedConfig.organizationId = config.organizationId.trim();
    if (config.accountId?.trim()) trimmedConfig.accountId = config.accountId.trim();
    if (config.apiEndpoint?.trim()) trimmedConfig.apiEndpoint = config.apiEndpoint.trim();

    try {
      await runAction({
        request: () => fetchWithAuth('/dns-security/integrations', {
          method: 'POST',
          body: JSON.stringify({
            provider,
            name: name.trim(),
            description: description.trim() || undefined,
            apiKey,
            apiSecret: apiSecret || undefined,
            config: Object.keys(trimmedConfig).length > 0 ? trimmedConfig : undefined,
            isActive: true,
          }),
        }),
        errorFallback: 'Failed to create integration',
        successMessage: `${spec.label} integration "${name}" added`,
        onUnauthorized: () => void navigateTo('/login', { replace: true }),
      });
      onCreated();
      onClose();
    } catch (err) {
      if (err instanceof ActionError) {
        if (err.status === 401) return;
        setError(err.message);
      } else {
        setError(err instanceof Error ? err.message : 'Network error');
      }
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog
      open
      onClose={onClose}
      title="Add DNS Integration"
      maxWidth="lg"
      className="p-6 max-h-[90vh] overflow-y-auto"
    >
      <div className="relative">
        <h2 className="text-lg font-semibold">Add DNS Integration</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Connect a DNS filtering provider to ingest query logs and threat events.
        </p>

        <form onSubmit={handleSubmit} className="mt-4 space-y-4">
          <Field label="Provider">
            {(id) => (
              <>
                <select
                  id={id}
                  value={provider}
                  onChange={(e) => {
                    setProvider(e.target.value as SupportedProvider);
                    setConfig({}); // clear provider-specific fields when switching
                  }}
                  className="h-9 w-full rounded-md border bg-background px-2 text-sm"
                >
                  {(Object.entries(PROVIDERS) as Array<[SupportedProvider, ProviderFieldSpec]>).map(
                    ([key, p]) => (
                      <option key={key} value={key}>
                        {p.label}
                      </option>
                    ),
                  )}
                </select>
                <p className="mt-1 text-xs text-muted-foreground">{spec.helpText}</p>
              </>
            )}
          </Field>

          <Field label="Display name">
            {(id) => (
              <input
                id={id}
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                maxLength={200}
                required
                placeholder="e.g. Acme HQ Gateway"
                className="h-9 w-full rounded-md border bg-background px-2 text-sm"
              />
            )}
          </Field>

          <Field label="Description (optional)">
            {(id) => (
              <textarea
                id={id}
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                maxLength={2000}
                rows={2}
                placeholder="What this integration covers"
                className="w-full rounded-md border bg-background px-2 py-1.5 text-sm"
              />
            )}
          </Field>

          <Field label={spec.apiKey.label}>
            {(id) => (
              <input
                id={id}
                type="text"
                autoComplete="off"
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                required
                placeholder={spec.apiKey.placeholder}
                className="h-9 w-full rounded-md border bg-background px-2 text-sm font-mono"
              />
            )}
          </Field>

          {spec.apiSecret && (
            <Field label={spec.apiSecret.label}>
              {(id) => (
                <input
                  id={id}
                  type="password"
                  autoComplete="new-password"
                  value={apiSecret}
                  onChange={(e) => setApiSecret(e.target.value)}
                  required
                  placeholder={spec.apiSecret!.placeholder}
                  className="h-9 w-full rounded-md border bg-background px-2 text-sm font-mono"
                />
              )}
            </Field>
          )}

          {spec.configFields?.map((field) => (
            <Field key={field.key} label={field.label}>
              {(id) => (
                <input
                  id={id}
                  type={field.type ?? 'text'}
                  value={config[field.key] ?? ''}
                  onChange={(e) => updateConfig(field.key, e.target.value)}
                  placeholder={field.placeholder}
                  className="h-9 w-full rounded-md border bg-background px-2 text-sm"
                />
              )}
            </Field>
          ))}

          {error && (
            <div role="alert" className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
              {error}
            </div>
          )}

          <div className="flex justify-end gap-2 pt-2">
            <button
              type="button"
              onClick={onClose}
              className="rounded-md border bg-background px-3 py-1.5 text-sm font-medium hover:bg-muted"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={submitting || !name.trim() || !apiKey.trim()}
              className="inline-flex items-center gap-2 rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
            >
              {submitting ? 'Adding…' : 'Add integration'}
            </button>
          </div>
        </form>
      </div>
    </Dialog>
  );
}

function Field({
  label,
  children,
}: {
  label: string;
  // Render-prop: gives the child the auto-generated `id` so the label's
  // htmlFor binding works for assistive tech AND for testing-library's
  // getByLabelText (which requires explicit for/id pairing or nested
  // form-control association — render-prop avoids the latter being
  // ambiguous when the Field also renders helper text).
  children: (id: string) => React.ReactNode;
}) {
  const id = useId();
  return (
    <div className="block">
      <label htmlFor={id} className="mb-1 block text-sm font-medium">
        {label}
      </label>
      {children(id)}
    </div>
  );
}
