/**
 * Network Proxy request budgets (spec 2026-10-06 §9): per-tunnel, per-user and
 * per-agent request rate (Redis sliding window via `rateLimiter`, which fails
 * closed without Redis, like ticket storage) and in-flight concurrency
 * (process-local, like the agentCommandAwait correlation map it protects),
 * with a short bounded wait queue per tunnel (TUNNEL_HTTP_QUEUE_LIMITS).
 * Applied by host mode (routes/tunnelHost.ts); path mode does not use them.
 *
 * These sit behind the per-IP `tunnelhost` global bucket (G7): that one bounds
 * a client address, these bound one user, one tunnel and one bridging agent
 * however many addresses the traffic comes from.
 */
import { getRedis } from './redis';
import { rateLimiter } from './rate-limit';

export const TUNNEL_HTTP_RATE_LIMITS = { user: 1200, tunnel: 900, agent: 2400, windowSeconds: 60 } as const;
export const TUNNEL_HTTP_CONCURRENCY_LIMITS = { user: 24, tunnel: 12, agent: 32 } as const;
export type TunnelBudgetScope = 'user' | 'tunnel' | 'agent';
export interface TunnelBudgetKeys { userId: string; tunnelId: string; agentId: string }

// Narrowest first, so the reported scope is the most specific one exhausted.
const SCOPES: readonly TunnelBudgetScope[] = ['tunnel', 'user', 'agent'];
const idFor = (keys: TunnelBudgetKeys, scope: TunnelBudgetScope) =>
  scope === 'user' ? keys.userId : scope === 'tunnel' ? keys.tunnelId : keys.agentId;

/** Retry hint when the budget store itself is down (not a budget being spent). */
const BUDGET_UNAVAILABLE_RETRY_SECONDS = 5;

export type TunnelRateResult =
  | { ok: true }
  | { ok: false; scope: TunnelBudgetScope; retryAfterSeconds: number }
  // Redis unavailable: still refused (fail closed), but reported as an outage,
  // not as this user/tunnel/agent exhausting a budget.
  | { ok: false; scope: 'unavailable'; retryAfterSeconds: number };

export async function checkTunnelHttpRate(keys: TunnelBudgetKeys): Promise<TunnelRateResult> {
  const redis = getRedis();
  if (!redis) return { ok: false, scope: 'unavailable', retryAfterSeconds: BUDGET_UNAVAILABLE_RETRY_SECONDS };
  for (const scope of SCOPES) {
    const result = await rateLimiter(
      redis,
      `tunnel-http:rate:${scope}:${idFor(keys, scope)}`,
      TUNNEL_HTTP_RATE_LIMITS[scope],
      TUNNEL_HTTP_RATE_LIMITS.windowSeconds,
    );
    if (!result.allowed) {
      return {
        ok: false,
        scope,
        retryAfterSeconds: Math.max(1, Math.ceil((result.resetAt.getTime() - Date.now()) / 1000)),
      };
    }
  }
  return { ok: true };
}

/**
 * A request that finds its TUNNEL at the concurrency cap waits for a slot
 * instead of being refused (#11464): a device UI's first paint can load many
 * dozens of assets at once, far wider than the tunnel cap, and browsers do not
 * retry a 429 on a script or stylesheet.
 *
 * Both bounds are hard: at most `depth` waiters per tunnel (one more is
 * refused at once with `queue_full`), and each waits at most `maxWaitMs`
 * before it is refused with `timeout`. A full queue is `depth /
 * TUNNEL_HTTP_CONCURRENCY_LIMITS.tunnel` device round trips deep.
 *
 * A request whose tunnel has room and no waiters, but whose user or agent
 * ceiling is full, is refused at once (`busy`), as before. A queued request is
 * admitted only when every scope has room, so it also waits for user and agent
 * room. Waiters hold no slot while they wait, so a busy tunnel holds at most
 * its own concurrency cap and the user's and agent's remaining room stays
 * available to their other tunnels.
 */
export const TUNNEL_HTTP_QUEUE_LIMITS = { depth: 96, maxWaitMs: 5_000 } as const;

export type TunnelSlotRefusal =
  /** A user or agent ceiling is full while the tunnel has room and no waiters: refused at once. */
  | 'busy'
  /** The tunnel is full and its wait queue is at `TUNNEL_HTTP_QUEUE_LIMITS.depth`. */
  | 'queue_full'
  /** Waited `TUNNEL_HTTP_QUEUE_LIMITS.maxWaitMs` without every scope having room. */
  | 'timeout'
  /** The client went away (request signal aborted) before a slot was granted. */
  | 'aborted';

export type TunnelSlotResult =
  | { ok: true; release: () => void }
  | { ok: false; scope: TunnelBudgetScope; reason: TunnelSlotRefusal };

type SlotEntries = ReadonlyArray<readonly [TunnelBudgetScope, string]>;

interface Waiter {
  entries: SlotEntries;
  settle: (result: TunnelSlotResult) => void;
}

const inFlight = new Map<string, number>();
/** FIFO wait queues, keyed by the tunnel scope key (`tunnel:<id>`). Empty queues are deleted. */
const queues = new Map<string, Waiter[]>();

