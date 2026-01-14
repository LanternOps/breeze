import { useMemo } from 'react';
import { useForm, useFieldArray } from 'react-hook-form';
import { z } from 'zod';
import { zodResolver } from '@hookform/resolvers/zod';
import { Plus, Trash2, Sparkles } from 'lucide-react';
import { cn } from '@/lib/utils';

const webhookSchema = z
  .object({
    name: z.string().min(1, 'Webhook name is required'),
    url: z.string().url('Invalid URL').min(1, 'URL is required'),
    events: z.array(z.string()).min(1, 'Select at least one event'),
    authType: z.enum(['hmac', 'bearer']),
    secret: z.string().optional(),
    bearerToken: z.string().optional(),
    payloadTemplate: z.string().optional(),
    enabled: z.boolean().optional(),
    headers: z
      .array(
        z.object({
          key: z.string().min(1, 'Header key is required'),
          value: z.string().optional()
        })
      )
      .optional()
  })
  .superRefine((values, ctx) => {
    if (values.authType === 'hmac' && !values.secret?.trim()) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Secret is required for HMAC authentication',
        path: ['secret']
      });
    }

    if (values.authType === 'bearer' && !values.bearerToken?.trim()) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Token is required for bearer authentication',
        path: ['bearerToken']
      });
    }

    if (values.payloadTemplate?.trim()) {
      try {
        JSON.parse(values.payloadTemplate);
      } catch {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'Payload template must be valid JSON',
          path: ['payloadTemplate']
        });
      }
    }
  });

export type WebhookFormValues = z.infer<typeof webhookSchema>;

type WebhookFormProps = {
  onSubmit?: (values: WebhookFormValues) => void | Promise<void>;
  onCancel?: () => void;
  defaultValues?: Partial<WebhookFormValues>;
  submitLabel?: string;
  loading?: boolean;
};

export const webhookEventOptions = [
  { value: 'device.online', label: 'Device Online', description: 'Triggered when a device connects.' },
  { value: 'device.offline', label: 'Device Offline', description: 'Triggered when a device disconnects.' },
  { value: 'alert.created', label: 'Alert Created', description: 'Triggered when an alert is created.' },
  { value: 'alert.resolved', label: 'Alert Resolved', description: 'Triggered when an alert is resolved.' },
  { value: 'script.completed', label: 'Script Completed', description: 'Triggered when a script finishes.' },
  { value: 'ticket.created', label: 'Ticket Created', description: 'Triggered when a ticket is created.' }
];

const generateSecret = (length = 32) => {
  const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  const randomValues = new Uint32Array(length);
  if (typeof window !== 'undefined' && window.crypto?.getRandomValues) {
    window.crypto.getRandomValues(randomValues);
  } else {
    for (let i = 0; i < length; i += 1) {
      randomValues[i] = Math.floor(Math.random() * chars.length);
    }
  }
  return Array.from(randomValues, value => chars[value % chars.length]).join('');
};

