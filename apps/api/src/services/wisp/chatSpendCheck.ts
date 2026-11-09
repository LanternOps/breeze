/**
 * #10414 (docs/superpowers/specs/ai-mcp/2026-11-06-wisp-chat-grant-followups-spec.md
 * §4, Option 2): the grantor notice when Wisp chat crosses the grant's daily
 * budget.
 *
 * Chat turns count toward the grant budget (budget.ts) but are never refused by
 * it. The floor tick already notifies on a background refusal
 * (jobs/wispWakeScheduler.ts), but a crossing late in the UTC day can miss it
 * when the next tick lands after the reset. So the chat turn loop
 * (streamingSessionManager.ts, `case 'result'`) calls this after a Wisp turn
 * settles, fire-and-forget, off the response path.
 *
 * Cost: a Redis `SET NX EX 300` per Wisp turn, and at most one spend read per
 * grant per 5 minutes. Without Redis it does nothing ('skipped'): the floor
 * tick still notifies, and a missed notice is not worth a spend read per turn.
 *
 * Accepted limit of the throttle: a check that finds the grant under budget
 * holds the key for 5 minutes, so a crossing inside that window is noticed by
 * the next turn after it, or by the floor tick — not by the crossing turn
 * itself. A failed check releases the key, so a DB blip never costs 5 minutes.
 */
import { wispEnabled } from '../../config/env';
import { getRedis } from '../redis';
import { notifyBudgetExhaustedOnce, spendSummary, utcDayWindow } from './budget';

/** `<prefix><grantId>:<YYYY-MM-DD>`: one throttle key per grant per UTC window. */
export const CHAT_SPEND_CHECK_KEY_PREFIX = 'wisp:chat-spend-check:';
export const CHAT_SPEND_CHECK_TTL_SECONDS = 300;

export type ChatSpendCheckResult = 'notified' | 'under' | 'skipped';

const errText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/**
 * If today's grant spend (chat included) has reached the budget, ask for the
 * once-per-window grantor notice. 'skipped' when Wisp is off, Redis is
 * unavailable, or another turn checked this grant within the last 5 minutes.
 * A spend-read or notice failure rejects (after releasing the throttle key);
 * the caller reports it.
 */
export async function maybeNotifyChatCrossedBudget(grantId: string, now: Date = new Date()): Promise<ChatSpendCheckResult> {
  if (!wispEnabled()) return 'skipped';
  const redis = getRedis();
  if (!redis) return 'skipped';
  const key = `${CHAT_SPEND_CHECK_KEY_PREFIX}${grantId}:${utcDayWindow(now).key}`;
  let claimed: boolean;
  try {
    claimed = (await redis.set(key, '1', 'EX', CHAT_SPEND_CHECK_TTL_SECONDS, 'NX')) === 'OK';
  } catch (err) {
    // Redis down: the throttle cannot hold, so do not read spend on every turn.
    console.warn('[wisp] chat spend check skipped: throttle unavailable:', errText(err));
    return 'skipped';
  }
  if (!claimed) return 'skipped';

  try {
    const { spentTodayCents, budgetCentsPerDay } = await spendSummary(grantId, now);
    if (spentTodayCents < budgetCentsPerDay) return 'under';
    await notifyBudgetExhaustedOnce(grantId, now);
    return 'notified';
  } catch (err) {
    // Best effort: let the next turn retry instead of waiting out the TTL.
    await redis.del(key).catch(() => undefined);
    throw err;
  }
}
