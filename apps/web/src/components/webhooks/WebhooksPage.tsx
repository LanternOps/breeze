import { useState, useEffect, useCallback, useMemo } from 'react';
import { Plus, Send } from 'lucide-react';
import WebhookList, { type Webhook } from './WebhookList';
import WebhookForm, { type WebhookFormValues, webhookEventOptions } from './WebhookForm';
import WebhookDeliveryHistory, { type WebhookDelivery } from './WebhookDeliveryHistory';
import { fetchWithAuth } from '../../stores/auth';
import { useOrgStore } from '../../stores/orgStore';
import { extractApiError } from '@/lib/apiError';
import { Trans, useTranslation } from 'react-i18next';
// Initializes the shared i18next singleton. Islands hydrate independently, so
// an island that hydrates before whichever other island happens to pull i18n in
// would otherwise render raw keys (and mismatch the SSR markup).
import '../../lib/i18n';

type ModalMode = 'closed' | 'create' | 'edit' | 'delete';

type PayloadPreview = {
  preview: string;
  error: string;
};

const defaultEventType = webhookEventOptions[0]?.value ?? 'device.online';

const formatPayloadPreview = (payload: string | null | undefined, t: (key: string) => string): PayloadPreview => {
  if (!payload?.trim()) {
    return { preview: '', error: '' };
  }

  try {
    return { preview: JSON.stringify(JSON.parse(payload), null, 2), error: '' };
  } catch {
    return { preview: payload, error: t('longTail.webhooks.WebhooksPage.errors.invalidPayloadTemplate') };
  }
};

const getWebhookEnabled = (webhook: Webhook) => {
  if (typeof webhook.enabled === 'boolean') return webhook.enabled;
  return webhook.status !== 'disabled';
};

