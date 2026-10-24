/**
 * Wisp W04 — the durable conversation thread (Wisp design §6; w00 "Threads
 * (W04)" + A24). One thread per grant; SDK sessions are short-lived and
 * attached to it. A new session inherits only what `seedContextForSession`
 * renders: the focus line, the deterministic summary, live attachments (by
 * handle) and recalled memory — every user/model-authored piece fenced as
 * untrusted data. Context, never authority.
 *
 * Every read/write runs in SYSTEM context (`inSystemContext`): callers are the
 * request path (createSession), the SDK background processor and the eviction
 * sweep, and the thread's partner axis is not visible to an org-scoped request
 * context. Ids are authorised by the caller (validateWispGrantForSession) —
 * this module never takes an id from the model.
 */
import { and, eq, sql } from 'drizzle-orm';
import { db } from '../../db';
import { aiSessions } from '../../db/schema/ai';
import { organizations } from '../../db/schema/orgs';
import { wispGrants } from '../../db/schema/wisp';
import { wispThreadSessions, wispThreads, type WispThreadRow } from '../../db/schema/wispThreads';
import { sanitizeUntrustedText, wrapUntrustedData } from '../aiInputSanitizer';
import { assertWithinCeiling, inSystemContext, type GrantCeiling } from './grantAuthority';
import { recallForGrant, renderMemoryForPrompt } from './memoryBroker';
import { attachmentSeedLines, listThreadAttachments } from './threadAttachments';
import { THREAD_SUMMARY_MAX_CHARS, truncateSummary } from './threadSummary';

export type WispThread = {
  id: string;
  grantId: string;
  partnerId: string;
  summary: string;
  summaryUpdatedAt: Date | null;
  lastSessionId: string | null;
  /** w00 A24: the customer this thread is working on; null = unfocused. */
  focusOrgId: string | null;
  createdAt: Date;
  updatedAt: Date;
};

export type WispThreadErrorCode = 'grant_not_found' | 'thread_not_found' | 'session_not_found';

export class WispThreadError extends Error {
  constructor(public readonly code: WispThreadErrorCode, message: string) {
    super(message);
    this.name = 'WispThreadError';
  }
}

/** Unfocused recall, and the focused user+org recall. */
const SEED_RECALL_LIMIT = 40;
/** Focused threads: partner-owned blocks, second. */
const SEED_PARTNER_RECALL_LIMIT = 20;
/** organizations.name is tenant-entered text; it never needs more. */
const FOCUS_NAME_MAX_CHARS = 200;

