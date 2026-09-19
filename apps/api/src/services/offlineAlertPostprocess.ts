import type Redis from 'ioredis';
import type { OfflineEffect } from '../db/schema/offlineTransitionEffects';
import type { OfflineRulePlan } from './offlineEffectsTypes';

function keys(deviceId: string, ruleId: string, policy: boolean) {
  return {
    cooldown: `${policy ? 'breeze:alerts:cooldown:cpar' : 'breeze:alerts:cooldown'}:${ruleId}:${deviceId}`,
    adaptive: `breeze:alerts:cooldown:adaptive:${ruleId}:${deviceId}`,
    flap: `breeze:alerts:flap:${ruleId}:${deviceId}`,
  };
}

export async function readOfflineAlertRedisSuppression(redis: Redis, deviceId: string, rule: OfflineRulePlan) {
  const k = keys(deviceId, rule.ruleId, rule.policy);
  const [cooling, entries, adaptiveRaw] = await Promise.all([redis.exists(k.cooldown), redis.lrange(k.flap, 0, -1), rule.policy ? Promise.resolve(null) : redis.get(k.adaptive)]);
  const cutoff = Date.now() - 600_000;
  let transitions = 0;
  for (const entry of entries) {
    try {
      const value = JSON.parse(entry) as { timestamp?: unknown };
      if (typeof value.timestamp === 'number' && value.timestamp >= cutoff) transitions++;
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
      console.warn('[OfflineEffects] Ignoring malformed flapping cache entry');
    }
  }
  let multiplier = 1;
  if (adaptiveRaw) {
    try {
      const prior = JSON.parse(adaptiveRaw) as { multiplier?: number; setAt?: number };
      if ([1, 2, 4].includes(prior.multiplier ?? 0) && typeof prior.setAt === 'number'
        && prior.setAt > Date.now() - 3_600_000 && prior.setAt <= Date.now()) {
        multiplier = Math.min(prior.multiplier! * 2, 4);
      }
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
      console.warn('[OfflineEffects] Ignoring malformed adaptive cooldown cache entry');
    }
  }
  return { cooling: cooling > 0, flapping: transitions >= 4, multiplier };
}

// One atomic Redis operation: ambiguous-send retry cannot double-record a flap,
// extend an old cooldown, or replace a newer adaptive state. The durable DB receipt
// remains admission authority while this cache projection is unavailable.
const APPLY_POSTPROCESS = `
local occurred = tonumber(ARGV[1])
local deadline = tonumber(ARGV[2])
local multiplier = tonumber(ARGV[3])
local now = tonumber(ARGV[6])
if redis.call('EXISTS', KEYS[4]) == 1 then return 0 end
local markerUntil = math.max(deadline, occurred + 3600000)
if markerUntil <= now then return 0 end
local existingTtl = redis.call('PTTL', KEYS[1])
if deadline > now and existingTtl ~= -1 and existingTtl < deadline - now then
  redis.call('SET', KEYS[1], cjson.encode({setAt=occurred,multiplier=multiplier}), 'PXAT', deadline)
end
if ARGV[4] == '0' and occurred + 3600000 > now then
  local value = redis.call('GET', KEYS[2])
  local ok, prior = pcall(cjson.decode, value or '{}')
  if not ok or not prior.setAt or tonumber(prior.setAt) <= occurred then
    redis.call('SET', KEYS[2], cjson.encode({setAt=occurred,multiplier=multiplier}), 'PXAT', occurred + 3600000)
  end
end
if ARGV[5] == '1' and occurred + 1800000 > now then
  redis.call('RPUSH', KEYS[3], cjson.encode({state='triggered',timestamp=occurred}))
  redis.call('LTRIM', KEYS[3], -20, -1)
  redis.call('EXPIRE', KEYS[3], 1800)
end
redis.call('SET', KEYS[4], '1', 'PXAT', markerUntil)
return 1
`;

export async function applyOfflineAlertPostprocess(redis: Redis, effect: OfflineEffect): Promise<void> {
  const p = effect.payload;
  if (p.type !== 'alert-postprocess' || !effect.cooldownUntil) throw new Error('Invalid alert postprocess payload');
  const k = keys(effect.deviceId, p.ruleId, p.policy);
  await redis.eval(APPLY_POSTPROCESS, 4, k.cooldown, k.adaptive, k.flap,
    `breeze:offline-effects:applied:${effect.id}`,
    new Date(p.occurredAt).getTime(), effect.cooldownUntil.getTime(), p.multiplier,
    p.policy ? '1' : '0', p.recordTrigger ? '1' : '0', Date.now());
}
