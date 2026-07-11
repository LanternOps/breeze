import { useMemo } from 'react';
import { useForm, useFieldArray } from 'react-hook-form';
import { z } from 'zod';
import { zodResolver } from '@hookform/resolvers/zod';
import { Plus, Trash2, Sparkles } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useTranslation } from 'react-i18next';

const createWebhookSchema = (t: (key: string) => string) => z
  .object({
    name: z.string().min(1, t('longTail.webhooks.WebhookForm.validation.nameRequired')),
    url: z.string().url(t('longTail.webhooks.WebhookForm.validation.invalidUrl')).min(1, t('longTail.webhooks.WebhookForm.validation.urlRequired')),
    events: z.array(z.string()).min(1, t('longTail.webhooks.WebhookForm.validation.eventRequired')),
    authType: z.enum(['hmac', 'bearer']),
    secret: z.string().optional(),
    bearerToken: z.string().optional(),
    payloadTemplate: z.string().optional(),
    enabled: z.boolean().optional(),
    headers: z
      .array(
        z.object({
          key: z.string().min(1, t('longTail.webhooks.WebhookForm.validation.headerKeyRequired')),
          value: z.string().optional()
        })
      )
      .optional()
  })
  .superRefine((values, ctx) => {
    if (values.authType === 'hmac' && !values.secret?.trim()) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: t('longTail.webhooks.WebhookForm.validation.secretRequired'),
        path: ['secret']
      });
    }

    if (values.authType === 'bearer' && !values.bearerToken?.trim()) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: t('longTail.webhooks.WebhookForm.validation.tokenRequired'),
        path: ['bearerToken']
      });
    }

    if (values.payloadTemplate?.trim()) {
      try {
        JSON.parse(values.payloadTemplate);
      } catch {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: t('longTail.webhooks.WebhookForm.validation.payloadJsonRequired'),
          path: ['payloadTemplate']
        });
      }
    }
  });

export type WebhookFormValues = z.infer<ReturnType<typeof createWebhookSchema>>;

type WebhookFormProps = {
  onSubmit?: (values: WebhookFormValues) => void | Promise<void>;
  onCancel?: () => void;
  defaultValues?: Partial<WebhookFormValues>;
  submitLabel?: string;
  loading?: boolean;
};

