import { useState } from 'react';
import { CheckCircle, XCircle, Clock, RotateCcw } from 'lucide-react';
import { cn } from '@/lib/utils';
import { formatDateTime } from '@/lib/dateTimeFormat';
import { useTranslation } from 'react-i18next';

export type WebhookDeliveryStatus = 'success' | 'failed' | 'pending';

export type WebhookDelivery = {
  id: string;
  timestamp: string;
  event: string;
  status: WebhookDeliveryStatus;
  responseCode?: number | null;
  attempt?: number;
};

type WebhookDeliveryHistoryProps = {
  deliveries: WebhookDelivery[];
  onRetry?: (delivery: WebhookDelivery) => void | Promise<void>;
  timezone?: string;
};

const statusStyles: Record<WebhookDeliveryStatus, string> = {
  success: 'bg-emerald-500/10 text-emerald-700',
  failed: 'bg-destructive/10 text-destructive',
  pending: 'bg-amber-500/10 text-amber-700'
};

const statusIcons: Record<WebhookDeliveryStatus, typeof CheckCircle> = {
  success: CheckCircle,
  failed: XCircle,
  pending: Clock
};

function formatTimestamp(value: string, timezone?: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return formatDateTime(date, { timeZone: timezone });
}

export default function WebhookDeliveryHistory({
  deliveries,
  onRetry,
  timezone
}: WebhookDeliveryHistoryProps) {
  const { t } = useTranslation('common');
  const [retryingId, setRetryingId] = useState<string | null>(null);

  const handleRetry = async (delivery: WebhookDelivery) => {
    if (!onRetry) return;
    setRetryingId(delivery.id);
    try {
      await onRetry(delivery);
    } finally {
      setRetryingId(null);
    }
  };

  return (
    <div className="rounded-lg border bg-card p-6 shadow-xs">
      <div>
        <h2 className="text-lg font-semibold">{t('longTail.webhooks.WebhookDeliveryHistory.title')}</h2>
        <p className="text-sm text-muted-foreground">
          {t('longTail.webhooks.WebhookDeliveryHistory.deliveryAttempts', { count: deliveries.length })}
        </p>
      </div>

      <div className="mt-6 overflow-x-auto rounded-md border">
        <table className="min-w-full divide-y">
          <thead className="bg-muted/40">
            <tr className="text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              <th className="px-4 py-3">{t('longTail.webhooks.WebhookDeliveryHistory.headers.timestamp')}</th>
              <th className="px-4 py-3">{t('longTail.webhooks.WebhookDeliveryHistory.headers.event')}</th>
              <th className="px-4 py-3">{t('common:labels.status')}</th>
              <th className="px-4 py-3">{t('longTail.webhooks.WebhookDeliveryHistory.headers.response')}</th>
              <th className="px-4 py-3 text-right">{t('longTail.webhooks.WebhookDeliveryHistory.headers.action')}</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {deliveries.length === 0 ? (
              <tr>
                <td colSpan={5} className="px-4 py-12 text-center">
                  <p className="text-sm text-muted-foreground">{t('longTail.webhooks.WebhookDeliveryHistory.empty')}</p>
                </td>
              </tr>
            ) : (
              deliveries.map(delivery => {
                const Icon = statusIcons[delivery.status];
                const isRetrying = retryingId === delivery.id;

                return (
                  <tr key={delivery.id} className="transition hover:bg-muted/40">
                    <td className="px-4 py-3 text-sm text-muted-foreground">
                      {formatTimestamp(delivery.timestamp, timezone)}
                    </td>
                    <td className="px-4 py-3 text-sm font-medium">{delivery.event}</td>
                    <td className="px-4 py-3 text-sm">
                      <span
                        className={cn(
                          'inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-xs font-medium',
                          statusStyles[delivery.status]
                        )}
                      >
                        <Icon className="h-3.5 w-3.5" />
                        {t(/* i18n-dynamic */ `longTail.webhooks.WebhookDeliveryHistory.status.${delivery.status}`)}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-sm text-muted-foreground">
                      {delivery.responseCode ? `HTTP ${delivery.responseCode}` : '—'}
                    </td>
                    <td className="px-4 py-3 text-right">
                      <button
                        type="button"
                        onClick={() => handleRetry(delivery)}
                        disabled={delivery.status !== 'failed' || !onRetry || isRetrying}
                        className="inline-flex h-8 items-center gap-1 rounded-md border px-2 text-xs font-medium hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
                      >
                        <RotateCcw className="h-3.5 w-3.5" />
                        {isRetrying ? t('longTail.webhooks.WebhookDeliveryHistory.retrying') : t('common:actions.retry')}
                      </button>
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