const entriesFor = (keys: TunnelBudgetKeys): SlotEntries =>
  SCOPES.map((scope) => [scope, `${scope}:${idFor(keys, scope)}`] as const);
/** The tunnel scope's key (`tunnel:<id>`), which also keys the wait queue. */
const tunnelKeyOf = (entries: SlotEntries): string => entries.find(([scope]) => scope === 'tunnel')![1];

function firstFullScope(entries: SlotEntries): TunnelBudgetScope | null {
  for (const [scope, key] of entries) {
    if ((inFlight.get(key) ?? 0) >= TUNNEL_HTTP_CONCURRENCY_LIMITS[scope]) return scope;
  }
  return null;
}

/** Take one slot in every scope (the caller has checked there is room) and return its release handle. */
function take(entries: SlotEntries): TunnelSlotResult {
  for (const [, key] of entries) inFlight.set(key, (inFlight.get(key) ?? 0) + 1);
  let released = false;
  return {
    ok: true,
    release: () => {
      if (released) return;
      released = true;
      for (const [, key] of entries) {
        const next = (inFlight.get(key) ?? 1) - 1;
        if (next <= 0) inFlight.delete(key);
        else inFlight.set(key, next);
      }
      admitWaiters(tunnelKeyOf(entries));
    },
  };
}

/** Admit waiters from the head of one tunnel's queue while every scope has room (strict FIFO per tunnel). */
function pump(tunnelKey: string): void {
  const queue = queues.get(tunnelKey);
  while (queue && queue.length > 0 && firstFullScope(queue[0]!.entries) === null) {
    const waiter = queue.shift()!;
    if (queue.length === 0) queues.delete(tunnelKey);
    waiter.settle(take(waiter.entries));
  }
}

/**
 * Called on every release. The releasing tunnel's own queue goes first (the
 * freed tunnel slot is only usable by it); then any other queue, whose head may
 * have been waiting on the user or agent slot this release also freed. Only
 * tunnels with waiters on this process have a queue, so the walk is short.
 */
function admitWaiters(releasedTunnelKey: string): void {
  pump(releasedTunnelKey);
  for (const tunnelKey of [...queues.keys()]) {
    if (tunnelKey !== releasedTunnelKey) pump(tunnelKey);
  }
}

const refused = (scope: TunnelBudgetScope, reason: TunnelSlotRefusal): TunnelSlotResult => ({ ok: false, scope, reason });

/**
 * Reserve one in-flight slot in every scope, or none. Resolves at once when
 * every scope has room, or with a `busy` refusal when a user or agent ceiling
 * is full; when the tunnel itself is full (or already has waiters) it queues
 * and resolves when a slot is handed over, the wait times out, the queue is
 * full, or `signal` aborts. Waiters are admitted in arrival order within a tunnel.
 *
 * On `ok: true` the caller MUST call `release()` exactly once when the request
 * finishes (it is idempotent, so a `finally` plus an early release is safe).
 * A refusal holds nothing.
 */
export function acquireTunnelHttpSlot(
  keys: TunnelBudgetKeys,
  options: { signal?: AbortSignal } = {},
): Promise<TunnelSlotResult> {
  const { signal } = options;
  if (signal?.aborted) return Promise.resolve(refused('tunnel', 'aborted'));
  const entries = entriesFor(keys);
  const tunnelKey = tunnelKeyOf(entries);
  const queue = queues.get(tunnelKey);
  if (!queue) {
    const full = firstFullScope(entries);
    if (full === null) return Promise.resolve(take(entries));
    if (full !== 'tunnel') return Promise.resolve(refused(full, 'busy'));
  } else if (queue.length >= TUNNEL_HTTP_QUEUE_LIMITS.depth) {
    return Promise.resolve(refused('tunnel', 'queue_full'));
  }

  return new Promise<TunnelSlotResult>((resolve) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const waiter: Waiter = {
      entries,
      settle: (result) => {
        if (settled) return;
        settled = true;
        if (timer !== undefined) clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        resolve(result);
      },
    };
    const leave = (reason: TunnelSlotRefusal) => {
      if (settled) return;
      const current = queues.get(tunnelKey);
      const index = current ? current.indexOf(waiter) : -1;
      if (current && index >= 0) {
        current.splice(index, 1);
        if (current.length === 0) queues.delete(tunnelKey);
      }
      waiter.settle(refused('tunnel', reason));
      // The next waiter may have been held only behind this one.
      pump(tunnelKey);
    };
    const onAbort = () => leave('aborted');
    timer = setTimeout(() => leave('timeout'), TUNNEL_HTTP_QUEUE_LIMITS.maxWaitMs);
    signal?.addEventListener('abort', onAbort, { once: true });
    if (queue) queue.push(waiter);
    else queues.set(tunnelKey, [waiter]);
  });
}

export function __tunnelHttpBudgetStateForTests(): { inFlight: Record<string, number>; queued: Record<string, number> } {
  return {
    inFlight: Object.fromEntries(inFlight),
    queued: Object.fromEntries([...queues].map(([key, waiters]) => [key, waiters.length])),
  };
}

export function __resetTunnelHttpBudgetForTests(): void {
  const waiting = [...queues.values()].flat();
  queues.clear();
  inFlight.clear();
  for (const waiter of waiting) waiter.settle(refused('tunnel', 'aborted'));
}
