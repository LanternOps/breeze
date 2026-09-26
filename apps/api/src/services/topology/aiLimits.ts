/**
 * Topology M4 Task 3 (#6000): investigation quotas in Redis, applied with
 * single atomic Lua scripts so parallel starts can never overshoot.
 *
 *   - at most 3 concurrent investigations per org (expiring leases; a retried
 *     reservation for the SAME session shares that session's slot — it never
 *     takes a second one — under its OWN per-request lease, so releasing the
 *     retry can never free the slot while another request still holds it);
 *   - at most 10 new investigations per user per UTC hour and 100 per org per
 *     UTC day, counted ONCE per investigation (idempotent per session id);
 *   - per investigation: 6 read calls (failed/refused attempts included), 1
 *     proposed diagnostic, 20,000 input and 2,000 output tokens CUMULATIVE
 *     across every model call and turn (prompt and tool-result continuations
 *     alike) — held in Redis keyed by the investigation, so an SDK/session
 *     restart cannot reset them. The prompt estimate is reserved before the
 *     first call; actual usage past it is recorded when the turn settles.
 * A lower configured ceiling wins; existing monetary budgets apply separately
 * (reserveAiBudget). Any Redis failure fails the AI start CLOSED; ordinary
 * topology diagnostics never depend on this module.
 *
 * All keys of one org share a `{topology-ai:<org>}` hash tag so the
 * multi-key scripts stay single-slot.
 */
import { randomUUID } from 'node:crypto';
import type { TopologyRequestContext } from './access';
import { getRedis } from '../redis';

export const TOPOLOGY_AI_QUOTAS = {
  concurrentPerOrg: 3,
  perUserHour: 10,
  perOrgDay: 100,
  readCalls: 6,
  proposals: 1,
  inputTokens: 20_000,
  outputTokens: 2_000,
  leaseTtlMs: 10 * 60_000,
  investigationTtlSeconds: 24 * 3600,
} as const;

export type TopologyAiQuotaOverrides = Partial<Record<'concurrentPerOrg' | 'perUserHour' | 'perOrgDay', number>>;
export type TopologyAiBudgetDimension = 'readCalls' | 'proposals' | 'inputTokens' | 'outputTokens';

export type TopologyAiLimitCode =
  | 'topology_ai_concurrency'
  | 'topology_ai_user_hourly'
  | 'topology_ai_org_daily'
  | 'topology_ai_budget_exhausted'
  | 'topology_ai_limits_unavailable';

const MESSAGES: Record<TopologyAiLimitCode, string> = {
  topology_ai_concurrency: 'Too many topology investigations are running for this organization. Try again shortly.',
  topology_ai_user_hourly: 'Topology investigation limit reached for this hour.',
  topology_ai_org_daily: 'Topology investigation limit reached for this organization today.',
  topology_ai_budget_exhausted: 'This investigation reached its limit. Start a new investigation to continue.',
  topology_ai_limits_unavailable: 'Topology AI is temporarily unavailable. Diagnostics still work.',
};

export class TopologyAiLimitError extends Error {
  readonly status: 429 | 503;
  constructor(public readonly code: TopologyAiLimitCode, public readonly dimension?: TopologyAiBudgetDimension) {
    super(MESSAGES[code]);
    this.name = 'TopologyAiLimitError';
    this.status = code === 'topology_ai_limits_unavailable' ? 503 : 429;
  }
}

// KEYS[2] is THIS session's owner set: every live request that reserved the
// session holds its own member (leaseId → expiry). A retry on an active session
// adds a member instead of replacing the owner, so the retry's cleanup can only
// remove its own member; the session's slot (KEYS[1] member) is freed only when
// its LAST live owner releases (C3 — a replaced owner let a retry's busy-path
// cleanup free the running turn's slot and admit a 4th investigation).
const RESERVE = `
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', ARGV[3])
redis.call('ZREMRANGEBYSCORE', KEYS[2], '-inf', ARGV[3])
local held = redis.call('ZSCORE', KEYS[1], ARGV[1])
if not held and redis.call('ZCARD', KEYS[1]) >= tonumber(ARGV[5]) then return 'concurrency' end
if redis.call('EXISTS', KEYS[3]) == 0 then
  local u = tonumber(redis.call('GET', KEYS[4]) or '0')
  local o = tonumber(redis.call('GET', KEYS[5]) or '0')
  if u >= tonumber(ARGV[6]) then return 'user_hourly' end
  if o >= tonumber(ARGV[7]) then return 'org_daily' end
  redis.call('INCR', KEYS[4]); redis.call('EXPIRE', KEYS[4], 7200)
  redis.call('INCR', KEYS[5]); redis.call('EXPIRE', KEYS[5], 172800)
  redis.call('SET', KEYS[3], '1', 'EX', ARGV[8])
end
redis.call('ZADD', KEYS[1], ARGV[4], ARGV[1])
redis.call('PEXPIRE', KEYS[1], ARGV[9])
redis.call('ZADD', KEYS[2], ARGV[4], ARGV[2])
redis.call('PEXPIRE', KEYS[2], ARGV[9])
return 'ok'`;

