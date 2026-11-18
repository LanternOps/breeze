/**
 * Wisp W02 — grant standing (Wisp design §4.4 "tightening applies
 * immediately").
 *
 * Two triggers, one evaluation:
 *   - push: every per-user permission-cache clear (status change, role
 *     assignment, org-access change, role-permission edit all pass through
 *     `clearPermissionCache(userId)`) reconciles that user's grants;
 *   - pull: the 5-minute `wisp-grant-reconciler` repeatable sweeps every live
 *     grant (catches expiry and anything the push path missed).
 *
 * This module only ever TIGHTENS (pause / expire) or lifts a pause it caused
 * itself (`grantor_access_lost` / `grantor_suspended`). Every other pause
 * reason belongs to its owning wave (W01 entitlements, W05 budget), and a
 * `user_paused` grant is never resumed here (w00 A29) — nor relabelled: the
 * grantor's own resume re-checks live standing instead.
 *
 * Every read/write runs in SYSTEM context: callers are workers and
 * post-commit hooks.
 */
import { and, asc, eq, gt, inArray } from 'drizzle-orm';
import { wispEnabled } from '../../config/env';
import { db } from '../../db';
import { wispGrantRevisions, wispGrants } from '../../db/schema/wisp';
import type { WispGrantRow } from '../../db/schema/wisp';
import { createAuditLogAsync } from '../auditService';
import { captureException } from '../sentry';
import { ANONYMOUS_ACTOR_ID } from '../auditEvents';
import { onPermissionAuthorityChanged } from '../permissions';
import { computeLiveHumanTerm, inSystemContext, wispCeilingSnapshotSchema, type LiveHumanTerm } from './grantAuthority';
import { pauseGrant, resumeGrant } from './grants';

export type GrantStanding =
  | { kind: 'ok' }
  | { kind: 'pause'; reason: 'grantor_access_lost' | 'grantor_suspended' }
  | { kind: 'expired' };

type StandingInput = Pick<WispGrantRow, 'id' | 'grantorUserId' | 'partnerId' | 'orgId' | 'expiresAt' | 'currentRevisionId'>;
type LiveMemo = Map<string, Promise<LiveHumanTerm>>;

/** Pause reasons this module set itself and may therefore lift. */
const SELF_RESUMABLE = new Set(['grantor_access_lost', 'grantor_suspended']);
const PAGE_SIZE = 200;

function systemContext<T>(fn: () => Promise<T>): Promise<T> {
  return inSystemContext(fn);
}

function liveFor(grant: StandingInput, memo?: LiveMemo): Promise<LiveHumanTerm> {
  if (!memo) return computeLiveHumanTerm(grant.grantorUserId, grant.partnerId);
  const key = `${grant.grantorUserId}:${grant.partnerId}`;
  let pending = memo.get(key);
  if (!pending) {
    pending = computeLiveHumanTerm(grant.grantorUserId, grant.partnerId);
    memo.set(key, pending);
  }
  return pending;
}

/**
 * Expired, pause (with the reason), or ok. A grantor whose live reach no
 * longer intersects the pinned revision's orgs pauses (grantor_access_lost) —
 * partial narrowing does not; it shrinks the ceiling silently.
 */
export async function evaluateGrantStanding(grant: StandingInput, memo?: LiveMemo, now: Date = new Date()): Promise<GrantStanding> {
  if (grant.expiresAt.getTime() <= now.getTime()) return { kind: 'expired' };

  const live = await liveFor(grant, memo);
  if (!live.ok) return { kind: 'pause', reason: live.reason };

  if (!grant.currentRevisionId) {
    reportCorruptPin(grant.id, null, 'grant has no current revision');
    return { kind: 'pause', reason: 'grantor_access_lost' };
  }
  const [revision] = await systemContext(() =>
    db
      .select({ ceilingSnapshot: wispGrantRevisions.ceilingSnapshot })
      .from(wispGrantRevisions)
      .where(and(eq(wispGrantRevisions.id, grant.currentRevisionId!), eq(wispGrantRevisions.grantId, grant.id)))
      .limit(1),
  );
  const parsed = wispCeilingSnapshotSchema.safeParse(revision?.ceilingSnapshot);
  if (!parsed.success) {
    // Data corruption, not lost access: pause (fail closed) but make it loud —
    // the grantor-facing reason alone would hide a broken pin from operators.
    reportCorruptPin(grant.id, grant.currentRevisionId, revision ? 'malformed ceiling snapshot' : 'current revision row missing');
    return { kind: 'pause', reason: 'grantor_access_lost' };
  }

  const liveOrgs = new Set(grant.orgId ? live.orgIds.filter((id) => id === grant.orgId) : live.orgIds);
  if (!parsed.data.orgIds.some((id) => liveOrgs.has(id))) return { kind: 'pause', reason: 'grantor_access_lost' };
  return { kind: 'ok' };
}

type Tally = { paused: number; resumed: number; expired: number };
type SweepTally = Tally & { failed: number };

