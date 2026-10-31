import { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import '@/lib/i18n';
import { fetchWithAuth } from '../../stores/auth';
import { runAction, ActionError } from '../../lib/runAction';
import { navigateTo } from '@/lib/navigation';
import { Dialog } from '../shared/Dialog';

// Mirrors the API bound (routes/dnsSecurity.ts integrationConfigSchema).
const MIN_DAYS = 1;
const MAX_DAYS = 365;

/**
 * #10020 / #10054 — edit what Breeze stores for an integration: whether
 * allowed queries are synced at all (`config.storeAllowedTraffic`, default
 * off = blocked and redirected only) and how long events are kept
 * (`config.retentionDays`). This modal is the one home of both settings.
 *
 * Retention: `config.retentionDays`. Empty sends `null`,
 * which clears the override so the deployment default applies
 * (DNS_SECURITY_RETENTION_DAYS_DEFAULT, 90 days). The nightly sweep in
 * apps/api/src/jobs/dnsSecurityRetention.ts applies it to events and daily
 * statistics alike.
 */
export default function EditDnsRetentionModal({
  integration,
  onClose,
  onSaved,
}: {
  integration: { id: string; name: string; retentionDays: number | null; storeAllowedTraffic: boolean };
  onClose: () => void;
  onSaved: () => void;
}) {
  const { t } = useTranslation('security');
  const inputId = useId();
  const helpId = useId();
  const allowedHelpId = useId();
  const [value, setValue] = useState(integration.retentionDays?.toString() ?? '');
  const [storeAllowedTraffic, setStoreAllowedTraffic] = useState(integration.storeAllowedTraffic);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    const trimmed = value.trim();
    let retentionDays: number | null = null;
    if (trimmed !== '') {
      const parsed = Number(trimmed);
      if (!Number.isInteger(parsed) || parsed < MIN_DAYS || parsed > MAX_DAYS) {
        setError(t('dnsSecurityEditDnsRetentionModal.invalid'));
        return;
      }
      retentionDays = parsed;
    }

    setSubmitting(true);
    try {
      await runAction({
        request: () => fetchWithAuth(`/dns-security/integrations/${integration.id}`, {
          method: 'PATCH',
          body: JSON.stringify({ retentionDays, storeAllowedTraffic }),
        }),
        errorFallback: t('dnsSecurityEditDnsRetentionModal.messages.saveFailed', { name: integration.name }),
        successMessage: t('dnsSecurityEditDnsRetentionModal.messages.saved', { name: integration.name }),
        onUnauthorized: () => void navigateTo('/login', { replace: true }),
      });
      onSaved();
      onClose();
    } catch (err) {
      if (err instanceof ActionError) {
        if (err.status === 401) return;
        setError(err.message);
      } else {
        setError(t('dnsSecurityEditDnsRetentionModal.messages.saveFailed', { name: integration.name }));
      }
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog
      open
      onClose={onClose}
      title={t('dnsSecurityEditDnsRetentionModal.title')}
      maxWidth="md"
      className="p-6"
    >
      <h2 className="text-lg font-semibold">{t('dnsSecurityEditDnsRetentionModal.title')}</h2>
      <p className="mt-1 text-sm text-muted-foreground">
        {t('dnsSecurityEditDnsRetentionModal.description')}
      </p>

      <form onSubmit={handleSubmit} className="mt-4 space-y-4" noValidate>
        <div>
          <label className="flex items-start gap-2 text-sm font-medium">
            <input
              type="checkbox"
              data-testid="dns-store-allowed-traffic"
              checked={storeAllowedTraffic}
              onChange={(e) => setStoreAllowedTraffic(e.target.checked)}
              aria-describedby={allowedHelpId}
              className="mt-0.5 h-4 w-4 rounded border"
            />
            {t('dnsSecurityEditDnsRetentionModal.storeAllowedTraffic.label')}
          </label>
          <p id={allowedHelpId} className="mt-1 text-xs text-muted-foreground">
            {storeAllowedTraffic
              ? t('dnsSecurityEditDnsRetentionModal.storeAllowedTraffic.helpOn')
              : t('dnsSecurityEditDnsRetentionModal.storeAllowedTraffic.helpOff')}
          </p>
        </div>

        <div>
          <label htmlFor={inputId} className="mb-1 block text-sm font-medium">
            {t('dnsSecurityEditDnsRetentionModal.fieldLabel')}
          </label>
          <input
            id={inputId}
            type="number"
            inputMode="numeric"
            min={MIN_DAYS}
            max={MAX_DAYS}
            step={1}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            aria-describedby={helpId}
            className="h-9 w-full rounded-md border bg-background px-2 text-sm"
          />
          <p id={helpId} className="mt-1 text-xs text-muted-foreground">
            {t('dnsSecurityEditDnsRetentionModal.fieldHelp')}
          </p>
        </div>

        {error && (
          <div role="alert" className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
            {error}
          </div>
        )}

        <div className="flex justify-end gap-2 pt-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded-md border bg-background px-3 py-1.5 text-sm font-medium hover:bg-muted"
          >
            {t('dnsSecurityEditDnsRetentionModal.actions.dismiss')}
          </button>
          <button
            type="submit"
            disabled={submitting}
            className="inline-flex items-center gap-2 rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
          >
            {submitting
              ? t('dnsSecurityEditDnsRetentionModal.actions.saving')
              : t('dnsSecurityEditDnsRetentionModal.actions.submit')}
          </button>
        </div>
      </form>
    </Dialog>
  );
}
