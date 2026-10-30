import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import '@/lib/i18n';
import type { FlowWebhookSecretRevealDto } from '@breeze/shared';
import { Dialog } from '../shared/Dialog';

/**
 * Reveal-once webhook secret (Tool Catalog W05 #5220, plan Decision 3). The
 * parent holds the secret only while this dialog is open and drops it on
 * close, so it is never rendered again (the routes/apiKeys.ts pattern).
 */
export function FlowWebhookSecretDialog({
  reveal,
  onClose,
}: {
  reveal: FlowWebhookSecretRevealDto;
  onClose: () => void;
}) {
  const { t } = useTranslation('flows');
  const [copied, setCopied] = useState(false);
  const [copyFailed, setCopyFailed] = useState(false);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(reveal.secret);
      setCopied(true);
      setCopyFailed(false);
    } catch (err) {
      // Clipboard unavailable (permissions, insecure context): the value stays
      // selectable on screen, so the operator can copy it by hand. Log the
      // error only, never the secret.
      console.warn('[FlowWebhookSecretDialog] clipboard write failed', err);
      setCopied(false);
      setCopyFailed(true);
    }
  };

  return (
    <Dialog open onClose={onClose} title={t('webhook.secret.dialogTitle')} maxWidth="lg" className="space-y-4 p-6">
      <h2 className="text-lg font-semibold">{t('webhook.secret.dialogTitle')}</h2>
      <p className="text-sm text-amber-700 dark:text-amber-400" data-testid="flow-webhook-secret-warning">
        {t('webhook.secret.warning')}
      </p>
      <div className="flex items-center gap-2">
        <code className="flex-1 select-all break-all rounded bg-muted px-2 py-1.5 font-mono text-sm" data-testid="flow-webhook-secret-value">
          {reveal.secret}
        </code>
        <button type="button" className="rounded border px-2 py-1 text-sm" onClick={copy} data-testid="flow-webhook-secret-copy">
          {copied ? t('webhook.copied') : t('webhook.copy')}
        </button>
      </div>
      {copyFailed && (
        <p role="status" className="text-xs text-destructive" data-testid="flow-webhook-secret-copy-failed">{t('webhook.copyFailed')}</p>
      )}
      <p className="text-xs text-muted-foreground">
        {t('webhook.secret.fingerprint')}: <span className="font-mono">{reveal.fingerprint}</span>
      </p>
      <div className="flex justify-end">
        <button type="button" className="rounded bg-primary px-3 py-1.5 text-sm text-primary-foreground" onClick={onClose} data-testid="flow-webhook-secret-done">
          {t('webhook.secret.done')}
        </button>
      </div>
    </Dialog>
  );
}