function reportCorruptPin(grantId: string, revisionId: string | null, detail: string): void {
  const err = new Error(`[wisp] grant ${grantId} has a corrupt ceiling pin (revision ${revisionId ?? 'none'}): ${detail}`);
  console.error(err.message);
  captureException(err, undefined, { grantId, ...(revisionId ? { revisionId } : {}) });
}

async function expireGrant(grantId: string): Promise<boolean> {
  const [row] = await systemContext(() =>
    db
      .update(wispGrants)
      .set({ status: 'expired', pausedReason: null })
      .where(and(eq(wispGrants.id, grantId), inArray(wispGrants.status, ['active', 'paused'])))
      .returning({ id: wispGrants.id, partnerId: wispGrants.partnerId, orgId: wispGrants.orgId }),
  );
  if (!row) return false;
  await createAuditLogAsync({
    partnerId: row.partnerId,
    orgId: row.orgId,
    actorType: 'system',
    actorId: ANONYMOUS_ACTOR_ID,
    action: 'wisp.grant.expired',
    resourceType: 'wisp_grant',
    resourceId: row.id,
    result: 'success',
  });
  return true;
}

async function reconcileOne(grant: WispGrantRow, tally: Tally, memo: LiveMemo, now: Date): Promise<void> {
  if (grant.status !== 'active' && grant.status !== 'paused') return;

  if (grant.expiresAt.getTime() <= now.getTime()) {
    if (await expireGrant(grant.id)) tally.expired += 1;
    return;
  }
  // A paused grant is only ours to evaluate when we paused it.
  if (grant.status === 'paused' && !SELF_RESUMABLE.has(grant.pausedReason ?? '')) return;

  const standing = await evaluateGrantStanding(grant, memo, now);
  if (standing.kind === 'expired') {
    if (await expireGrant(grant.id)) tally.expired += 1;
  } else if (grant.status === 'active' && standing.kind === 'pause') {
    // Only from active: a pause the grantor made while standing was being
    // evaluated stays theirs, and is never relabelled into one we could lift.
    await pauseGrant(grant.id, standing.reason, { onlyFromActive: true });
    tally.paused += 1;
  } else if (grant.status === 'paused' && standing.kind === 'ok') {
    // Compare-and-set on the exact pause we judged; a different pause set
    // meanwhile (W01/W05 owners) is left alone.
    await resumeGrant(grant.id, grant.pausedReason ?? undefined);
    tally.resumed += 1;
  }
}

async function reconcileRows(rows: WispGrantRow[], tally: SweepTally, memo: LiveMemo, now: Date): Promise<void> {
  for (const grant of rows) {
    try {
      await reconcileOne(grant, tally, memo, now);
    } catch (err) {
      // One grant must not stop the sweep, but a failure is never silent:
      // counted, logged and captured, and the job fails when nothing succeeded.
      tally.failed += 1;
      console.error(`[wisp] grant reconcile failed for ${grant.id}:`, err);
      captureException(err, undefined, { grantId: grant.id });
    }
  }
}

/** Push path: reconcile one grantor's live grants right after their authority changed. */
export async function reconcileGrantsForUser(userId: string): Promise<Tally> {
  const tally: SweepTally = { paused: 0, resumed: 0, expired: 0, failed: 0 };
  if (!wispEnabled()) return { paused: 0, resumed: 0, expired: 0 };
  const rows = await systemContext(() =>
    db
      .select()
      .from(wispGrants)
      .where(and(eq(wispGrants.grantorUserId, userId), inArray(wispGrants.status, ['active', 'paused']))),
  );
  await reconcileRows(rows, tally, new Map(), new Date());
  return { paused: tally.paused, resumed: tally.resumed, expired: tally.expired };
}

/** Pull path: the 5-minute sweep over every live grant, paged by id. */
export async function reconcileActiveGrants(now: Date = new Date()): Promise<SweepTally & { scanned: number }> {
  const tally: SweepTally = { paused: 0, resumed: 0, expired: 0, failed: 0 };
  const memo: LiveMemo = new Map();
  let scanned = 0;
  let cursor: string | null = null;
  for (;;) {
    const after: string | null = cursor;
    const page: WispGrantRow[] = await systemContext(() =>
      db
        .select()
        .from(wispGrants)
        .where(after === null
          ? inArray(wispGrants.status, ['active', 'paused'])
          : and(inArray(wispGrants.status, ['active', 'paused']), gt(wispGrants.id, after)))
        .orderBy(asc(wispGrants.id))
        .limit(PAGE_SIZE),
    );
    scanned += page.length;
    await reconcileRows(page, tally, memo, now);
    if (page.length < PAGE_SIZE) break;
    cursor = page[page.length - 1]!.id;
  }
  return { scanned, ...tally };
}

/**
 * Boot hook (index.ts, after the permission cache is cleared): reconcile a
 * user's grants whenever their permission authority changes. A noop when Wisp
 * is off at boot (the flag turned on later is picked up by the 5-minute sweep
 * until the next restart installs the push path); once installed, the
 * listener re-checks the flag on every call.
 */
export function installWispGrantHooks(): () => void {
  if (!wispEnabled()) return () => {};
  return onPermissionAuthorityChanged(async (userId) => {
    await reconcileGrantsForUser(userId);
  });
}
