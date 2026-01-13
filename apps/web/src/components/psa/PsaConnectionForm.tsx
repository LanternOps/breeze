import { useMemo, useState } from 'react';
import { useForm, useWatch } from 'react-hook-form';
import { z } from 'zod';
import { zodResolver } from '@hookform/resolvers/zod';
import { providerMeta, type PsaProvider } from './PsaConnectionList';

const psaConnectionSchema = z.object({
  name: z.string().min(1, 'Connection name is required'),
  provider: z.enum(['jira', 'servicenow', 'connectwise', 'autotask', 'freshservice', 'zendesk']),
  baseUrl: z.string().url('Must be a valid URL').optional().or(z.literal('')),
  defaultQueue: z.string().optional(),
  username: z.string().optional(),
  password: z.string().optional(),
  apiToken: z.string().optional(),
  clientId: z.string().optional(),
  clientSecret: z.string().optional(),
  syncEnabled: z.boolean(),
  syncInterval: z.enum(['15m', '30m', '1h', '6h', '24h']),
  syncDirection: z.enum(['inbound', 'outbound', 'bidirectional']),
  syncOnClose: z.boolean(),
  includeNotes: z.boolean()
});

export type PsaConnectionFormValues = z.infer<typeof psaConnectionSchema>;

type PsaConnectionFormProps = {
  onSubmit?: (values: PsaConnectionFormValues) => void | Promise<void>;
  onCancel?: () => void;
  onTestConnection?: () => void;
  defaultValues?: Partial<PsaConnectionFormValues>;
  submitLabel?: string;
  loading?: boolean;
  testingConnection?: boolean;
  isEditing?: boolean;
  hasCredentials?: {
    password?: boolean;
    apiToken?: boolean;
    clientSecret?: boolean;
  };
};

const providerDescriptions: Record<PsaProvider, { hint: string; urlPlaceholder: string }> = {
  jira: {
    hint: 'Use an Atlassian API token and your Jira account email for authentication.',
    urlPlaceholder: 'https://your-domain.atlassian.net'
  },
  servicenow: {
    hint: 'Use a ServiceNow user with REST API permissions.',
    urlPlaceholder: 'https://instance.service-now.com'
  },
  connectwise: {
    hint: 'Use your ConnectWise Manage credentials or API keys.',
    urlPlaceholder: 'https://api-na.myconnectwise.net'
  },
  autotask: {
    hint: 'Use your Autotask API user credentials.',
    urlPlaceholder: 'https://webservices.autotask.net/atservices/1.6/atws.asmx'
  },
  freshservice: {
    hint: 'Use your Freshservice API key or OAuth credentials.',
    urlPlaceholder: 'https://your-domain.freshservice.com'
  },
  zendesk: {
    hint: 'Use an API token or OAuth client credentials.',
    urlPlaceholder: 'https://your-domain.zendesk.com'
  }
};

const syncIntervalLabels: Record<PsaConnectionFormValues['syncInterval'], string> = {
  '15m': 'Every 15 minutes',
  '30m': 'Every 30 minutes',
  '1h': 'Every hour',
  '6h': 'Every 6 hours',
  '24h': 'Daily'
};

const syncDirectionLabels: Record<PsaConnectionFormValues['syncDirection'], string> = {
  inbound: 'PSA → Breeze',
  outbound: 'Breeze → PSA',
  bidirectional: 'Bidirectional'
};

