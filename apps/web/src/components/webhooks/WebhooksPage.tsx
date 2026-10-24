import { useState, useEffect, useCallback, useMemo } from 'react';
import { usePermissions } from '../../lib/permissions';
import AccessDenied from '../shared/AccessDenied';
import { Plus, Send, Webhook as WebhookIcon } from 'lucide-react';
import WebhookList, { type Webhook, isWebhookActive } from './WebhookList';
import WebhookForm, { type WebhookFormValues, webhookEventOptions } from './WebhookForm';
import WebhookDeliveryHistory, { normalizeDelivery, type WebhookDelivery } from './WebhookDeliveryHistory';
import { fetchWithAuth, handleSessionExpired } from '../../stores/auth';
import { useOrgStore } from '../../stores/orgStore';
import { ActionError, handleActionError, runAction } from '@/lib/runAction';
import { formSecretValue, isMaskedSecret, MASKED_SECRET } from '@/lib/redactedSecret';
import { Trans, useTranslation } from 'react-i18next';
import { Dialog } from '../shared/Dialog';
import { IntegrationPanelHeader } from '../integrations/IntegrationPanelHeader';
// Initializes the shared i18next singleton. Islands hydrate independently, so
// an island that hydrates before whichever other island happens to pull i18n in
// would otherwise render raw keys (and mismatch the SSR markup).
import '../../lib/i18n';
import { useStableT } from '@/lib/i18n/useStableT';

type ModalMode = 'closed' | 'create' | 'edit' | 'delete';

const FORM_TITLE_ID = 'webhook-form-dialog-title';
const DELETE_TITLE_ID = 'webhook-delete-dialog-title';

export interface WebhooksPageProps {
  /** Rendered as a panel inside the Integrations page, which owns the page h1:
   *  the title drops to an h2 panel header. Standalone routes keep the h1. */
  embedded?: boolean;
}

const defaultEventType = webhookEventOptions[0]?.value ?? 'device.online';

// #9652: the API stores bearer auth as an encrypted `Authorization: Bearer
// <token>` custom header. The form shows it as the Bearer option instead of
// a custom header row, and writes it back as that header.
const isAuthorizationHeader = (key: string) => key.trim().toLowerCase() === 'authorization';
const webhookFormAuthType = (webhook: Webhook): 'hmac' | 'bearer' =>
  webhook.authType === 'bearer' ? 'bearer' : 'hmac';

// Reading webhooks requires webhooks:read (GET /webhooks and the delivery
// history). Without it the page shows the permission-denied state and makes no
// request. UX only — every route re-checks server-side.
export default function WebhooksPage({ embedded = false }: WebhooksPageProps = {}) {
  const { permissions, can } = usePermissions();
  if (!can('webhooks', 'read')) {
    // Grants still loading: render nothing rather than flash the denied state.
    if (!permissions) return null;
    return <AccessDenied testId="webhooks-access-denied" />;
  }
  return <WebhooksPageContent embedded={embedded} />;
}

