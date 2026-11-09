/**
 * Wisp check-in timers (#10991, W05 #10996) — the grantor's view of the
 * check-ins Wisp scheduled on its own thread:
 *
 *   GET    /wisp/thread/:id/check-ins              → 200 { data: { checkIns } }
 *                                                    (scheduled + fired, due first, max 50)
 *   DELETE /wisp/thread/:id/check-ins/:checkInId   → 204 | 404 { error, code: 'not_found' }
 *
 * Mounted under W02's `wispRoutes` beside W04's thread router, so every gate
 * of the hub applies (BREEZE_WISP_ENABLED 404, partner scope,
 * ai_sessions:use, the `wisp` entitlement). Grantor-only via W04's
 * `loadOwnThread`: another user's thread and a malformed id are the same 404.
 *
 * Ownership only, no ceiling: a person can always see and drop their own
 * reminders, even while the grant is paused. Threads and grants are 1:1
 * (`wisp_threads_grant_uq`), so the service reads and cancels by the thread's
 * grant; the cancel's UPDATE is keyed on that grant, so another grant's id
 * cancels nothing. A consumed or already-cancelled check-in is 404.
 */
import { Hono } from 'hono';
import { z } from 'zod';
import { writeRouteAudit } from '../services/auditEvents';
import { cancelCheckIn, listCheckIns, toCheckInDto } from '../services/wisp/checkIns';
import { loadOwnThread } from './wispThreads';

const NOT_FOUND = { error: 'Wisp thread not found', code: 'not_found' } as const;
const CHECK_IN_NOT_FOUND = { error: 'Check-in not found', code: 'not_found' } as const;

/** The chip and the Run now gate need every pending row: at most 5 are scheduled, and the next turn consumes fired ones. */
const LIST_LIMIT = 50;

const checkInIdParam = z.string().guid();

export const wispCheckInRoutes = new Hono();

wispCheckInRoutes.get('/:id/check-ins', async (c) => {
  const own = await loadOwnThread(c);
  if (!own) return c.json(NOT_FOUND, 404);
  const rows = await listCheckIns(own.grant.id, { limit: LIST_LIMIT });
  return c.json({ data: { checkIns: rows.map(toCheckInDto) } });
});

wispCheckInRoutes.delete('/:id/check-ins/:checkInId', async (c) => {
  const checkInId = checkInIdParam.safeParse(c.req.param('checkInId'));
  if (!checkInId.success) return c.json(CHECK_IN_NOT_FOUND, 404);
  const own = await loadOwnThread(c);
  if (!own) return c.json(NOT_FOUND, 404);
  const cancelled = await cancelCheckIn(own.grant.id, checkInId.data);
  if (!cancelled) return c.json(CHECK_IN_NOT_FOUND, 404);
  writeRouteAudit(c, {
    orgId: cancelled.orgId,
    partnerId: own.thread.partnerId,
    action: 'wisp.thread.check_in_cancelled',
    resourceType: 'wisp_thread',
    resourceId: own.thread.id,
    details: { threadId: own.thread.id, checkInId: checkInId.data },
  });
  return c.body(null, 204);
});

