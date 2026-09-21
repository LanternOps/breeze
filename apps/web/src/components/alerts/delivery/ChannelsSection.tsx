import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Plus } from 'lucide-react';
import NotificationChannelList, { type NotificationChannel } from '../NotificationChannelList';
import NotificationChannelForm, { type NotificationChannelFormValues } from '../NotificationChannelForm';
import { ActionError } from '../../../lib/runAction';
import { runChannelDelete, runChannelSave, runChannelTest } from './deliveryActions';

type ModalMode = 'closed' | 'create' | 'edit' | 'delete';

export default function ChannelsSection({ channels, currentOrgId, isPartnerScope, defaultOwnerScope, onChanged, onUnauthorized }: {
  channels: NotificationChannel[];
  currentOrgId: string | null;
  isPartnerScope: boolean;
  defaultOwnerScope: 'organization' | 'partner';
  onChanged: () => Promise<void>;
  onUnauthorized: () => void;
}) {
  const { t } = useTranslation('alerts');
  const [modalMode, setModalMode] = useState<ModalMode>('closed');
  const [selectedChannel, setSelectedChannel] = useState<NotificationChannel | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string>();
  const [channelOwnerScope, setChannelOwnerScope] = useState<'organization' | 'partner'>('organization');
  const handleCreate = () => {
    setChannelOwnerScope(defaultOwnerScope);
    setSelectedChannel(null);
    setModalMode('create');
  };

  const handleEdit = (channel: NotificationChannel) => {
    setSelectedChannel(channel);
    setModalMode('edit');
  };

  const handleDelete = (channel: NotificationChannel) => {
    setSelectedChannel(channel);
    setModalMode('delete');
  };

  const handleTest = async (channel: NotificationChannel) => {
    await runChannelTest(channel, {
      fetchChannels: onChanged,
      onUnauthorized,
    });
  };

  const handleCloseModal = () => {
    setModalMode('closed');
    setSelectedChannel(null);
  };

  const transformFormToPayload = (values: NotificationChannelFormValues) => {
    const base = {
      name: values.name,
      type: values.type,
      enabled: values.enabled
    };

    let config: Record<string, unknown> = {};

    switch (values.type) {
      case 'email':
        config = {
          recipients: values.emailRecipients?.map(r => r.value).filter(v => v) ?? []
        };
        break;
      case 'slack':
        config = {
          webhookUrl: values.slackWebhookUrl,
          channel: values.slackChannel
        };
        break;
      case 'teams':
        config = {
          webhookUrl: values.teamsWebhookUrl
        };
        break;
      case 'pagerduty':
        config = {
          integrationKey: values.pagerdutyIntegrationKey,
          severity: values.pagerdutySeverity
        };
        break;
      case 'webhook':
        config = {
          url: values.webhookUrl,
          method: values.webhookMethod,
          // The form models headers as a repeatable [{key,value}] list, but the
          // API requires a Record<string,string> and rejects anything else with
          // "Headers must be an object" — so every webhook channel save 400'd.
          // Convert at the boundary rather than reshaping the field array,
          // which is the right UI model for add/remove rows.
          headers: Object.fromEntries(
            (values.webhookHeaders ?? []).filter(h => h.key).map(h => [h.key, h.value])
          ),
          authType: values.webhookAuthType,
          authUsername: values.webhookAuthUsername,
          authPassword: values.webhookAuthPassword,
          authToken: values.webhookAuthToken
        };
        break;
      case 'sms':
        config = {
          phoneNumbers: values.smsPhoneNumbers
            ?.map(p => p.value.trim())
            .filter(v => v) ?? []
        };
        if (values.smsFrom?.trim()) {
          config.from = values.smsFrom.trim();
        }
        if (values.smsMessagingServiceSid?.trim()) {
          config.messagingServiceSid = values.smsMessagingServiceSid.trim();
        }
        break;
      case 'pushover':
        config = {
          user: values.pushoverUser?.trim() ?? ''
        };
        if (values.pushoverToken?.trim()) {
          config.token = values.pushoverToken.trim();
        }
        if (values.pushoverDevice?.trim()) {
          config.device = values.pushoverDevice.trim();
        }
        if (values.pushoverSound?.trim()) {
          config.sound = values.pushoverSound.trim();
        }
        if (typeof values.pushoverPriority === 'number') {
          config.priority = values.pushoverPriority;
        }
        break;
    }

    // Per-channel templates
    const templates: Record<string, string> = {};
    if (values.templateTriggered?.trim()) {
      templates.alert_triggered = values.templateTriggered.trim();
    }
    if (values.templateResolved?.trim()) {
      templates.alert_resolved = values.templateResolved.trim();
    }

    return { ...base, config, ...(Object.keys(templates).length > 0 ? { templates } : {}) };
  };

  const transformChannelToForm = (channel: NotificationChannel): Partial<NotificationChannelFormValues> => {
    const base: Partial<NotificationChannelFormValues> = {
      name: channel.name,
      type: channel.type,
      enabled: channel.enabled
    };

    // Per-channel templates
    const channelTemplates = (channel as NotificationChannel & { templates?: Record<string, string> }).templates;
    if (channelTemplates) {
      base.templateTriggered = channelTemplates.alert_triggered ?? '';
      base.templateResolved = channelTemplates.alert_resolved ?? '';
    }

    const config = channel.config;

    switch (channel.type) {
      case 'email':
        base.emailRecipients = Array.isArray(config.recipients)
          ? (config.recipients as string[]).map(v => ({ value: v }))
          : [{ value: '' }];
        break;
      case 'slack':
        base.slackWebhookUrl = config.webhookUrl as string;
        base.slackChannel = config.channel as string;
        break;
      case 'teams':
        base.teamsWebhookUrl = config.webhookUrl as string;
        break;
      case 'pagerduty':
        base.pagerdutyIntegrationKey = config.integrationKey as string;
        base.pagerdutySeverity = config.severity as 'critical' | 'error' | 'warning' | 'info';
        break;
      case 'webhook':
        base.webhookUrl = config.url as string;
        base.webhookMethod = config.method as 'POST' | 'PUT' | 'PATCH';
        // Mirror of the outbound conversion. The array branch is kept because
        // any channel saved before the fix — or hand-written via the API —
        // may still carry the old shape.
        base.webhookHeaders = Array.isArray(config.headers)
          ? (config.headers as { key: string; value: string }[])
          : config.headers && typeof config.headers === 'object'
            ? Object.entries(config.headers as Record<string, string>).map(([key, value]) => ({
                key,
                value: String(value),
              }))
            : [];
        base.webhookAuthType = config.authType as 'none' | 'basic' | 'bearer';
        base.webhookAuthUsername = config.authUsername as string;
        base.webhookAuthPassword = config.authPassword as string;
        base.webhookAuthToken = config.authToken as string;
        break;
      case 'sms':
        base.smsPhoneNumbers = Array.isArray(config.phoneNumbers)
          ? (config.phoneNumbers as string[]).map(v => ({ value: v }))
          : [{ value: '' }];
        base.smsFrom = config.from as string;
        base.smsMessagingServiceSid = config.messagingServiceSid as string;
        break;
      case 'pushover':
        base.pushoverToken = (config.token as string) ?? '';
        base.pushoverUser = (config.user as string) ?? '';
        base.pushoverDevice = (config.device as string) ?? '';
        base.pushoverSound = (config.sound as string) ?? '';
        if (typeof config.priority === 'number') {
          base.pushoverPriority = config.priority as -2 | -1 | 0 | 1 | 2;
        }
        break;
    }

    return base;
  };


  const handleSubmit = async (values: NotificationChannelFormValues) => {
    setSubmitting(true);
    setError(undefined);

    const payload = transformFormToPayload(values);
    const isCreate = modalMode === 'create';
    const url = isCreate ? '/alerts/channels' : `/alerts/channels/${selectedChannel?.id}`;
    const method = isCreate ? 'POST' : 'PUT';
    const partnerWideCreate = isCreate && isPartnerScope && channelOwnerScope === 'partner';
    const requestPayload = partnerWideCreate
      ? { ...payload, ownerScope: 'partner' }
      : isCreate && currentOrgId
        ? { ...payload, orgId: currentOrgId }
        : payload;

    try {
      await runChannelSave(
        { url, method, payload: requestPayload, channelName: selectedChannel?.name ?? '', isCreate },
        { onUnauthorized }
      );
      await onChanged();
      handleCloseModal();
    } catch (err) {
      if (err instanceof ActionError && err.status === 401) return;
      if (!(err instanceof ActionError)) {
        setError(err instanceof Error ? err.message : t('notificationChannelsPage.genericError'));
      }
      // ActionError non-401: runAction already toasted
    } finally {
      setSubmitting(false);
    }
  };

  const handleConfirmDelete = async () => {
    if (!selectedChannel) return;

    setSubmitting(true);
    try {
      await runChannelDelete(selectedChannel, { onUnauthorized });
      await onChanged();
      handleCloseModal();
    } catch (err) {
      if (err instanceof ActionError && err.status === 401) return;
      if (!(err instanceof ActionError)) {
        setError(err instanceof Error ? err.message : t('notificationChannelsPage.genericError'));
      }
      // ActionError non-401: runAction already toasted
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <section className="space-y-4" data-testid="delivery-channels">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold">{t('deliveryPage.sections.channels')}</h2>
        <button type="button" onClick={handleCreate} data-testid="delivery-new-channel"
          className="inline-flex h-9 items-center gap-2 rounded-md bg-primary px-3 text-sm font-medium text-primary-foreground hover:opacity-90">
          <Plus className="h-4 w-4" />{t('notificationChannelsPage.newChannel')}
        </button>
      </div>
      <p className="text-sm text-muted-foreground">{t('notificationChannelsPage.newChannelsRequireRouting')}</p>
      {error && modalMode === 'closed' && (
        <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</div>
      )}
      <NotificationChannelList channels={channels} onEdit={handleEdit} onDelete={handleDelete} onTest={handleTest} onCreate={handleCreate} />
      {/* Create/Edit Modal */}
      {(modalMode === 'create' || modalMode === 'edit') && (
        <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-background/80 px-4 py-8">
          <div className="w-full max-w-3xl">
            <div className="mb-4 flex items-center justify-between">
              <h2 className="text-xl font-bold">
                {modalMode === 'create' ? t('notificationChannelsPage.createNotificationChannel') : t('notificationChannelsPage.editNotificationChannel')}
              </h2>
            </div>
            {error && (
              <div className="mb-4 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
                {error}
              </div>
            )}
            {/* Ownership scope — partner-scope creators only, create-only (#2130) */}
            {modalMode === 'create' && isPartnerScope && (
              <fieldset className="mb-4 space-y-2 rounded-md border bg-card p-4" data-testid="notification-channel-owner">
                <legend className="px-1 text-xs font-medium uppercase text-muted-foreground">{t('notificationChannelsPage.scope')}</legend>
                <label className="flex items-center gap-2 text-sm">
                  <input
                    type="radio"
                    checked={channelOwnerScope === 'partner'}
                    onChange={() => setChannelOwnerScope('partner')}
                    data-testid="notification-channel-owner-partner"
                  />
                  {t('notificationChannelsPage.allOrganizations')}
                </label>
                <label className="flex items-center gap-2 text-sm">
                  <input
                    type="radio"
                    checked={channelOwnerScope === 'organization'}
                    onChange={() => setChannelOwnerScope('organization')}
                    data-testid="notification-channel-owner-org"
                  />
                  {t('notificationChannelsPage.thisOrganizationOnly')}
                </label>
              </fieldset>
            )}
            <NotificationChannelForm
              onSubmit={handleSubmit}
              onCancel={handleCloseModal}
              defaultValues={
                modalMode === 'edit' && selectedChannel
                  ? transformChannelToForm(selectedChannel)
                  : undefined
              }
              submitLabel={modalMode === 'create' ? t('notificationChannelsPage.createChannel') : t('common:actions.save')}
              loading={submitting}
            />
          </div>
        </div>
      )}

      {/* Delete Confirmation Modal */}
      {modalMode === 'delete' && selectedChannel && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 px-4 py-8">
          <div className="w-full max-w-md rounded-lg border bg-card p-6 shadow-xs">
            <h2 className="text-lg font-semibold">{t('notificationChannelsPage.deleteNotificationChannel')}</h2>
            <p className="mt-2 text-sm text-muted-foreground">
              {t('notificationChannelsPage.deleteChannelConfirm', { name: selectedChannel.name })}
            </p>
            <div className="mt-6 flex justify-end gap-3">
              <button
                type="button"
                onClick={handleCloseModal}
                data-testid="channel-delete-cancel"
                className="h-10 rounded-md border px-4 text-sm font-medium text-muted-foreground transition hover:text-foreground"
              >
                {t('notificationChannelsPage.cancel')}
              </button>
              <button
                type="button"
                onClick={handleConfirmDelete}
                data-testid="channel-delete-confirm"
                disabled={submitting}
                className="inline-flex h-10 items-center justify-center rounded-md bg-destructive px-4 text-sm font-medium text-destructive-foreground transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {submitting ? t('notificationChannelsPage.deleting') : t('common:actions.delete')}
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
