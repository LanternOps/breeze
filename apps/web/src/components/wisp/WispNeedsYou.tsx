import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { BellRing } from 'lucide-react';
import type { Concern } from '@breeze/shared';
import { WispConcernsPanel } from '../ai/WispConcernsPanel';

const live = (c: Pick<Concern, 'status'>) => c.status === 'open' || c.status === 'snoozed';

/**
 * "Needs your attention" on the Wisp home (W08 Task 9): the grant's live
 * concerns, approvals first. The rows, snooze/dismiss/feedback and the
 * `#concern=<id>` deep link are W05/W06's `WispConcernsPanel` — reused, not
 * re-implemented — listed grant-wide like the thread page. Approvals open in
 * the existing approval surface from each row; nothing here decides one.
 */
export default function WispNeedsYou({
  grantId,
  threadId,
  initial,
  refreshKey = 0,
}: {
  grantId: string;
  threadId: string;
  initial: Concern[];
  /** Bumped by the host to reload the concerns (the rail's activity key). */
  refreshKey?: number;
}) {
  const { t } = useTranslation('ai');
  const [concerns, setConcerns] = useState<Concern[]>(initial);
  const waiting = concerns.filter(live);
  const approvals = waiting.filter((c) => c.approvalIntentId != null).length;

  return (
    <section id="needs-you" className="overflow-hidden rounded-lg border bg-card" data-testid="wisp-needs-you" aria-labelledby="wisp-needs-you-title">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b px-4 py-2">
        <h2 id="wisp-needs-you-title" className="flex items-center gap-1.5 text-sm font-semibold">
          <BellRing className="h-4 w-4" aria-hidden="true" />
          {t('wisp.home.needsYouTitle')}
        </h2>
        <div className="flex items-center gap-2 text-[11px]">
          {waiting.length > 0 && (
            <span className="text-muted-foreground" data-testid="wisp-needs-you-count">
              {t('wisp.home.needsYouCount', { count: waiting.length })}
            </span>
          )}
          {approvals > 0 && (
            <span className="rounded-full bg-amber-500/15 px-2 py-0.5 font-medium text-amber-700 dark:text-amber-300" data-testid="wisp-needs-you-approvals">
              {t('wisp.home.needsYouApprovals', { count: approvals })}
            </span>
          )}
        </div>
      </div>
      <WispConcernsPanel key={grantId} grantId={grantId} threadId={threadId} crossOrg title="" onLoaded={setConcerns} refreshKey={refreshKey} />
    </section>
  );
}
