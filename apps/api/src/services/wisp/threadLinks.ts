/**
 * Wisp W08 (feature #9906; w00 A35, Review Focus 1–2) — the objects linked to
 * a Wisp thread (`wisp_thread_links`).
 *
 * Every read goes through `listLinks`, which re-resolves EVERY row with
 * `resolveEntityRef` (entity read, caller permission, live ceiling, token
 * scope) — the stored `label` and `org_id` are caches, never an authority:
 *   - `not_found` (the object is gone) → the row is deleted;
 *   - `forbidden` / `outside_ceiling` / `outside_token_scope` → the row is
 *     kept and omitted (the grant or the role may widen again);
 *   - resolved → returned with the fresh label/status; a stale cached label or
 *     org is refreshed in place.
 * There is no other read path that returns a stored label.
 *
 * Reads, prunes and removes go through `readOwnPartnerAxisRows`: in place
 * under the caller's RLS when a request context can see the partner (so an
 * org-scoped context never even loads an `org_id IS NULL` row), in system
 * scope otherwise (the session seed, which has no caller). `addLink` writes in
 * system scope once the resolver has decided, so its cap counts every row.
 * Every query is pinned to `(partner_id, thread_id)`; thread ownership is the
 * caller's job (the routes' `loadOwnThread`, the chat tools' own grant thread).
 */
import { and, count, desc, eq } from 'drizzle-orm';
import {
  WISP_THREAD_LINK_LIMIT,
  type WispEntityKind,
  type WispLinkRefusal,
  type WispThreadLink,
} from '@breeze/shared';
import { db } from '../../db';
import { readOwnPartnerAxisRows } from '../../db/partnerAxisRead';
import { wispThreadLinks, type WispThreadLinkRow } from '../../db/schema/wispThreadLinks';
import { wispThreads } from '../../db/schema/wispThreads';
import {
  createEntityResolver,
  isResolveFailure,
  resolveEntityRef,
  type EntityResolveContext,
  type ResolvedEntity,
} from './entityRefs';
import { inSystemContext } from './grantAuthority';

export class ThreadLinkError extends Error {
  constructor(public readonly code: WispLinkRefusal) {
    super(`Wisp thread link refused: ${code}`);
    this.name = 'ThreadLinkError';
  }
}

/** HTTP status for each refusal (routes); existence-neutral 404 for `not_found`. */
export const THREAD_LINK_REFUSAL_STATUS: Readonly<Record<WispLinkRefusal, 403 | 404 | 409>> = Object.freeze({
  not_found: 404,
  forbidden: 403,
  outside_ceiling: 403,
  outside_token_scope: 403,
  link_limit: 409,
});

function toLink(row: Pick<WispThreadLinkRow, 'id' | 'addedByGrantId' | 'createdAt'>, r: ResolvedEntity): WispThreadLink {
  return {
    id: row.id,
    ref: r.ref,
    label: r.label,
    status: r.status,
    href: r.href,
    addedBy: row.addedByGrantId ? 'wisp' : 'user',
    createdAt: row.createdAt.toISOString(),
  };
}

const inPartner = <T>(partnerId: string, fn: () => Promise<T>) => readOwnPartnerAxisRows(partnerId, fn);

/**
 * Link `ref` to the thread. Resolves first (the org is the entity's); an
 * `orgId` hint that disagrees with the entity's org is `not_found` (a model
 * that names the wrong customer links nothing). Idempotent on
 * (thread, kind, id): a re-add returns the existing row with a refreshed
 * label/org. 50 links per thread (`link_limit`), counted under a row lock on
 * the thread so two concurrent adds cannot pass the cap together.
 */