const RELEASE = `
if redis.call('ZREM', KEYS[2], ARGV[2]) == 0 then return 0 end
redis.call('ZREMRANGEBYSCORE', KEYS[2], '-inf', ARGV[3])
if redis.call('ZCARD', KEYS[2]) == 0 then
  redis.call('ZREM', KEYS[1], ARGV[1])
  redis.call('DEL', KEYS[2])
end
return 1`;

const CONSUME = `
local fields = {'readCalls', 'proposals', 'inputTokens', 'outputTokens'}
for i = 1, 4 do
  local delta = tonumber(ARGV[i])
  if delta > 0 then
    local current = tonumber(redis.call('HGET', KEYS[1], fields[i]) or '0')
    if current + delta > tonumber(ARGV[4 + i]) then return fields[i] end
  end
end
for i = 1, 4 do
  local delta = tonumber(ARGV[i])
  if delta > 0 then redis.call('HINCRBY', KEYS[1], fields[i], delta) end
end
redis.call('EXPIRE', KEYS[1], ARGV[9])
return {'ok', redis.call('HGET', KEYS[1], 'readCalls') or '0', redis.call('HGET', KEYS[1], 'proposals') or '0',
  redis.call('HGET', KEYS[1], 'inputTokens') or '0', redis.call('HGET', KEYS[1], 'outputTokens') or '0'}`;

// Actual provider usage is RECORDED, never refused: the tokens were already
// spent, so accounting must show them even past a cap (the caps are enforced
// before and during the turn — `consumeTopologyAiBudget` and the runtime).
const RECORD = `
if tonumber(ARGV[1]) > 0 then redis.call('HINCRBY', KEYS[1], 'inputTokens', ARGV[1]) end
if tonumber(ARGV[2]) > 0 then redis.call('HINCRBY', KEYS[1], 'outputTokens', ARGV[2]) end
redis.call('EXPIRE', KEYS[1], ARGV[3])
return {'ok', redis.call('HGET', KEYS[1], 'readCalls') or '0', redis.call('HGET', KEYS[1], 'proposals') or '0',
  redis.call('HGET', KEYS[1], 'inputTokens') or '0', redis.call('HGET', KEYS[1], 'outputTokens') or '0'}`;

// A prompt reservation returned by a turn that never reached the model
// (PR #7147 F2). Atomic, and floored at zero so a refund can never mint budget
// another turn did not reserve.
const REFUND = `
local current = tonumber(redis.call('HGET', KEYS[1], 'inputTokens') or '0')
local refund = math.min(current, tonumber(ARGV[1]))
if refund > 0 then redis.call('HINCRBY', KEYS[1], 'inputTokens', -refund) end
return refund`;

type EvalRedis = { eval(script: string, numKeys: number, ...args: Array<string | number>): Promise<unknown> };

function redisOrFail(): EvalRedis {
  const redis = getRedis() as EvalRedis | null;
  if (!redis) throw new TopologyAiLimitError('topology_ai_limits_unavailable');
  return redis;
}

async function run(redis: EvalRedis, script: string, keys: string[], args: Array<string | number>): Promise<unknown> {
  // Redis EVAL of the constant Lua scripts above (server-side, atomic); no
  // caller-supplied code is ever evaluated — keys/args are data.
  try {
    return await redis.eval(script, keys.length, ...keys, ...args.map(String));
  } catch {
    throw new TopologyAiLimitError('topology_ai_limits_unavailable');
  }
}

const utcHour = (now: Date) => now.toISOString().slice(0, 13).replace(/[-T]/g, '');
const utcDay = (now: Date) => now.toISOString().slice(0, 10).replace(/-/g, '');
const tag = (orgId: string) => `topology-ai:{${orgId}}`;
const budgetKey = (investigationId: string) => `topology-ai:budget:{${investigationId}}`;

export type TopologyInvestigationLease = { leaseId: string; release: () => Promise<void> };

/** Reserve (or renew) this session's investigation slot and count a NEW investigation once. */
export async function reserveTopologyInvestigation(
  ctx: TopologyRequestContext,
  sessionId: string,
  options: { now?: Date; limits?: TopologyAiQuotaOverrides } = {},
): Promise<TopologyInvestigationLease> {
  const redis = redisOrFail();
  const now = options.now ?? new Date();
  const limit = (name: keyof TopologyAiQuotaOverrides) => Math.min(TOPOLOGY_AI_QUOTAS[name], Math.max(0, Math.trunc(options.limits?.[name] ?? TOPOLOGY_AI_QUOTAS[name])));
  const base = tag(ctx.scope.orgId);
  const leases = `${base}:leases`;
  const owners = `${base}:lease-owners:${sessionId}`;
  const leaseId = randomUUID();
  const answer = await run(redis, RESERVE, [
    leases, owners, `${base}:counted:${sessionId}`, `${base}:user:${ctx.auth.user.id}:${utcHour(now)}`, `${base}:day:${utcDay(now)}`,
  ], [
    sessionId, leaseId, now.getTime(), now.getTime() + TOPOLOGY_AI_QUOTAS.leaseTtlMs,
    limit('concurrentPerOrg'), limit('perUserHour'), limit('perOrgDay'),
    TOPOLOGY_AI_QUOTAS.investigationTtlSeconds, TOPOLOGY_AI_QUOTAS.leaseTtlMs * 2,
  ]);
  if (answer === 'concurrency') throw new TopologyAiLimitError('topology_ai_concurrency');
  if (answer === 'user_hourly') throw new TopologyAiLimitError('topology_ai_user_hourly');
  if (answer === 'org_daily') throw new TopologyAiLimitError('topology_ai_org_daily');
  if (answer !== 'ok') throw new TopologyAiLimitError('topology_ai_limits_unavailable');
  let released = false;
  return {
    leaseId,
    release: async () => {
      if (released) return;
      released = true;
      try {
        await redis.eval(RELEASE, 2, leases, owners, sessionId, leaseId, Date.now());
      } catch {
        // The lease expires on its own (leaseTtlMs); a failed release never blocks the turn's teardown.
      }
    },
  };
}

