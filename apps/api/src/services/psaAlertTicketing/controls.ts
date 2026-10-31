import { randomUUID } from 'node:crypto';
import type Redis from 'ioredis';
import { getRedis } from '../redis';
import { executeTicketing, type TicketingDeps } from './execution';
import { nextOperation } from './stateMachine';
export interface TicketingControls {
  acquire(connectionId: string): Promise<(() => Promise<void>) | null>;
  budget(connectionId: string, cap: number, now: Date): Promise<boolean>;
}
const RELEASE = "if redis.call('GET',KEYS[1])==ARGV[1] then return redis.call('DEL',KEYS[1]) else return 0 end";
const RENEW = "if redis.call('GET',KEYS[1])==ARGV[1] then return redis.call('PEXPIRE',KEYS[1],60000) else return 0 end";
const BUDGET = "local n=redis.call('INCR',KEYS[1]); if n==1 then redis.call('EXPIRE',KEYS[1],7200) end; return n";
export function redisTicketingControls(redis: () => Redis | null = getRedis): TicketingControls {
  return {
    async acquire(connectionId) {
      const client = redis(); if (!client) return null;
      const key = `psa:alert-ticketing:lease:${connectionId}`, token = randomUUID();
      try { if (await client.set(key, token, 'PX', 60000, 'NX') !== 'OK') return null; } catch { return null; }
      // The adapter's 20s HTTP timeout fits inside the 60s lease. Renewal also
      // covers a long paged lookup; compare-and-delete cannot release a new owner.
      const timer = setInterval(() => { void client.eval(RENEW,1,key,token).catch(() => {}); },20000); timer.unref();
      return async () => { clearInterval(timer); await client.eval(RELEASE,1,key,token).catch(() => {}); };
    },
    async budget(connectionId, cap, now) {
      const client=redis(); if (!client) throw new Error('PSA ticketing Redis unavailable');
      const utcHour=now.toISOString().replace(/[-T:]/g,'').slice(0,10);
      return Number(await client.eval(BUDGET,1,`psa:alert-ticketing:cap:${connectionId}:${utcHour}`)) <= cap;
    },
  };
}
export async function withTicketingControls(mappingId: string, deps: TicketingDeps, controls=redisTicketingControls(), now=new Date()) {
  const ctx=await deps.load(mappingId);
  if (!ctx || ctx.connection.alertTicketingPausedReason || nextOperation(ctx.mapping,ctx.alert,now)==='none') return;
  const release=await controls.acquire(ctx.connection.id); if (!release) return;
  try {
    // Reload after waiting for the shared slot; claim still fences every attempt.
    await executeTicketing(mappingId,{ ...deps, beforeCreate: async (current) => {
      const allowed=await controls.budget(current.connection.id,current.snapshot.hourlyCreateCap,now);
      return allowed;
    } },now);
  } finally { await release(); }
}
