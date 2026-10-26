import { useTranslation } from 'react-i18next';
import type { WispTimelinePost } from '@breeze/shared';
import { formatRelativeTime } from '@/lib/utils';
import WispBriefPost from './WispBriefPost';
import { safeActivityHref } from './wispActivity';

/**
 * One durable proactive Wisp post (morning brief, nudge, digest) in the Wisp
 * chat thread. A brief with sections reuses the brief card; every other post
 * is a plain prose block: eyebrow, title, optional body and an optional "Open"
 * link. Nudge actions live in the rail's concern row (that row component is
 * not exported from WispConcernsPanel), so a nudge links to it via `post.link`.
 * All server text renders as literal React text.
 */
export default function WispPost({ post, now }: { post: WispTimelinePost; now?: number }) {
  const { t } = useTranslation('ai');
  const unread = post.read === false;

  if (post.kind === 'brief' && (post.sections?.length ?? 0) > 0) {
    return (
      <div data-testid="wisp-post" data-kind="brief">
        <WispBriefPost
          brief={{ sentAt: post.createdAt, sections: post.sections ?? [] }}
          now={now}
          showStale={false}
          unread={unread}
        />
      </div>
    );
  }

  const eyebrow =
    post.kind === 'nudge' ? t('wisp.post.nudge') : post.kind === 'digest' ? t('wisp.post.digest') : t('wisp.post.brief');
  const href = safeActivityHref(post.link);

  return (
    <article data-testid="wisp-post" data-kind={post.kind} className="space-y-1">
      <p className="text-xs font-medium text-muted-foreground">
        {unread && (
          <span
            data-testid="wisp-post-unread"
            role="img"
            aria-label={t('wisp.post.unread')}
            className="mr-1.5 inline-block h-1.5 w-1.5 rounded-full bg-primary align-middle"
          />
        )}
        <span className="uppercase tracking-wide">{eyebrow}</span>
        {' · '}
        <time dateTime={post.createdAt} data-testid="wisp-post-sent">
          {t('wisp.home.briefSentAt', { time: formatRelativeTime(new Date(post.createdAt)) })}
        </time>
      </p>
      <p data-testid="wisp-post-title" className="break-words text-sm font-medium text-foreground">
        {post.title}
      </p>
      {post.body && (
        <p data-testid="wisp-post-body" className="whitespace-pre-wrap break-words text-sm text-foreground">
          {post.body}
        </p>
      )}
      {href && (
        <a
          href={href}
          data-testid="wisp-post-open"
          className="text-xs font-medium text-primary underline-offset-2 hover:underline"
        >
          {t('wisp.post.open')}
        </a>
      )}
    </article>
  );
}
