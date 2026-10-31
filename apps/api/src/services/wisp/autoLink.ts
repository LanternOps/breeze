import { WISP_AUTO_LINKS_PER_TURN, type BreezeEntityRef } from '@breeze/shared';
import type { AuthContext } from '../../middleware/auth';
import { requestLikeFromSnapshot, writeAuditEvent } from '../auditEvents';
import type { ActiveSession } from '../streamingSessionManager';
import { createEntityResolver, isResolveFailure } from './entityRefs';
import { relatedRefs } from './entityRelations';
import type { GrantCeiling } from './grantAuthority';
import { addLink, ThreadLinkError, touchLinks } from './threadLinks';
import { subjectRefsOf } from './toolSubjects';

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
  if (!grant || grant.grantId !== ceiling.grantId || grant.revisionId !== ceiling.revisionId) return { added: 0, touched: 0 };
  const subjects = subjectRefsOf(toolName, input);
  // Reserve ALL slots before the first await. Parallel calls share this
  // counter; refusals consume their reservation rather than opening a race.
  const reserved = subjects.map((subject) => {
    const mayAdd = session.pendingTurnAutoLinkCount < WISP_AUTO_LINKS_PER_TURN;
    if (mayAdd) session.pendingTurnAutoLinkCount += 1;
    return { subject, mayAdd };
  });
  const ctx = { auth, ceiling };
  const resolve = createEntityResolver(ctx);
  let added = 0;
  let touched = 0;
  for (const { subject, mayAdd } of reserved) {
    const resolved = await resolve(subject);
    if (isResolveFailure(resolved)) continue;
    const toTouch: BreezeEntityRef[] = [];
    if (mayAdd) {
      try {
        const link = await addLink(ctx, grant.threadId, subject, { source: 'auto', addedByGrantId: ceiling.grantId });
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
            details: { threadId: grant.threadId, grantId: ceiling.grantId, kind: subject.kind, entityId: subject.id, source: 'auto' },
          });
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
  return { added, touched };
}