export async function addLink(
  ctx: EntityResolveContext,
  threadId: string,
  ref: { kind: WispEntityKind; id: string; orgId?: string | null },
  opts: { addedByGrantId?: string | null } = {},
): Promise<WispThreadLink> {
  const resolved = await resolveEntityRef(ctx, { kind: ref.kind, id: ref.id });
  if (isResolveFailure(resolved)) throw new ThreadLinkError(resolved.reason);
  if (ref.orgId !== undefined && ref.orgId !== resolved.orgId) throw new ThreadLinkError('not_found');

  const partnerId = ctx.ceiling.partnerId;
  const addedByUserId = ctx.auth?.user.id ?? ctx.ceiling.grantorUserId;
  // The write runs in system scope, after the resolver decided the caller's
  // authority: the 50-link cap must count EVERY row of the thread, including
  // the org_id NULL rows an org-scoped caller's RLS would hide (precedent:
  // concerns.ts writes on ids the caller already authorised). Every statement
  // stays pinned to (partner_id, thread_id).
  const row = await inSystemContext(() => db.transaction(async (tx) => {
    const [thread] = await tx.select({ id: wispThreads.id }).from(wispThreads)
      .where(and(eq(wispThreads.id, threadId), eq(wispThreads.partnerId, partnerId)))
      .for('update')
      .limit(1);
    if (!thread) throw new ThreadLinkError('not_found');

    const [existing] = await tx.update(wispThreadLinks)
      .set({ label: resolved.label, orgId: resolved.orgId })
      .where(and(
        eq(wispThreadLinks.threadId, threadId),
        eq(wispThreadLinks.partnerId, partnerId),
        eq(wispThreadLinks.entityKind, ref.kind),
        eq(wispThreadLinks.entityId, ref.id),
      ))
      .returning();
    if (existing) return existing;

    const [counted] = await tx.select({ n: count() }).from(wispThreadLinks)
      .where(and(eq(wispThreadLinks.threadId, threadId), eq(wispThreadLinks.partnerId, partnerId)));
    if ((counted?.n ?? 0) >= WISP_THREAD_LINK_LIMIT) throw new ThreadLinkError('link_limit');

    const [inserted] = await tx.insert(wispThreadLinks).values({
      threadId,
      partnerId,
      orgId: resolved.orgId,
      entityKind: ref.kind,
      entityId: ref.id,
      label: resolved.label,
      addedByUserId,
      addedByGrantId: opts.addedByGrantId ?? null,
    }).returning();
    if (!inserted) throw new Error('wisp_thread_links insert returned no row');
    return inserted;
  }));
  return toLink(row, resolved);
}

export type RemovedThreadLink = { id: string; orgId: string | null; entityKind: WispEntityKind; entityId: string };

/**
 * Remove one link of the thread (no resolve: a person may always drop a link
 * from their own thread, even one they can no longer open). Null when it is
 * not there or not visible to the caller.
 */
export async function removeLink(partnerId: string, threadId: string, linkId: string): Promise<RemovedThreadLink | null> {
  const [row] = await inPartner(partnerId, () => db.delete(wispThreadLinks)
    .where(and(
      eq(wispThreadLinks.id, linkId),
      eq(wispThreadLinks.threadId, threadId),
      eq(wispThreadLinks.partnerId, partnerId),
    ))
    .returning({
      id: wispThreadLinks.id,
      orgId: wispThreadLinks.orgId,
      entityKind: wispThreadLinks.entityKind,
      entityId: wispThreadLinks.entityId,
    }));
  return row ?? null;
}

/**
 * The thread's links this caller may see right now, newest first. Rows whose
 * object is gone are deleted; rows the caller or grant cannot see are kept
 * and omitted. Entities resolve one at a time (each is a short system read).
 */
export async function listLinks(ctx: EntityResolveContext, threadId: string): Promise<WispThreadLink[]> {
  const partnerId = ctx.ceiling.partnerId;
  const rows = await inPartner(partnerId, () => db.select().from(wispThreadLinks)
    .where(and(eq(wispThreadLinks.threadId, threadId), eq(wispThreadLinks.partnerId, partnerId)))
    .orderBy(desc(wispThreadLinks.createdAt), desc(wispThreadLinks.id))
    .limit(WISP_THREAD_LINK_LIMIT * 2));

  const resolve = createEntityResolver(ctx);
  const out: WispThreadLink[] = [];
  const gone: string[] = [];
  const stale: Array<{ id: string; label: string; orgId: string | null }> = [];
  // One system context for every resolve: from a request each loader would
  // otherwise take (and give back) a second pooled connection per row.
  await inSystemContext(async () => {
    for (const row of rows) {
      const r = await resolve({ kind: row.entityKind, id: row.entityId });
      if (isResolveFailure(r)) {
        if (r.reason === 'not_found') gone.push(row.id);
        continue;
      }
      if (r.label !== row.label || r.orgId !== row.orgId) stale.push({ id: row.id, label: r.label, orgId: r.orgId });
      out.push(toLink(row, r));
    }
  });

  if (gone.length > 0 || stale.length > 0) {
    await inPartner(partnerId, async () => {
      for (const id of gone) {
        await db.delete(wispThreadLinks).where(and(eq(wispThreadLinks.id, id), eq(wispThreadLinks.partnerId, partnerId)));
      }
      for (const s of stale) {
        await db.update(wispThreadLinks).set({ label: s.label, orgId: s.orgId })
          .where(and(eq(wispThreadLinks.id, s.id), eq(wispThreadLinks.partnerId, partnerId)));
      }
    });
  }
  return out.slice(0, WISP_THREAD_LINK_LIMIT);
}
