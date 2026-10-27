import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import '@/lib/i18n';
import type { FlowDetailDto, FlowWebhookSecretRevealDto } from '@breeze/shared';
import { formatDateTime, formatRelativeTime } from '@/lib/dateTimeFormat';
import { ActionError } from '@/lib/runAction';
import { ConfirmDialog } from '../shared/ConfirmDialog';
import { showToast } from '../shared/Toast';
import { rotateWebhookSecret } from './api';
import { FlowDeliveriesList } from './FlowDeliveriesList';
import { FlowWebhookSecretDialog } from './FlowWebhookSecretDialog';

/**
 * The webhook tab (Tool Catalog W05 #5220, plan Task D2 / spec §6.8): the
 * URL, how a sender authenticates, the secret's fingerprint, the last refused
 * request, and the delivery log. Creating or rotating the secret reveals it
 * once; rotation cuts the old secret off immediately, so it asks first.
 * Actions need `automations.write` (UX only: the API re-checks).
 */
export function FlowWebhookPanel({
  flow,
  canWrite,
  onSecretChanged,
}: {
  flow: FlowDetailDto;
  canWrite: boolean;
  onSecretChanged: () => void;
}) {
  const { t } = useTranslation('flows');
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [reveal, setReveal] = useState<FlowWebhookSecretRevealDto | null>(null);
  const [copied, setCopied] = useState(false);

  const info = flow.webhook;
  const trigger = flow.definition.trigger;
  if (!info || trigger.type !== 'webhook') return null;
  const hasSecret = info.secretFingerprint !== null;

  const mint = async () => {
    if (busy) return;
    setBusy(true);
    try {
      setReveal(await rotateWebhookSecret(flow.id));
    } catch (err) {
      if (err instanceof ActionError && err.status === 401) return; // auth redirect handles it
      if (!(err instanceof ActionError)) showToast({ type: 'error', message: t('webhook.secret.failed') }); // ActionError already toasted
    } finally {
      setBusy(false);
      setConfirmOpen(false);
    }
  };

  const closeReveal = () => {
    setReveal(null); // the only copy of the plaintext in the page goes here
    onSecretChanged();
  };

  const copyUrl = async () => {
    try {
      await navigator.clipboard.writeText(info.url);
      setCopied(true);
    } catch {
      setCopied(false); // the URL stays selectable on screen
    }
  };

  const resolver = trigger.orgResolver;
  const resolverText = !resolver
    ? t('webhook.orgResolver.orgFlow')
    : 'system' in resolver && resolver.system
      ? t('webhook.orgResolver.externalId', { path: resolver.path, system: resolver.system })
      : t('webhook.orgResolver.breezeOrgId', { path: resolver.path });

  const snippet = info.authMode === 'hmac'
    ? [
        'X-Breeze-Timestamp: <unix seconds>',
        'X-Breeze-Signature: sha256=<hex HMAC-SHA256(secret, "<timestamp>.<raw body>")>',
        'Content-Type: application/json',
      ].join('\n')
    : ['X-Breeze-Webhook-Token: <secret>', 'Content-Type: application/json'].join('\n');

  return (
    <div className="space-y-6" data-testid="flow-webhook-panel">
      <section className="space-y-3">
        <h2 className="text-sm font-semibold">{t('webhook.title')}</h2>
        <dl className="grid gap-x-4 gap-y-2 text-sm sm:grid-cols-[12rem_1fr]">
          <dt className="text-muted-foreground">{t('webhook.url')}</dt>
          <dd className="flex min-w-0 items-center gap-2">
            <code className="min-w-0 select-all break-all rounded bg-muted px-1.5 py-0.5 font-mono text-xs" data-testid="flow-webhook-url">{info.url}</code>
            <button type="button" className="shrink-0 rounded border px-2 py-0.5 text-xs" onClick={copyUrl} data-testid="flow-webhook-url-copy">
              {copied ? t('webhook.copied') : t('webhook.copy')}
            </button>
          </dd>

          <dt className="text-muted-foreground">{t('webhook.authMode.label')}</dt>
          <dd data-testid="flow-webhook-auth">
            <div>{t(/* i18n-dynamic */ `webhook.authMode.${info.authMode}`)}</div>
            <p className="text-xs text-muted-foreground">{t(/* i18n-dynamic */ `webhook.authHelp.${info.authMode}`)}</p>
          </dd>

          <dt className="text-muted-foreground">{t('webhook.orgResolver.label')}</dt>
          <dd data-testid="flow-webhook-resolver">{resolverText}</dd>

          <dt className="text-muted-foreground">{t('webhook.secret.label')}</dt>
          <dd className="space-y-1">
            {hasSecret ? (
              <div className="text-xs text-muted-foreground" data-testid="flow-webhook-fingerprint">
                {t('webhook.secret.fingerprint')}: <span className="font-mono">{info.secretFingerprint}</span>
                {info.secretRotatedAt && <> · {t('webhook.secret.rotatedAt')} {formatDateTime(info.secretRotatedAt)}</>}
              </div>
            ) : (
              <p className="text-sm text-amber-700 dark:text-amber-400" data-testid="flow-webhook-no-secret">{t('webhook.secret.none')}</p>
            )}
            {canWrite && (hasSecret ? (
              <button type="button" className="rounded border px-3 py-1 text-sm" disabled={busy} onClick={() => setConfirmOpen(true)} data-testid="flow-webhook-rotate">
                {t('webhook.secret.rotate')}
              </button>
            ) : (
              <button type="button" className="rounded bg-primary px-3 py-1 text-sm text-primary-foreground" disabled={busy} onClick={mint} data-testid="flow-webhook-create">
                {t('webhook.secret.create')}
              </button>
            ))}
          </dd>

          <dt className="text-muted-foreground">{t('webhook.lastFailure.label')}</dt>
          <dd data-testid="flow-webhook-last-failure">
            {info.lastAuthFailureReason && info.lastAuthFailureAt ? (
              <>
                {t(/* i18n-dynamic */ `webhook.lastFailure.${info.lastAuthFailureReason}`)}{' '}
                <span className="text-xs text-muted-foreground" title={formatDateTime(info.lastAuthFailureAt)}>
                  ({formatRelativeTime(info.lastAuthFailureAt)})
                </span>
              </>
            ) : t('webhook.lastFailure.none')}
          </dd>
        </dl>
      </section>

      <section className="space-y-2">
        <h3 className="text-sm font-semibold">{t('webhook.signing.title')}</h3>
        <p className="text-sm text-muted-foreground">{t(/* i18n-dynamic */ `webhook.signing.${info.authMode}`)}</p>
        <pre className="overflow-x-auto rounded bg-muted p-3 font-mono text-xs" data-testid="flow-webhook-snippet">{snippet}</pre>
        <p className="text-xs text-muted-foreground">{t('webhook.signing.deliveryId', { header: 'X-Breeze-Delivery-Id' })}</p>
      </section>

      <FlowDeliveriesList flowId={flow.id} />

      <ConfirmDialog
        open={confirmOpen}
        onClose={() => setConfirmOpen(false)}
        onConfirm={mint}
        title={t('webhook.secret.rotateTitle')}
        message={t('webhook.secret.rotateMessage')}
        confirmLabel={t('webhook.secret.rotate')}
        variant="warning"
        isLoading={busy}
        confirmTestId="flow-webhook-rotate-confirm"
      />
      {reveal && <FlowWebhookSecretDialog reveal={reveal} onClose={closeReveal} />}
    </div>
  );
}