export default function PsaConnectionForm({
  onSubmit,
  onCancel,
  onTestConnection,
  defaultValues,
  submitLabel = 'Save connection',
  loading,
  testingConnection,
  isEditing,
  hasCredentials
}: PsaConnectionFormProps) {
  const [showPassword, setShowPassword] = useState(false);
  const [showApiToken, setShowApiToken] = useState(false);
  const [showClientSecret, setShowClientSecret] = useState(false);

  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
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

  return (
    <form
      onSubmit={handleSubmit(async values => {
        await onSubmit?.(values);
      })}
      className="space-y-6 rounded-lg border bg-card p-6 shadow-sm"
    >
      <div className="space-y-4">
        <h3 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
          Basic Information
        </h3>
        <div className="grid gap-6 md:grid-cols-2">
          <div className="space-y-2">
            <label htmlFor="connection-name" className="text-sm font-medium">
              Connection name
            </label>
            <input
              id="connection-name"
              placeholder="e.g., Jira Production"
              className="h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
              {...register('name')}
            />
            {errors.name && <p className="text-sm text-destructive">{errors.name.message}</p>}
          </div>

          <div className="space-y-2">
            <label htmlFor="connection-provider" className="text-sm font-medium">
              Provider
            </label>
            <select
              id="connection-provider"
              className="h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
              {...register('provider')}
            >
              {Object.entries(providerMeta).map(([value, meta]) => (
                <option key={value} value={value}>
                  {meta.label}
                </option>
              ))}
            </select>
            <p className="text-xs text-muted-foreground">{credentialHint.hint}</p>
          </div>
        </div>
      </div>

      <div className="space-y-4 border-t pt-6">
        <h3 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
          Connection Details
        </h3>
        <div className="grid gap-6 md:grid-cols-2">
          <div className="space-y-2 md:col-span-2">
            <label htmlFor="connection-url" className="text-sm font-medium">
              Instance URL
            </label>
            <input
              id="connection-url"
              type="url"
              placeholder={credentialHint.urlPlaceholder}
              className="h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
              {...register('baseUrl')}
            />
            {errors.baseUrl && <p className="text-sm text-destructive">{errors.baseUrl.message}</p>}
          </div>

          <div className="space-y-2 md:col-span-2">
            <label htmlFor="connection-default-queue" className="text-sm font-medium">
              Default project or queue
            </label>
            <input
              id="connection-default-queue"
              placeholder="e.g., IT Support"
              className="h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
              {...register('defaultQueue')}
            />
            <p className="text-xs text-muted-foreground">
              Optional. Used when creating tickets from Breeze alerts.
            </p>
          </div>
        </div>
      </div>

      <div className="space-y-4 border-t pt-6">
        <h3 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
          Credentials
        </h3>
        <div className="grid gap-6 md:grid-cols-2">
          <div className="space-y-2">
            <label htmlFor="connection-username" className="text-sm font-medium">
              Username or email
            </label>
            <input
              id="connection-username"
              placeholder="admin@example.com"
              className="h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
              {...register('username')}
            />
          </div>

          <div className="space-y-2">
            <label htmlFor="connection-password" className="text-sm font-medium">
              Password
              {isEditing && hasCredentials?.password && (
                <span className="ml-2 text-xs text-muted-foreground">(leave blank to keep existing)</span>
              )}
            </label>
            <div className="relative">
              <input
                id="connection-password"
                type={showPassword ? 'text' : 'password'}
                placeholder={isEditing && hasCredentials?.password ? '********' : 'password'}
                className="h-10 w-full rounded-md border bg-background px-3 pr-10 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                {...register('password')}
              />
              <button
                type="button"
                onClick={() => setShowPassword(!showPassword)}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
              >
                {showPassword ? (
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
          </div>

          <div className="space-y-2">
            <label htmlFor="connection-api-token" className="text-sm font-medium">
              API token or key
              {isEditing && hasCredentials?.apiToken && (
                <span className="ml-2 text-xs text-muted-foreground">(leave blank to keep existing)</span>
              )}
            </label>
            <div className="relative">
              <input
                id="connection-api-token"
                type={showApiToken ? 'text' : 'password'}
                placeholder={isEditing && hasCredentials?.apiToken ? '********' : 'api-token'}
                className="h-10 w-full rounded-md border bg-background px-3 pr-10 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                {...register('apiToken')}
              />
              <button
                type="button"
                onClick={() => setShowApiToken(!showApiToken)}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
              >
                {showApiToken ? (
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
          </div>

          <div className="space-y-2">
            <label htmlFor="connection-client-id" className="text-sm font-medium">
              Client ID
            </label>
            <input
              id="connection-client-id"
              placeholder="oauth-client-id"
              className="h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
              {...register('clientId')}
            />
          </div>

          <div className="space-y-2">
            <label htmlFor="connection-client-secret" className="text-sm font-medium">
              Client Secret
              {isEditing && hasCredentials?.clientSecret && (
                <span className="ml-2 text-xs text-muted-foreground">(leave blank to keep existing)</span>
              )}
            </label>
            <div className="relative">
              <input
                id="connection-client-secret"
                type={showClientSecret ? 'text' : 'password'}
                placeholder={isEditing && hasCredentials?.clientSecret ? '********' : 'client-secret'}
                className="h-10 w-full rounded-md border bg-background px-3 pr-10 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                {...register('clientSecret')}
              />
              <button
                type="button"
                onClick={() => setShowClientSecret(!showClientSecret)}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
              >
                {showClientSecret ? (
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
          </div>
        </div>
      </div>

      <div className="space-y-4 border-t pt-6">
        <h3 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
          Sync Settings
        </h3>
        <div className="space-y-4">
          <label className="flex items-start gap-3">
            <input
              type="checkbox"
              className="mt-1 h-4 w-4 rounded border-gray-300 text-primary focus:ring-primary"
              {...register('syncEnabled')}
            />
            <div>
              <span className="text-sm font-medium">Enable sync</span>
              <p className="text-xs text-muted-foreground">
                Keep tickets and alert links up to date on a schedule.
              </p>
            </div>
          </label>

          <div className="grid gap-6 md:grid-cols-2">
            <div className="space-y-2">
              <label htmlFor="sync-interval" className="text-sm font-medium">
                Sync interval
              </label>
              <select
                id="sync-interval"
                className="h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                disabled={!syncEnabled}
                {...register('syncInterval')}
              >
                {Object.entries(syncIntervalLabels).map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
            </div>

            <div className="space-y-2">
              <label htmlFor="sync-direction" className="text-sm font-medium">
                Sync direction
              </label>
              <select
                id="sync-direction"
                className="h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                disabled={!syncEnabled}
                {...register('syncDirection')}
              >
                {Object.entries(syncDirectionLabels).map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div className="grid gap-4 md:grid-cols-2">
            <label className="flex items-start gap-3">
              <input
                type="checkbox"
                className="mt-1 h-4 w-4 rounded border-gray-300 text-primary focus:ring-primary"
                disabled={!syncEnabled}
                {...register('syncOnClose')}
              />
              <div>
                <span className="text-sm font-medium">Auto-close PSA tickets</span>
                <p className="text-xs text-muted-foreground">
                  Close linked tickets when Breeze alerts are resolved.
                </p>
              </div>
            </label>

            <label className="flex items-start gap-3">
              <input
                type="checkbox"
                className="mt-1 h-4 w-4 rounded border-gray-300 text-primary focus:ring-primary"
                disabled={!syncEnabled}
                {...register('includeNotes')}
              />
              <div>
                <span className="text-sm font-medium">Sync alert notes</span>
                <p className="text-xs text-muted-foreground">
                  Push Breeze comments and updates to the PSA ticket timeline.
                </p>
              </div>
            </label>
          </div>
        </div>
      </div>

      <div className="flex flex-col gap-3 border-t pt-6 sm:flex-row sm:justify-between">
        <button
          type="button"
          onClick={onTestConnection}
          disabled={testingConnection}
          className="flex h-11 w-full items-center justify-center gap-2 rounded-md border bg-background text-sm font-medium text-foreground transition hover:bg-muted disabled:cursor-not-allowed disabled:opacity-60 sm:w-auto sm:px-6"
        >
          {testingConnection ? (
            <>
              <div className="h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent" />
              Testing...
            </>
          ) : (
            <>
              <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
              Test connection
            </>
          )}
        </button>

        <div className="flex flex-col gap-3 sm:flex-row">
          <button
            type="button"
            onClick={onCancel}
            className="h-11 w-full rounded-md border bg-background text-sm font-medium text-foreground transition hover:bg-muted sm:w-auto sm:px-6"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={isLoading}
            className="flex h-11 w-full items-center justify-center rounded-md bg-primary text-sm font-medium text-primary-foreground transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60 sm:w-auto sm:px-6"
          >
            {isLoading ? 'Saving...' : submitLabel}
          </button>
        </div>
      </div>
    </form>
  );
}
