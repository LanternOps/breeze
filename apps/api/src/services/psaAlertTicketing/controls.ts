import { randomUUID } from 'node:crypto';
import type Redis from 'ioredis';
import { getRedis } from '../redis';
import { executeTicketing, type TicketingDeps } from './execution';
import { nextOperation } from './stateMachine';
import { TICKETING_LEASE_MS } from './constants';
import { TicketingLeaseLostError, TicketingRedisError, redisCommandError } from './controlErrors';
export interface TicketingControls {
  acquire(
    connectionId: string
  ): Promise<{ release(): Promise<void>; assertOwned(): Promise<void> } | null>;
  budget(connectionId: string, cap: number, now: Date): Promise<boolean>;
  refund?(connectionId: string, now: Date): Promise<void>;
}
const RELEASE =
  "if redis.call('GET',KEYS[1])==ARGV[1] then return redis.call('DEL',KEYS[1]) else return 0 end";
const RENEW =
  `if redis.call('GET',KEYS[1])==ARGV[1] then return redis.call('PEXPIRE',KEYS[1],${TICKETING_LEASE_MS}) else return 0 end`;
const BUDGET =
  "local n=redis.call('INCR',KEYS[1]); if n==1 then redis.call('EXPIRE',KEYS[1],7200) end; return n";
export function redisTicketingControls(redis: () => Redis | null = getRedis): TicketingControls {
  return {
    async acquire(connectionId) {
      const client = redis();
      if (!client) {
        console.warn('[psa-ticketing] Redis lease unavailable', { connectionId });
        return null;
      }
      const key = `psa:alert-ticketing:lease:${connectionId}`,
        token = randomUUID();
      try {
        if ((await client.set(key, token, 'PX', TICKETING_LEASE_MS, 'NX')) !== 'OK') return null;
      } catch (error) {
        const failure = redisCommandError(error);
        console.error('[psa-ticketing] Redis lease acquire failed', { connectionId, message: failure.message });
        return null;
      }
      // The adapter's 20s HTTP timeout fits inside the 60s lease. Renewal also
      // covers a long paged lookup; compare-and-delete cannot release a new owner.
      let lost = false;
      const assertOwned = async () => {
        if (lost) throw new TicketingLeaseLostError();
        try {
          if (Number(await client.eval(RENEW, 1, key, token)) !== 1)
            throw new TicketingLeaseLostError();
        } catch (error) {
          lost = true;
          const failure = error instanceof TicketingLeaseLostError ? error : redisCommandError(error);
          console.error('[psa-ticketing] Redis lease renewal failed', { connectionId, message: failure.message });
          throw failure;
        }
      };
      const timer = setInterval(() => {
        void assertOwned().catch((error: unknown) => {
          // assertOwned already logged a known command/fencing failure.
          if (!(error instanceof TicketingLeaseLostError || error instanceof TicketingRedisError))
            console.error('[psa-ticketing] unexpected lease renewal failure', { connectionId, error });
        });
      }, 20000);
      timer.unref();
      return {
        assertOwned,
        release: async () => {
          clearInterval(timer);
          try { await client.eval(RELEASE, 1, key, token); } catch (error) {
            const failure = redisCommandError(error);
            console.error('[psa-ticketing] Redis lease release failed', { connectionId, message: failure.message });
          }
        },
      };
    },
    async budget(connectionId, cap, now) {
      const client = redis();
      if (!client) throw new TicketingRedisError('PSA ticketing Redis unavailable');
      const utcHour = now.toISOString().replace(/[-T:]/g, '').slice(0, 10);
      try {
        const allowed = Number(await client.eval(BUDGET, 1, `psa:alert-ticketing:cap:${connectionId}:${utcHour}`)) <= cap;
        if (!allowed) await this.refund?.(connectionId, now);
        return allowed;
      } catch (error) {
        const failure = redisCommandError(error);
        console.error('[psa-ticketing] Redis cap failed', { connectionId, message: failure.message });
        throw failure;
      }
    },
    async refund(connectionId, now) {
      const client = redis();
      if (!client) throw new TicketingRedisError('PSA ticketing Redis unavailable');
      const utcHour = now.toISOString().replace(/[-T:]/g, '').slice(0, 10);
      try { await client.eval("if tonumber(redis.call('GET',KEYS[1]) or '0') > 0 then return redis.call('DECR',KEYS[1]) else return 0 end", 1, `psa:alert-ticketing:cap:${connectionId}:${utcHour}`); }
      catch (error) {
        const failure = redisCommandError(error);
        console.error('[psa-ticketing] Redis cap refund failed', { connectionId, message: failure.message });
        throw failure;
      }
    },
  };
}
export async function withTicketingControls(
  mappingId: string,
  deps: TicketingDeps,
  controls = redisTicketingControls(),
  now = new Date()
) {
  const ctx = await deps.load(mappingId);
  if (!ctx || ctx.connection.alertTicketingPausedReason) return;
  const hint = ctx.alert?.status === 'resolved' ? 'close' : ctx.alert?.acknowledgedAt ? 'note' : 'create';
  const retrySoon = () => deps.wake(mappingId, hint, new Date(now.getTime() + 1000 + Math.floor(Math.random() * 4001)));
  if (nextOperation(ctx.mapping, ctx.alert, now) === 'none') {
    const next = [ctx.mapping.nextAttemptAt, ctx.mapping.leaseUntil]
      .filter((at): at is Date => at !== null && at > now)
      .sort((a, b) => b.getTime() - a.getTime())[0];
    if (next && next > now) {
      // A promoted early job still owns its due-second ID until completion.
      // Wake after the due time so the successor has a different ID.
      await deps.wake(mappingId, hint, new Date(next.getTime() + 1000 + Math.floor(Math.random() * 4001)));
    }
    return;
  }
  const lease = await controls.acquire(ctx.connection.id);
  if (!lease) {
    await retrySoon();
    return;
  }
  try {
    // Reload after waiting for the shared slot; claim still fences every attempt.
    await executeTicketing(
      mappingId,
      {
        ...deps,
        beforeCall: lease.assertOwned,
        refundCreateBudget: () => controls.refund?.(ctx.connection.id, now) ?? Promise.resolve(),
        beforeCreate: async (current) => {
          const allowed = await controls.budget(
            current.connection.id,
            current.snapshot.hourlyCreateCap,
            now
          );
          return allowed;
        },
      },
      now
    );
  } finally {
    await lease.release();
  }
}
