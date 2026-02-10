import { useMemo } from 'react';
import { useForm, useFieldArray, Controller } from 'react-hook-form';
import { z } from 'zod';
import { zodResolver } from '@hookform/resolvers/zod';
import { Plus, Trash2, Mail, MessageSquare, Bell, Webhook, Phone } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { NotificationChannelType } from './NotificationChannelList';

const E164_PHONE_REGEX = /^\+[1-9]\d{1,14}$/;

const emailConfigSchema = z.object({
  recipients: z.array(z.string().email('Invalid email address')).min(1, 'At least one recipient is required')
});

const slackConfigSchema = z.object({
  webhookUrl: z.string().url('Invalid URL').min(1, 'Webhook URL is required'),
  channel: z.string().optional()
});

const teamsConfigSchema = z.object({
  webhookUrl: z.string().url('Invalid URL').min(1, 'Webhook URL is required')
});

const pagerdutyConfigSchema = z.object({
  integrationKey: z.string().min(1, 'Integration key is required'),
  severity: z.enum(['critical', 'error', 'warning', 'info']).optional()
});

const webhookConfigSchema = z.object({
  url: z.string().url('Invalid URL').min(1, 'URL is required'),
  method: z.enum(['POST', 'PUT', 'PATCH']).optional(),
  headers: z.array(z.object({
    key: z.string().min(1, 'Header key is required'),
    value: z.string()
  })).optional(),
  authType: z.enum(['none', 'basic', 'bearer']).optional(),
  authUsername: z.string().optional(),
  authPassword: z.string().optional(),
  authToken: z.string().optional()
});

const smsConfigSchema = z.object({
  phoneNumbers: z.array(z.string().min(1, 'Phone number is required')).min(1, 'At least one phone number is required')
});

const notificationChannelSchema = z.object({
  name: z.string().min(1, 'Channel name is required'),
  type: z.enum(['email', 'slack', 'teams', 'pagerduty', 'webhook', 'sms']),
  enabled: z.boolean(),
  // Config fields (validated conditionally based on type)
  emailRecipients: z.array(z.object({ value: z.string() })).optional(),
  slackWebhookUrl: z.string().optional(),
  slackChannel: z.string().optional(),
  teamsWebhookUrl: z.string().optional(),
  pagerdutyIntegrationKey: z.string().optional(),
  pagerdutySeverity: z.enum(['critical', 'error', 'warning', 'info']).optional(),
  webhookUrl: z.string().optional(),
  webhookMethod: z.enum(['POST', 'PUT', 'PATCH']).optional(),
  webhookHeaders: z.array(z.object({ key: z.string(), value: z.string() })).optional(),
  webhookAuthType: z.enum(['none', 'basic', 'bearer']).optional(),
  webhookAuthUsername: z.string().optional(),
  webhookAuthPassword: z.string().optional(),
  webhookAuthToken: z.string().optional(),
  smsPhoneNumbers: z.array(z.object({ value: z.string().trim() })).optional(),
  smsFrom: z.string().optional(),
  smsMessagingServiceSid: z.string().optional()
}).superRefine((data, ctx) => {
  if (data.type !== 'sms') {
    return;
  }

  const phoneNumbers = (data.smsPhoneNumbers || [])
    .map((entry) => entry.value.trim())
    .filter(Boolean);

  if (phoneNumbers.length === 0) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['smsPhoneNumbers'],
      message: 'At least one phone number is required'
    });
    return;
  }

  let hasInvalidPhoneNumber = false;
  for (const [index, phoneNumber] of phoneNumbers.entries()) {
    if (!E164_PHONE_REGEX.test(phoneNumber)) {
      hasInvalidPhoneNumber = true;
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['smsPhoneNumbers', index, 'value'],
        message: 'Phone number must be in E.164 format (e.g. +1234567890)'
      });
    }
  }

  if (hasInvalidPhoneNumber) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['smsPhoneNumbers'],
      message: 'All SMS phone numbers must use E.164 format (e.g. +1234567890)'
    });
  }

  const smsFrom = data.smsFrom?.trim();
  if (smsFrom && !E164_PHONE_REGEX.test(smsFrom)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['smsFrom'],
      message: 'From number must be in E.164 format (e.g. +1234567890)'
    });
  }
});

export type NotificationChannelFormValues = z.infer<typeof notificationChannelSchema>;

type NotificationChannelFormProps = {
  onSubmit?: (values: NotificationChannelFormValues) => void | Promise<void>;
  onCancel?: () => void;
  defaultValues?: Partial<NotificationChannelFormValues>;
  submitLabel?: string;
  loading?: boolean;
};

