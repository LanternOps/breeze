import { WISP_AUTO_LINKS_PER_TURN, type BreezeEntityRef } from '@breeze/shared';
import type { AuthContext } from '../../middleware/auth';
import { requestLikeFromSnapshot, writeAuditEvent } from '../auditEvents';
import type { ActiveSession } from '../streamingSessionManager';
import { createEntityResolver, isResolveFailure } from './entityRefs';
import { relatedRefs } from './entityRelations';
import type { GrantCeiling } from './grantAuthority';
import { addLink, ThreadLinkError, touchLinks } from './threadLinks';
import { subjectRefsOf } from './toolSubjects';

// Keep admission in call order so capped calls can reuse slots released by
// earlier re-touches. The counter still reserves before the first await.
type AutoLinkTurn = {
  usage: ActiveSession['pendingTurnUsage'];
  count: number;
  admission?: Promise<void>;
};
const autoLinkTurns = new WeakMap<ActiveSession, AutoLinkTurn>();

/**
 * A successful focal call's best-effort working-set update. Authority is the
 * call's captured auth/ceiling, never the session's mutable toolAuth. Even the
 * touch-only path resolves its subject and each relation before writing IDs.
 * Unexpected faults reach the detached onSuccess hook's logger/capture.
 */
export async function autoLinkFocalAct(args: {
  session: ActiveSession;
  toolName: string;
  input: Record<string, unknown>;
  auth: AuthContext;
  ceiling: GrantCeiling;
}): Promise<{ added: number; touched: number }> {
  const { session, toolName, input, auth, ceiling } = args;
  const grant = session.wispGrant;
  if (!grant) return { added: 0, touched: 0 };
  if (grant.grantId !== ceiling.grantId || grant.revisionId !== ceiling.revisionId) {
    console.debug('[Wisp] Auto-link grant mismatch', {
      grantId: ceiling.grantId, threadId: grant.threadId, toolName, reason: 'grant_mismatch',
    });
    return { added: 0, touched: 0 };
  }
  const subjects = subjectRefsOf(toolName, input);
  if (subjects.length === 0) return { added: 0, touched: 0 };
  // Settlement replaces pendingTurnUsage. Detached hooks retain their own
  // budget so releasing/reusing an old slot cannot change the next turn.
  let turn = autoLinkTurns.get(session);
  if (!turn || turn.usage !== session.pendingTurnUsage) {
    turn = { usage: session.pendingTurnUsage, count: session.pendingTurnAutoLinkCount };
    autoLinkTurns.set(session, turn);
  }
  const budget = turn;
  const publishCount = () => {
    if (session.pendingTurnUsage === budget.usage) session.pendingTurnAutoLinkCount = budget.count;
  };
  const reserveSlot = () => {
    if (budget.count >= WISP_AUTO_LINKS_PER_TURN) return false;
    budget.count += 1;
    publishCount();
    return true;
  };
  const releaseSlots = (count: number) => {
    budget.count = Math.max(0, budget.count - count);
    publishCount();
  };
  // Reserve ALL slots before the first await. Refusals consume reservations;
  // an existing-row touch releases one once the insert outcome is known.
  const reserved = subjects.map((subject) => {
    const mayAdd = reserveSlot();
    return { subject, mayAdd, attempted: false };
  });
  const previous = budget.admission;
  let finish!: () => void;
  const admission = new Promise<void>((resolve) => { finish = resolve; });
  budget.admission = admission;
  const ctx = { auth, ceiling };
  let added = 0;
  let touched = 0;
  let index = 0;
  try {
    await previous;
    const resolve = createEntityResolver(ctx);
    for (; index < reserved.length; index += 1) {
      const reservation = reserved[index]!;
      const { subject } = reservation;
      // Earlier calls may have released slots while this call was queued.
      if (!reservation.mayAdd) reservation.mayAdd = reserveSlot();
      const resolved = await resolve(subject);
      if (isResolveFailure(resolved)) {
        reservation.attempted = true; // Refusals deliberately consume the slot.
        continue;
      }
      const toTouch: BreezeEntityRef[] = [];
      reservation.attempted = true;
      if (reservation.mayAdd) {
        try {
          // Once entered, an unexpected throw may hide a committed insert.
          // Retain that slot even when the eventual outcome is unknown.
          const { link, inserted } = await addLink(ctx, grant.threadId, subject, {
            source: 'auto', addedByGrantId: ceiling.grantId, reportInsertion: true,
          });
          if (!inserted) {
            releaseSlots(1);
            touched += 1; // addLink already touched the existing row, including pins.
          } else {
            added += 1;
            if (session.auditSnapshot) {
              writeAuditEvent(requestLikeFromSnapshot(session.auditSnapshot), {
                orgId: link.ref.orgId,
                partnerId: ceiling.partnerId,
                action: 'wisp.thread.link_added',
                resourceType: 'wisp_thread',
                resourceId: grant.threadId,
                actorId: auth.user.id,
                actorEmail: auth.user.email,
                initiatedBy: 'ai',
                result: 'success',
                ipAddress: session.auditSnapshot.ip,
                userAgent: session.auditSnapshot.userAgent,
                details: { threadId: grant.threadId, grantId: ceiling.grantId, kind: subject.kind, entityId: subject.id, source: link.source },
              });
            }
          }
        } catch (err) {
          if (err instanceof ThreadLinkError) continue;
          throw err;
        }
      } else {
        toTouch.push(resolved.ref);
      }
      for (const relation of await relatedRefs(ceiling.partnerId, subject)) {
        const related = await resolve(relation);
        if (!isResolveFailure(related)) toTouch.push(related.ref);
      }
      touched += await touchLinks(ceiling.partnerId, grant.threadId, toTouch);
    }
  } catch (cause) {
    const abandoned = reserved.filter((reservation) => !reservation.attempted);
    const released = abandoned.filter((reservation) => reservation.mayAdd).length;
    releaseSlots(released);
    const subject = reserved[index]?.subject ?? subjects[0]!;
    throw new Error(`Wisp auto-link subject ${subject.kind}:${subject.id} threadId=${grant.threadId} failed; released=${released} abandoned=${abandoned.length}: ${cause instanceof Error ? cause.message : String(cause)}`, { cause });
  } finally {
    finish();
    if (autoLinkTurns.get(session) === budget && budget.admission === admission) autoLinkTurns.delete(session);
  }
  return { added, touched };
}
