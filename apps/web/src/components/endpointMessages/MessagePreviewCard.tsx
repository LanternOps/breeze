import { useTranslation } from 'react-i18next';
import type { EndpointMessageSeverity } from '@breeze/shared';
import { cn } from '@/lib/utils';

const SEVERITY_STYLE: Record<EndpointMessageSeverity, string> = {
  info: 'border-sky-500/50',
  warning: 'border-amber-500/60',
  critical: 'border-red-500/60',
};

export interface MessagePreviewCardProps {
  title: string;
  body: string;
  severity: EndpointMessageSeverity;
  requiresAck: boolean;
}

/**
 * Approximation of the card the user sees on their machine. Title and body are
 * rendered as plain text (React text nodes, `whitespace-pre-wrap` for line
 * breaks) so what the technician previews is exactly what they submit. The
 * sender slot and footer are fixed: the sender is the partner's company, never
 * technician-supplied text.
 */
export default function MessagePreviewCard({ title, body, severity, requiresAck }: MessagePreviewCardProps) {
  const { t } = useTranslation('devices');
  return (
    <div
      data-testid="message-preview-card"
      data-severity={severity}
      className={cn('rounded-lg border-2 bg-card p-4 shadow-sm', SEVERITY_STYLE[severity])}
    >
      <p data-testid="message-preview-sender" className="text-xs font-medium text-muted-foreground">
        {t('endpointMessages.preview.sender')}
      </p>
      <h3 data-testid="message-preview-title" className="mt-1 break-words text-base font-semibold">
        {title}
      </h3>
      <p data-testid="message-preview-body" className="mt-2 whitespace-pre-wrap break-words text-sm">
        {body}
      </p>
      {requiresAck && (
        <div
          data-testid="message-preview-ack"
          className="mt-3 inline-flex rounded-md bg-primary px-3 py-1 text-xs font-medium text-primary-foreground"
        >
          {t('endpointMessages.preview.acknowledge')}
        </div>
      )}
      <p className="mt-3 border-t pt-2 text-xs text-muted-foreground">{t('endpointMessages.preview.footer')}</p>
    </div>
  );
}
