import { useMemo, useState } from 'react';
import { useForm, useWatch } from 'react-hook-form';
import { z } from 'zod';
import { zodResolver } from '@hookform/resolvers/zod';
import { psaProviderIdSchema } from '@breeze/shared';
import { providerMeta, type PsaProvider } from './PsaConnectionList';
import { useTranslation } from 'react-i18next';

const createPsaConnectionSchema = (t: (key: string) => string) => z.object({
  name: z.string().min(1, t('longTail.psa.PsaConnectionForm.validation.nameRequired')),
  // Single-source provider list — @breeze/shared PSA_PROVIDERS.
  provider: psaProviderIdSchema,
  baseUrl: z.string().url(t('longTail.psa.PsaConnectionForm.validation.validUrl')).optional().or(z.literal('')),
  defaultQueue: z.string().optional(),
  // Every credential key any adapter reads. Which ones are RENDERED is decided
  // per provider by PROVIDER_CREDENTIAL_FIELDS below; they are all optional
  // here because the server is the authority on per-provider requirements
  // (apps/api/src/services/psa/credentials.ts).
  username: z.string().optional(),
  password: z.string().optional(),
  apiToken: z.string().optional(),
  clientId: z.string().optional(),
  clientSecret: z.string().optional(),
  email: z.string().optional(),
  companyId: z.string().optional(),
  publicKey: z.string().optional(),
  privateKey: z.string().optional(),
  integrationCode: z.string().optional(),
  secret: z.string().optional(),
  apiKey: z.string().optional(),
  personalAccessToken: z.string().optional(),
  syncEnabled: z.boolean(),
  syncInterval: z.enum(['15m', '30m', '1h', '6h', '24h']),
  syncDirection: z.enum(['inbound', 'outbound', 'bidirectional']),
  syncOnClose: z.boolean(),
  includeNotes: z.boolean()
});

export type PsaConnectionFormValues = z.infer<ReturnType<typeof createPsaConnectionSchema>>;

/** Credential keys, i.e. everything in the form that lands in `credentials`. */
export type PsaCredentialField =
  | 'username'
  | 'password'
  | 'apiToken'
  | 'clientId'
  | 'clientSecret'
  | 'email'
  | 'companyId'
  | 'publicKey'
  | 'privateKey'
  | 'integrationCode'
  | 'secret'
  | 'apiKey'
  | 'personalAccessToken';

type CredentialFieldDescriptor = {
  name: PsaCredentialField;
  /** Masked with a reveal toggle, and shown as "keep existing" when stored. */
  secret?: boolean;
};

/**
 * What each provider's adapter ACTUALLY reads, mirroring
 * REQUIRED_CREDENTIAL_KEYS in apps/api/src/services/psa/credentials.ts.
 *
 * The form used to offer one generic set (baseUrl/username/password/apiToken/
 * clientId/clientSecret) for every provider, so ConnectWise and Autotask
 * connections could not be created at all — their required keys (companyId /
 * publicKey / privateKey, integrationCode / secret) had no input, and every
 * Test returned 400 (#3291 review).
 *
 * Typed as a total Record over the shared PsaProviderId union, so adding a
 * provider to @breeze/shared PSA_PROVIDERS fails this file to compile until
 * its fields are declared. `baseUrl` is rendered separately (Instance URL).
 */
const PROVIDER_CREDENTIAL_FIELDS: Record<PsaProvider, readonly CredentialFieldDescriptor[]> = {
  jira: [
    { name: 'email' },
    { name: 'apiToken', secret: true },
    { name: 'username' },
    { name: 'password', secret: true },
    { name: 'personalAccessToken', secret: true }
  ],
  servicenow: [
    { name: 'username' },
    { name: 'password', secret: true }
  ],
  connectwise: [
    { name: 'companyId' },
    { name: 'publicKey' },
    { name: 'privateKey', secret: true },
    { name: 'clientId' }
  ],
  autotask: [
    { name: 'username' },
    { name: 'secret', secret: true },
    { name: 'integrationCode', secret: true }
  ],
  freshservice: [
    { name: 'apiKey', secret: true }
  ],
  zendesk: [
    { name: 'email' },
    { name: 'apiToken', secret: true }
  ]
};

