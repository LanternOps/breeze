import { useState, useEffect, useCallback, useMemo } from 'react';
import { Plus, Send } from 'lucide-react';
import WebhookList, { type Webhook } from './WebhookList';
import WebhookForm, { type WebhookFormValues, webhookEventOptions } from './WebhookForm';
import WebhookDeliveryHistory, { type WebhookDelivery } from './WebhookDeliveryHistory';

type ModalMode = 'closed' | 'create' | 'edit' | 'delete';

type PayloadPreview = {
  preview: string;
  error: string;
};

const defaultEventType = webhookEventOptions[0]?.value ?? 'device.online';

const formatPayloadPreview = (payload?: string | null): PayloadPreview => {
  if (!payload?.trim()) {
    return { preview: '', error: '' };
  }

  try {
    return { preview: JSON.stringify(JSON.parse(payload), null, 2), error: '' };
  } catch {
    return { preview: payload, error: 'Payload template is not valid JSON.' };
  }
};

const getWebhookEnabled = (webhook: Webhook) => {
  if (typeof webhook.enabled === 'boolean') return webhook.enabled;
  return webhook.status !== 'disabled';
};

export default function WebhooksPage() {
  const [webhooks, setWebhooks] = useState<Webhook[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [modalMode, setModalMode] = useState<ModalMode>('closed');
  const [selectedWebhook, setSelectedWebhook] = useState<Webhook | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [activeWebhookId, setActiveWebhookId] = useState<string | null>(null);
  const [deliveries, setDeliveries] = useState<WebhookDelivery[]>([]);
  const [deliveriesLoading, setDeliveriesLoading] = useState(false);
  const [deliveriesError, setDeliveriesError] = useState<string>();
  const [testEvent, setTestEvent] = useState<string>(defaultEventType);

  const fetchWebhooks = useCallback(async () => {
    try {
      setLoading(true);
      setError(undefined);
      const response = await fetch('/api/webhooks');
      if (!response.ok) {
        throw new Error('Failed to fetch webhooks');
      }
      const data = await response.json();
      setWebhooks(data.webhooks ?? data ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An error occurred');
    } finally {
      setLoading(false);
    }
  }, []);

  const fetchDeliveries = useCallback(async (webhookId: string) => {
    try {
      setDeliveriesLoading(true);
      setDeliveriesError(undefined);
      const response = await fetch(`/api/webhooks/${webhookId}/deliveries`);
      if (!response.ok) {
        throw new Error('Failed to fetch delivery history');
      }
      const data = await response.json();
      setDeliveries(data.deliveries ?? data ?? []);
    } catch (err) {
      setDeliveriesError(err instanceof Error ? err.message : 'Unable to load delivery history');
      setDeliveries([]);
    } finally {
      setDeliveriesLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchWebhooks();
  }, [fetchWebhooks]);

  useEffect(() => {
    if (!webhooks.length) {
      setActiveWebhookId(null);
      return;
    }

    if (!activeWebhookId) {
      setActiveWebhookId(webhooks[0]?.id ?? null);
      return;
    }

    const stillExists = webhooks.some(webhook => webhook.id === activeWebhookId);
    if (!stillExists) {
      setActiveWebhookId(webhooks[0]?.id ?? null);
    }
  }, [webhooks, activeWebhookId]);

  useEffect(() => {
    if (activeWebhookId) {
      fetchDeliveries(activeWebhookId);
    }
  }, [activeWebhookId, fetchDeliveries]);

  const activeWebhook = useMemo(
    () => webhooks.find(webhook => webhook.id === activeWebhookId) ?? null,
    [webhooks, activeWebhookId]
  );

  const payloadPreview = useMemo(
    () => formatPayloadPreview(activeWebhook?.payloadTemplate),
    [activeWebhook?.payloadTemplate]
  );

  const labelMap = useMemo(() => {
    const map = new Map<string, string>();
    webhookEventOptions.forEach(option => map.set(option.value, option.label));
    return map;
  }, []);

  useEffect(() => {
    if (!activeWebhook) return;
    const defaultEvent = activeWebhook.events?.[0] ?? defaultEventType;
    setTestEvent(prev => (activeWebhook.events?.includes(prev) ? prev : defaultEvent));
  }, [activeWebhook]);

  const handleCreate = () => {
    setSelectedWebhook(null);
    setModalMode('create');
  };

  const handleEdit = (webhook: Webhook) => {
    setSelectedWebhook(webhook);
    setModalMode('edit');
  };

  const handleDelete = (webhook: Webhook) => {
    setSelectedWebhook(webhook);
    setModalMode('delete');
  };

  const handleTest = async (webhook: Webhook, eventType?: string) => {
    try {
      const response = await fetch(`/api/webhooks/${webhook.id}/test`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          event: eventType ?? webhook.events?.[0] ?? defaultEventType,
          payloadTemplate: webhook.payloadTemplate
        })
      });

      if (!response.ok) {
        throw new Error('Test failed');
      }

      await fetchWebhooks();
      if (activeWebhookId === webhook.id) {
        await fetchDeliveries(webhook.id);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Test failed');
    }
  };

  const handleToggle = async (webhook: Webhook, enabled: boolean) => {
    try {
      const response = await fetch(`/api/webhooks/${webhook.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled })
      });

      if (!response.ok) {
        throw new Error(`Failed to ${enabled ? 'enable' : 'disable'} webhook`);
      }

      setWebhooks(prev =>
        prev.map(item =>
          item.id === webhook.id
            ? { ...item, enabled, status: enabled ? 'active' : 'disabled' }
            : item
        )
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An error occurred');
    }
  };

  const handleCloseModal = () => {
    setModalMode('closed');
    setSelectedWebhook(null);
  };

  const transformFormToPayload = (values: WebhookFormValues) => {
    const auth =
      values.authType === 'bearer'
        ? { type: 'bearer', token: values.bearerToken }
        : { type: 'hmac', secret: values.secret };

    return {
      name: values.name,
      url: values.url,
      events: values.events,
      enabled: values.enabled ?? true,
      auth,
      secret: values.authType === 'hmac' ? values.secret : undefined,
      bearerToken: values.authType === 'bearer' ? values.bearerToken : undefined,
      payloadTemplate: values.payloadTemplate?.trim() || undefined,
      headers: values.headers?.filter(header => header.key) ?? []
    };
  };

  const transformWebhookToForm = (webhook: Webhook): Partial<WebhookFormValues> => {
    const authType = webhook.auth?.type ?? (webhook.bearerToken ? 'bearer' : 'hmac');
    return {
      name: webhook.name,
      url: webhook.url,
      authType,
      secret: webhook.auth?.secret ?? webhook.secret ?? '',
      bearerToken: webhook.auth?.token ?? webhook.bearerToken ?? '',
      events: webhook.events ?? [],
      headers: webhook.headers ?? [],
      enabled: getWebhookEnabled(webhook),
      payloadTemplate: webhook.payloadTemplate ?? ''
    };
  };

  const handleSubmit = async (values: WebhookFormValues) => {
    setSubmitting(true);
    setError(undefined);

    try {
      const payload = transformFormToPayload(values);
      const url =
        modalMode === 'create' ? '/api/webhooks' : `/api/webhooks/${selectedWebhook?.id}`;
      const method = modalMode === 'create' ? 'POST' : 'PUT';

      const response = await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });

      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.error || 'Failed to save webhook');
      }

      await fetchWebhooks();
      handleCloseModal();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An error occurred');
    } finally {
      setSubmitting(false);
    }
  };

  const handleConfirmDelete = async () => {
    if (!selectedWebhook) return;

    setSubmitting(true);
    try {
      const response = await fetch(`/api/webhooks/${selectedWebhook.id}`, {
        method: 'DELETE'
      });

      if (!response.ok) {
        throw new Error('Failed to delete webhook');
      }

      await fetchWebhooks();
      handleCloseModal();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An error occurred');
    } finally {
      setSubmitting(false);
    }
  };

  const handleRetryDelivery = async (delivery: WebhookDelivery) => {
    if (!activeWebhookId) return;

    try {
      const response = await fetch(
        `/api/webhooks/${activeWebhookId}/deliveries/${delivery.id}/retry`,
        { method: 'POST' }
      );

      if (!response.ok) {
        throw new Error('Failed to retry delivery');
      }

      await fetchDeliveries(activeWebhookId);
    } catch (err) {
      setDeliveriesError(err instanceof Error ? err.message : 'Failed to retry delivery');
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <div className="text-center">
          <div className="mx-auto h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent" />
          <p className="mt-4 text-sm text-muted-foreground">Loading webhooks...</p>
        </div>
      </div>
    );
  }

  if (error && webhooks.length === 0 && modalMode === 'closed') {
    return (
      <div className="rounded-lg border border-destructive/40 bg-destructive/10 p-6 text-center">
        <p className="text-sm text-destructive">{error}</p>
        <button
          type="button"
          onClick={fetchWebhooks}
          className="mt-4 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90"
        >
          Try again
        </button>
      </div>
    );
  }

  const authSummary = activeWebhook
    ? activeWebhook.auth?.type ?? (activeWebhook.bearerToken ? 'bearer' : 'hmac')
    : 'hmac';

  const authLabel = authSummary === 'bearer' ? 'Bearer token' : 'HMAC signature';
  const authHeader = authSummary === 'bearer' ? 'Authorization: Bearer ***' : 'X-Signature: sha256=***';

  const testEventOptions = activeWebhook?.events?.length
    ? activeWebhook.events
    : webhookEventOptions.map(option => option.value);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold">Webhooks</h1>
          <p className="text-muted-foreground">Deliver events to external systems.</p>
        </div>
        <button
          type="button"
          onClick={handleCreate}
          className="inline-flex h-10 items-center justify-center gap-2 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground transition hover:opacity-90"
        >
          <Plus className="h-4 w-4" />
          New Webhook
        </button>
      </div>

      {error && modalMode === 'closed' && (
        <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </div>
      )}

      <WebhookList
        webhooks={webhooks}
        onEdit={handleEdit}
        onDelete={handleDelete}
        onTest={handleTest}
        onToggle={handleToggle}
        onSelect={webhook => setActiveWebhookId(webhook.id)}
        selectedWebhookId={activeWebhookId}
      />

      {activeWebhook ? (
        <div className="grid gap-6 lg:grid-cols-[1.1fr_0.9fr]">
          <div className="rounded-lg border bg-card p-6 shadow-sm">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <h2 className="text-lg font-semibold">Webhook details</h2>
                <p className="text-sm text-muted-foreground">{activeWebhook.name}</p>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  onClick={() => handleEdit(activeWebhook)}
                  className="inline-flex h-9 items-center justify-center rounded-md border px-3 text-xs font-medium hover:bg-muted"
                >
                  Edit webhook
                </button>
                <button
                  type="button"
                  onClick={() => handleTest(activeWebhook, testEvent)}
                  className="inline-flex h-9 items-center justify-center gap-2 rounded-md bg-primary px-3 text-xs font-medium text-primary-foreground hover:opacity-90"
                >
                  <Send className="h-3.5 w-3.5" />
                  Test webhook
                </button>
              </div>
            </div>

            <div className="mt-6 grid gap-6 lg:grid-cols-2">
              <div className="space-y-4">
                <div>
                  <label className="text-sm font-medium">Endpoint</label>
                  <div className="mt-2 rounded-md border bg-muted/20 px-3 py-2 text-sm text-muted-foreground">
                    {activeWebhook.url}
                  </div>
                </div>
                <div>
                  <label className="text-sm font-medium">Test event</label>
                  <select
                    value={testEvent}
                    onChange={event => setTestEvent(event.target.value)}
                    className="mt-2 h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                  >
                    {testEventOptions.map(eventType => (
                      <option key={eventType} value={eventType}>
                        {labelMap.get(eventType) ?? eventType}
                      </option>
                    ))}
                  </select>
                  <p className="mt-2 text-xs text-muted-foreground">
                    Tests use the selected event and your payload template.
                  </p>
                </div>
                <div>
                  <label className="text-sm font-medium">Authentication</label>
                  <div className="mt-2 space-y-1 rounded-md border bg-muted/20 px-3 py-2 text-sm">
                    <p className="font-medium">{authLabel}</p>
                    <p className="text-xs text-muted-foreground">Header: {authHeader}</p>
                  </div>
                </div>
              </div>
              <div className="space-y-2">
                <label className="text-sm font-medium">Payload template preview</label>
                <div className="rounded-md border bg-background p-3 text-xs text-muted-foreground">
                  {payloadPreview.preview ? (
                    <pre className="max-h-64 overflow-auto">{payloadPreview.preview}</pre>
                  ) : (
                    <p className="text-xs text-muted-foreground">No payload template saved yet.</p>
                  )}
                </div>
                {payloadPreview.error && (
                  <p className="text-xs text-destructive">{payloadPreview.error}</p>
                )}
              </div>
            </div>
          </div>

          <div>
            {deliveriesLoading ? (
              <div className="flex items-center justify-center rounded-lg border bg-card p-6 shadow-sm">
                <div className="text-center">
                  <div className="mx-auto h-6 w-6 animate-spin rounded-full border-2 border-primary border-t-transparent" />
                  <p className="mt-3 text-sm text-muted-foreground">Loading delivery history...</p>
                </div>
              </div>
            ) : deliveriesError ? (
              <div className="rounded-lg border border-destructive/40 bg-destructive/10 p-6 text-center">
                <p className="text-sm text-destructive">{deliveriesError}</p>
                <button
                  type="button"
                  onClick={() => activeWebhookId && fetchDeliveries(activeWebhookId)}
                  className="mt-4 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90"
                >
                  Try again
                </button>
              </div>
            ) : (
              <WebhookDeliveryHistory deliveries={deliveries} onRetry={handleRetryDelivery} />
            )}
          </div>
        </div>
      ) : (
        <div className="rounded-lg border bg-card p-6 text-center text-sm text-muted-foreground">
          Select a webhook to view delivery history and testing tools.
        </div>
      )}

      {(modalMode === 'create' || modalMode === 'edit') && (
        <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-background/80 px-4 py-8">
          <div className="w-full max-w-3xl">
            <div className="mb-4 flex items-center justify-between">
              <h2 className="text-xl font-bold">
                {modalMode === 'create' ? 'Create Webhook' : 'Edit Webhook'}
              </h2>
            </div>
            {error && (
              <div className="mb-4 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
                {error}
              </div>
            )}
            <WebhookForm
              onSubmit={handleSubmit}
              onCancel={handleCloseModal}
              defaultValues={
                modalMode === 'edit' && selectedWebhook
                  ? transformWebhookToForm(selectedWebhook)
                  : undefined
              }
              submitLabel={modalMode === 'create' ? 'Create Webhook' : 'Save Changes'}
              loading={submitting}
            />
          </div>
        </div>
      )}

      {modalMode === 'delete' && selectedWebhook && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 px-4 py-8">
          <div className="w-full max-w-md rounded-lg border bg-card p-6 shadow-sm">
            <h2 className="text-lg font-semibold">Delete Webhook</h2>
            <p className="mt-2 text-sm text-muted-foreground">
              Are you sure you want to delete{' '}
              <span className="font-medium">{selectedWebhook.name}</span>? This action cannot be
              undone.
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
