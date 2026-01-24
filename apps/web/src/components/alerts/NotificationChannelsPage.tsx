import { useState, useEffect, useCallback } from 'react';
import { Plus } from 'lucide-react';
import NotificationChannelList, { type NotificationChannel } from './NotificationChannelList';
import NotificationChannelForm, { type NotificationChannelFormValues } from './NotificationChannelForm';
import { fetchWithAuth } from '../../stores/auth';

type ModalMode = 'closed' | 'create' | 'edit' | 'delete';

export default function NotificationChannelsPage() {
  const [channels, setChannels] = useState<NotificationChannel[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [modalMode, setModalMode] = useState<ModalMode>('closed');
  const [selectedChannel, setSelectedChannel] = useState<NotificationChannel | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const fetchChannels = useCallback(async () => {
    try {
      setLoading(true);
      setError(undefined);
      const response = await fetchWithAuth('/alerts/channels');
      if (!response.ok) {
        if (response.status === 401) {
          window.location.href = '/login';
          return;
        }
        throw new Error('Failed to fetch notification channels');
      }
      const data = await response.json();
      setChannels(data.channels ?? data.data ?? (Array.isArray(data) ? data : []));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An error occurred');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchChannels();
  }, [fetchChannels]);

  const handleCreate = () => {
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
    try {
      const response = await fetchWithAuth(`/alerts/channels/${channel.id}/test`, {
        method: 'POST'
      });

      if (!response.ok) {
        if (response.status === 401) {
          window.location.href = '/login';
          return;
        }
        throw new Error('Test failed');
      }

      // Refresh to update test status
      await fetchChannels();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Test failed');
    }
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
          headers: values.webhookHeaders?.filter(h => h.key) ?? [],
          authType: values.webhookAuthType,
          authUsername: values.webhookAuthUsername,
          authPassword: values.webhookAuthPassword,
          authToken: values.webhookAuthToken
        };
        break;
      case 'sms':
        config = {
          phoneNumbers: values.smsPhoneNumbers?.map(p => p.value).filter(v => v) ?? []
        };
        break;
    }

    return { ...base, config };
  };

  const transformChannelToForm = (channel: NotificationChannel): Partial<NotificationChannelFormValues> => {
    const base: Partial<NotificationChannelFormValues> = {
      name: channel.name,
      type: channel.type,
      enabled: channel.enabled
    };

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
        base.webhookHeaders = Array.isArray(config.headers)
          ? (config.headers as { key: string; value: string }[])
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
        break;
    }

    return base;
  };

  const handleSubmit = async (values: NotificationChannelFormValues) => {
    setSubmitting(true);
    setError(undefined);

    try {
      const payload = transformFormToPayload(values);
      const url =
        modalMode === 'create'
          ? '/alerts/channels'
          : `/alerts/channels/${selectedChannel?.id}`;
      const method = modalMode === 'create' ? 'POST' : 'PUT';

      const response = await fetchWithAuth(url, {
        method,
        body: JSON.stringify(payload)
      });

      if (!response.ok) {
        if (response.status === 401) {
          window.location.href = '/login';
          return;
        }
        const data = await response.json();
        throw new Error(data.error || 'Failed to save channel');
      }

      await fetchChannels();
      handleCloseModal();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An error occurred');
    } finally {
      setSubmitting(false);
    }
  };

  const handleConfirmDelete = async () => {
    if (!selectedChannel) return;

    setSubmitting(true);
    try {
      const response = await fetchWithAuth(`/alerts/channels/${selectedChannel.id}`, {
        method: 'DELETE'
      });

      if (!response.ok) {
        if (response.status === 401) {
          window.location.href = '/login';
          return;
        }
        throw new Error('Failed to delete channel');
      }

      await fetchChannels();
      handleCloseModal();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An error occurred');
    } finally {
      setSubmitting(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <div className="text-center">
          <div className="h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent mx-auto" />
          <p className="mt-4 text-sm text-muted-foreground">Loading notification channels...</p>
        </div>
      </div>
    );
  }

  if (error && channels.length === 0 && modalMode === 'closed') {
    return (
      <div className="rounded-lg border border-destructive/40 bg-destructive/10 p-6 text-center">
        <p className="text-sm text-destructive">{error}</p>
        <button
          type="button"
          onClick={fetchChannels}
          className="mt-4 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90"
        >
          Try again
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Notification Channels</h1>
          <p className="text-muted-foreground">
            Configure where alert notifications are sent.
          </p>
        </div>
        <div className="flex items-center gap-3">
          <a
            href="/alerts/rules"
            className="inline-flex h-10 items-center justify-center gap-2 rounded-md border bg-background px-4 text-sm font-medium hover:bg-muted"
          >
            Alert Rules
          </a>
          <button
            type="button"
            onClick={handleCreate}
            className="inline-flex h-10 items-center justify-center gap-2 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground transition hover:opacity-90"
          >
            <Plus className="h-4 w-4" />
            New Channel
          </button>
        </div>
      </div>

      {error && modalMode === 'closed' && (
        <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </div>
      )}

      <NotificationChannelList
        channels={channels}
        onEdit={handleEdit}
        onDelete={handleDelete}
        onTest={handleTest}
      />

      {/* Create/Edit Modal */}
      {(modalMode === 'create' || modalMode === 'edit') && (
        <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-background/80 px-4 py-8">
          <div className="w-full max-w-3xl">
            <div className="mb-4 flex items-center justify-between">
              <h2 className="text-xl font-bold">
                {modalMode === 'create' ? 'Create Notification Channel' : 'Edit Notification Channel'}
              </h2>
            </div>
            {error && (
              <div className="mb-4 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
                {error}
              </div>
            )}
            <NotificationChannelForm
              onSubmit={handleSubmit}
              onCancel={handleCloseModal}
              defaultValues={
                modalMode === 'edit' && selectedChannel
                  ? transformChannelToForm(selectedChannel)
                  : undefined
              }
              submitLabel={modalMode === 'create' ? 'Create Channel' : 'Save Changes'}
              loading={submitting}
            />
          </div>
        </div>
      )}

      {/* Delete Confirmation Modal */}
      {modalMode === 'delete' && selectedChannel && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 px-4 py-8">
          <div className="w-full max-w-md rounded-lg border bg-card p-6 shadow-sm">
            <h2 className="text-lg font-semibold">Delete Notification Channel</h2>
            <p className="mt-2 text-sm text-muted-foreground">
              Are you sure you want to delete{' '}
              <span className="font-medium">{selectedChannel.name}</span>? This action cannot be
              undone. Any alert rules using this channel will no longer send notifications to it.
            </p>
            <div className="mt-6 flex justify-end gap-3">
              <button
                type="button"
                onClick={handleCloseModal}
                className="h-10 rounded-md border px-4 text-sm font-medium text-muted-foreground transition hover:text-foreground"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleConfirmDelete}
                disabled={submitting}
                className="inline-flex h-10 items-center justify-center rounded-md bg-destructive px-4 text-sm font-medium text-destructive-foreground transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {submitting ? 'Deleting...' : 'Delete'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
