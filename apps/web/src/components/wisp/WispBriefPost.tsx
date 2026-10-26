import { useTranslation } from 'react-i18next';
import { formatRelativeTime } from '@/lib/utils';
import { briefAge } from './wispHome';
import type { BriefSection } from '@breeze/shared';

export default function WispBriefPost({
  brief,
  now,
}: {
  brief: { sentAt: string; sections: BriefSection[] };
  now?: number;
}) {
  const { t } = useTranslation('ai');
  const stale = briefAge(brief.sentAt, now) === 'stale';

  return (
    <article data-testid="wisp-brief-card" className="space-y-3">
      <p className="text-xs font-medium text-muted-foreground">
        <span className="uppercase tracking-wide">{t('wisp.post.brief')}</span>
        {' · '}
        <span data-testid="wisp-brief-sent">
          {t('wisp.home.briefSentAt', { time: formatRelativeTime(new Date(brief.sentAt)) })}
        </span>
        {stale && (
          <span
            data-testid="wisp-brief-stale"
            className="ml-2 rounded bg-amber-500/15 px-1.5 py-0.5 text-xs font-medium text-amber-700 dark:text-amber-400"
          >
            {t('wisp.home.briefStale')}
          </span>
        )}
      </p>
      {brief.sections.map((section, i) => (
        <div key={`${i}-${section.heading}`} data-testid="wisp-brief-section" className="space-y-1">
          <h3 className="text-sm font-semibold break-words">{section.heading}</h3>
          <ul className="space-y-1 text-xs">
            {section.lines.map((line, j) => (
              <li key={j} className="break-words">{line}</li>
            ))}
          </ul>
        </div>
      ))}
    </article>
  );
}
