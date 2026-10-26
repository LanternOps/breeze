/**
 * Tool Catalog W05 (#5220), plan Task A4 / Decision 14 — flow notices.
 *
 * One sender for the notices a flow's delegator must see: a system pause
 * (moved here from versions.ts `pauseFlow`, W04 behaviour unchanged) and a
 * monthly-cap refusal (Decision 15: runs are refused, the flow is not paused,
 * so the delegator is told once per flow, month and code).
 *
 * The in-app notice is a cross-user insert, so it runs in its own system
 * context after the caller's transaction commits (never inside a request
 * transaction). Best effort: a failure is logged and reported, never thrown —
 * the notice is never a reason to fail the work that triggered it.
 *
 * The document's `notices.channelId` (Decision 14) is delivered in W5 PR B
 * (Task B3, `sendChannelMessage`); in PR A only the in-app notice is sent.
 */
import type { FlowDocumentV1 } from '@breeze/shared';
import { runAfterDbContextCommit, runOutsideDbContext, withSystemDbAccessContext } from '../../db';
import { captureException } from '../sentry';
import { createNotification } from '../userNotifications';

export type FlowNoticeKind = 'paused' | 'unknown_outcome' | 'cap_reached';

export interface FlowNoticeTarget {
  id: string;
  name: string;
  orgId: string | null;
  /** The delegator (the publication's enabling user); null after a user tombstone. */
  enabledByUserId: string | null;
}

export interface FlowNotice {
  kind: FlowNoticeKind;
  title: string;
  text: string;
  /** createNotification's per-user dedupe key: the notice is sent at most once per key. */
  dedupeKey: string;
  metadata?: Record<string, unknown>;
}

export async function sendFlowNotice(flow: FlowNoticeTarget, _doc: FlowDocumentV1 | null, notice: FlowNotice): Promise<void> {
  const delegator = flow.enabledByUserId;
  if (!delegator) return;
  const label = `flows.notice.${notice.kind}`;
  runAfterDbContextCommit(label, async () => {
    try {
      await runOutsideDbContext(() => withSystemDbAccessContext(() => createNotification({
        userId: delegator,
        orgId: flow.orgId,
        type: 'automation',
        priority: 'high',
        title: notice.title,
        message: notice.text,
        link: `/flows/${flow.id}`,
        metadata: notice.metadata ?? { flowId: flow.id, kind: notice.kind },
        dedupeKey: notice.dedupeKey,
      }), label));
    } catch (err) {
      captureException(err instanceof Error ? err : new Error(String(err)), undefined,
        { ...(flow.orgId ? { org_id: flow.orgId } : {}), flow_id: flow.id, flow_site: label },
        { fingerprint: ['flow', label] });
      console.error(`[flows] ${notice.kind} notice failed (flow=${flow.id})`, err);
    }
  });
}
