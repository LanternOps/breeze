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
 * The live publication's `notices.channelId` (Decision 14, Task B3) also
 * receives the notice via `sendChannelMessage`, independent of the in-app
 * notice (it is sent even when the flow has no delegator). A channel failure is
 * logged and reported, never thrown.
 */
import { and, eq } from 'drizzle-orm';
import type { FlowDocumentV1 } from '@breeze/shared';
import { db, runAfterDbContextCommit, runOutsideDbContext, withSystemDbAccessContext } from '../../db';
import { flows, flowVersions, organizations } from '../../db/schema';
import { sendChannelMessage } from '../notificationSenders/channelMessage';
import { getRedis } from '../redis';
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

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function noticeChannelOf(doc: unknown): string | null {
  const channelId = (doc as { notices?: { channelId?: unknown } } | null | undefined)?.notices?.channelId;
  return typeof channelId === 'string' && UUID_RE.test(channelId) ? channelId : null;
}

/** The notice channel and the owner for its visibility rule; null when there is no channel. */
async function resolveNoticeChannel(
  flow: Pick<FlowNoticeTarget, 'id'>,
  doc: FlowDocumentV1 | null,
): Promise<{ channelId: string; owner: { orgId: string | null; partnerId: string } } | null> {
  const [row] = await db
    .select({ orgId: flows.orgId, partnerId: flows.partnerId, enabledPublicationSeq: flows.enabledPublicationSeq })
    .from(flows)
    .where(eq(flows.id, flow.id))
    .limit(1);
  if (!row) return null;
  let channelId = noticeChannelOf(doc);
  if (!channelId && !doc) {
    if (row.enabledPublicationSeq === null || row.enabledPublicationSeq === undefined) return null;
    const [version] = await db
      .select({ definition: flowVersions.definition })
      .from(flowVersions)
      .where(and(eq(flowVersions.flowId, flow.id), eq(flowVersions.publicationSeq, row.enabledPublicationSeq)))
      .limit(1);
    channelId = noticeChannelOf(version?.definition);
  }
  if (!channelId) return null;
  let partnerId = row.partnerId;
  if (row.orgId) {
    const [org] = await db.select({ partnerId: organizations.partnerId }).from(organizations).where(eq(organizations.id, row.orgId)).limit(1);
    partnerId = org?.partnerId ?? null;
  }
  if (!partnerId) return null;
  return { channelId, owner: { orgId: row.orgId, partnerId } };
}

function reportNoticeFailure(flow: { id: string; orgId: string | null }, err: unknown, site: string): void {
  captureException(err instanceof Error ? err : new Error(String(err)), undefined,
    { ...(flow.orgId ? { org_id: flow.orgId } : {}), flow_id: flow.id, flow_site: site },
    { fingerprint: ['flow', site] });
}

/** A channel notice is sent at most once per dedupe key, like the in-app one. */
const CHANNEL_NOTICE_DEDUPE_TTL_SECONDS = 35 * 24 * 3600;

/**
 * Claim the notice's dedupe key for the channel. The in-app notice dedupes in
 * the DB (`user_notifications` unique key), but the cap marker re-fires up to
 * once a minute while a flow sits at its cap, so the channel needs its own
 * once-per-key claim. Redis unavailable ⇒ not claimed: the channel send is
 * skipped rather than risk repeating it every minute (the in-app notice is the
 * durable copy).
 */
async function claimChannelNotice(dedupeKey: string): Promise<boolean> {
  const redis = getRedis();
  if (!redis) return false;
  return (await redis.set(`flow-notice-channel:${dedupeKey}`, '1', 'EX', CHANNEL_NOTICE_DEDUPE_TTL_SECONDS, 'NX')) === 'OK';
}

/** Hand a claimed slot back after a failed send (best effort: a lost DEL only delays the retry to the TTL). */
async function releaseChannelNotice(dedupeKey: string): Promise<void> {
  try {
    await getRedis()?.del(`flow-notice-channel:${dedupeKey}`);
  } catch (err) {
    console.warn(`[flows] could not release the channel notice slot ${dedupeKey}`, err);
  }
}

/**
 * The channel half of a flow notice (Decision 14): to the live publication's
 * `notices.channelId`, after commit, once per dedupe key. Best effort — a
 * failure is logged and reported, never thrown. Used by `sendFlowNotice` and
 * by the unknown-outcome notice (runEvents.ts), which keeps its own in-app copy.
 */
export async function sendFlowNoticeToChannel(
  flow: { id: string; orgId: string | null },
  doc: FlowDocumentV1 | null,
  notice: Pick<FlowNotice, 'kind' | 'title' | 'text' | 'dedupeKey'>,
): Promise<void> {
  const channelLabel = 'flows.notice.channel';
  runAfterDbContextCommit(channelLabel, async () => {
    try {
      const target = await runOutsideDbContext(() => withSystemDbAccessContext(() => resolveNoticeChannel(flow, doc), channelLabel));
      if (!target) return;
      if (!(await claimChannelNotice(notice.dedupeKey))) {
        if (!getRedis()) console.warn(`[flows] ${notice.kind} notice channel send skipped: Redis unavailable for its dedupe (flow=${flow.id})`);
        return;
      }
      let result: Awaited<ReturnType<typeof sendChannelMessage>>;
      try {
        result = await sendChannelMessage(target.channelId, {
          title: notice.title,
          body: notice.text,
          severity: notice.kind === 'paused' || notice.kind === 'unknown_outcome' ? 'warning' : 'info',
          link: `/flows/${flow.id}`,
        }, target.owner);
      } catch (err) {
        // Not delivered: give the slot back so the next notice of this key retries.
        await releaseChannelNotice(notice.dedupeKey);
        throw err;
      }
      if (!result.ok) {
        // A throttled channel enforced its own cap: that is its answer, keep the slot.
        if (result.code !== 'throttled') await releaseChannelNotice(notice.dedupeKey);
        reportNoticeFailure(flow, new Error(`flow notice channel send failed: ${result.code}`), channelLabel);
        console.error(`[flows] ${notice.kind} notice channel send failed (flow=${flow.id}): ${result.code}`);
      }
    } catch (err) {
      reportNoticeFailure(flow, err, channelLabel);
      console.error(`[flows] ${notice.kind} notice channel send failed (flow=${flow.id})`, err);
    }
  });
}

export async function sendFlowNotice(flow: FlowNoticeTarget, doc: FlowDocumentV1 | null, notice: FlowNotice): Promise<void> {
  const delegator = flow.enabledByUserId;
  const label = `flows.notice.${notice.kind}`;
  const report = (err: unknown, site: string) => reportNoticeFailure(flow, err, site);

  if (!delegator) {
    console.warn(`[flows] ${notice.kind} notice for flow ${flow.id} has no delegator to notify`);
  } else {
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
        report(err, label);
        console.error(`[flows] ${notice.kind} notice failed (flow=${flow.id})`, err);
      }
    });
  }

  await sendFlowNoticeToChannel(flow, doc, notice);
}