const channelTypeOptions: { value: NotificationChannelType; label: string; icon: typeof Mail; description: string }[] = [
  { value: 'email', label: 'Email', icon: Mail, description: 'Send alerts via email' },
  { value: 'slack', label: 'Slack', icon: MessageSquare, description: 'Post alerts to Slack channel' },
  { value: 'teams', label: 'Microsoft Teams', icon: MessageSquare, description: 'Post alerts to Teams channel' },
  { value: 'pagerduty', label: 'PagerDuty', icon: Bell, description: 'Create PagerDuty incidents' },
  { value: 'webhook', label: 'Webhook', icon: Webhook, description: 'Send to custom HTTP endpoint' },
  { value: 'sms', label: 'SMS', icon: Phone, description: 'Send SMS notifications' }
];

export default function NotificationChannelForm({
  onSubmit,
  onCancel,
  defaultValues,
  submitLabel = 'Save channel',
  loading
}: NotificationChannelFormProps) {
  const {
    register,
    handleSubmit,
    control,
    watch,
    formState: { errors, isSubmitting }
  } = useForm<NotificationChannelFormValues>({
    resolver: zodResolver(notificationChannelSchema),
    defaultValues: {
      name: '',
      type: 'email',
      enabled: true,
      emailRecipients: [{ value: '' }],
      slackWebhookUrl: '',
      slackChannel: '',
      teamsWebhookUrl: '',
      pagerdutyIntegrationKey: '',
      pagerdutySeverity: 'error',
      webhookUrl: '',
      webhookMethod: 'POST',
      webhookHeaders: [],
      webhookAuthType: 'none',
      webhookAuthUsername: '',
      webhookAuthPassword: '',
      webhookAuthToken: '',
      smsPhoneNumbers: [{ value: '' }],
      smsFrom: '',
      smsMessagingServiceSid: '',
      ...defaultValues
    }
  });

  const {
    fields: emailFields,
    append: appendEmail,
    remove: removeEmail
  } = useFieldArray({
    control,
    name: 'emailRecipients'
  });

  const {
    fields: headerFields,
    append: appendHeader,
    remove: removeHeader
  } = useFieldArray({
    control,
    name: 'webhookHeaders'
  });

  const {
    fields: smsFields,
    append: appendSms,
    remove: removeSms
  } = useFieldArray({
    control,
    name: 'smsPhoneNumbers'
  });

  const watchType = watch('type');
  const watchAuthType = watch('webhookAuthType');

  const isLoading = useMemo(() => loading ?? isSubmitting, [loading, isSubmitting]);

  return (
    <form
      onSubmit={handleSubmit(async values => {
        await onSubmit?.(values);
      })}
      className="space-y-6 rounded-lg border bg-card p-6 shadow-sm"
    >
      {/* Basic Information */}
      <div className="grid gap-6 md:grid-cols-2">
        <div className="space-y-2">
          <label htmlFor="channel-name" className="text-sm font-medium">
            Channel name
          </label>
          <input
            id="channel-name"
            placeholder="Production Alerts"
            className="h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
            {...register('name')}
          />
          {errors.name && <p className="text-sm text-destructive">{errors.name.message}</p>}
        </div>

        <div className="space-y-2">
          <label className="text-sm font-medium">Enabled</label>
          <Controller
            name="enabled"
            control={control}
            render={({ field }) => (
              <label className="flex items-center gap-2 h-10 cursor-pointer">
                <input
                  type="checkbox"
                  checked={field.value}
                  onChange={e => field.onChange(e.target.checked)}
                  className="h-4 w-4 rounded border-gray-300"
                />
                <span className="text-sm">Enable this notification channel</span>
              </label>
            )}
          />
        </div>
      </div>

      {/* Channel Type Selection */}
      <div className="space-y-2">
        <label className="text-sm font-medium">Channel Type</label>
        <Controller
          name="type"
          control={control}
          render={({ field }) => (
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {channelTypeOptions.map(opt => {
                const Icon = opt.icon;
                return (
                  <button
                    key={opt.value}
                    type="button"
                    onClick={() => field.onChange(opt.value)}
                    className={cn(
                      'flex items-start gap-3 rounded-lg border p-4 text-left transition',
                      field.value === opt.value
                        ? 'border-primary bg-primary/5'
                        : 'border-input hover:bg-muted'
                    )}
                  >
                    <div
                      className={cn(
                        'flex h-10 w-10 items-center justify-center rounded-lg',
                        field.value === opt.value ? 'bg-primary/20' : 'bg-muted'
                      )}
                    >
                      <Icon className="h-5 w-5" />
                    </div>
                    <div>
                      <p className="text-sm font-medium">{opt.label}</p>
                      <p className="text-xs text-muted-foreground">{opt.description}</p>
                    </div>
                  </button>
                );
              })}
            </div>
          )}
        />
      </div>

      {/* Email Configuration */}
      {watchType === 'email' && (
        <div className="rounded-md border bg-muted/20 p-4">
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-sm font-semibold">Email Configuration</h3>
            <button
              type="button"
              onClick={() => appendEmail({ value: '' })}
              className="inline-flex items-center gap-1 rounded-md border px-3 py-1.5 text-sm font-medium hover:bg-muted"
            >
              <Plus className="h-4 w-4" />
              Add Recipient
            </button>
          </div>
          <div className="space-y-3">
            {emailFields.map((field, index) => (
              <div key={field.id} className="flex items-center gap-2">
                <input
                  placeholder="email@example.com"
                  className="h-10 flex-1 rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                  {...register(`emailRecipients.${index}.value`)}
                />
                {emailFields.length > 1 && (
                  <button
                    type="button"
                    onClick={() => removeEmail(index)}
                    className="flex h-10 w-10 items-center justify-center rounded-md hover:bg-muted text-destructive"
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Slack Configuration */}
      {watchType === 'slack' && (
        <div className="rounded-md border bg-muted/20 p-4">
          <h3 className="text-sm font-semibold mb-4">Slack Configuration</h3>
          <div className="space-y-4">
            <div className="space-y-2">
              <label htmlFor="slack-webhook" className="text-sm font-medium">
                Webhook URL
              </label>
              <input
                id="slack-webhook"
                placeholder="https://hooks.slack.com/services/..."
                className="h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                {...register('slackWebhookUrl')}
              />
              <p className="text-xs text-muted-foreground">
                Create a Slack Incoming Webhook and paste the URL here
              </p>
            </div>
            <div className="space-y-2">
              <label htmlFor="slack-channel" className="text-sm font-medium">
                Channel (optional)
              </label>
              <input
                id="slack-channel"
                placeholder="#alerts"
                className="h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                {...register('slackChannel')}
              />
              <p className="text-xs text-muted-foreground">
                Override the default channel configured in the webhook
              </p>
            </div>
          </div>
        </div>
      )}

      {/* Teams Configuration */}
      {watchType === 'teams' && (
        <div className="rounded-md border bg-muted/20 p-4">
          <h3 className="text-sm font-semibold mb-4">Microsoft Teams Configuration</h3>
          <div className="space-y-2">
            <label htmlFor="teams-webhook" className="text-sm font-medium">
              Webhook URL
            </label>
            <input
              id="teams-webhook"
              placeholder="https://outlook.office.com/webhook/..."
              className="h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
              {...register('teamsWebhookUrl')}
            />
            <p className="text-xs text-muted-foreground">
              Create an Incoming Webhook connector in your Teams channel
            </p>
          </div>
        </div>
      )}

      {/* PagerDuty Configuration */}
      {watchType === 'pagerduty' && (
        <div className="rounded-md border bg-muted/20 p-4">
          <h3 className="text-sm font-semibold mb-4">PagerDuty Configuration</h3>
          <div className="space-y-4">
            <div className="space-y-2">
              <label htmlFor="pagerduty-key" className="text-sm font-medium">
                Integration Key
              </label>
              <input
                id="pagerduty-key"
                type="password"
                placeholder="Enter your PagerDuty integration key"
                className="h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                {...register('pagerdutyIntegrationKey')}
              />
              <p className="text-xs text-muted-foreground">
                Find this in your PagerDuty service's Integrations tab
              </p>
            </div>
            <div className="space-y-2">
              <label htmlFor="pagerduty-severity" className="text-sm font-medium">
                Default Severity
              </label>
              <select
                id="pagerduty-severity"
                className="h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                {...register('pagerdutySeverity')}
              >
                <option value="critical">Critical</option>
                <option value="error">Error</option>
                <option value="warning">Warning</option>
                <option value="info">Info</option>
              </select>
            </div>
          </div>
        </div>
      )}

      {/* Webhook Configuration */}
      {watchType === 'webhook' && (
        <div className="rounded-md border bg-muted/20 p-4">
          <h3 className="text-sm font-semibold mb-4">Webhook Configuration</h3>
          <div className="space-y-4">
            <div className="grid gap-4 sm:grid-cols-3">
              <div className="space-y-2 sm:col-span-2">
                <label htmlFor="webhook-url" className="text-sm font-medium">
                  URL
                </label>
                <input
                  id="webhook-url"
                  placeholder="https://api.example.com/alerts"
                  className="h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                  {...register('webhookUrl')}
                />
              </div>
              <div className="space-y-2">
                <label htmlFor="webhook-method" className="text-sm font-medium">
                  Method
                </label>
                <select
                  id="webhook-method"
                  className="h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                  {...register('webhookMethod')}
                >
                  <option value="POST">POST</option>
                  <option value="PUT">PUT</option>
                  <option value="PATCH">PATCH</option>
                </select>
              </div>
            </div>

            {/* Headers */}
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <label className="text-sm font-medium">Headers</label>
                <button
                  type="button"
                  onClick={() => appendHeader({ key: '', value: '' })}
                  className="inline-flex items-center gap-1 text-xs text-primary hover:underline"
                >
                  <Plus className="h-3 w-3" />
                  Add Header
                </button>
              </div>
              {headerFields.length > 0 ? (
                <div className="space-y-2">
                  {headerFields.map((field, index) => (
                    <div key={field.id} className="flex items-center gap-2">
                      <input
                        placeholder="Header key"
                        className="h-9 flex-1 rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                        {...register(`webhookHeaders.${index}.key`)}
                      />
                      <input
                        placeholder="Header value"
                        className="h-9 flex-1 rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                        {...register(`webhookHeaders.${index}.value`)}
                      />
                      <button
                        type="button"
                        onClick={() => removeHeader(index)}
                        className="flex h-9 w-9 items-center justify-center rounded-md hover:bg-muted text-destructive"
                      >
                        <Trash2 className="h-4 w-4" />
                      </button>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="text-xs text-muted-foreground">No custom headers configured</p>
              )}
            </div>

            {/* Authentication */}
            <div className="space-y-2">
              <label className="text-sm font-medium">Authentication</label>
              <select
                className="h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                {...register('webhookAuthType')}
              >
                <option value="none">No Authentication</option>
                <option value="basic">Basic Auth</option>
                <option value="bearer">Bearer Token</option>
              </select>
            </div>

            {watchAuthType === 'basic' && (
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-2">
                  <label htmlFor="webhook-username" className="text-sm font-medium">
                    Username
                  </label>
                  <input
                    id="webhook-username"
                    className="h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                    {...register('webhookAuthUsername')}
                  />
                </div>
                <div className="space-y-2">
                  <label htmlFor="webhook-password" className="text-sm font-medium">
                    Password
                  </label>
                  <input
                    id="webhook-password"
                    type="password"
                    className="h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                    {...register('webhookAuthPassword')}
                  />
                </div>
              </div>
            )}

            {watchAuthType === 'bearer' && (
              <div className="space-y-2">
                <label htmlFor="webhook-token" className="text-sm font-medium">
                  Bearer Token
                </label>
                <input
                  id="webhook-token"
                  type="password"
                  className="h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                  {...register('webhookAuthToken')}
                />
              </div>
            )}
          </div>
        </div>
      )}

      {/* SMS Configuration */}
      {watchType === 'sms' && (
        <div className="rounded-md border bg-muted/20 p-4">
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-sm font-semibold">SMS Configuration</h3>
            <button
              type="button"
              onClick={() => appendSms({ value: '' })}
              className="inline-flex items-center gap-1 rounded-md border px-3 py-1.5 text-sm font-medium hover:bg-muted"
            >
              <Plus className="h-4 w-4" />
              Add Number
            </button>
          </div>
          <div className="space-y-3">
            {smsFields.map((field, index) => (
              <div key={field.id} className="flex items-center gap-2">
                <input
                  placeholder="+1234567890"
                  className="h-10 flex-1 rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                  {...register(`smsPhoneNumbers.${index}.value`)}
                />
                {smsFields.length > 1 && (
                  <button
                    type="button"
                    onClick={() => removeSms(index)}
                    className="flex h-10 w-10 items-center justify-center rounded-md hover:bg-muted text-destructive"
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                )}
              </div>
            ))}
          </div>
          <p className="mt-2 text-xs text-muted-foreground">
            Enter phone numbers in international format (e.g., +1234567890)
          </p>
          <div className="mt-4 grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <label htmlFor="sms-from" className="text-sm font-medium">
                Twilio From Number (optional)
              </label>
              <input
                id="sms-from"
                placeholder="+1234567890"
                className="h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                {...register('smsFrom')}
              />
              <p className="text-xs text-muted-foreground">
                Optional override for sender number when not using a messaging service
              </p>
              {errors.smsFrom && <p className="text-sm text-destructive">{errors.smsFrom.message}</p>}
            </div>
            <div className="space-y-2">
              <label htmlFor="sms-messaging-service" className="text-sm font-medium">
                Twilio Messaging Service SID (optional)
              </label>
              <input
                id="sms-messaging-service"
                placeholder="MGXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX"
                className="h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                {...register('smsMessagingServiceSid')}
              />
              <p className="text-xs text-muted-foreground">
                Optional override for Twilio messaging service per channel
              </p>
            </div>
          </div>
          {errors.smsPhoneNumbers?.message && (
            <p className="mt-2 text-sm text-destructive">{errors.smsPhoneNumbers.message}</p>
          )}
        </div>
      )}

      {/* Form Actions */}
      <div className="flex flex-col gap-3 sm:flex-row sm:justify-end">
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
    </form>
  );
}
