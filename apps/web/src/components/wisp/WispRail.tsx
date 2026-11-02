import type { Dispatch, SetStateAction } from 'react';
import { useTranslation } from 'react-i18next';
import { Brain, MessagesSquare } from 'lucide-react';
import type { Concern, CurrentActivity, WispThreadLink } from '@breeze/shared';
import type { WispState } from '@/stores/aiStore';
import WispThreadHeader from '../ai/WispThreadHeader';
import WispActivityPanel from './WispActivityPanel';
import WispIdentityCard from './WispIdentityCard';
import WispLinksPanel from './WispLinksPanel';
import WispNeedsYou from './WispNeedsYou';
import WispWorkersPanel from './WispWorkersPanel';

type Wisp = NonNullable<WispState>;

export type WispRailProps = {
  wisp: Wisp;
  orgName: string | null;
  current: CurrentActivity;
  /** Null hides the section (the thread page has no home payload). */
  needsYou: Concern[] | null;
  /** Null hides the section. */
  links: WispThreadLink[] | null;
  onLinksChange: Dispatch<SetStateAction<WispThreadLink[]>>;
  onWispChange: (patch: Partial<Wisp>) => void;
  onRevoked: () => void | Promise<void>;
  /** Bumped when a check starts or finishes: workers and activity reload. */
  activityKey: number;
};

const CHATS_HREF = '/ai/chat';
const MEMORY_HREF = '/settings/wisp-memory';
const BOX = 'overflow-hidden rounded-lg border bg-card';

/**
 * The header renders its own chrome (`border-b px-4 py-2`) for the docked chat
 * panel. Inside the identity card that reads as a second box, so it is dropped
 * from here rather than by changing the header the panel still uses.
 */
const HEADER_FLUSH = '[&>[data-testid=wisp-thread-header]]:border-b-0 [&>[data-testid=wisp-thread-header]]:p-0';

/**
 * `WispNeedsYou` is its own bordered section, so it is not boxed again. Its
 * concern list scrolls past 22rem (needs-you runs to 50 rows) while the
 * section header and count stay put; the list's own bottom border would
 * double the section's, so it goes too.
 */
const NEEDS_YOU_BODY =
  '[&_[data-testid=wisp-concerns]]:max-h-[22rem] [&_[data-testid=wisp-concerns]]:overflow-y-auto [&_[data-testid=wisp-concerns]]:border-b-0';

/**
 * The Wisp home's right rail (W01 #10211, spec §4.1): who Wisp is and the
 * grant controls, what needs you, the specialists at work, the linked items,
 * the activity timeline (collapsed: the thread's posts carry the narrative),
 * then the way out to all chats and memory. `#needs-you`, `#links` and
 * `#activity` land on these sections.
 */
export default function WispRail({
  wisp,
  orgName,
  current,
  needsYou,
  links,
  onLinksChange,
  onWispChange,
  onRevoked,
  activityKey,
}: WispRailProps) {
  const { t } = useTranslation(['ai', 'pages']);
  // #10104: an ended delegation (revoked or expired) authorizes no reads; the
  // concerns, activity and links routes answer 409 grant_inactive. Say so once
  // instead of mounting panes that can only fail.
  const ended = wisp.status === 'revoked' || wisp.status === 'expired';

  return (
    <div className="space-y-4" data-testid="wisp-rail">
      <div className={BOX}>
        <WispIdentityCard wisp={wisp} orgName={orgName} currentActivity={current}>
          <div className={HEADER_FLUSH}>
            <WispThreadHeader
              wisp={wisp}
              orgName={orgName}
              wideningAvailable={wisp.wideningAvailable}
              showFocus={false}
              showIdentity={false}
              currentActivity={null}
              onWispChange={onWispChange}
              onRevoked={onRevoked}
            />
          </div>
        </WispIdentityCard>
      </div>

      {ended ? (
        <p className={`${BOX} px-4 py-3 text-sm text-muted-foreground`} data-testid="wisp-rail-ended" role="status">
          {t('ai:wisp.rail.ended')}
        </p>
      ) : (
        <>
          {needsYou !== null && (
            <div className={NEEDS_YOU_BODY}>
              <WispNeedsYou key={wisp.grantId} grantId={wisp.grantId} threadId={wisp.threadId} initial={needsYou} refreshKey={activityKey} />
            </div>
          )}

          <div className={BOX}>
            <WispWorkersPanel threadId={wisp.threadId} refreshKey={activityKey} />
          </div>

          {links !== null && (
            <div className={BOX}>
              <WispLinksPanel threadId={wisp.threadId} links={links} onLinksChange={onLinksChange} canAdd={wisp.status === 'active'} />
            </div>
          )}

          <section id="activity" className={BOX}>
            <WispActivityPanel threadId={wisp.threadId} refreshKey={activityKey} collapsible />
          </section>
        </>
      )}

      <nav className="flex flex-wrap items-center gap-1 text-sm" aria-label={t('pages:titles.wisp')} data-testid="wisp-rail-nav">
        <a href={CHATS_HREF} data-testid="wisp-home-chats" className="flex items-center gap-1.5 rounded px-2 py-1 text-muted-foreground hover:bg-muted hover:text-foreground">
          <MessagesSquare className="h-4 w-4" aria-hidden="true" />
          {t('ai:wisp.home.openChats')}
        </a>
        <a href={MEMORY_HREF} data-testid="wisp-home-memory" className="flex items-center gap-1.5 rounded px-2 py-1 text-muted-foreground hover:bg-muted hover:text-foreground">
          <Brain className="h-4 w-4" aria-hidden="true" />
          {t('ai:wisp.home.memory')}
        </a>
      </nav>
    </div>
  );
}
