import { useState } from 'react';
import { CheckCircle, XCircle, Clock, RotateCcw } from 'lucide-react';
import { cn } from '@/lib/utils';

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
};

const statusStyles: Record<WebhookDeliveryStatus, string> = {
  success: 'bg-emerald-500/10 text-emerald-700',
  failed: 'bg-destructive/10 text-destructive',
  pending: 'bg-amber-500/10 text-amber-700'
};

const statusLabels: Record<WebhookDeliveryStatus, string> = {
  success: 'Success',
  failed: 'Failed',
  pending: 'Pending'
};

const statusIcons: Record<WebhookDeliveryStatus, typeof CheckCircle> = {
  success: CheckCircle,
  failed: XCircle,
  pending: Clock
};

function formatTimestamp(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString();
}

export default function WebhookDeliveryHistory({
  deliveries,
  onRetry
}: WebhookDeliveryHistoryProps) {
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
    <div className="rounded-lg border bg-card p-6 shadow-sm">
      <div>
        <h2 className="text-lg font-semibold">Delivery History</h2>
        <p className="text-sm text-muted-foreground">
          {deliveries.length} delivery attempts
        </p>
      </div>

      <div className="mt-6 overflow-hidden rounded-md border">
        <table className="min-w-full divide-y">
          <thead className="bg-muted/40">
            <tr className="text-left text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              <th className="px-4 py-3">Timestamp</th>
              <th className="px-4 py-3">Event</th>
              <th className="px-4 py-3">Status</th>
              <th className="px-4 py-3">Response</th>
              <th className="px-4 py-3 text-right">Action</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {deliveries.length === 0 ? (
              <tr>
                <td colSpan={5} className="px-4 py-12 text-center">
                  <p className="text-sm text-muted-foreground">No delivery attempts yet.</p>
                </td>
              </tr>
            ) : (
              deliveries.map(delivery => {
                const Icon = statusIcons[delivery.status];
                const isRetrying = retryingId === delivery.id;

                return (
                  <tr key={delivery.id} className="transition hover:bg-muted/40">
                    <td className="px-4 py-3 text-sm text-muted-foreground">
                      {formatTimestamp(delivery.timestamp)}
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
                        {statusLabels[delivery.status]}
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
                        {isRetrying ? 'Retrying...' : 'Retry'}
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
