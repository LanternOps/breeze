import { useTranslation } from 'react-i18next';
import { CheckCircle2, Clock } from 'lucide-react';
import type { WispTimelinePost } from '@breeze/shared';
import { formatRelativeTime } from '@/lib/utils';
import WispBriefPost from './WispBriefPost';
import { safeActivityHref } from './wispActivity';
import { checkInIdFromLink } from './wispThreadHash';

/**
 * One durable proactive Wisp post (morning brief, nudge, digest, check-in, first look or
 * the couldn't-look variant of it, or a resolved-nudge follow-up) in the Wisp
 * chat thread. A brief with sections reuses the brief card; every other post
 * is a plain prose block: eyebrow, title, optional body and an optional "Open"
 * link. Nudge actions live in the rail's concern row (that row component is
 * not exported from WispConcernsPanel), so a nudge links to it via `post.link`.
 * All server text renders as literal React text.
 *
 * A check-in post (W05 #10996) carries a clock icon and `data-check-in-id`
 * (read from its `#checkin=<id>` link) so the thread can scroll the bell's
 * deep link to it. **Run now** renders only when `onRunNow` is set: the thread
 * passes it for a check-in that is still `fired` (not yet consumed).
 *
 * A `nudge_resolved` post (#11427) renders like a nudge (it links to the same
 * concern) with a check icon: the thing Wisp nudged about closed, no action needed.
 */
export default function WispPost({
  post,
  now,
  onRunNow,
  runNowDisabled = false,
}: {
  post: WispTimelinePost;
  now?: number;
  onRunNow?: () => void;
  runNowDisabled?: boolean;
}) {
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
    post.kind === 'nudge'
      ? t('wisp.post.nudge')
      : post.kind === 'nudge_resolved'
        ? t('wisp.post.nudgeResolved')
        : post.kind === 'digest'
          ? t('wisp.post.digest')
          : post.kind === 'check_in'
            ? t('wisp.post.checkIn')
            : post.kind === 'specialist_result'
              ? t('wisp.post.specialistResult')
              : post.kind === 'first_look'
                ? post.variant === 'couldnt_look' ? t('wisp.post.couldntLook') : t('wisp.post.firstLook')
                : t('wisp.post.brief');
  // A check-in's and a first look's link is this same thread, so an "Open" link
  // would go nowhere.
  const isCheckIn = post.kind === 'check_in';
  const href = isCheckIn || post.kind === 'first_look' ? null : safeActivityHref(post.link);
  const checkInId = isCheckIn ? checkInIdFromLink(post.link) : null;

  return (
    <article
      data-testid="wisp-post"
      data-kind={post.kind}
      data-variant={post.variant}
      data-check-in-id={checkInId ?? undefined}
      className="space-y-1"
    >
      <p className="text-xs font-medium text-muted-foreground">
        {isCheckIn && (
          <Clock data-testid="wisp-post-check-in-icon" className="mr-1 inline-block h-3 w-3 align-[-2px]" aria-hidden="true" />
        )}
        {post.kind === 'nudge_resolved' && (
          <CheckCircle2 data-testid="wisp-post-resolved-icon" className="mr-1 inline-block h-3 w-3 align-[-2px] text-success" aria-hidden="true" />
        )}
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
      {isCheckIn && onRunNow && (
        <button
          type="button"
          data-testid="wisp-post-run-now"
          onClick={onRunNow}
          disabled={runNowDisabled}
          className="mt-1 rounded-md border px-2.5 py-1 text-xs font-medium hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
        >
          {t('wisp.checkIn.runNow')}
        </button>
      )}
    </article>
  );
}