export default function WebhooksPage() {
  const { t } = useTranslation('common');
  const { currentOrgId } = useOrgStore();
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
      const response = await fetchWithAuth('/webhooks');
      if (!response.ok) {
        throw new Error(t('longTail.webhooks.WebhooksPage.errors.fetchWebhooks'));
      }
      const data = await response.json();
      setWebhooks(data.data ?? data.webhooks ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : t('longTail.webhooks.WebhooksPage.errors.generic'));
    } finally {
      setLoading(false);
    }
  }, [t]);

  const fetchDeliveries = useCallback(async (webhookId: string) => {
    try {
      setDeliveriesLoading(true);
      setDeliveriesError(undefined);
      const response = await fetchWithAuth(`/webhooks/${webhookId}/deliveries`);
      if (!response.ok) {
        throw new Error(t('longTail.webhooks.WebhooksPage.errors.fetchDeliveries'));
      }
      const data = await response.json();
      setDeliveries(data.data ?? data.deliveries ?? []);
    } catch (err) {
      setDeliveriesError(err instanceof Error ? err.message : t('longTail.webhooks.WebhooksPage.errors.loadDeliveries'));
      setDeliveries([]);
    } finally {
      setDeliveriesLoading(false);
    }
  }, [t]);

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
    () => formatPayloadPreview(activeWebhook?.payloadTemplate, t),
    [activeWebhook?.payloadTemplate, t]
  );

  const labelMap = useMemo(() => {
    const map = new Map<string, string>();
    webhookEventOptions.forEach(option => map.set(option.value, t(/* i18n-dynamic */ option.labelKey)));
    return map;
  }, [t]);

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
      const response = await fetchWithAuth(`/webhooks/${webhook.id}/test`, {
        method: 'POST',
        body: JSON.stringify({
          event: eventType ?? webhook.events?.[0] ?? defaultEventType,
          payloadTemplate: webhook.payloadTemplate
        })
      });

      if (!response.ok) {
        throw new Error(t('longTail.webhooks.WebhooksPage.errors.testFailed'));
      }

      await fetchWebhooks();
      if (activeWebhookId === webhook.id) {
        await fetchDeliveries(webhook.id);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : t('longTail.webhooks.WebhooksPage.errors.testFailed'));
    }
  };

  const handleToggle = async (webhook: Webhook, enabled: boolean) => {
    try {
      const response = await fetchWithAuth(`/webhooks/${webhook.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ enabled })
      });

      if (!response.ok) {
        throw new Error(enabled ? t('longTail.webhooks.WebhooksPage.errors.enableWebhook') : t('longTail.webhooks.WebhooksPage.errors.disableWebhook'));
      }

      setWebhooks(prev =>
        prev.map(item =>
          item.id === webhook.id
            ? { ...item, enabled, status: enabled ? 'active' : 'disabled' }
            : item
        )
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : t('longTail.webhooks.WebhooksPage.errors.generic'));
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
        modalMode === 'create' ? '/webhooks' : `/webhooks/${selectedWebhook?.id}`;
      const method = modalMode === 'create' ? 'POST' : 'PATCH';

      // Include orgId when creating a new webhook
      const requestPayload = modalMode === 'create' && currentOrgId
        ? { ...payload, orgId: currentOrgId }
        : payload;

      const response = await fetchWithAuth(url, {
        method,
        body: JSON.stringify(requestPayload)
      });

      if (!response.ok) {
        const data = await response.json();
        throw new Error(extractApiError(data, t('longTail.webhooks.WebhooksPage.errors.saveWebhook')));
      }

      await fetchWebhooks();
      handleCloseModal();
    } catch (err) {
      setError(err instanceof Error ? err.message : t('longTail.webhooks.WebhooksPage.errors.generic'));
    } finally {
      setSubmitting(false);
    }
  };

  const handleConfirmDelete = async () => {
    if (!selectedWebhook) return;

    setSubmitting(true);
    try {
      const response = await fetchWithAuth(`/webhooks/${selectedWebhook.id}`, {
        method: 'DELETE'
      });

      if (!response.ok) {
        throw new Error(t('longTail.webhooks.WebhooksPage.errors.deleteWebhook'));
      }

      await fetchWebhooks();
      handleCloseModal();
    } catch (err) {
      setError(err instanceof Error ? err.message : t('longTail.webhooks.WebhooksPage.errors.generic'));
    } finally {
      setSubmitting(false);
    }
  };

  const handleRetryDelivery = async (delivery: WebhookDelivery) => {
    if (!activeWebhookId) return;

    try {
      const response = await fetchWithAuth(
        `/webhooks/${activeWebhookId}/deliveries/${delivery.id}/retry`,
        { method: 'POST' }
      );

      if (!response.ok) {
        throw new Error(t('longTail.webhooks.WebhooksPage.errors.retryDelivery'));
      }

      await fetchDeliveries(activeWebhookId);
    } catch (err) {
      setDeliveriesError(err instanceof Error ? err.message : t('longTail.webhooks.WebhooksPage.errors.retryDelivery'));
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <div className="text-center">
          <div className="mx-auto h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent" />
          <p className="mt-4 text-sm text-muted-foreground">{t('longTail.webhooks.WebhooksPage.loading')}</p>
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
          {t('longTail.webhooks.WebhooksPage.actions.tryAgain')}
        </button>
      </div>
    );
  }

  const authSummary = activeWebhook
    ? activeWebhook.auth?.type ?? (activeWebhook.bearerToken ? 'bearer' : 'hmac')
    : 'hmac';

  const authLabel = authSummary === 'bearer' ? t('longTail.webhooks.WebhooksPage.auth.bearerToken') : t('longTail.webhooks.WebhooksPage.auth.hmacSignature');
  const authHeader = authSummary === 'bearer' ? 'Authorization: Bearer ***' : 'X-Signature: sha256=***';

  const testEventOptions = activeWebhook?.events?.length
    ? activeWebhook.events
    : webhookEventOptions.map(option => option.value);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">{t('longTail.webhooks.WebhooksPage.title')}</h1>
          <p className="text-muted-foreground">{t('longTail.webhooks.WebhooksPage.subtitle')}</p>
        </div>
        <button
          type="button"
          onClick={handleCreate}
          className="inline-flex h-10 items-center justify-center gap-2 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground transition hover:opacity-90"
        >
          <Plus className="h-4 w-4" />
          {t('longTail.webhooks.WebhooksPage.actions.newWebhook')}
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
          <div className="rounded-lg border bg-card p-6 shadow-xs">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <h2 className="text-lg font-semibold">{t('longTail.webhooks.WebhooksPage.details.title')}</h2>
                <p className="text-sm text-muted-foreground">{activeWebhook.name}</p>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  onClick={() => handleEdit(activeWebhook)}
                  className="inline-flex h-9 items-center justify-center rounded-md border px-3 text-xs font-medium hover:bg-muted"
                >
                  {t('longTail.webhooks.WebhooksPage.actions.editWebhook')}
                </button>
                <button
                  type="button"
                  onClick={() => handleTest(activeWebhook, testEvent)}
                  className="inline-flex h-9 items-center justify-center gap-2 rounded-md bg-primary px-3 text-xs font-medium text-primary-foreground hover:opacity-90"
                >
                  <Send className="h-3.5 w-3.5" />
                  {t('longTail.webhooks.WebhooksPage.actions.testWebhook')}
                </button>
              </div>
            </div>

            <div className="mt-6 grid gap-6 lg:grid-cols-2">
              <div className="space-y-4">
                <div>
                  <label className="text-sm font-medium">{t('longTail.webhooks.WebhooksPage.details.endpoint')}</label>
                  <div className="mt-2 rounded-md border bg-muted/20 px-3 py-2 text-sm text-muted-foreground">
                    {activeWebhook.url}
                  </div>
                </div>
                <div>
                  <label className="text-sm font-medium">{t('longTail.webhooks.WebhooksPage.details.testEvent')}</label>
                  <select
                    value={testEvent}
                    onChange={event => setTestEvent(event.target.value)}
                    className="mt-2 h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
                  >
                    {testEventOptions.map(eventType => (
                      <option key={eventType} value={eventType}>
                        {labelMap.get(eventType) ?? eventType}
                      </option>
                    ))}
                  </select>
                  <p className="mt-2 text-xs text-muted-foreground">
                    {t('longTail.webhooks.WebhooksPage.details.testEventHelp')}
                  </p>
                </div>
                <div>
                  <label className="text-sm font-medium">{t('longTail.webhooks.WebhooksPage.details.authentication')}</label>
                  <div className="mt-2 space-y-1 rounded-md border bg-muted/20 px-3 py-2 text-sm">
                    <p className="font-medium">{authLabel}</p>
                    <p className="text-xs text-muted-foreground">
                      {t('longTail.webhooks.WebhooksPage.auth.header', { header: authHeader })}
                    </p>
                  </div>
                </div>
              </div>
              <div className="space-y-2">
                <label className="text-sm font-medium">{t('longTail.webhooks.WebhooksPage.details.payloadPreview')}</label>
                <div className="rounded-md border bg-background p-3 text-xs text-muted-foreground">
                  {payloadPreview.preview ? (
                    <pre className="max-h-64 overflow-auto">{payloadPreview.preview}</pre>
                  ) : (
                    <p className="text-xs text-muted-foreground">{t('longTail.webhooks.WebhooksPage.details.noPayloadTemplate')}</p>
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
              <div className="flex items-center justify-center rounded-lg border bg-card p-6 shadow-xs">
                <div className="text-center">
                  <div className="mx-auto h-6 w-6 animate-spin rounded-full border-2 border-primary border-t-transparent" />
                  <p className="mt-3 text-sm text-muted-foreground">{t('longTail.webhooks.WebhooksPage.loadingDeliveryHistory')}</p>
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
                  {t('longTail.webhooks.WebhooksPage.actions.tryAgain')}
                </button>
              </div>
            ) : (
              <WebhookDeliveryHistory deliveries={deliveries} onRetry={handleRetryDelivery} />
            )}
          </div>
        </div>
      ) : (
        <div className="rounded-lg border bg-card p-6 text-center text-sm text-muted-foreground">
          {t('longTail.webhooks.WebhooksPage.emptySelection')}
        </div>
      )}

      {(modalMode === 'create' || modalMode === 'edit') && (
        <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-background/80 px-4 py-8">
          <div className="w-full max-w-3xl">
            <div className="mb-4 flex items-center justify-between">
              <h2 className="text-xl font-bold">
                {modalMode === 'create' ? t('longTail.webhooks.WebhooksPage.modal.createTitle') : t('longTail.webhooks.WebhooksPage.modal.editTitle')}
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
              submitLabel={modalMode === 'create' ? t('longTail.webhooks.WebhooksPage.actions.createWebhook') : t('longTail.webhooks.WebhooksPage.actions.saveChanges')}
              loading={submitting}
            />
          </div>
        </div>
      )}

      {modalMode === 'delete' && selectedWebhook && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 px-4 py-8">
          <div className="w-full max-w-md rounded-lg border bg-card p-6 shadow-xs">
            <h2 className="text-lg font-semibold">{t('longTail.webhooks.WebhooksPage.delete.title')}</h2>
            <p className="mt-2 text-sm text-muted-foreground">
              <Trans
                i18nKey="longTail.webhooks.WebhooksPage.delete.confirm"
                ns="common"
                values={{ name: selectedWebhook.name }}
                components={{ strong: <span className="font-medium" /> }}
              />
            </p>
            <div className="mt-6 flex justify-end gap-3">
              <button
                type="button"
                onClick={handleCloseModal}
                className="h-10 rounded-md border px-4 text-sm font-medium text-muted-foreground transition hover:text-foreground"
              >
                {t('common:actions.cancel')}
              </button>
              <button
                type="button"
                onClick={handleConfirmDelete}
                disabled={submitting}
                className="inline-flex h-10 items-center justify-center rounded-md bg-destructive px-4 text-sm font-medium text-destructive-foreground transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {submitting ? t('longTail.webhooks.WebhooksPage.actions.deleting') : t('common:actions.delete')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
