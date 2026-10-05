import { and, eq } from 'drizzle-orm';
import { orgAutopayEnrollments } from '../../db/schema';
import type { NoticePreSendValidator } from './noticeOutbox';
import type { RenderedNotice } from './types';

type Enrollment = typeof orgAutopayEnrollments.$inferSelect;
const TRANSITIONS = {
  autopay_paused: { status: 'paused', at: (e: Enrollment) => e.pausedAt },
  autopay_resumed: { status: 'active', at: (e: Enrollment) => e.effectiveFrom },
  autopay_stopped: { status: 'cancelled', at: (e: Enrollment) => e.cancelledAt },
} as const;
export type LifecycleNoticeKind = keyof typeof TRANSITIONS;
export const LIFECYCLE_NOTICE_KINDS = Object.keys(TRANSITIONS) as LifecycleNoticeKind[];

/** The instant that identifies this transition (pausedAt, effectiveFrom or cancelledAt). */
export function lifecycleTransitionAt(kind: string, enrollment: Enrollment): string | null {
  return kind in TRANSITIONS ? TRANSITIONS[kind as LifecycleNoticeKind].at(enrollment)?.toISOString() ?? null : null;
}

/** Lifecycle emails retry with backoff and dispatch in nextAttemptAt order, so a
 * pause email whose transport failed can land after the resume email. Each one is
 * sent only while the enrollment is still in that state, at the same generation
 * and transition instant. */
export const validateLifecycleNotice: NoticePreSendValidator = async (tx, row) => {
  const superseded = 'Automatic payment status changed since this notice';
  const transition = TRANSITIONS[row.kind as LifecycleNoticeKind];
  if (!transition || !row.enrollmentId) return superseded;
  const [enrollment] = await tx.select().from(orgAutopayEnrollments).where(and(
    eq(orgAutopayEnrollments.id, row.enrollmentId), eq(orgAutopayEnrollments.orgId, row.orgId),
  )).limit(1);
  if (!enrollment || enrollment.id !== row.enrollmentId || enrollment.orgId !== row.orgId
    || enrollment.status !== transition.status || enrollment.generation !== row.seq) return superseded;
  // Rows enqueued before the transition instant was frozen fall back to status + generation.
  const frozen = (row.rendered as RenderedNotice).frozen?.transitionAt;
  return typeof frozen === 'string' && frozen !== transition.at(enrollment)?.toISOString() ? superseded : null;
};