function WebhooksPageContent({ embedded }: { embedded: boolean }) {
  const { t } = useTranslation('common');
  const { can } = usePermissions();
  // UX gate: every webhook write (create, edit, delete, pause/resume, test,
  // retry) requires organizations:write. A webhooks:read-only caller sees the
  // list, details and delivery history with no write controls.
  const canManage = can('organizations', 'write');
  const stableT = useStableT(t); // #3632: effect-safe translator; JSX keeps `t`
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
        throw new Error(stableT('longTail.webhooks.WebhooksPage.errors.fetchWebhooks'));
      }
      const data = await response.json();
      setWebhooks(data.data ?? data.webhooks ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : stableT('longTail.webhooks.WebhooksPage.errors.generic'));
    } finally {
      setLoading(false);
    }
  }, [stableT]);

  const fetchDeliveries = useCallback(async (webhookId: string) => {
    try {
      setDeliveriesLoading(true);
      setDeliveriesError(undefined);
      const response = await fetchWithAuth(`/webhooks/${webhookId}/deliveries`);
      if (!response.ok) {
        throw new Error(stableT('longTail.webhooks.WebhooksPage.errors.fetchDeliveries'));
      }
      const data = await response.json();
      const rows: Record<string, unknown>[] = data.data ?? data.deliveries ?? [];
      setDeliveries(rows.map(normalizeDelivery));
    } catch (err) {
      setDeliveriesError(err instanceof Error ? err.message : stableT('longTail.webhooks.WebhooksPage.errors.loadDeliveries'));
      setDeliveries([]);
    } finally {
      setDeliveriesLoading(false);
    }
  }, [stableT]);

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
      await runAction({
        request: () =>
          fetchWithAuth(`/webhooks/${webhook.id}/test`, {
            method: 'POST',
            body: JSON.stringify({
              event: eventType ?? webhook.events?.[0] ?? defaultEventType
            })
          }),
        errorFallback: t('longTail.webhooks.WebhooksPage.errors.testFailed'),
        successMessage: t('longTail.webhooks.WebhooksPage.success.testQueued'),
        onUnauthorized: handleSessionExpired,
      });

      await fetchWebhooks();
      if (activeWebhookId === webhook.id) {
        await fetchDeliveries(webhook.id);
      }
    } catch (err) {
      handleActionError(err, t('longTail.webhooks.WebhooksPage.errors.testFailed'));
    }
  };

  const handleToggle = async (webhook: Webhook, enabled: boolean) => {
    const errorFallback = enabled
      ? t('longTail.webhooks.WebhooksPage.errors.enableWebhook')
      : t('longTail.webhooks.WebhooksPage.errors.disableWebhook');
    try {
      // PATCH speaks `status`; an `enabled` key is stripped by the API's
      // schema, which made this toggle a silent no-op (#6767).
      const updated = await runAction<Partial<Webhook>>({
        request: () => fetchWithAuth(`/webhooks/${webhook.id}`, {
          method: 'PATCH',
          body: JSON.stringify({ status: enabled ? 'active' : 'paused' })
        }),
        errorFallback,
        successMessage: enabled
          ? t('longTail.webhooks.WebhooksPage.success.enabled')
          : t('longTail.webhooks.WebhooksPage.success.disabled'),
        onUnauthorized: handleSessionExpired,
      });

      // Render what the server saved, not what we asked for.
      setWebhooks(prev =>
        prev.map(item =>
          item.id === webhook.id
            ? { ...item, status: updated?.status ?? (enabled ? 'active' : 'paused') }
            : item
        )
      );
    } catch (err) {
      handleActionError(err, errorFallback);
    }
  };

  const handleCloseModal = () => {
    setModalMode('closed');
    setSelectedWebhook(null);
  };

  const transformFormToPayload = (values: WebhookFormValues, current: Webhook | null) => {
    const enabled = values.enabled ?? true;
    // The API has no `enabled` field. On edit, only send `status` when the
    // switch actually changed, so saving an untouched `failed` webhook does not
    // quietly re-activate it (#6767).
    const status = current && enabled === isWebhookActive(current)
      ? undefined
      : enabled ? 'active' : 'paused';
    const headers = values.headers?.filter(header => header.key) ?? [];
    let secret: { secret?: string | null } = { secret: values.secret };
    if (values.authType === 'bearer') {
      // A masked token means "keep the stored one": the API resolves a masked
      // value by exact key, then by position, so send the stored header's own
      // key spelling back or it may resolve to a different header.
      const storedKey = current && webhookFormAuthType(current) === 'bearer'
        ? current.headers?.find(header => isAuthorizationHeader(header.key))?.key
        : undefined;
      const token = (values.bearerToken ?? '').trim().replace(/^bearer\s+/i, '');
      headers.push({
        key: storedKey ?? 'Authorization',
        value: isMaskedSecret(token) ? MASKED_SECRET : `Bearer ${token}`,
      });
      // Switching an HMAC webhook to bearer clears its signing secret.
      secret = current && webhookFormAuthType(current) !== 'bearer' ? { secret: null } : {};
    }

    return {
      name: values.name,
      url: values.url,
      events: values.events,
      ...(status ? { status } : {}),
      ...secret,
      headers
    };
  };

  const transformWebhookToForm = (webhook: Webhook): Partial<WebhookFormValues> => {
    const authType = webhookFormAuthType(webhook);
    // The API never returns the stored secret, only `hasSecret`, and returns
    // each header value as a redaction marker. Pre-fill the masked string the
    // API reads as "keep what is stored"; a blank secret would fail HMAC
    // validation and block every edit until it was re-typed (#4983).
    const headers = webhook.headers ?? [];
    const bearerHeader = authType === 'bearer'
      ? headers.find(header => isAuthorizationHeader(header.key))
      : undefined;
    return {
      name: webhook.name,
      url: webhook.url,
      authType,
      secret: webhook.hasSecret ? MASKED_SECRET : '',
      bearerToken: bearerHeader ? formSecretValue(bearerHeader.value) : '',
      events: webhook.events ?? [],
      // The bearer Authorization header is edited through the Bearer option,
      // not as a custom header row.
      headers: headers
        .filter(header => header !== bearerHeader)
        .map(header => ({
          key: header.key,
          value: formSecretValue(header.value),
        })),
      enabled: isWebhookActive(webhook)
    };
  };

  const handleSubmit = async (values: WebhookFormValues) => {
    setSubmitting(true);
    setError(undefined);

    try {
      const payload = transformFormToPayload(values, modalMode === 'create' ? null : selectedWebhook);
      const url =
        modalMode === 'create' ? '/webhooks' : `/webhooks/${selectedWebhook?.id}`;
      const method = modalMode === 'create' ? 'POST' : 'PATCH';

      // Include orgId when creating a new webhook
      const requestPayload = modalMode === 'create' && currentOrgId
        ? { ...payload, orgId: currentOrgId }
        : payload;

      await runAction({
        request: () =>
          fetchWithAuth(url, {
            method,
            body: JSON.stringify(requestPayload)
          }),
        errorFallback: t('longTail.webhooks.WebhooksPage.errors.saveWebhook'),
        successMessage: modalMode === 'create'
          ? t('longTail.webhooks.WebhooksPage.success.created')
          : t('longTail.webhooks.WebhooksPage.success.updated'),
        onUnauthorized: handleSessionExpired,
      });

      await fetchWebhooks();
      handleCloseModal();
    } catch (err) {
      // runAction toasted the failure; also keep the inline message inside the
      // still-open form modal so it sits next to the fields being edited.
      if (err instanceof ActionError) {
        if (err.status !== 401) setError(err.message);
      } else {
        handleActionError(err, t('longTail.webhooks.WebhooksPage.errors.saveWebhook'));
      }
    } finally {
      setSubmitting(false);
    }
  };

  const handleConfirmDelete = async () => {
    if (!selectedWebhook) return;

    setSubmitting(true);
    try {
      await runAction({
        request: () =>
          fetchWithAuth(`/webhooks/${selectedWebhook.id}`, {
            method: 'DELETE'
          }),
        errorFallback: t('longTail.webhooks.WebhooksPage.errors.deleteWebhook'),
        onUnauthorized: handleSessionExpired,
      });

      await fetchWebhooks();
      handleCloseModal();
    } catch (err) {
      // The page error banner is hidden while any modal is open (#3531), so
      // runAction's toast is the feedback; the delete modal stays open on a
      // real failure so the operator can retry or cancel. A 404 means the row
      // is already gone (deleted elsewhere) — retrying can't help, so close
      // the modal and refetch instead of leaving a stale row on screen (sweep A2).
      if (err instanceof ActionError && err.status === 404) {
        await fetchWebhooks();
        handleCloseModal();
        return;
      }
      handleActionError(err, t('longTail.webhooks.WebhooksPage.errors.deleteWebhook'));
    } finally {
      setSubmitting(false);
    }
  };

  const handleRetryDelivery = async (delivery: WebhookDelivery) => {
    if (!activeWebhookId) return;

    try {
      await runAction({
        request: () =>
          fetchWithAuth(
            `/webhooks/${activeWebhookId}/retry/${delivery.id}`,
            { method: 'POST' }
          ),
        errorFallback: t('longTail.webhooks.WebhooksPage.errors.retryDelivery'),
        successMessage: t('longTail.webhooks.WebhooksPage.success.retryQueued'),
        onUnauthorized: handleSessionExpired,
      });

      await fetchDeliveries(activeWebhookId);
    } catch (err) {
      if (err instanceof ActionError && err.status === 401) return;
      setDeliveriesError(err instanceof Error ? err.message : t('longTail.webhooks.WebhooksPage.errors.retryDelivery'));
      handleActionError(err, t('longTail.webhooks.WebhooksPage.errors.retryDelivery'));
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

  const authSummary = activeWebhook ? webhookFormAuthType(activeWebhook) : 'hmac';

  const authLabel = authSummary === 'bearer' ? t('longTail.webhooks.WebhooksPage.auth.bearerToken') : t('longTail.webhooks.WebhooksPage.auth.hmacSignature');
  const authHeader = authSummary === 'bearer' ? 'Authorization: Bearer ***' : 'X-Breeze-Signature: sha256=***, X-Breeze-Signature-Timestamp';

  const testEventOptions = activeWebhook?.events?.length
    ? activeWebhook.events
    : webhookEventOptions.map(option => option.value);

  const newWebhookButton = canManage ? (
    <button
      type="button"
      onClick={handleCreate}
      className="inline-flex h-10 items-center justify-center gap-2 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground transition hover:opacity-90"
    >
      <Plus className="h-4 w-4" />
      {t('longTail.webhooks.WebhooksPage.actions.newWebhook')}
    </button>
  ) : null;

  return (
    <div className="space-y-6">
      {embedded ? (
        <IntegrationPanelHeader
          icon={<WebhookIcon className="h-4 w-4" />}
          title={t('longTail.webhooks.WebhooksPage.title')}
          description={t('longTail.webhooks.WebhooksPage.subtitle')}
          actions={newWebhookButton}
          headingTestId="webhooks-panel-heading"
        />
      ) : (
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <h1 className="text-xl font-semibold tracking-tight">{t('longTail.webhooks.WebhooksPage.title')}</h1>
            <p className="text-muted-foreground">{t('longTail.webhooks.WebhooksPage.subtitle')}</p>
          </div>
          {newWebhookButton}
        </div>
      )}

      {error && modalMode === 'closed' && (
        <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </div>
      )}

      <WebhookList
        webhooks={webhooks}
        showTitle={!embedded}
        onEdit={canManage ? handleEdit : undefined}
        onDelete={canManage ? handleDelete : undefined}
        onTest={canManage ? handleTest : undefined}
        onToggle={canManage ? handleToggle : undefined}
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
              {canManage && (
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
              )}
            </div>

            <div className="mt-6">
              <div className="space-y-4">
                <div>
                  <label className="text-sm font-medium">{t('longTail.webhooks.WebhooksPage.details.endpoint')}</label>
                  <div className="mt-2 rounded-md border bg-muted/20 px-3 py-2 text-sm text-muted-foreground">
                    {activeWebhook.url}
                  </div>
                </div>
                {canManage && (
                <div>
                  <label htmlFor="webhook-test-event" className="text-sm font-medium">{t('longTail.webhooks.WebhooksPage.details.testEvent')}</label>
                  <select
                    id="webhook-test-event"
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
                )}
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
              <WebhookDeliveryHistory deliveries={deliveries} onRetry={canManage ? handleRetryDelivery : undefined} />
            )}
          </div>
        </div>
      ) : (
        <div className="rounded-lg border bg-card p-6 text-center text-sm text-muted-foreground">
          {t('longTail.webhooks.WebhooksPage.emptySelection')}
        </div>
      )}

      {(modalMode === 'create' || modalMode === 'edit') && (
        // WebhookForm draws its own card, so the dialog panel stays transparent
        // rather than nesting a card in a card.
        <Dialog
          open
          onClose={handleCloseModal}
          title={modalMode === 'create' ? t('longTail.webhooks.WebhooksPage.modal.createTitle') : t('longTail.webhooks.WebhooksPage.modal.editTitle')}
          labelledBy={FORM_TITLE_ID}
          maxWidth="3xl"
          alignTop
          className="!border-0 !bg-transparent !shadow-none"
        >
          <div className="mb-4 flex items-center justify-between">
            <h2 id={FORM_TITLE_ID} className="text-xl font-bold">
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
        </Dialog>
      )}

      {modalMode === 'delete' && selectedWebhook && (
        // Dialog rather than ConfirmDialog: the confirm copy bolds the webhook
        // name through <Trans>, and ConfirmDialog's message is plain text.
        <Dialog
          open
          onClose={handleCloseModal}
          title={t('longTail.webhooks.WebhooksPage.delete.title')}
          labelledBy={DELETE_TITLE_ID}
          maxWidth="md"
          className="p-6"
        >
          <h2 id={DELETE_TITLE_ID} className="text-lg font-semibold">{t('longTail.webhooks.WebhooksPage.delete.title')}</h2>
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
        </Dialog>
      )}
    </div>
  );
}
