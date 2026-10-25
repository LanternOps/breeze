/**
 * Wisp W08 (feature #9906; w00 A35, spec §17.2) — `GET /wisp/home?grantId=`:
 * one read for the home's first paint. Tables only — no model call (pinned
 * by services/wisp/home.noModel.contract.test.ts).
 *
 * Mounted under W02's `wispRoutes` (flag 404, partner scope,
 * ai_sessions:use, entitlement). Grantor-only: the grant comes from the
 * caller's own grants (`listGrants({ view: 'mine' })`), so another user's
 * grant id is the same 404 as a missing one. Without `grantId`, the caller's
 * usable grant: active before paused, partner-wide before org-scoped, newest
 * first; none → 404 `no_grant` (the page shows the start card).
 *
 * Payload = `GET /wisp/thread/:id`'s members (thread, focusOrgName, grant with
 * the spend meter and pausedReason, wideningAvailable) + brief, needsYou,
 * activity, current, links, partner. A paused grant still renders (brief +
 * partner switch, empty ceiling-bound sections) so the page can offer resume.
 */
import { Hono, type Context } from 'hono';
import { wispHomeQuerySchema, type WispHomePayload } from '@breeze/shared';
import { zValidator } from '../lib/validation';
import type { AuthContext } from '../middleware/auth';
import { listGrants, type WispGrant } from '../services/wisp/grants';
import { buildHomeSections } from '../services/wisp/home';
import { getOrCreateThread } from '../services/wisp/threads';
import { ceilingOf, ceilingRefusal, threadPayload } from './wispThreads';

const authOf = (c: Context): AuthContext => c.get('auth') as AuthContext;

const usable = (g: WispGrant, now: number) => (g.status === 'active' || g.status === 'paused') && g.expiresAt.getTime() > now;

/** Active first, then partner-wide, then the order listGrants returned (newest first). */
function pickGrant(grants: WispGrant[], now: number): WispGrant | null {
  const candidates = grants.filter((g) => usable(g, now));
  const rank = (g: WispGrant) => (g.status === 'active' ? 0 : 2) + (g.orgId === null ? 0 : 1);
  return candidates.map((g, i) => ({ g, i })).sort((a, b) => rank(a.g) - rank(b.g) || a.i - b.i)[0]?.g ?? null;
}

export const wispHomeRoutes = new Hono();

wispHomeRoutes.get('/', zValidator('query', wispHomeQuerySchema), async (c) => {
  const auth = authOf(c);
  if (!auth.partnerId) throw new Error('wisp home reached without a partner (hub gates bypassed?)');
  const partnerId = auth.partnerId;
  const { grantId } = c.req.valid('query');
  const now = Date.now();

  const mine = await listGrants({ auth, view: 'mine' });
  const grant = grantId
    ? mine.find((g) => g.id === grantId && usable(g, now)) ?? null
    : pickGrant(mine, now);
  if (!grant) {
    return grantId
      ? c.json({ error: 'Wisp delegation not found', code: 'not_found' }, 404)
      : c.json({ error: 'No Wisp delegation yet', code: 'no_grant' }, 404);
  }

  // Idempotent create-on-first-use of the grantor's own thread (W04), the same
  // as GET /thread: the home of a fresh grant has a thread to show.
  const thread = await getOrCreateThread(grant.id);
  const outcome = await ceilingOf({ thread, grant });
  if (!outcome.ok && outcome.reason === 'corrupt') return ceilingRefusal(c, 'corrupt');

  const [base, sections] = await Promise.all([
    threadPayload(partnerId, thread, grant),
    buildHomeSections({
      auth,
      partnerId,
      grantId: grant.id,
      grantorUserId: grant.grantorUserId,
      threadId: thread.id,
      ceiling: outcome.ok ? outcome.ceiling : null,
    }),
  ]);
  const payload: WispHomePayload = { ...base, ...sections };
  return c.json({ data: payload });
});