type PsaConnectionFormProps = {
  onSubmit?: (values: PsaConnectionFormValues) => void | Promise<void>;
  onCancel?: () => void;
  onTestConnection?: () => void;
  defaultValues?: Partial<PsaConnectionFormValues>;
  submitLabel?: string;
  loading?: boolean;
  testingConnection?: boolean;
  isEditing?: boolean;
  /** Per-field presence of the STORED secrets (server: `credentialFields`). */
  credentialFields?: Partial<Record<PsaCredentialField, boolean>>;
};

const providerDescriptions: Record<PsaProvider, {
  hintKey: string;
  urlPlaceholder: string;
  /** Extra note above the credential inputs, for providers with alternatives. */
  credentialsNoteKey?: string;
}> = {
  jira: {
    hintKey: 'longTail.psa.PsaConnectionForm.providerHints.jira',
    urlPlaceholder: 'https://your-domain.atlassian.net',
    // Jira accepts three mutually exclusive auth modes; the server derives
    // which one is in use from the fields actually filled in.
    credentialsNoteKey: 'longTail.psa.PsaConnectionForm.credentialsNote.jira'
  },
  servicenow: {
    hintKey: 'longTail.psa.PsaConnectionForm.providerHints.servicenow',
    urlPlaceholder: 'https://instance.service-now.com'
  },
  connectwise: {
    hintKey: 'longTail.psa.PsaConnectionForm.providerHints.connectwise',
    urlPlaceholder: 'https://api-na.myconnectwise.net'
  },
  autotask: {
    hintKey: 'longTail.psa.PsaConnectionForm.providerHints.autotask',
    urlPlaceholder: 'https://webservices.autotask.net/atservices/1.6/atws.asmx'
  },
  freshservice: {
    hintKey: 'longTail.psa.PsaConnectionForm.providerHints.freshservice',
    urlPlaceholder: 'https://your-domain.freshservice.com'
  },
  zendesk: {
    hintKey: 'longTail.psa.PsaConnectionForm.providerHints.zendesk',
    urlPlaceholder: 'https://your-domain.zendesk.com'
  }
};

const syncIntervalLabelKeys: Record<PsaConnectionFormValues['syncInterval'], string> = {
  '15m': 'longTail.psa.PsaConnectionForm.syncIntervals.every15Minutes',
  '30m': 'longTail.psa.PsaConnectionForm.syncIntervals.every30Minutes',
  '1h': 'longTail.psa.PsaConnectionForm.syncIntervals.everyHour',
  '6h': 'longTail.psa.PsaConnectionForm.syncIntervals.every6Hours',
  '24h': 'longTail.psa.PsaConnectionForm.syncIntervals.daily'
};

const syncDirectionLabelKeys: Record<PsaConnectionFormValues['syncDirection'], string> = {
  inbound: 'longTail.psa.PsaConnectionForm.syncDirections.inbound',
  outbound: 'longTail.psa.PsaConnectionForm.syncDirections.outbound',
  bidirectional: 'longTail.psa.PsaConnectionForm.syncDirections.bidirectional'
};