export default function WebhookForm({
  onSubmit,
  onCancel,
  defaultValues,
  submitLabel = 'Save webhook',
  loading
}: WebhookFormProps) {
  const {
    register,
    handleSubmit,
    control,
    setValue,
    setFocus,
    watch,
    formState: { errors, isSubmitting }
  } = useForm<WebhookFormValues>({
    resolver: zodResolver(webhookSchema),
    defaultValues: {
      name: '',
      url: '',
      events: [],
      authType: 'hmac',
      secret: '',
      bearerToken: '',
      payloadTemplate: '',
      enabled: true,
      headers: [],
      ...defaultValues
    }
  });

  const { fields, append, remove } = useFieldArray({
    control,
    name: 'headers'
  });

  const isLoading = useMemo(() => loading ?? isSubmitting, [loading, isSubmitting]);
  const authType = watch('authType');
  const payloadTemplate = watch('payloadTemplate') ?? '';
  const enabled = watch('enabled') ?? true;

  const payloadPreview = useMemo(() => {
    if (!payloadTemplate.trim()) {
      return { preview: '', error: '' };
    }
    try {
      return {
        preview: JSON.stringify(JSON.parse(payloadTemplate), null, 2),
        error: ''
      };
    } catch {
      return { preview: payloadTemplate, error: 'Invalid JSON in template.' };
    }
  }, [payloadTemplate]);

  const handleGenerateSecret = () => {
    const secret = generateSecret();
    setValue('secret', secret, { shouldDirty: true, shouldValidate: true });
    setFocus('secret');
  };

  const handleGenerateToken = () => {
    const token = generateSecret();
    setValue('bearerToken', token, { shouldDirty: true, shouldValidate: true });
    setFocus('bearerToken');
  };

  const handleToggleEnabled = () => {
    setValue('enabled', !enabled, { shouldDirty: true, shouldValidate: false });
  };

  return (
    <form
      onSubmit={handleSubmit(async values => {
        await onSubmit?.(values);
      })}
      className="space-y-6 rounded-lg border bg-card p-6 shadow-sm"
    >
      <input type="hidden" {...register('enabled')} />
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold">Webhook configuration</h2>
          <p className="text-sm text-muted-foreground">Set delivery, authentication, and payload behavior.</p>
        </div>
        <button
          type="button"
          onClick={handleToggleEnabled}
          className={cn(
            'inline-flex items-center gap-2 rounded-full border px-3 py-1 text-xs font-semibold transition',
            enabled
              ? 'border-emerald-200 bg-emerald-50 text-emerald-700'
              : 'border-slate-200 bg-slate-50 text-slate-600'
          )}
        >
          <span className={cn('h-2 w-2 rounded-full', enabled ? 'bg-emerald-500' : 'bg-slate-400')} />
          {enabled ? 'Enabled' : 'Disabled'}
        </button>
      </div>

      <div className="grid gap-6 md:grid-cols-2">
        <div className="space-y-2">
          <label htmlFor="webhook-name" className="text-sm font-medium">
            Webhook name
          </label>
          <input
            id="webhook-name"
            placeholder="Production Webhook"
            className="h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
            {...register('name')}
          />
          {errors.name && <p className="text-sm text-destructive">{errors.name.message}</p>}
        </div>

        <div className="space-y-2">
          <label htmlFor="webhook-url" className="text-sm font-medium">
            Endpoint URL
          </label>
          <input
            id="webhook-url"
            placeholder="https://api.example.com/webhooks"
            className="h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
            {...register('url')}
          />
          {errors.url && <p className="text-sm text-destructive">{errors.url.message}</p>}
        </div>
      </div>

      <div className="space-y-2">
        <label className="text-sm font-medium">Events</label>
        <div className="grid gap-3 sm:grid-cols-2">
          {webhookEventOptions.map(option => (
            <label
              key={option.value}
              className={cn(
                'flex items-start gap-3 rounded-md border p-3 transition',
                'hover:bg-muted/40'
              )}
            >
              <input
                type="checkbox"
                value={option.value}
                className="mt-1 h-4 w-4 rounded border-gray-300"
                {...register('events')}
              />
              <div>
                <p className="text-sm font-medium">{option.label}</p>
                <p className="text-xs text-muted-foreground">{option.description}</p>
              </div>
            </label>
          ))}
        </div>
        {errors.events && <p className="text-sm text-destructive">{errors.events.message}</p>}
      </div>

      <div className="space-y-3 rounded-md border bg-muted/20 p-4">
        <div>
          <h3 className="text-sm font-semibold">Authentication</h3>
          <p className="text-xs text-muted-foreground">
            Choose how your destination verifies webhook authenticity.
          </p>
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="flex items-start gap-3 rounded-md border bg-background p-3 text-sm">
            <input
              type="radio"
              value="hmac"
              className="mt-1 h-4 w-4"
              {...register('authType')}
            />
            <div>
              <p className="text-sm font-medium">HMAC signature</p>
              <p className="text-xs text-muted-foreground">Sign requests with a shared secret.</p>
            </div>
          </label>
          <label className="flex items-start gap-3 rounded-md border bg-background p-3 text-sm">
            <input
              type="radio"
              value="bearer"
              className="mt-1 h-4 w-4"
              {...register('authType')}
            />
            <div>
              <p className="text-sm font-medium">Bearer token</p>
              <p className="text-xs text-muted-foreground">Send a static token in the header.</p>
            </div>
          </label>
        </div>
        {authType === 'hmac' ? (
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <label htmlFor="webhook-secret" className="text-sm font-medium">
                Signing secret
              </label>
              <button
                type="button"
                onClick={handleGenerateSecret}
                className="inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline"
              >
                <Sparkles className="h-3 w-3" />
                Auto-generate
              </button>
            </div>
            <input
              id="webhook-secret"
              type="text"
              placeholder="Enter a signing secret"
              className="h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
              {...register('secret')}
            />
            {errors.secret && <p className="text-sm text-destructive">{errors.secret.message}</p>}
            <p className="text-xs text-muted-foreground">
              Use this secret to verify webhook signatures.
            </p>
          </div>
        ) : (
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <label htmlFor="webhook-token" className="text-sm font-medium">
                Bearer token
              </label>
              <button
                type="button"
                onClick={handleGenerateToken}
                className="inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline"
              >
                <Sparkles className="h-3 w-3" />
                Auto-generate
              </button>
            </div>
            <input
              id="webhook-token"
              type="text"
              placeholder="Enter a bearer token"
              className="h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
              {...register('bearerToken')}
            />
            {errors.bearerToken && (
              <p className="text-sm text-destructive">{errors.bearerToken.message}</p>
            )}
            <p className="text-xs text-muted-foreground">
              This token is sent as an Authorization header.
            </p>
          </div>
        )}
      </div>

      <div className="space-y-3 rounded-md border bg-muted/20 p-4">
        <div>
          <h3 className="text-sm font-semibold">Payload template</h3>
          <p className="text-xs text-muted-foreground">
            Define the JSON payload shape sent to your destination.
          </p>
        </div>
        <div className="grid gap-4 lg:grid-cols-2">
          <div className="space-y-2">
            <label htmlFor="payload-template" className="text-sm font-medium">
              Template (JSON)
            </label>
            <textarea
              id="payload-template"
              rows={8}
              placeholder='{"event":"device.online","device":{"id":"{{device.id}}"}}'
              className="w-full rounded-md border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
              {...register('payloadTemplate')}
            />
            {errors.payloadTemplate && (
              <p className="text-sm text-destructive">{errors.payloadTemplate.message}</p>
            )}
          </div>
          <div className="space-y-2">
            <label className="text-sm font-medium">JSON preview</label>
            <div className="rounded-md border bg-background p-3 text-xs text-muted-foreground">
              {payloadPreview.preview ? (
                <pre className="max-h-56 overflow-auto">{payloadPreview.preview}</pre>
              ) : (
                <p className="text-xs text-muted-foreground">Preview appears once JSON is valid.</p>
              )}
            </div>
            {!errors.payloadTemplate && payloadPreview.error && (
              <p className="text-xs text-destructive">{payloadPreview.error}</p>
            )}
          </div>
        </div>
      </div>

      <div className="space-y-3 rounded-md border bg-muted/20 p-4">
        <div className="flex items-center justify-between">
          <div>
            <h3 className="text-sm font-semibold">Custom Headers</h3>
            <p className="text-xs text-muted-foreground">Optional headers sent with each request.</p>
          </div>
          <button
            type="button"
            onClick={() => append({ key: '', value: '' })}
            className="inline-flex items-center gap-1 rounded-md border px-3 py-1.5 text-sm font-medium hover:bg-muted"
          >
            <Plus className="h-4 w-4" />
            Add Header
          </button>
        </div>

        {fields.length === 0 ? (
          <p className="text-xs text-muted-foreground">No custom headers configured.</p>
        ) : (
          <div className="space-y-2">
            {fields.map((field, index) => (
              <div key={field.id} className="flex items-center gap-2">
                <input
                  placeholder="Header key"
                  className="h-9 flex-1 rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                  {...register(`headers.${index}.key`)}
                />
                <input
                  placeholder="Header value"
                  className="h-9 flex-1 rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                  {...register(`headers.${index}.value`)}
                />
                <button
                  type="button"
                  onClick={() => remove(index)}
                  className="flex h-9 w-9 items-center justify-center rounded-md hover:bg-muted text-destructive"
                >
                  <Trash2 className="h-4 w-4" />
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

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
