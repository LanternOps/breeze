/**
 * Wisp W08 (feature #9906; w00 A35, Review Focus 1–2) — the objects linked to
 * a Wisp thread (`wisp_thread_links`).
 *
 * Stored reads share `readStoredLinks`, which re-resolves EVERY row with
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
 * `touchLinks` also writes in system scope for the caller-owned thread.
 * Every query is pinned to `(partner_id, thread_id)`; thread ownership is the
 * caller's job (the routes' `loadOwnThread`, the chat tools' own grant thread).
 */
import { and, asc, count, desc, eq, inArray, or, sql } from 'drizzle-orm';
import {
  CONCERN_KIND_TO_ENTITY_KIND,
  WISP_THREAD_AUTO_LINK_LIMIT,
  WISP_THREAD_LINK_LIMIT,
  type BreezeEntityRef,
  type Concern,
  type WispEntityKind,
  type WispLinkRefusal,
  type WispLinkSource,
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

function toLink(row: Pick<WispThreadLinkRow, 'id' | 'source' | 'lastTouchedAt' | 'createdAt'>, r: ResolvedEntity): WispThreadLink {
  return {
    id: row.id,
    ref: r.ref,
    label: r.label,
    status: r.status,
    href: r.href,
    source: row.source,
    lastTouchedAt: row.lastTouchedAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
  };
}

const inPartner = <T>(partnerId: string, fn: () => Promise<T>) => readOwnPartnerAxisRows(partnerId, fn);

/**
 * Link `ref` to the thread. Resolves first (the org is the entity's); an
 * `orgId` hint that disagrees with the entity's org is `not_found` (a model
 * that names the wrong customer links nothing). Idempotent on
 * (thread, kind, id): a re-add promotes the source, refreshes label/org and
 * touches the existing row. Pins share a 50-row cap (`link_limit`); autos
 * evict the least recently touched auto at 20 rows. The thread row lock
 * serializes adds so concurrent inserts cannot pass either cap together.
 */
export async function addLink(
  ctx: EntityResolveContext,
  threadId: string,
  ref: { kind: WispEntityKind; id: string; orgId?: string | null },
  opts: { source: WispLinkSource; addedByGrantId?: string | null },
): Promise<WispThreadLink> {
  const resolved = await resolveEntityRef(ctx, { kind: ref.kind, id: ref.id });
  if (isResolveFailure(resolved)) throw new ThreadLinkError(resolved.reason);
  if (ref.orgId !== undefined && ref.orgId !== resolved.orgId) throw new ThreadLinkError('not_found');

  const partnerId = ctx.ceiling.partnerId;
  const addedByUserId = ctx.auth?.user.id ?? ctx.ceiling.grantorUserId;
  // The write runs in system scope, after the resolver decided the caller's
  // authority: the caps must count EVERY row of their class, including
  // the org_id NULL rows an org-scoped caller's RLS would hide (precedent:
  // concerns.ts writes on ids the caller already authorised). Every statement
  // stays pinned to (partner_id, thread_id).
  const row = await inSystemContext(() => db.transaction(async (tx) => {
    const [thread] = await tx.select({ id: wispThreads.id }).from(wispThreads)
      .where(and(eq(wispThreads.id, threadId), eq(wispThreads.partnerId, partnerId)))
      .for('update')
      .limit(1);
    if (!thread) throw new ThreadLinkError('not_found');

    const linkScope = and(
      eq(wispThreadLinks.threadId, threadId),
      eq(wispThreadLinks.partnerId, partnerId),
      eq(wispThreadLinks.entityKind, ref.kind),
      eq(wispThreadLinks.entityId, ref.id),
    );
    if (opts.source !== 'auto') {
      const [prior] = await tx.select({ source: wispThreadLinks.source }).from(wispThreadLinks)
        .where(linkScope).limit(1);
      // Promotion consumes a pin slot just like insertion. Check before any
      // update, under the thread lock, so a refusal leaves the auto untouched.
      if (prior?.source === 'auto') {
        const [pins] = await tx.select({ n: count() }).from(wispThreadLinks).where(and(
          eq(wispThreadLinks.threadId, threadId),
          eq(wispThreadLinks.partnerId, partnerId),
          inArray(wispThreadLinks.source, ['user_pin', 'wisp_pin']),
        ));
        if ((pins?.n ?? 0) >= WISP_THREAD_LINK_LIMIT) throw new ThreadLinkError('link_limit');
      }
    }

    const [existing] = await tx.update(wispThreadLinks)
      .set({
        label: resolved.label,
        orgId: resolved.orgId,
        source: sql<WispLinkSource>`CASE
          WHEN ${wispThreadLinks.source} = 'user_pin' OR ${opts.source} = 'user_pin' THEN 'user_pin'
          WHEN ${wispThreadLinks.source} = 'wisp_pin' OR ${opts.source} = 'wisp_pin' THEN 'wisp_pin'
          ELSE 'auto' END`,
        lastTouchedAt: sql`now()`,
        touchCount: sql`${wispThreadLinks.touchCount} + 1`,
      })
      .where(linkScope)
      .returning();
    if (existing) return existing;

    const isAuto = opts.source === 'auto';
    const classScope = and(
      eq(wispThreadLinks.threadId, threadId),
      eq(wispThreadLinks.partnerId, partnerId),
      isAuto ? eq(wispThreadLinks.source, 'auto') : inArray(wispThreadLinks.source, ['user_pin', 'wisp_pin']),
    );
    const [counted] = await tx.select({ n: count() }).from(wispThreadLinks).where(classScope);
    if ((counted?.n ?? 0) >= (isAuto ? WISP_THREAD_AUTO_LINK_LIMIT : WISP_THREAD_LINK_LIMIT)) {
      if (!isAuto) throw new ThreadLinkError('link_limit');
      const [oldest] = await tx.select({ id: wispThreadLinks.id }).from(wispThreadLinks)
        .where(classScope)
        .orderBy(asc(wispThreadLinks.lastTouchedAt), asc(wispThreadLinks.id))
        .limit(1);
      if (oldest) {
        await tx.delete(wispThreadLinks).where(and(classScope, eq(wispThreadLinks.id, oldest.id)));
      }
    }

    const [inserted] = await tx.insert(wispThreadLinks).values({
      threadId,
      partnerId,
      orgId: resolved.orgId,
      entityKind: ref.kind,
      entityId: ref.id,
      label: resolved.label,
      addedByUserId,
      addedByGrantId: opts.addedByGrantId ?? null,
      source: opts.source,
    }).returning();
    if (!inserted) throw new Error('wisp_thread_links insert returned no row');
    return inserted;
  }));
  return toLink(row, resolved);
}

/**
 * Touch existing refs only; no resolution, insertion or cached-field changes.
 * Writes in system scope, pinned to the partner and thread, even when caller
 * RLS hides some links. `partnerId` and `threadId` must be server-derived;
 * the caller must establish that it owns the thread.
 */
export async function touchLinks(partnerId: string, threadId: string, refs: BreezeEntityRef[]): Promise<number> {
  if (refs.length === 0) return 0;
  const rows = await inSystemContext(() => db.update(wispThreadLinks)
    .set({ lastTouchedAt: sql`now()`, touchCount: sql`${wispThreadLinks.touchCount} + 1` })
    .where(and(
      eq(wispThreadLinks.threadId, threadId),
      eq(wispThreadLinks.partnerId, partnerId),
      or(...refs.map((ref) => and(
        eq(wispThreadLinks.entityKind, ref.kind),
        eq(wispThreadLinks.entityId, ref.id),
      ))),
    ))
    .returning({ id: wispThreadLinks.id }));
  return rows.length;
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
 * The thread's stored links this caller may see, most recently touched first. Rows whose
 * object is gone are deleted; rows the caller or grant cannot see are kept
 * and omitted. Entities resolve one at a time (each is a short system read).
 */
async function readStoredLinks(
  ctx: EntityResolveContext,
  threadId: string,
  resolve: ReturnType<typeof createEntityResolver>,
): Promise<WispThreadLink[]> {
  const partnerId = ctx.ceiling.partnerId;
  const rows = await inPartner(partnerId, () => db.select().from(wispThreadLinks)
    .where(and(eq(wispThreadLinks.threadId, threadId), eq(wispThreadLinks.partnerId, partnerId)))
    .orderBy(desc(wispThreadLinks.lastTouchedAt), desc(wispThreadLinks.id))
    .limit(WISP_THREAD_LINK_LIMIT * 2));

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
  return out;
}

/** Stored-only read for list_links; preserve its existing output cap. */
export async function listLinks(ctx: EntityResolveContext, threadId: string): Promise<WispThreadLink[]> {
  const links = await readStoredLinks(ctx, threadId, createEntityResolver(ctx));
  return links.slice(0, WISP_THREAD_LINK_LIMIT);
}

/** Pins, live concern subjects, then autos; concern rows are never persisted. */
export async function listWorkingSet(
  ctx: EntityResolveContext,
  threadId: string,
  opts?: { concerns?: Concern[] },
): Promise<WispThreadLink[]> {
  const resolve = createEntityResolver(ctx);
  const stored = await readStoredLinks(ctx, threadId, resolve);
  const key = (ref: { kind: WispEntityKind; id: string }) => `${ref.kind}:${ref.id}`;
  const seen = new Set(stored.map((link) => key(link.ref)));
  const subjects: WispThreadLink[] = [];
  await inSystemContext(async () => {
    for (const concern of opts?.concerns ?? []) {
      if (concern.status !== 'open' && concern.status !== 'snoozed') continue;
      const kind = CONCERN_KIND_TO_ENTITY_KIND[concern.subject.kind];
      if (!kind) continue;
      const ref = { kind, id: concern.subject.id };
      if (seen.has(key(ref))) continue;
      seen.add(key(ref));
      const resolved = await resolve(ref);
      if (isResolveFailure(resolved)) continue;
      subjects.push({
        id: null,
        ref: resolved.ref,
        label: resolved.label,
        status: resolved.status,
        href: resolved.href,
        source: 'concern',
        // Concern.updatedAt is its latest change, including snooze/status changes.
        lastTouchedAt: concern.updatedAt,
        createdAt: concern.createdAt,
      });
    }
  });
  return [
    ...stored.filter((link) => link.source !== 'auto'),
    ...subjects,
    ...stored.filter((link) => link.source === 'auto'),
  ];
}