export const webhookEventOptions = [
  { value: 'device.online', label: 'Device Online', labelKey: 'longTail.webhooks.WebhookForm.events.deviceOnline.label', description: 'Triggered when a device connects.', descriptionKey: 'longTail.webhooks.WebhookForm.events.deviceOnline.description' },
  { value: 'device.offline', label: 'Device Offline', labelKey: 'longTail.webhooks.WebhookForm.events.deviceOffline.label', description: 'Triggered when a device disconnects.', descriptionKey: 'longTail.webhooks.WebhookForm.events.deviceOffline.description' },
  { value: 'alert.created', label: 'Alert Created', labelKey: 'longTail.webhooks.WebhookForm.events.alertCreated.label', description: 'Triggered when an alert is created.', descriptionKey: 'longTail.webhooks.WebhookForm.events.alertCreated.description' },
  { value: 'alert.resolved', label: 'Alert Resolved', labelKey: 'longTail.webhooks.WebhookForm.events.alertResolved.label', description: 'Triggered when an alert is resolved.', descriptionKey: 'longTail.webhooks.WebhookForm.events.alertResolved.description' },
  { value: 'script.completed', label: 'Script Completed', labelKey: 'longTail.webhooks.WebhookForm.events.scriptCompleted.label', description: 'Triggered when a script finishes.', descriptionKey: 'longTail.webhooks.WebhookForm.events.scriptCompleted.description' },
  { value: 'ticket.created', label: 'Ticket Created', labelKey: 'longTail.webhooks.WebhookForm.events.ticketCreated.label', description: 'Triggered when a ticket is created.', descriptionKey: 'longTail.webhooks.WebhookForm.events.ticketCreated.description' }
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
  submitLabel,
  loading
}: WebhookFormProps) {
  const { t } = useTranslation('common');
  const resolvedSubmitLabel = submitLabel ?? t('longTail.webhooks.WebhookForm.defaultSubmitLabel');
  const webhookSchema = useMemo(() => createWebhookSchema(t), [t]);
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
      return { preview: payloadTemplate, error: t('longTail.webhooks.WebhookForm.invalidJsonPreview') };
    }
  }, [payloadTemplate, t]);

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
      className="space-y-6 rounded-lg border bg-card p-6 shadow-xs"
    >
      <input type="hidden" {...register('enabled')} />
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold">{t('longTail.webhooks.WebhookForm.title')}</h2>
          <p className="text-sm text-muted-foreground">{t('longTail.webhooks.WebhookForm.subtitle')}</p>
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
          {enabled ? t('common:states.enabled') : t('common:states.disabled')}
        </button>
      </div>

      <div className="grid gap-6 md:grid-cols-2">
        <div className="space-y-2">
          <label htmlFor="webhook-name" className="text-sm font-medium">
            {t('longTail.webhooks.WebhookForm.fields.name')}
          </label>
          <input
            id="webhook-name"
            placeholder={t('longTail.webhooks.WebhookForm.placeholders.name')}
            className="h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
            {...register('name')}
          />
          {errors.name && <p className="text-sm text-destructive">{errors.name.message}</p>}
        </div>

        <div className="space-y-2">
          <label htmlFor="webhook-url" className="text-sm font-medium">
            {t('longTail.webhooks.WebhookForm.fields.endpointUrl')}
          </label>
          <input
            id="webhook-url"
            placeholder={t('longTail.webhooks.WebhookForm.placeholders.endpointUrl')}
            className="h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
            {...register('url')}
          />
          {errors.url && <p className="text-sm text-destructive">{errors.url.message}</p>}
        </div>
      </div>

      <div className="space-y-2">
        <label className="text-sm font-medium">{t('longTail.webhooks.WebhookForm.fields.events')}</label>
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
                className="mt-1 h-4 w-4 rounded border-border"
                {...register('events')}
              />
              <div>
                <p className="text-sm font-medium">{t(option.labelKey)}</p>
                <p className="text-xs text-muted-foreground">{t(option.descriptionKey)}</p>
              </div>
            </label>
          ))}
        </div>
        {errors.events && <p className="text-sm text-destructive">{errors.events.message}</p>}
      </div>

      <div className="space-y-3 rounded-md border bg-muted/20 p-4">
        <div>
          <h3 className="text-sm font-semibold">{t('longTail.webhooks.WebhookForm.authentication.title')}</h3>
          <p className="text-xs text-muted-foreground">
            {t('longTail.webhooks.WebhookForm.authentication.subtitle')}
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
              <p className="text-sm font-medium">{t('longTail.webhooks.WebhookForm.authentication.hmac.title')}</p>
              <p className="text-xs text-muted-foreground">{t('longTail.webhooks.WebhookForm.authentication.hmac.description')}</p>
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
              <p className="text-sm font-medium">{t('longTail.webhooks.WebhookForm.authentication.bearer.title')}</p>
              <p className="text-xs text-muted-foreground">{t('longTail.webhooks.WebhookForm.authentication.bearer.description')}</p>
            </div>
          </label>
        </div>
        {authType === 'hmac' ? (
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <label htmlFor="webhook-secret" className="text-sm font-medium">
                {t('longTail.webhooks.WebhookForm.fields.signingSecret')}
              </label>
              <button
                type="button"
                onClick={handleGenerateSecret}
                className="inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline"
              >
                <Sparkles className="h-3 w-3" />
                {t('longTail.webhooks.WebhookForm.actions.autoGenerate')}
              </button>
            </div>
            <input
              id="webhook-secret"
              type="text"
              placeholder={t('longTail.webhooks.WebhookForm.placeholders.signingSecret')}
              className="h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
              {...register('secret')}
            />
            {errors.secret && <p className="text-sm text-destructive">{errors.secret.message}</p>}
            <p className="text-xs text-muted-foreground">
              {t('longTail.webhooks.WebhookForm.help.signingSecret')}
            </p>
          </div>
        ) : (
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <label htmlFor="webhook-token" className="text-sm font-medium">
                {t('longTail.webhooks.WebhookForm.fields.bearerToken')}
              </label>
              <button
                type="button"
                onClick={handleGenerateToken}
                className="inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline"
              >
                <Sparkles className="h-3 w-3" />
                {t('longTail.webhooks.WebhookForm.actions.autoGenerate')}
              </button>
            </div>
            <input
              id="webhook-token"
              type="text"
              placeholder={t('longTail.webhooks.WebhookForm.placeholders.bearerToken')}
              className="h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
              {...register('bearerToken')}
            />
            {errors.bearerToken && (
              <p className="text-sm text-destructive">{errors.bearerToken.message}</p>
            )}
            <p className="text-xs text-muted-foreground">
              {t('longTail.webhooks.WebhookForm.help.bearerToken')}
            </p>
          </div>
        )}
      </div>

      <div className="space-y-3 rounded-md border bg-muted/20 p-4">
        <div>
          <h3 className="text-sm font-semibold">{t('longTail.webhooks.WebhookForm.payload.title')}</h3>
          <p className="text-xs text-muted-foreground">
            {t('longTail.webhooks.WebhookForm.payload.subtitle')}
          </p>
        </div>
        <div className="grid gap-4 lg:grid-cols-2">
          <div className="space-y-2">
            <label htmlFor="payload-template" className="text-sm font-medium">
              {t('longTail.webhooks.WebhookForm.fields.templateJson')}
            </label>
            <textarea
              id="payload-template"
              rows={8}
              placeholder='{"event":"device.online","device":{"id":"{{device.id}}"}}'
              className="w-full rounded-md border bg-background px-3 py-2 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
              {...register('payloadTemplate')}
            />
            {errors.payloadTemplate && (
              <p className="text-sm text-destructive">{errors.payloadTemplate.message}</p>
            )}
          </div>
          <div className="space-y-2">
            <label className="text-sm font-medium">{t('longTail.webhooks.WebhookForm.fields.jsonPreview')}</label>
            <div className="rounded-md border bg-background p-3 text-xs text-muted-foreground">
              {payloadPreview.preview ? (
                <pre className="max-h-56 overflow-auto">{payloadPreview.preview}</pre>
              ) : (
                <p className="text-xs text-muted-foreground">{t('longTail.webhooks.WebhookForm.payload.previewEmpty')}</p>
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
            <h3 className="text-sm font-semibold">{t('longTail.webhooks.WebhookForm.headers.title')}</h3>
            <p className="text-xs text-muted-foreground">{t('longTail.webhooks.WebhookForm.headers.subtitle')}</p>
          </div>
          <button
            type="button"
            onClick={() => append({ key: '', value: '' })}
            className="inline-flex items-center gap-1 rounded-md border px-3 py-1.5 text-sm font-medium hover:bg-muted"
          >
            <Plus className="h-4 w-4" />
            {t('longTail.webhooks.WebhookForm.actions.addHeader')}
          </button>
        </div>

        {fields.length === 0 ? (
          <p className="text-xs text-muted-foreground">{t('longTail.webhooks.WebhookForm.headers.empty')}</p>
        ) : (
          <div className="space-y-2">
            {fields.map((field, index) => (
              <div key={field.id} className="flex items-center gap-2">
                <input
                  placeholder={t('longTail.webhooks.WebhookForm.placeholders.headerKey')}
                  className="h-9 flex-1 rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
                  {...register(`headers.${index}.key`)}
                />
                <input
                  placeholder={t('longTail.webhooks.WebhookForm.placeholders.headerValue')}
                  className="h-9 flex-1 rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
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
    </form>
  );
}
