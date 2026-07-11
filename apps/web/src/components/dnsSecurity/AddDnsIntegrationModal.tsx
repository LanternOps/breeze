import { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import '@/lib/i18n';
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
  labelKey: string;
  helpTextKey: string;
  apiKey: { labelKey: string; placeholderKey: string };
  apiSecret?: { labelKey: string; placeholderKey: string };
  configFields?: Array<{
    key: 'organizationId' | 'accountId' | 'apiEndpoint';
    labelKey: string;
    placeholderKey: string;
    type?: 'text' | 'url';
  }>;
}

const PROVIDERS: Record<SupportedProvider, ProviderFieldSpec> = {
  umbrella: {
    labelKey: 'providers.umbrella.label',
    helpTextKey: 'providers.umbrella.helpText',
    apiKey: { labelKey: 'fields.apiKey', placeholderKey: 'providers.umbrella.apiKeyPlaceholder' },
    apiSecret: { labelKey: 'fields.apiSecret', placeholderKey: 'providers.umbrella.apiSecretPlaceholder' },
    configFields: [
      { key: 'organizationId', labelKey: 'fields.organizationId', placeholderKey: 'providers.umbrella.organizationIdPlaceholder' },
    ],
  },
  cloudflare: {
    labelKey: 'providers.cloudflare.label',
    helpTextKey: 'providers.cloudflare.helpText',
    apiKey: { labelKey: 'fields.apiToken', placeholderKey: 'providers.cloudflare.apiTokenPlaceholder' },
    configFields: [
      { key: 'accountId', labelKey: 'fields.accountId', placeholderKey: 'providers.cloudflare.accountIdPlaceholder' },
    ],
  },
  dnsfilter: {
    labelKey: 'providers.dnsfilter.label',
    helpTextKey: 'providers.dnsfilter.helpText',
    apiKey: { labelKey: 'fields.apiKey', placeholderKey: 'providers.dnsfilter.apiKeyPlaceholder' },
    configFields: [
      { key: 'accountId', labelKey: 'fields.accountIdOptional', placeholderKey: 'providers.dnsfilter.accountIdPlaceholder' },
    ],
  },
  pihole: {
    labelKey: 'providers.pihole.label',
    helpTextKey: 'providers.pihole.helpText',
    apiKey: { labelKey: 'fields.apiKey', placeholderKey: 'providers.pihole.apiKeyPlaceholder' },
    configFields: [
      { key: 'apiEndpoint', labelKey: 'fields.apiEndpoint', placeholderKey: 'providers.pihole.apiEndpointPlaceholder', type: 'url' },
    ],
  },
  adguard_home: {
    labelKey: 'providers.adguardHome.label',
    helpTextKey: 'providers.adguardHome.helpText',
    apiKey: { labelKey: 'fields.httpBasicUsername', placeholderKey: 'providers.adguardHome.usernamePlaceholder' },
    apiSecret: { labelKey: 'fields.httpBasicPassword', placeholderKey: 'providers.adguardHome.passwordPlaceholder' },
    configFields: [
      { key: 'apiEndpoint', labelKey: 'fields.apiEndpoint', placeholderKey: 'providers.adguardHome.apiEndpointPlaceholder', type: 'url' },
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
  const { t } = useTranslation('security');
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
        errorFallback: t('dnsSecurityAddDnsIntegrationModal.messages.createFailed'),
        successMessage: t('dnsSecurityAddDnsIntegrationModal.messages.createSuccess', {
          provider: t(/* i18n-dynamic */ `dnsSecurityAddDnsIntegrationModal.${spec.labelKey}`),
          name,
        }),
        onUnauthorized: () => void navigateTo('/login', { replace: true }),
      });
      onCreated();
      onClose();
    } catch (err) {
      if (err instanceof ActionError) {
        if (err.status === 401) return;
        setError(err.message);
      } else {
        setError(err instanceof Error ? err.message : t('dnsSecurityAddDnsIntegrationModal.messages.networkError'));
      }
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog
      open
      onClose={onClose}
      title={t('dnsSecurityAddDnsIntegrationModal.title')}
      maxWidth="lg"
      className="p-6 max-h-[90vh] overflow-y-auto"
    >
      <div className="relative">
        <h2 className="text-lg font-semibold">{t('dnsSecurityAddDnsIntegrationModal.title')}</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          {t('dnsSecurityAddDnsIntegrationModal.description')}
        </p>

        <form onSubmit={handleSubmit} className="mt-4 space-y-4">
          <Field label={t('dnsSecurityAddDnsIntegrationModal.fields.provider')}>
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
                        {t(/* i18n-dynamic */ `dnsSecurityAddDnsIntegrationModal.${p.labelKey}`)}
                      </option>
                    ),
                  )}
                </select>
                <p className="mt-1 text-xs text-muted-foreground">
                  {t(/* i18n-dynamic */ `dnsSecurityAddDnsIntegrationModal.${spec.helpTextKey}`)}
                </p>
              </>
            )}
          </Field>

          <Field label={t('dnsSecurityAddDnsIntegrationModal.fields.displayName')}>
            {(id) => (
              <input
                id={id}
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                maxLength={200}
                required
                placeholder={t('dnsSecurityAddDnsIntegrationModal.placeholders.displayName')}
                className="h-9 w-full rounded-md border bg-background px-2 text-sm"
              />
            )}
          </Field>

          <Field label={t('dnsSecurityAddDnsIntegrationModal.fields.descriptionOptional')}>
            {(id) => (
              <textarea
                id={id}
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                maxLength={2000}
                rows={2}
                placeholder={t('dnsSecurityAddDnsIntegrationModal.placeholders.description')}
                className="w-full rounded-md border bg-background px-2 py-1.5 text-sm"
              />
            )}
          </Field>

          <Field label={t(/* i18n-dynamic */ `dnsSecurityAddDnsIntegrationModal.${spec.apiKey.labelKey}`)}>
            {(id) => (
              <input
                id={id}
                type="text"
                autoComplete="off"
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                required
                placeholder={t(/* i18n-dynamic */ `dnsSecurityAddDnsIntegrationModal.${spec.apiKey.placeholderKey}`)}
                className="h-9 w-full rounded-md border bg-background px-2 text-sm font-mono"
              />
            )}
          </Field>

          {spec.apiSecret && (
            <Field label={t(/* i18n-dynamic */ `dnsSecurityAddDnsIntegrationModal.${spec.apiSecret.labelKey}`)}>
              {(id) => (
                <input
                  id={id}
                  type="password"
                  autoComplete="new-password"
                  value={apiSecret}
                  onChange={(e) => setApiSecret(e.target.value)}
                  required
                  placeholder={t(/* i18n-dynamic */ `dnsSecurityAddDnsIntegrationModal.${spec.apiSecret!.placeholderKey}`)}
                  className="h-9 w-full rounded-md border bg-background px-2 text-sm font-mono"
                />
              )}
            </Field>
          )}

          {spec.configFields?.map((field) => (
            <Field key={field.key} label={t(/* i18n-dynamic */ `dnsSecurityAddDnsIntegrationModal.${field.labelKey}`)}>
              {(id) => (
                <input
                  id={id}
                  type={field.type ?? 'text'}
                  value={config[field.key] ?? ''}
                  onChange={(e) => updateConfig(field.key, e.target.value)}
                  placeholder={t(/* i18n-dynamic */ `dnsSecurityAddDnsIntegrationModal.${field.placeholderKey}`)}
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
              {t('dnsSecurityAddDnsIntegrationModal.actions.cancel')}
            </button>
            <button
              type="submit"
              disabled={submitting || !name.trim() || !apiKey.trim()}
              className="inline-flex items-center gap-2 rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
            >
              {submitting
                ? t('dnsSecurityAddDnsIntegrationModal.actions.adding')
                : t('dnsSecurityAddDnsIntegrationModal.actions.addIntegration')}
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
