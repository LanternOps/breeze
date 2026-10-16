import { useTranslation } from 'react-i18next';
import type { EndpointMessageDetail, EndpointMessageDeliveryStatus } from '@/lib/endpointMessages';
import { SeverityBadge, StatusSummary } from './messageBadges';

export interface EndpointMessageDetailViewProps {
  detail: EndpointMessageDetail;
  canSend: boolean;
  busy: boolean;
  onRetract: () => void;
  onResend: () => void;
}

const RESENDABLE: EndpointMessageDeliveryStatus[] = ['failed', 'expired'];

const fmt = (iso: string | null) => (iso ? new Date(iso).toLocaleString() : null);

export default function EndpointMessageDetailView({ detail, canSend, busy, onRetract, onResend }: EndpointMessageDetailViewProps) {
  const { t } = useTranslation('devices');
  const h = 'endpointMessages.history';
  const retracted = detail.retractedAt !== null;
  const resendCount = detail.deliveries.filter((d) => RESENDABLE.includes(d.status)).length;
  const showRetract = canSend && !retracted;
  const showResend = canSend && !retracted && !detail.bodyPurged && resendCount > 0;

  return (
    <div className="space-y-4" data-testid="endpoint-message-detail">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 space-y-1">
          <h2 className="truncate text-lg font-semibold">{detail.title ?? t(`${h}.purgedListTitle`)}</h2>
          <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            <SeverityBadge severity={detail.severity} />
            <span>{t(`${h}.fields.sent`)}: {fmt(detail.createdAt)}</span>
            <span>{t(`${h}.fields.expires`)}: {fmt(detail.expiresAt)}</span>
            {detail.requiresAck && <span>{t(`${h}.fields.requiresAck`)}</span>}
            {retracted && <span className="rounded bg-muted px-1.5 py-0.5 font-medium">{t(`${h}.badgeRetracted`)}</span>}
          </div>
          <StatusSummary counts={detail.statusCounts} />
        </div>
        <div className="flex gap-2">
          {showResend && (
            <button
              type="button"
              data-testid="endpoint-message-resend"
              disabled={busy}
              onClick={onResend}
              className="h-9 rounded-md border px-3 text-sm font-medium hover:bg-muted disabled:opacity-50"
            >
              {t(busy ? `${h}.actions.resending` : `${h}.actions.resend`)}
            </button>
          )}
          {showRetract && (
            <button
              type="button"
              data-testid="endpoint-message-retract"
              disabled={busy}
              onClick={onRetract}
              className="h-9 rounded-md border border-destructive/40 px-3 text-sm font-medium text-destructive hover:bg-destructive/10 disabled:opacity-50"
            >
              {t(`${h}.actions.retract`)}
            </button>
          )}
        </div>
      </div>

      {detail.bodyPurged || detail.body === null ? (
        <div className="rounded-md border bg-muted/40 px-4 py-3 text-sm" data-testid="endpoint-message-purged">
          <p className="font-medium">{t(`${h}.purgedTitle`)}</p>
          <p className="text-muted-foreground">{t(`${h}.purgedBody`)}</p>
        </div>
      ) : (
        <div>
          <h3 className="mb-1 text-sm font-semibold">{t(`${h}.fields.body`)}</h3>
          <p className="whitespace-pre-wrap rounded-md border bg-background px-4 py-3 text-sm" data-testid="endpoint-message-body">{detail.body}</p>
        </div>
      )}

      <div>
        <h3 className="mb-1 text-sm font-semibold">{t(`${h}.fields.deliveries`)}</h3>
        <div className="overflow-x-auto rounded-md border">
          <table className="w-full text-left text-sm">
            <thead className="bg-muted/50 text-xs text-muted-foreground">
              <tr>
                <th className="px-3 py-2 font-medium">{t(`${h}.fields.host`)}</th>
                <th className="px-3 py-2 font-medium">{t(`${h}.fields.status`)}</th>
                <th className="px-3 py-2 font-medium">{t(`${h}.fields.surface`)}</th>
                <th className="px-3 py-2 font-medium">{t(`${h}.fields.error`)}</th>
                <th className="px-3 py-2 font-medium">{t(`${h}.fields.delivered`)}</th>
                <th className="px-3 py-2 font-medium">{t(`${h}.fields.receipts`)}</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {detail.deliveries.map((d) => {
                const times: Array<[string, string | null]> = [
                  [t(`${h}.fields.delivered`), fmt(d.deliveredAt)],
                  [t(`${h}.fields.displayed`), fmt(d.displayedAt)],
                  [t(`${h}.fields.acknowledged`), fmt(d.acknowledgedAt)],
                  [t(`${h}.fields.dismissed`), fmt(d.dismissedAt)],
                  [t(`${h}.fields.retracted`), fmt(d.retractedAt)],
                ];
                return (
                  <tr key={d.id} data-testid={`endpoint-delivery-row-${d.id}`} className="align-top">
                    <td className="px-3 py-2 font-medium">{d.hostname ?? d.deviceId}</td>
                    <td className="px-3 py-2">{t(`${h}.statuses.${d.status}`)}</td>
                    <td className="px-3 py-2">{d.surface ? t(`${h}.surface.${d.surface === 'assist' ? 'assist' : 'native'}`) : '-'}</td>
                    <td className="px-3 py-2 font-mono text-xs">{d.errorCode ?? '-'}</td>
                    <td className="px-3 py-2 text-xs text-muted-foreground">
                      {times.filter(([, v]) => v).map(([label, v]) => (
                        <div key={label}>{label}: {v}</div>
                      ))}
                    </td>
                    <td className="px-3 py-2 text-xs">
                      {d.receipts.length === 0 ? (
                        <span className="text-muted-foreground">{t(`${h}.fields.noReceipts`)}</span>
                      ) : (
                        d.receipts.map((r, i) => (
                          <div key={`${r.eventType}-${r.occurredAt}-${i}`}>
                            {r.sessionUsername ?? '-'} · {t(`${h}.receiptEvents.${r.eventType}`)} · {fmt(r.occurredAt)}
                          </div>
                        ))
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
