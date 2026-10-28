/**
 * Wisp W08 (feature #9906; w00 A35) — the objects linked to a Wisp thread:
 *
 *   GET    /wisp/thread/:id/links            → 200 { data: { links } }
 *   POST   /wisp/thread/:id/links            → 201 { data: { link } }   body linkEntitySchema
 *   DELETE /wisp/thread/:id/links/:linkId    → 204
 *
 * Mounted under W02's `wispRoutes` beside W04's thread router, so every gate
 * of the hub applies (BREEZE_WISP_ENABLED 404, partner scope,
 * ai_sessions:use, the `wisp` entitlement). Grantor-only via W04's
 * `loadOwnThread`: another user's thread and a malformed id are the same 404.
 *
 * Reads and adds need the grant's live ceiling (`ceilingOf`; a paused or
 * ended grant is 409 grant_inactive): every link is re-resolved through
 * `resolveEntityRef` on each read and resolved before it is written. A
 * remove needs only ownership — a person can always drop a link from their
 * own thread. Both mutations are audited with `{ threadId, kind, entityId }`.
 */
import { Hono, type Context } from 'hono';
import { linkEntitySchema, threadLinkParamsSchema, type WispLinkRefusal } from '@breeze/shared';
import { zValidator } from '../lib/validation';
import type { AuthContext } from '../middleware/auth';
import { writeRouteAudit } from '../services/auditEvents';
import {
  addLink,
  listLinks,
  removeLink,
  ThreadLinkError,
  THREAD_LINK_REFUSAL_STATUS,
} from '../services/wisp/threadLinks';
import { ceilingOf, ceilingRefusal, loadOwnThread } from './wispThreads';

const NOT_FOUND = { error: 'Wisp thread not found', code: 'not_found' } as const;

const REFUSAL_MESSAGE: Record<WispLinkRefusal, string> = {
  not_found: 'That item was not found.',
  forbidden: 'You do not have access to that item.',
  outside_ceiling: 'That item is outside what you have delegated to Wisp.',
  outside_token_scope: 'That item is outside your current organization.',
  link_limit: 'This Wisp thread already has the maximum number of linked items.',
};

const authOf = (c: Context): AuthContext => c.get('auth') as AuthContext;

export const wispThreadLinkRoutes = new Hono();

wispThreadLinkRoutes.get('/:id/links', async (c) => {
  const own = await loadOwnThread(c);
  if (!own) return c.json(NOT_FOUND, 404);
  const outcome = await ceilingOf(own);
  if (!outcome.ok) return ceilingRefusal(c, outcome.reason);
  const links = await listLinks({ auth: authOf(c), ceiling: outcome.ceiling }, own.thread.id);
  return c.json({ data: { links } });
});

wispThreadLinkRoutes.post('/:id/links', zValidator('json', linkEntitySchema), async (c) => {
  const own = await loadOwnThread(c);
  if (!own) return c.json(NOT_FOUND, 404);
  const outcome = await ceilingOf(own);
  if (!outcome.ok) return ceilingRefusal(c, outcome.reason);
  const body = c.req.valid('json');
  let link;
  try {
    // `label` is accepted but never stored as given: the label is the entity's.
    link = await addLink(
      { auth: authOf(c), ceiling: outcome.ceiling },
      own.thread.id,
      { kind: body.kind, id: body.id, orgId: body.orgId },
      { source: 'user_pin', addedByGrantId: null },
    );
  } catch (err) {
    if (err instanceof ThreadLinkError) {
      return c.json({ error: REFUSAL_MESSAGE[err.code], code: err.code }, THREAD_LINK_REFUSAL_STATUS[err.code]);
    }
    throw err;
  }
  writeRouteAudit(c, {
    orgId: link.ref.orgId,
    partnerId: own.thread.partnerId,
    action: 'wisp.thread.link_added',
    resourceType: 'wisp_thread',
    resourceId: own.thread.id,
    details: { threadId: own.thread.id, kind: link.ref.kind, entityId: link.ref.id },
  });
  return c.json({ data: { link } }, 201);
});

wispThreadLinkRoutes.delete('/:id/links/:linkId', async (c) => {
  const params = threadLinkParamsSchema.safeParse({ id: c.req.param('id'), linkId: c.req.param('linkId') });
  if (!params.success) return c.json(NOT_FOUND, 404);
  const own = await loadOwnThread(c);
  if (!own) return c.json(NOT_FOUND, 404);
  const removed = await removeLink(own.thread.partnerId, own.thread.id, params.data.linkId);
  if (!removed) return c.json({ error: 'Link not found', code: 'not_found' }, 404);
  writeRouteAudit(c, {
    orgId: removed.orgId,
    partnerId: own.thread.partnerId,
    action: 'wisp.thread.link_removed',
    resourceType: 'wisp_thread',
    resourceId: own.thread.id,
    details: { threadId: own.thread.id, kind: removed.entityKind, entityId: removed.entityId },
  });
  return c.body(null, 204);
});
