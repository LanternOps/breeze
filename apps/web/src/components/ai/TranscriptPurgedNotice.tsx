import { useTranslation } from 'react-i18next';
import { Archive } from 'lucide-react';
import { formatDate } from '@/lib/dateTimeFormat';

/**
 * #4342 W4: shown where a transcript would be when transcript retention has
 * emptied the session (`transcriptPurgedAt` set). The session record (cost,
 * model, turn count) stays; the messages, title and tool details are gone.
 * A flagged session is never emptied.
 */
export default function TranscriptPurgedNotice({ purgedAt, testId }: { purgedAt: string; testId: string }) {
  const { t } = useTranslation('ai');
  return (
    <div className="flex items-start gap-2 rounded-md border border-dashed bg-muted/30 px-3 py-2 text-sm text-muted-foreground" role="note" data-testid={testId}>
      <Archive className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
      <div>
        <p className="font-medium text-foreground">{t('transcriptRetention.removedOn', { date: formatDate(purgedAt) })}</p>
        <p className="mt-0.5 text-xs">{t('transcriptRetention.removedHelp')}</p>
      </div>
    </div>
  );
}
