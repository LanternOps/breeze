/**
 * Topology M4 Task 3 (#6000): investigation quotas in Redis, applied with
 * single atomic Lua scripts so parallel starts can never overshoot.
 *
 *   - at most 3 concurrent investigations per org (expiring leases; a retried
 *     reservation for the SAME session renews its own lease, it never takes a
 *     second slot);
 *   - at most 10 new investigations per user per UTC hour and 100 per org per
 *     UTC day, counted ONCE per investigation (idempotent per session id);
 *   - per investigation: 6 read calls (failed/refused attempts included), 1
 *     proposed diagnostic, 20,000 input and 2,000 output tokens — held in
 *     Redis keyed by the investigation, so an SDK/session restart cannot
 *     reset them.
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

const RESERVE = `
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', ARGV[3])
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
redis.call('HSET', KEYS[2], ARGV[1], ARGV[2])
redis.call('PEXPIRE', KEYS[2], ARGV[9])
return 'ok'`;

const RELEASE = `
if redis.call('HGET', KEYS[2], ARGV[1]) == ARGV[2] then
  redis.call('ZREM', KEYS[1], ARGV[1])
  redis.call('HDEL', KEYS[2], ARGV[1])
  return 1
end
return 0`;

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
return 'ok'`;

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
  const owners = `${base}:lease-owner`;
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
        await redis.eval(RELEASE, 2, leases, owners, sessionId, leaseId);
      } catch {
        // The lease expires on its own (leaseTtlMs); a failed release never blocks the turn's teardown.
      }
    },
  };
}

/** Atomically consume per-investigation budget; refuses (without applying) any delta past a cap. */
export async function consumeTopologyAiBudget(
  investigationId: string,
  delta: Partial<Record<TopologyAiBudgetDimension, number>>,
): Promise<void> {
  const redis = redisOrFail();
  const value = (name: TopologyAiBudgetDimension) => Math.max(0, Math.trunc(delta[name] ?? 0));
  const answer = await run(redis, CONSUME, [budgetKey(investigationId)], [
    value('readCalls'), value('proposals'), value('inputTokens'), value('outputTokens'),
    TOPOLOGY_AI_QUOTAS.readCalls, TOPOLOGY_AI_QUOTAS.proposals, TOPOLOGY_AI_QUOTAS.inputTokens, TOPOLOGY_AI_QUOTAS.outputTokens,
    TOPOLOGY_AI_QUOTAS.investigationTtlSeconds,
  ]);
  if (answer === 'ok') return;
  if (answer === 'readCalls' || answer === 'proposals' || answer === 'inputTokens' || answer === 'outputTokens') {
    throw new TopologyAiLimitError('topology_ai_budget_exhausted', answer);
  }
  throw new TopologyAiLimitError('topology_ai_limits_unavailable');
}