function toThread(row: WispThreadRow): WispThread {
  return {
    id: row.id,
    grantId: row.grantId,
    partnerId: row.partnerId,
    summary: row.summary,
    summaryUpdatedAt: row.summaryUpdatedAt ?? null,
    lastSessionId: row.lastSessionId ?? null,
    focusOrgId: row.focusOrgId ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/**
 * The grant's thread, created on first use. Fast path: one SELECT. On a miss,
 * INSERT … ON CONFLICT (grant_id) DO NOTHING (partner_id from wisp_grants),
 * then SELECT — two concurrent first sessions end on the same row.
 */
export async function getOrCreateThread(grantId: string): Promise<WispThread> {
  return inSystemContext(async () => {
    const [existing] = await db.select().from(wispThreads).where(eq(wispThreads.grantId, grantId)).limit(1);
    if (existing) return toThread(existing);

    const [grant] = await db
      .select({ id: wispGrants.id, partnerId: wispGrants.partnerId })
      .from(wispGrants)
      .where(eq(wispGrants.id, grantId))
      .limit(1);
    if (!grant) throw new WispThreadError('grant_not_found', `Wisp grant ${grantId} not found`);

    const [created] = await db
      .insert(wispThreads)
      .values({ grantId, partnerId: grant.partnerId })
      .onConflictDoNothing({ target: wispThreads.grantId })
      .returning();
    if (created) return toThread(created);

    const [raced] = await db.select().from(wispThreads).where(eq(wispThreads.grantId, grantId)).limit(1);
    if (!raced) throw new WispThreadError('thread_not_found', `Wisp thread for grant ${grantId} not found after insert`);
    return toThread(raced);
  });
}

/**
 * Link a session to its thread: (thread_id, session_id, partner_id from the
 * thread, org_id from ai_sessions), and point `last_session_id` at it.
 * Idempotent on the (thread_id, session_id) PK; a session already attached to
 * a DIFFERENT thread still violates `wisp_thread_sessions_session_uq` loudly.
 */
export async function attachSession(threadId: string, sessionId: string): Promise<void> {
  await inSystemContext(async () => {
    const [thread] = await db
      .select({ partnerId: wispThreads.partnerId })
      .from(wispThreads)
      .where(eq(wispThreads.id, threadId))
      .limit(1);
    if (!thread) throw new WispThreadError('thread_not_found', `Wisp thread ${threadId} not found`);

    const [session] = await db
      .select({ orgId: aiSessions.orgId })
      .from(aiSessions)
      .where(eq(aiSessions.id, sessionId))
      .limit(1);
    if (!session) throw new WispThreadError('session_not_found', `AI session ${sessionId} not found`);

    await db
      .insert(wispThreadSessions)
      .values({ threadId, sessionId, partnerId: thread.partnerId, orgId: session.orgId })
      .onConflictDoNothing({ target: [wispThreadSessions.threadId, wispThreadSessions.sessionId] });
    await db
      .update(wispThreads)
      .set({ lastSessionId: sessionId, updatedAt: sql`now()` })
      .where(eq(wispThreads.id, threadId));
  });
}

/** Store `truncateSummary(summary)` (≤ 4 000) and stamp `summary_updated_at`. */
export async function updateThreadSummary(threadId: string, summary: string): Promise<void> {
  const stored = truncateSummary(summary);
  await inSystemContext(async () => {
    const rows = await db
      .update(wispThreads)
      .set({ summary: stored, summaryUpdatedAt: sql`now()`, updatedAt: sql`now()` })
      .where(eq(wispThreads.id, threadId))
      .returning({ id: wispThreads.id });
    if (rows.length === 0) throw new WispThreadError('thread_not_found', `Wisp thread ${threadId} not found`);
  });
}

/**
 * The only context a new SDK session inherits from its thread ('' when there
 * is nothing to say):
 *
 *   ## Wisp thread
 *   Focus: <org name>                              (focused threads only)
 *   <wisp_thread_summary fence>                    (non-empty summary only)
 *   <wisp_thread_attachments fence>                (live attachments only, by handle)
 *   <memory>                                       (focused: user+org for the focus, then partner;
 *                                                   unfocused: one call, grant org or none)
 *
 * A focus org outside the ceiling makes `recallForGrant` throw
 * CeilingViolationError; it propagates (the caller re-checks the focus at
 * session create, w00 A24).
 */
export async function seedContextForSession(threadId: string, ceiling: GrantCeiling): Promise<string> {
  return inSystemContext(async () => {
    const [row] = await db
      .select()
      .from(wispThreads)
      .where(and(eq(wispThreads.id, threadId), eq(wispThreads.partnerId, ceiling.partnerId)))
      .limit(1);
    if (!row) throw new WispThreadError('thread_not_found', `Wisp thread ${threadId} not found`);
    const thread = toThread(row);
    const flags: string[] = [];
    const parts: string[] = [];

    if (thread.focusOrgId !== null) {
      const [org] = await db
        .select({ name: organizations.name })
        .from(organizations)
        .where(and(eq(organizations.id, thread.focusOrgId), eq(organizations.partnerId, thread.partnerId)))
        .limit(1);
      if (org) parts.push(`Focus: ${sanitizeUntrustedText(org.name, FOCUS_NAME_MAX_CHARS, flags)}`);
    }

    if (thread.summary !== '') {
      parts.push(wrapUntrustedData(
        'wisp_thread_summary',
        sanitizeUntrustedText(thread.summary, THREAD_SUMMARY_MAX_CHARS, flags),
        flags,
      ));
    }

    const attachments = await listThreadAttachments(threadId);
    if (attachments.length > 0) {
      const lines = attachmentSeedLines(attachments);
      // Labels are user text, hence the fence; the model reads bytes by handle (read_artifact).
      if (lines !== '') parts.push(wrapUntrustedData('wisp_thread_attachments', lines, flags));
    }

    if (thread.focusOrgId !== null) {
      // Org-private blocks belong to the focus, never to a partner-level answer (spec §8.3).
      const focused = await recallForGrant(ceiling, {
        owners: ['user', 'org'], orgId: thread.focusOrgId, limit: SEED_RECALL_LIMIT,
      });
      const partnerBlocks = await recallForGrant(ceiling, { owners: ['partner'], limit: SEED_PARTNER_RECALL_LIMIT });
      for (const rendered of [renderMemoryForPrompt(focused), renderMemoryForPrompt(partnerBlocks)]) {
        if (rendered !== '') parts.push(rendered);
      }
    } else {
      const blocks = await recallForGrant(ceiling, { limit: SEED_RECALL_LIMIT, orgId: ceiling.scopeOrgId ?? undefined });
      const rendered = renderMemoryForPrompt(blocks);
      if (rendered !== '') parts.push(rendered);
    }

    if (parts.length === 0) return '';
    return `## Wisp thread\n${parts.join('\n\n')}`;
  });
}

/**
 * w00 A24: set or clear the thread's focus org. A non-null org is checked
 * against the ceiling BEFORE the write (CeilingViolationError propagates, no
 * UPDATE runs); null clears with no ceiling check. The UPDATE is keyed by the
 * thread id AND the ceiling's partner and grant, so a ceiling can only move its
 * own grant's thread. Throws WispThreadError('thread_not_found') when nothing
 * matched.
 */
export async function setThreadFocus(threadId: string, orgId: string | null, ceiling: GrantCeiling): Promise<WispThread> {
  if (orgId !== null) assertWithinCeiling(ceiling, { orgId });
  return inSystemContext(async () => {
    const [row] = await db
      .update(wispThreads)
      .set({ focusOrgId: orgId, updatedAt: sql`now()` })
      .where(and(
        eq(wispThreads.id, threadId),
        eq(wispThreads.partnerId, ceiling.partnerId),
        eq(wispThreads.grantId, ceiling.grantId),
      ))
      .returning();
    if (!row) throw new WispThreadError('thread_not_found', `Wisp thread ${threadId} not found`);
    return toThread(row);
  });
}