export default function PsaConnectionForm({
  onSubmit,
  onCancel,
  onTestConnection,
  defaultValues,
  submitLabel,
  loading,
  testingConnection,
  isEditing,
  credentialFields
}: PsaConnectionFormProps) {
  const { t } = useTranslation('common');
  const resolvedSubmitLabel = submitLabel ?? t('longTail.psa.PsaConnectionForm.defaultSubmitLabel');
  const psaConnectionSchema = useMemo(() => createPsaConnectionSchema(t), [t]);
  const [revealed, setRevealed] = useState<Partial<Record<PsaCredentialField, boolean>>>({});

  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting, dirtyFields },
    control
  } = useForm<PsaConnectionFormValues>({
    resolver: zodResolver(psaConnectionSchema),
    defaultValues: {
      name: '',
      provider: 'jira',
      baseUrl: '',
      defaultQueue: '',
      username: '',
      password: '',
      apiToken: '',
      clientId: '',
      clientSecret: '',
      email: '',
      companyId: '',
      publicKey: '',
      privateKey: '',
      integrationCode: '',
      secret: '',
      apiKey: '',
      personalAccessToken: '',
      syncEnabled: true,
      syncInterval: '1h',
      syncDirection: 'bidirectional',
      syncOnClose: true,
      includeNotes: true,
      ...defaultValues
    }
  });

  const selectedProvider = useWatch({ control, name: 'provider' });
  const syncEnabled = useWatch({ control, name: 'syncEnabled' });
  const isLoading = useMemo(() => loading ?? isSubmitting, [loading, isSubmitting]);

  const credentialHint = providerDescriptions[selectedProvider];
  const credentialInputs = PROVIDER_CREDENTIAL_FIELDS[selectedProvider];

  // Test posts to the server, which tests the STORED credentials — so a green
  // result would vouch for credentials the user is about to overwrite. Block it
  // while any credential input (baseUrl included) has unsaved edits (#3291).
  const credentialsDirty =
    Boolean(dirtyFields.baseUrl) ||
    credentialInputs.some((field) => Boolean(dirtyFields[field.name]));

  return (
    <form
      onSubmit={handleSubmit(async values => {
        await onSubmit?.(values);
      })}
      className="space-y-6 rounded-lg border bg-card p-6 shadow-xs"
    >
      <div className="space-y-4">
        <h3 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
          {t('longTail.psa.PsaConnectionForm.sections.basicInformation')}
        </h3>
        <div className="grid gap-6 md:grid-cols-2">
          <div className="space-y-2">
            <label htmlFor="connection-name" className="text-sm font-medium">
              {t('longTail.psa.PsaConnectionForm.fields.connectionName')}
            </label>
            <input
              id="connection-name"
              placeholder={t('longTail.psa.PsaConnectionForm.placeholders.connectionName')}
              className="h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
              {...register('name')}
            />
            {errors.name && <p className="text-sm text-destructive">{errors.name.message}</p>}
          </div>

          <div className="space-y-2">
            <label htmlFor="connection-provider" className="text-sm font-medium">
              {t('longTail.psa.PsaConnectionForm.fields.provider')}
            </label>
            <select
              id="connection-provider"
              className="h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
              {...register('provider')}
            >
              {Object.entries(providerMeta).map(([value, meta]) => (
                <option key={value} value={value}>
                  {meta.label}
                </option>
              ))}
            </select>
            <p className="text-xs text-muted-foreground">{t(/* i18n-dynamic */ credentialHint.hintKey)}</p>
          </div>
        </div>
      </div>

      <div className="space-y-4 border-t pt-6">
        <h3 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
          {t('longTail.psa.PsaConnectionForm.sections.connectionDetails')}
        </h3>
        <div className="grid gap-6 md:grid-cols-2">
          <div className="space-y-2 md:col-span-2">
            <label htmlFor="connection-url" className="text-sm font-medium">
              {t('longTail.psa.PsaConnectionForm.fields.instanceUrl')}
            </label>
            <input
              id="connection-url"
              type="url"
              placeholder={credentialHint.urlPlaceholder}
              className="h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
              {...register('baseUrl')}
            />
            {errors.baseUrl && <p className="text-sm text-destructive">{errors.baseUrl.message}</p>}
          </div>

          <div className="space-y-2 md:col-span-2">
            <label htmlFor="connection-default-queue" className="text-sm font-medium">
              {t('longTail.psa.PsaConnectionForm.fields.defaultQueue')}
            </label>
            <input
              id="connection-default-queue"
              placeholder={t('longTail.psa.PsaConnectionForm.placeholders.defaultQueue')}
              className="h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
              {...register('defaultQueue')}
            />
            <p className="text-xs text-muted-foreground">
              {t('longTail.psa.PsaConnectionForm.help.defaultQueue')}
            </p>
          </div>
        </div>
      </div>

      <div className="space-y-4 border-t pt-6">
        <h3 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
          {t('longTail.psa.PsaConnectionForm.sections.credentials')}
        </h3>
        {credentialHint.credentialsNoteKey && (
          <p className="text-xs text-muted-foreground">
            {t(/* i18n-dynamic */ credentialHint.credentialsNoteKey)}
          </p>
        )}
        <div className="grid gap-6 md:grid-cols-2">
          {credentialInputs.map((field) => {
            const stored = Boolean(isEditing && credentialFields?.[field.name]);
            const inputId = `connection-${field.name}`;
            // Template-literal form on purpose: the i18n keyUsage guard checks
            // that the static prefix names a real, non-empty group in the en
            // catalog, which a precomputed identifier would skip entirely.
            const label = t(/* i18n-dynamic */ `longTail.psa.PsaConnectionForm.fields.${field.name}`);
            const placeholder = stored
              ? t('longTail.psa.PsaConnectionForm.placeholders.existingCredential')
              : t(/* i18n-dynamic */ `longTail.psa.PsaConnectionForm.placeholders.${field.name}`);

            return (
              <div key={field.name} className="space-y-2">
                <label htmlFor={inputId} className="text-sm font-medium">
                  {label}
                  {stored && (
                    <span className="ml-2 text-xs text-muted-foreground">
                      {t('longTail.psa.PsaConnectionForm.keepExisting')}
                    </span>
                  )}
                </label>
                {field.secret ? (
                  <div className="relative">
                    <input
                      id={inputId}
                      data-testid={`psa-credential-${field.name}`}
                      type={revealed[field.name] ? 'text' : 'password'}
                      placeholder={placeholder}
                      className="h-10 w-full rounded-md border bg-background px-3 pr-10 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
                      {...register(field.name)}
                    />
                    <button
                      type="button"
                      aria-label={t('longTail.psa.PsaConnectionForm.actions.toggleVisibility')}
                      onClick={() => setRevealed((prev) => ({ ...prev, [field.name]: !prev[field.name] }))}
                      className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                    >
                      {revealed[field.name] ? (
                        <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13.875 18.825A10.05 10.05 0 0112 19c-4.478 0-8.268-2.943-9.543-7a9.97 9.97 0 011.563-3.029m5.858.908a3 3 0 114.243 4.243M9.878 9.878l4.242 4.242M9.88 9.88l-3.29-3.29m7.532 7.532l3.29 3.29M3 3l3.59 3.59m0 0A9.953 9.953 0 0112 5c4.478 0 8.268 2.943 9.543 7a10.025 10.025 0 01-4.132 5.411m0 0L21 21" />
                        </svg>
                      ) : (
                        <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
                        </svg>
                      )}
                    </button>
                  </div>
                ) : (
                  <input
                    id={inputId}
                    data-testid={`psa-credential-${field.name}`}
                    placeholder={placeholder}
                    className="h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
                    {...register(field.name)}
                  />
                )}
              </div>
            );
          })}
        </div>
      </div>

      <div className="space-y-4 border-t pt-6">
        <h3 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
          {t('longTail.psa.PsaConnectionForm.sections.syncSettings')}
        </h3>
        <div className="space-y-4">
          <label className="flex items-start gap-3">
            <input
              type="checkbox"
              className="mt-1 h-4 w-4 rounded border-border text-primary focus:ring-primary"
              {...register('syncEnabled')}
            />
            <div>
              <span className="text-sm font-medium">{t('longTail.psa.PsaConnectionForm.sync.enable')}</span>
              <p className="text-xs text-muted-foreground">
                {t('longTail.psa.PsaConnectionForm.sync.enableHelp')}
              </p>
            </div>
          </label>

          <div className="grid gap-6 md:grid-cols-2">
            <div className="space-y-2">
              <label htmlFor="sync-interval" className="text-sm font-medium">
                {t('longTail.psa.PsaConnectionForm.fields.syncInterval')}
              </label>
              <select
                id="sync-interval"
                className="h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
                disabled={!syncEnabled}
                {...register('syncInterval')}
              >
                {Object.entries(syncIntervalLabelKeys).map(([value, labelKey]) => (
                  <option key={value} value={value}>
                    {t(/* i18n-dynamic */ labelKey)}
                  </option>
                ))}
              </select>
            </div>

            <div className="space-y-2">
              <label htmlFor="sync-direction" className="text-sm font-medium">
                {t('longTail.psa.PsaConnectionForm.fields.syncDirection')}
              </label>
              <select
                id="sync-direction"
                className="h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
                disabled={!syncEnabled}
                {...register('syncDirection')}
              >
                {Object.entries(syncDirectionLabelKeys).map(([value, labelKey]) => (
                  <option key={value} value={value}>
                    {t(/* i18n-dynamic */ labelKey)}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div className="grid gap-4 md:grid-cols-2">
            <label className="flex items-start gap-3">
              <input
                type="checkbox"
                className="mt-1 h-4 w-4 rounded border-border text-primary focus:ring-primary"
                disabled={!syncEnabled}
                {...register('syncOnClose')}
              />
              <div>
                <span className="text-sm font-medium">{t('longTail.psa.PsaConnectionForm.sync.autoClose')}</span>
                <p className="text-xs text-muted-foreground">
                  {t('longTail.psa.PsaConnectionForm.sync.autoCloseHelp')}
                </p>
              </div>
            </label>

            <label className="flex items-start gap-3">
              <input
                type="checkbox"
                className="mt-1 h-4 w-4 rounded border-border text-primary focus:ring-primary"
                disabled={!syncEnabled}
                {...register('includeNotes')}
              />
              <div>
                <span className="text-sm font-medium">{t('longTail.psa.PsaConnectionForm.sync.notes')}</span>
                <p className="text-xs text-muted-foreground">
                  {t('longTail.psa.PsaConnectionForm.sync.notesHelp')}
                </p>
              </div>
            </label>
          </div>
        </div>
      </div>

      <div className="flex flex-col gap-3 border-t pt-6 sm:flex-row sm:justify-between">
        <div className="flex flex-col gap-1">
        <button
          type="button"
          data-testid="psa-test-connection"
          onClick={onTestConnection}
          disabled={testingConnection || credentialsDirty}
          title={credentialsDirty ? t('longTail.psa.PsaConnectionForm.testDirtyHint') : undefined}
          className="flex h-11 w-full items-center justify-center gap-2 rounded-md border bg-background text-sm font-medium text-foreground transition hover:bg-muted disabled:cursor-not-allowed disabled:opacity-60 sm:w-auto sm:px-6"
        >
          {testingConnection ? (
            <>
              <div className="h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent" />
              {t('longTail.psa.PsaConnectionForm.actions.testing')}
            </>
          ) : (
            <>
              <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
              {t('longTail.psa.PsaConnectionForm.actions.testConnection')}
            </>
          )}
        </button>
          {credentialsDirty && (
            <p data-testid="psa-test-dirty-hint" className="text-xs text-muted-foreground">
              {t('longTail.psa.PsaConnectionForm.testDirtyHint')}
            </p>
          )}
        </div>

        <div className="flex flex-col gap-3 sm:flex-row">
          <button
            type="button"
            onClick={onCancel}
            className="h-11 w-full rounded-md border bg-background text-sm font-medium text-foreground transition hover:bg-muted sm:w-auto sm:px-6"
          >
            {t('common:actions.cancel')}
          </button>
          <button
            type="submit"
            disabled={isLoading}
            className="flex h-11 w-full items-center justify-center rounded-md bg-primary text-sm font-medium text-primary-foreground transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60 sm:w-auto sm:px-6"
          >
            {isLoading ? t('common:states.saving') : resolvedSubmitLabel}
          </button>
        </div>
      </div>
    </form>
  );
}
