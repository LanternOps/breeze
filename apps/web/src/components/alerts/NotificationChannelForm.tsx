import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import '../../lib/i18n';
import { useForm, useFieldArray, Controller } from 'react-hook-form';
import { z } from 'zod';
import { zodResolver } from '@hookform/resolvers/zod';
import { Plus, Trash2, Mail, MessageSquare, Bell, Webhook, Phone, Smartphone } from 'lucide-react';
import { NOTIFICATION_CHANNEL_TYPES } from '@breeze/shared';
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

const pushoverConfigSchema = z.object({
  token: z.string().max(30, 'Token must be 30 characters or fewer').optional(),
  user: z.string().min(1, 'User or group key is required').max(30, 'User key must be 30 characters or fewer'),
  device: z.string().max(25, 'Device name must be 25 characters or fewer').optional(),
  priority: z.union([z.literal(-2), z.literal(-1), z.literal(0), z.literal(1), z.literal(2)]).optional(),
  sound: z.string().max(40).optional()
});

const createNotificationChannelSchema = (t: TFunction<'alerts'>) => z.object({
  name: z.string().min(1, t('notificationChannelForm.validation.channelNameRequired')),
  type: z.enum(NOTIFICATION_CHANNEL_TYPES),
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
  smsMessagingServiceSid: z.string().optional(),
  pushoverToken: z.string().optional(),
  pushoverUser: z.string().optional(),
  pushoverDevice: z.string().optional(),
  pushoverPriority: z.union([z.literal(-2), z.literal(-1), z.literal(0), z.literal(1), z.literal(2)]).optional(),
  pushoverSound: z.string().optional(),
  // Per-channel templates
  templateTriggered: z.string().optional(),
  templateResolved: z.string().optional(),
}).superRefine((data, ctx) => {
  if (data.type === 'pushover') {
    if (data.pushoverUser && data.pushoverUser.length > 30) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['pushoverUser'],
        message: t('notificationChannelForm.validation.userKeyTooLong')
      });
    }
    if (data.pushoverToken && data.pushoverToken.length > 30) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['pushoverToken'],
        message: t('notificationChannelForm.validation.tokenTooLong')
      });
    }
    if (data.pushoverDevice && data.pushoverDevice.length > 25) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['pushoverDevice'],
        message: t('notificationChannelForm.validation.deviceNameTooLong')
      });
    }
  }

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
      message: t('notificationChannelForm.validation.phoneRequired')
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
        message: t('notificationChannelForm.validation.phoneFormat')
      });
    }
  }

  if (hasInvalidPhoneNumber) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['smsPhoneNumbers'],
      message: t('notificationChannelForm.validation.allPhoneFormat')
    });
  }

  const smsFrom = data.smsFrom?.trim();
  if (smsFrom && !E164_PHONE_REGEX.test(smsFrom)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['smsFrom'],
      message: t('notificationChannelForm.validation.fromPhoneFormat')
    });
  }
});

export type NotificationChannelFormValues = z.infer<ReturnType<typeof createNotificationChannelSchema>>;

type NotificationChannelFormProps = {
  onSubmit?: (values: NotificationChannelFormValues) => void | Promise<void>;
  onCancel?: () => void;
  defaultValues?: Partial<NotificationChannelFormValues>;
  submitLabel?: string;
  loading?: boolean;
};

const channelTypeOptions: { value: NotificationChannelType; icon: typeof Mail }[] = [
  { value: 'email', icon: Mail },
  { value: 'slack', icon: MessageSquare },
  { value: 'teams', icon: MessageSquare },
  { value: 'pagerduty', icon: Bell },
  { value: 'webhook', icon: Webhook },
  { value: 'sms', icon: Phone },
  { value: 'pushover', icon: Smartphone }
];

