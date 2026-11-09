/**
 * #10414 (spec §4.2 Option 2) — the grantor notice when Wisp chat crosses the
 * grant's daily budget.
 *
 * Chat counts toward the grant budget (budget.ts) but is never refused by it.
 * The floor tick already notifies on a background refusal
 * (jobs/wispWakeScheduler.ts), but a crossing late in the UTC day can miss it
 * when the next tick lands after the reset. So the chat turn loop
 * (streamingSessionManager.ts, `case 'result'`) calls this after a Wisp turn
 * settles, fire-and-forget, off the response path.
 *
 * Cost: a Redis `SET NX EX 300` per Wisp turn, and at most one spend read per
 * grant per 5 minutes. Without Redis it does nothing ('skipped'): the floor
 * tick still notifies, and a missed notice is not worth a spend read per turn.
 */
import { wispEnabled } from '../../config/env';
import { getRedis } from '../redis';
import { notifyBudgetExhaustedOnce, spendSummary, utcDayWindow } from './budget';

/** `<prefix><grantId>:<YYYY-MM-DD>`: one throttle key per grant per UTC window. */
export const CHAT_SPEND_CHECK_KEY_PREFIX = 'wisp:chat-spend-check:';
export const CHAT_SPEND_CHECK_TTL_SECONDS = 300;

export type ChatSpendCheckResult = 'notified' | 'under' | 'skipped';

/**
 * If today's grant spend (chat included) has reached the budget, ask for the
 * once-per-window grantor notice. 'skipped' when Wisp is off, Redis is
 * unavailable, or another turn checked this grant within the last 5 minutes.
 * A spend-read or notice failure rejects; the caller reports it.
 */
export async function maybeNotifyChatCrossedBudget(grantId: string, now: Date = new Date()): Promise<ChatSpendCheckResult> {
  if (!wispEnabled()) return 'skipped';
  const redis = getRedis();
  if (!redis) return 'skipped';
  let claimed: boolean;
  try {
    const key = `${CHAT_SPEND_CHECK_KEY_PREFIX}${grantId}:${utcDayWindow(now).key}`;
    claimed = (await redis.set(key, '1', 'EX', CHAT_SPEND_CHECK_TTL_SECONDS, 'NX')) === 'OK';
  } catch {
    // Redis down: the throttle cannot hold, so do not read spend on every turn.
    return 'skipped';
  }
  if (!claimed) return 'skipped';

  const { spentTodayCents, budgetCentsPerDay } = await spendSummary(grantId, now);
  if (spentTodayCents < budgetCentsPerDay) return 'under';
  await notifyBudgetExhaustedOnce(grantId, now);
  return 'notified';
}
