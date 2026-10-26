import { useTranslation } from 'react-i18next';
import { formatRelativeTime } from '@/lib/utils';
import { briefAge } from './wispHome';
import type { BriefSection } from '@breeze/shared';

export default function WispBriefCard({
  brief,
  now,
}: {
  brief: { sentAt: string; sections: BriefSection[] } | null;
  now?: number;
}) {
  const { t } = useTranslation('ai');
  const hasContent = brief !== null && brief.sections.length > 0;
  const stale = hasContent && briefAge(brief.sentAt, now) === 'stale';

  return (
    <section
      id="brief"
      data-testid="wisp-brief-card"
      aria-labelledby="wisp-brief-title"
      className="overflow-hidden rounded-lg border bg-card"
    >
      <div className="flex items-center justify-between gap-2 border-b px-4 py-3">
        <h2 id="wisp-brief-title" className="text-sm font-semibold">{t('wisp.home.briefTitle')}</h2>
      </div>
      <div className="space-y-3 px-4 py-3">
        {!hasContent ? (
          <p data-testid="wisp-brief-empty" className="text-xs text-muted-foreground">{t('wisp.home.briefEmpty')}</p>
        ) : (
          <>
            <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
              <span data-testid="wisp-brief-sent">
                {t('wisp.home.briefSentAt', { time: formatRelativeTime(new Date(brief.sentAt)) })}
              </span>
              {stale && (
                <span
                  data-testid="wisp-brief-stale"
                  className="rounded bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-medium text-amber-700 dark:text-amber-400"
                >
                  {t('wisp.home.briefStale')}
                </span>
              )}
            </div>
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
          </>
        )}
      </div>
    </section>
  );
}