export default function NotificationChannelForm({
  onSubmit,
  onCancel,
  defaultValues,
  submitLabel,
  loading
}: NotificationChannelFormProps) {
  const { t } = useTranslation('alerts');
  const notificationChannelSchema = useMemo(() => createNotificationChannelSchema(t), [t]);
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
      pushoverToken: '',
      pushoverUser: '',
      pushoverDevice: '',
      pushoverPriority: 0,
      pushoverSound: '',
      templateTriggered: '',
      templateResolved: '',
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
      className="space-y-6 rounded-lg border bg-card p-6 shadow-xs"
    >
      {/* Basic Information */}
      <div className="grid gap-6 md:grid-cols-2">
        <div className="space-y-2">
          <label htmlFor="channel-name" className="text-sm font-medium">
            {t('notificationChannelForm.channelName')}
          </label>
          <input
            id="channel-name"
            placeholder={t('notificationChannelForm.productionAlerts')}
            className="h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
            {...register('name')}
          />
          {errors.name && <p className="text-sm text-destructive">{errors.name.message}</p>}
        </div>

        <div className="space-y-2">
          <label className="text-sm font-medium">{t('notificationChannelForm.enabled')}</label>
          <Controller
            name="enabled"
            control={control}
            render={({ field }) => (
              <label className="flex items-center gap-2 h-10 cursor-pointer">
                <input
                  type="checkbox"
                  checked={field.value}
                  onChange={e => field.onChange(e.target.checked)}
                  className="h-4 w-4 rounded border-border"
                />
                <span className="text-sm">{t('notificationChannelForm.enableThisNotificationChannel')}</span>
              </label>
            )}
          />
        </div>
      </div>

      {/* Channel Type Selection */}
      <div className="space-y-2">
        <label className="text-sm font-medium">{t('notificationChannelForm.channelType')}</label>
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
                      <p className="text-sm font-medium">{t(/* i18n-dynamic */ `notificationChannelForm.channelTypeOption.${opt.value}.label`)}</p>
                      <p className="text-xs text-muted-foreground">{t(/* i18n-dynamic */ `notificationChannelForm.channelTypeOption.${opt.value}.description`)}</p>
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
            <h3 className="text-sm font-semibold">{t('notificationChannelForm.emailConfiguration')}</h3>
            <button
              type="button"
              onClick={() => appendEmail({ value: '' })}
              className="inline-flex items-center gap-1 rounded-md border px-3 py-1.5 text-sm font-medium hover:bg-muted"
            >
              <Plus className="h-4 w-4" />
              {t('notificationChannelForm.addRecipient')}
            </button>
          </div>
          <div className="space-y-3">
            {emailFields.map((field, index) => (
              <div key={field.id} className="flex items-center gap-2">
                <input
                  placeholder={t('notificationChannelForm.emailExampleCom')}
                  className="h-10 flex-1 rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
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
          <h3 className="text-sm font-semibold mb-4">{t('notificationChannelForm.slackConfiguration')}</h3>
          <div className="space-y-4">
            <div className="space-y-2">
              <label htmlFor="slack-webhook" className="text-sm font-medium">
                {t('notificationChannelForm.webhookUrl')}
              </label>
              <input
                id="slack-webhook"
                placeholder={t('notificationChannelForm.httpsHooksSlackComServices')}
                className="h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
                {...register('slackWebhookUrl')}
              />
              <p className="text-xs text-muted-foreground">
                {t('notificationChannelForm.createASlackIncomingWebhookAndPaste')}
              </p>
            </div>
            <div className="space-y-2">
              <label htmlFor="slack-channel" className="text-sm font-medium">
                {t('notificationChannelForm.channelOptional')}
              </label>
              <input
                id="slack-channel"
                placeholder={t('notificationChannelForm.alerts')}
                className="h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
                {...register('slackChannel')}
              />
              <p className="text-xs text-muted-foreground">
                {t('notificationChannelForm.overrideTheDefaultChannelConfiguredInThe')}
              </p>
            </div>
          </div>
        </div>
      )}

      {/* Teams Configuration */}
      {watchType === 'teams' && (
        <div className="rounded-md border bg-muted/20 p-4">
          <h3 className="text-sm font-semibold mb-4">{t('notificationChannelForm.microsoftTeamsConfiguration')}</h3>
          <div className="space-y-2">
            <label htmlFor="teams-webhook" className="text-sm font-medium">
              {t('notificationChannelForm.webhookUrl')}
            </label>
            <input
              id="teams-webhook"
              placeholder={t('notificationChannelForm.httpsOutlookOfficeComWebhook')}
              className="h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
              {...register('teamsWebhookUrl')}
            />
            <p className="text-xs text-muted-foreground">
              {t('notificationChannelForm.createAnIncomingWebhookConnectorInYour')}
            </p>
          </div>
        </div>
      )}

      {/* PagerDuty Configuration */}
      {watchType === 'pagerduty' && (
        <div className="rounded-md border bg-muted/20 p-4">
          <h3 className="text-sm font-semibold mb-4">{t('notificationChannelForm.pagerdutyConfiguration')}</h3>
          <div className="space-y-4">
            <div className="space-y-2">
              <label htmlFor="pagerduty-key" className="text-sm font-medium">
                {t('notificationChannelForm.integrationKey')}
              </label>
              <input
                id="pagerduty-key"
                type="password"
                placeholder={t('notificationChannelForm.enterYourPagerdutyIntegrationKey')}
                className="h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
                {...register('pagerdutyIntegrationKey')}
              />
              <p className="text-xs text-muted-foreground">
                {t('notificationChannelForm.findThisInYourPagerdutyServiceS')}
              </p>
            </div>
            <div className="space-y-2">
              <label htmlFor="pagerduty-severity" className="text-sm font-medium">
                {t('notificationChannelForm.defaultSeverity')}
              </label>
              <select
                id="pagerduty-severity"
                className="h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
                {...register('pagerdutySeverity')}
              >
                <option value="critical">{t('notificationChannelForm.critical')}</option>
                <option value="error">{t('notificationChannelForm.error')}</option>
                <option value="warning">{t('notificationChannelForm.warning')}</option>
                <option value="info">{t('notificationChannelForm.info')}</option>
              </select>
            </div>
          </div>
        </div>
      )}

      {/* Pushover Configuration */}
      {watchType === 'pushover' && (
        <div className="rounded-md border bg-muted/20 p-4">
          <h3 className="text-sm font-semibold mb-4">{t('notificationChannelForm.pushoverConfiguration')}</h3>
          <div className="space-y-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <label htmlFor="pushover-token" className="text-sm font-medium">
                  {t('notificationChannelForm.applicationToken')}
                </label>
                <input
                  id="pushover-token"
                  type="password"
                  placeholder={t('notificationChannelForm.leaveBlankToInheritFromPartner')}
                  maxLength={30}
                  className="h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
                  {...register('pushoverToken')}
                />
                {errors.pushoverToken?.message ? (
                  <p className="text-xs text-destructive">{errors.pushoverToken.message}</p>
                ) : (
                  <p className="text-xs text-muted-foreground">
                    {t('notificationChannelForm.value30CharAppKeyFromYourPushover')}
                  </p>
                )}
              </div>
              <div className="space-y-2">
                <label htmlFor="pushover-user" className="text-sm font-medium">
                  {t('notificationChannelForm.userOrGroupKey')}
                </label>
                <input
                  id="pushover-user"
                  type="text"
                  placeholder={t('notificationChannelForm.leaveBlankToInheritFromPartner')}
                  maxLength={30}
                  className="h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
                  {...register('pushoverUser')}
                />
                {errors.pushoverUser?.message ? (
                  <p className="text-xs text-destructive">{errors.pushoverUser.message}</p>
                ) : (
                  <p className="text-xs text-muted-foreground">
                    {t('notificationChannelForm.value30CharUserGroupKeyBlankUses')}
                  </p>
                )}
              </div>
            </div>
            <div className="grid gap-4 sm:grid-cols-3">
              <div className="space-y-2">
                <label htmlFor="pushover-device" className="text-sm font-medium">
                  {t('notificationChannelForm.deviceOptional')}
                </label>
                <input
                  id="pushover-device"
                  type="text"
                  placeholder={t('notificationChannelForm.iphoneBdunn')}
                  maxLength={25}
                  className="h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
                  {...register('pushoverDevice')}
                />
                {errors.pushoverDevice?.message && (
                  <p className="text-xs text-destructive">{errors.pushoverDevice.message}</p>
                )}
              </div>
              <div className="space-y-2">
                <label htmlFor="pushover-priority" className="text-sm font-medium">
                  {t('notificationChannelForm.priority')}
                </label>
                <select
                  id="pushover-priority"
                  className="h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
                  {...register('pushoverPriority', { valueAsNumber: true })}
                >
                  <option value={-2}>{t('notificationChannelForm.lowestNoNotificationUi')}</option>
                  <option value={-1}>{t('notificationChannelForm.lowSilent')}</option>
                  <option value={0}>{t('notificationChannelForm.normal')}</option>
                  <option value={1}>{t('notificationChannelForm.highBypassQuietHours')}</option>
                  <option value={2}>{t('notificationChannelForm.emergencyRepeatsUntilAck')}</option>
                </select>
                <p className="text-xs text-muted-foreground">
                  {t('notificationChannelForm.fallsBackToAlertSeverityMappingWhen')}
                </p>
              </div>
              <div className="space-y-2">
                <label htmlFor="pushover-sound" className="text-sm font-medium">
                  {t('notificationChannelForm.soundOptional')}
                </label>
                <input
                  id="pushover-sound"
                  type="text"
                  placeholder={t('notificationChannelForm.pushover')}
                  className="h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
                  {...register('pushoverSound')}
                />
                <p className="text-xs text-muted-foreground">
                  {t('notificationChannelForm.builtInNamePushoverBikeBugleOr')}
                </p>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Webhook Configuration */}
      {watchType === 'webhook' && (
        <div className="rounded-md border bg-muted/20 p-4">
          <h3 className="text-sm font-semibold mb-4">{t('notificationChannelForm.webhookConfiguration')}</h3>
          <div className="space-y-4">
            <div className="grid gap-4 sm:grid-cols-3">
              <div className="space-y-2 sm:col-span-2">
                <label htmlFor="webhook-url" className="text-sm font-medium">
                  {t('notificationChannelForm.url')}
                </label>
                <input
                  id="webhook-url"
                  placeholder={t('notificationChannelForm.httpsApiExampleComAlerts')}
                  className="h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
                  {...register('webhookUrl')}
                />
              </div>
              <div className="space-y-2">
                <label htmlFor="webhook-method" className="text-sm font-medium">
                  {t('notificationChannelForm.method')}
                </label>
                <select
                  id="webhook-method"
                  className="h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
                  {...register('webhookMethod')}
                >
                  <option value="POST">{t('notificationChannelForm.post')}</option>
                  <option value="PUT">{t('notificationChannelForm.put')}</option>
                  <option value="PATCH">{t('notificationChannelForm.patch')}</option>
                </select>
              </div>
            </div>

            {/* Headers */}
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <label className="text-sm font-medium">{t('notificationChannelForm.headers')}</label>
                <button
                  type="button"
                  onClick={() => appendHeader({ key: '', value: '' })}
                  className="inline-flex items-center gap-1 text-xs text-primary hover:underline"
                >
                  <Plus className="h-3 w-3" />
                  {t('notificationChannelForm.addHeader')}
                </button>
              </div>
              {headerFields.length > 0 ? (
                <div className="space-y-2">
                  {headerFields.map((field, index) => (
                    <div key={field.id} className="flex items-center gap-2">
                      <input
                        placeholder={t('notificationChannelForm.headerKey')}
                        className="h-9 flex-1 rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
                        {...register(`webhookHeaders.${index}.key`)}
                      />
                      <input
                        placeholder={t('notificationChannelForm.headerValue')}
                        className="h-9 flex-1 rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
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
                <p className="text-xs text-muted-foreground">{t('notificationChannelForm.noCustomHeadersConfigured')}</p>
              )}
            </div>

            {/* Authentication */}
            <div className="space-y-2">
              <label className="text-sm font-medium">{t('notificationChannelForm.authentication')}</label>
              <select
                className="h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
                {...register('webhookAuthType')}
              >
                <option value="none">{t('notificationChannelForm.noAuthentication')}</option>
                <option value="basic">{t('notificationChannelForm.basicAuth')}</option>
                <option value="bearer">{t('notificationChannelForm.bearerToken')}</option>
              </select>
            </div>

            {watchAuthType === 'basic' && (
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-2">
                  <label htmlFor="webhook-username" className="text-sm font-medium">
                    {t('notificationChannelForm.username')}
                  </label>
                  <input
                    id="webhook-username"
                    className="h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
                    {...register('webhookAuthUsername')}
                  />
                </div>
                <div className="space-y-2">
                  <label htmlFor="webhook-password" className="text-sm font-medium">
                    {t('notificationChannelForm.password')}
                  </label>
                  <input
                    id="webhook-password"
                    type="password"
                    className="h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
                    {...register('webhookAuthPassword')}
                  />
                </div>
              </div>
            )}

            {watchAuthType === 'bearer' && (
              <div className="space-y-2">
                <label htmlFor="webhook-token" className="text-sm font-medium">
                  {t('notificationChannelForm.bearerToken')}
                </label>
                <input
                  id="webhook-token"
                  type="password"
                  className="h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
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
            <h3 className="text-sm font-semibold">{t('notificationChannelForm.smsConfiguration')}</h3>
            <button
              type="button"
              onClick={() => appendSms({ value: '' })}
              className="inline-flex items-center gap-1 rounded-md border px-3 py-1.5 text-sm font-medium hover:bg-muted"
            >
              <Plus className="h-4 w-4" />
              {t('notificationChannelForm.addNumber')}
            </button>
          </div>
          <div className="space-y-3">
            {smsFields.map((field, index) => (
              <div key={field.id} className="flex items-center gap-2">
                <input
                  placeholder="+1234567890"
                  className="h-10 flex-1 rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
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
            {t('notificationChannelForm.enterPhoneNumbersInInternationalFormatE')}
          </p>
          <div className="mt-4 grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <label htmlFor="sms-from" className="text-sm font-medium">
                {t('notificationChannelForm.twilioFromNumberOptional')}
              </label>
              <input
                id="sms-from"
                placeholder="+1234567890"
                className="h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
                {...register('smsFrom')}
              />
              <p className="text-xs text-muted-foreground">
                {t('notificationChannelForm.optionalOverrideForSenderNumberWhenNot')}
              </p>
              {errors.smsFrom && <p className="text-sm text-destructive">{errors.smsFrom.message}</p>}
            </div>
            <div className="space-y-2">
              <label htmlFor="sms-messaging-service" className="text-sm font-medium">
                {t('notificationChannelForm.twilioMessagingServiceSidOptional')}
              </label>
              <input
                id="sms-messaging-service"
                placeholder={t('notificationChannelForm.mgxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx')}
                className="h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
                {...register('smsMessagingServiceSid')}
              />
              <p className="text-xs text-muted-foreground">
                {t('notificationChannelForm.optionalOverrideForTwilioMessagingServicePer')}
              </p>
            </div>
          </div>
          {errors.smsPhoneNumbers?.message && (
            <p className="mt-2 text-sm text-destructive">{errors.smsPhoneNumbers.message}</p>
          )}
        </div>
      )}

      {/* Per-Channel Message Templates */}
      <div className="rounded-md border bg-muted/20 p-4">
        <h3 className="text-sm font-semibold mb-1">{t('notificationChannelForm.customMessageTemplates')}</h3>
        <p className="text-xs text-muted-foreground mb-4">
          {t('notificationChannelForm.overrideDefaultNotificationMessagesUse')} {'{{variable}}'} {t('notificationChannelForm.syntaxForDynamicValues')}
          {' '}{'{{deviceName}}'}, {'{{severity}}'}, {'{{metric}}'}, {'{{actualValue}}'}, {'{{threshold}}'}, {'{{operator}}'}{t('notificationChannelForm.leaveBlankToUseDefaults')}
        </p>
        <div className="space-y-4">
          <div className="space-y-2">
            <label htmlFor="template-triggered" className="text-sm font-medium">
              {t('notificationChannelForm.alertTriggeredTemplate')}
            </label>
            <textarea
              id="template-triggered"
              rows={3}
              placeholder={t('notificationChannelForm.alertValueValueIsValueThresholdValue')}
              className="w-full rounded-md border bg-background px-3 py-2 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
              {...register('templateTriggered')}
            />
          </div>
          <div className="space-y-2">
            <label htmlFor="template-resolved" className="text-sm font-medium">
              {t('notificationChannelForm.alertResolvedTemplate')}
            </label>
            <textarea
              id="template-resolved"
              rows={3}
              placeholder={t('notificationChannelForm.resolvedValueValueHasReturnedToNormal')}
              className="w-full rounded-md border bg-background px-3 py-2 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
              {...register('templateResolved')}
            />
          </div>
        </div>
      </div>

      {/* Form Actions */}
      <div className="flex flex-col gap-3 sm:flex-row sm:justify-end">
        <button
          type="button"
          onClick={onCancel}
          className="h-11 w-full rounded-md border bg-background text-sm font-medium text-foreground transition hover:bg-muted sm:w-auto sm:px-6"
        >
          {t('notificationChannelForm.cancel')}
        </button>
        <button
          type="submit"
          disabled={isLoading}
          className="flex h-11 w-full items-center justify-center rounded-md bg-primary text-sm font-medium text-primary-foreground transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60 sm:w-auto sm:px-6"
        >
          {isLoading ? t('common:states.saving') : (submitLabel ?? t('notificationChannelForm.saveChannel'))}
        </button>
      </div>
    </form>
  );
}