/** One investigation's cumulative usage, as held in Redis. */
export type TopologyAiBudgetTotals = Record<TopologyAiBudgetDimension, number>;

function totalsFrom(answer: unknown): TopologyAiBudgetTotals | null {
  if (!Array.isArray(answer) || answer[0] !== 'ok' || answer.length !== 5) return null;
  const [readCalls, proposals, inputTokens, outputTokens] = answer.slice(1).map((value) => Number(value));
  const totals = { readCalls: readCalls!, proposals: proposals!, inputTokens: inputTokens!, outputTokens: outputTokens! };
  return Object.values(totals).every((value) => Number.isFinite(value)) ? totals : null;
}

/**
 * Atomically consume per-investigation budget; refuses (without applying) any
 * delta past a cap. Returns the investigation's cumulative totals after the
 * delta, so a turn can count what EARLIER turns already used (review C4).
 */
export async function consumeTopologyAiBudget(
  investigationId: string,
  delta: Partial<Record<TopologyAiBudgetDimension, number>>,
): Promise<TopologyAiBudgetTotals> {
  const redis = redisOrFail();
  const value = (name: TopologyAiBudgetDimension) => Math.max(0, Math.trunc(delta[name] ?? 0));
  const answer = await run(redis, CONSUME, [budgetKey(investigationId)], [
    value('readCalls'), value('proposals'), value('inputTokens'), value('outputTokens'),
    TOPOLOGY_AI_QUOTAS.readCalls, TOPOLOGY_AI_QUOTAS.proposals, TOPOLOGY_AI_QUOTAS.inputTokens, TOPOLOGY_AI_QUOTAS.outputTokens,
    TOPOLOGY_AI_QUOTAS.investigationTtlSeconds,
  ]);
  const totals = totalsFrom(answer);
  if (totals) return totals;
  if (answer === 'readCalls' || answer === 'proposals' || answer === 'inputTokens' || answer === 'outputTokens') {
    throw new TopologyAiLimitError('topology_ai_budget_exhausted', answer);
  }
  throw new TopologyAiLimitError('topology_ai_limits_unavailable');
}

/**
 * Record ACTUAL token usage for an investigation (never refused — the tokens
 * were spent) and return the cumulative totals. A Redis failure throws
 * `topology_ai_limits_unavailable`: the caller cannot prove the investigation
 * stayed within budget and must not publish (review C5).
 */
export async function recordTopologyAiTokenUsage(
  investigationId: string,
  usage: { inputTokens: number; outputTokens: number },
): Promise<TopologyAiBudgetTotals> {
  const redis = redisOrFail();
  const answer = await run(redis, RECORD, [budgetKey(investigationId)], [
    Math.max(0, Math.trunc(usage.inputTokens)), Math.max(0, Math.trunc(usage.outputTokens)), TOPOLOGY_AI_QUOTAS.investigationTtlSeconds,
  ]);
  const totals = totalsFrom(answer);
  if (!totals) throw new TopologyAiLimitError('topology_ai_limits_unavailable');
  return totals;
}

/**
 * Return a turn's up-front input reservation (`consumeTopologyAiBudget`'s
 * prompt estimate) when the turn was refused before any model call — a
 * 409/402/503 at dispatch — so a refusal never burns the investigation's
 * cumulative budget. Only the reservation is returned; usage a model call
 * actually spent is never refunded. Throws `topology_ai_limits_unavailable` on
 * a Redis failure (the caller keeps the charge: conservative).
 */
export async function refundTopologyAiTokenReservation(investigationId: string, inputTokens: number): Promise<void> {
  const amount = Math.max(0, Math.trunc(inputTokens));
  if (amount === 0) return;
  await run(redisOrFail(), REFUND, [budgetKey(investigationId)], [amount]);
}

/** True while cumulative token totals are within the per-investigation caps. */
export function topologyAiTokensWithinBudget(totals: Pick<TopologyAiBudgetTotals, 'inputTokens' | 'outputTokens'>): boolean {
  return totals.inputTokens <= TOPOLOGY_AI_QUOTAS.inputTokens && totals.outputTokens <= TOPOLOGY_AI_QUOTAS.outputTokens;
}
