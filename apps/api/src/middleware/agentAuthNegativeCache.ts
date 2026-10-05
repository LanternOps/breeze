/**
 * #8050 — short-TTL negative cache for TERMINAL agent auth rejections.
 *
 * Agents whose credentials are permanently rejected (suspended tenant, deleted
 * device, revoked/stale token) keep polling at full rate — old builds never
 * back off — and every rejection used to cost the API at least one system-
 * context DB transaction (the `devices ⋈ organizations` lookup), plus a second
 * for a decommissioned device's drain check and the tenant-state lookup. This
 * cache lets a repeat of the SAME rejected credential short-circuit before any
 * of that work, replaying the identical status and body.
 *
 * Contract (do not loosen without re-reading the issue):
 *
 * - KEY is (surface, agentId, sha256(token)). Never agentId alone: a forged
 *   token for a real agentId may only ever cache the forger's own key. Keying
 *   on agentId alone would let anyone lock a legitimate agent out for the TTL.
 * - ONLY terminal rejections are stored (`AgentAuthTerminalRejection`). Rate
 *   limits, drain/parked refusals, quarantine, certificate-binding failures and
 *   anything transient are never cached — callers simply don't call
 *   `remember` for them.
 * - TTL is short (60 s) and there is no explicit invalidation: reinstatement
 *   (tenant unsuspended, device restored) takes effect within the TTL.
 * - Storage is an in-process bounded Map — zero I/O on the hit path. Map
 *   iteration order is insertion order and every entry has the same TTL, so the
 *   oldest entry is also the soonest to expire: evicting from the head is both
 *   "evict oldest" and "sweep expired".
 * - `surface` separates the REST middleware from the WS upgrade: the two paths
 *   render the same facts into different responses, and each replays its own.
 *
 * Leaf module: `prom-client` + `metricsRegistry` only, so it can be imported by
 * both `middleware/agentAuth.ts` and `routes/agentWs.ts` without new cycles.
 */
import { Counter } from 'prom-client';

import { metricsRegistry } from '../services/metricsRegistry';

export type AgentAuthSurface = 'rest' | 'ws';

/**
 * The rejection kinds that may be cached. Each is a property of the presented
 * credential or of durable device/tenant state — none can flip on its own
 * between two requests a second apart.
 */
export type AgentAuthTerminalRejection =
  /** No device row for this agentId. */
  | 'device_not_found'
  /** Token auto-suspended (cross-tenant probing etc.). */
  | 'token_suspended'
  /** Presented token matches no current/previous/pending hash for the role. */
  | 'token_mismatch'
  /** Device row predates the token-hash migration — agent must re-enroll. */
  | 're_enrollment_required'
  /** Decommissioned and NOT inside the device-remove uninstall drain. */
  | 'decommissioned'
  /** Tenant (org/partner) suspended, churned or deleted. */
  | 'tenant_denied';

export const AGENT_AUTH_NEGATIVE_CACHE_TTL_MS = 60_000;
export const AGENT_AUTH_NEGATIVE_CACHE_MAX_ENTRIES = 10_000;

/**
 * `devices.agent_id` is varchar(64). A longer URL param can never match a row,
 * and caching it would let a caller grow per-entry key size without bound, so
 * such requests are simply not cached (they keep today's behaviour).
 */
export const MAX_CACHEABLE_AGENT_ID_LENGTH = 64;

export const AGENT_AUTH_NEGATIVE_CACHE_METRIC = 'breeze_agent_auth_negative_cache_total';

type CounterLabels = 'surface' | 'result' | 'rejection';

const negativeCacheCounter: Counter<CounterLabels> =
  (metricsRegistry.getSingleMetric(AGENT_AUTH_NEGATIVE_CACHE_METRIC) as Counter<CounterLabels> | undefined)
  ?? new Counter({
    name: AGENT_AUTH_NEGATIVE_CACHE_METRIC,
    help: 'Agent auth negative cache: lookups that hit or missed, and terminal rejections stored (#8050)',
    labelNames: ['surface', 'result', 'rejection'],
    registers: [metricsRegistry],
  });

// Pre-seed every series at 0 so an alert/rate() on a series that has not
// fired yet sees a zero rather than an absent series.
const ALL_REJECTIONS: readonly AgentAuthTerminalRejection[] = [
  'device_not_found',
  'token_suspended',
  'token_mismatch',
  're_enrollment_required',
  'decommissioned',
  'tenant_denied',
];
for (const surface of ['rest', 'ws'] as const) {
  negativeCacheCounter.inc({ surface, result: 'miss', rejection: 'none' }, 0);
  for (const rejection of ALL_REJECTIONS) {
    negativeCacheCounter.inc({ surface, result: 'hit', rejection }, 0);
    negativeCacheCounter.inc({ surface, result: 'store', rejection }, 0);
  }
}

interface Entry {
  rejection: AgentAuthTerminalRejection;
  expiresAt: number;
}

export interface AgentAuthNegativeCacheOptions {
  ttlMs: number;
  maxEntries: number;
  now?: () => number;
}

export class AgentAuthNegativeCache {
  private readonly entries = new Map<string, Entry>();
  private readonly ttlMs: number;
  private readonly maxEntries: number;
  private readonly now: () => number;

  constructor(options: AgentAuthNegativeCacheOptions) {
    this.ttlMs = options.ttlMs;
    this.maxEntries = Math.max(1, options.maxEntries);
    // Monotonic: a wall-clock step backwards (NTP, VM resume) must not stretch
    // an entry's life past the TTL. Read at call time so fake timers apply.
    this.now = options.now ?? (() => performance.now());
  }

  get size(): number {
    return this.entries.size;
  }

  /**
   * The cached terminal rejection for this exact credential, or null. A hit
   * means the caller must replay that rejection WITHOUT touching the DB.
   */
  lookup(surface: AgentAuthSurface, agentId: string, tokenHash: string): AgentAuthTerminalRejection | null {
    const key = cacheKey(surface, agentId, tokenHash);
    const entry = key === null ? undefined : this.entries.get(key);
    if (entry && entry.expiresAt > this.now()) {
      negativeCacheCounter.inc({ surface, result: 'hit', rejection: entry.rejection });
      return entry.rejection;
    }
    if (entry && key !== null) this.entries.delete(key);
    negativeCacheCounter.inc({ surface, result: 'miss', rejection: 'none' });
    return null;
  }

  /** Record a terminal rejection for this exact credential. */
  remember(
    surface: AgentAuthSurface,
    agentId: string,
    tokenHash: string,
    rejection: AgentAuthTerminalRejection,
  ): void {
    const key = cacheKey(surface, agentId, tokenHash);
    if (key === null) return;
    const now = this.now();
    // Delete first so a re-store moves the key to the young end of the Map.
    this.entries.delete(key);
    this.entries.set(key, { rejection, expiresAt: now + this.ttlMs });
    negativeCacheCounter.inc({ surface, result: 'store', rejection });
    this.evict(now);
  }

  clear(): void {
    this.entries.clear();
  }

  private evict(now: number): void {
    for (const [key, entry] of this.entries) {
      if (this.entries.size > this.maxEntries || entry.expiresAt <= now) {
        this.entries.delete(key);
        continue;
      }
      break;
    }
  }
}

function cacheKey(surface: AgentAuthSurface, agentId: string, tokenHash: string): string | null {
  if (agentId.length > MAX_CACHEABLE_AGENT_ID_LENGTH) return null;
  // tokenHash is fixed-width hex and surface is from a closed set, so the
  // agentId between them is recovered unambiguously — no delimiter collisions.
  return `${surface}:${agentId}:${tokenHash}`;
}

/** The process-wide instance shared by the REST middleware and the WS upgrade. */
export const agentAuthNegativeCache = new AgentAuthNegativeCache({
  ttlMs: AGENT_AUTH_NEGATIVE_CACHE_TTL_MS,
  maxEntries: AGENT_AUTH_NEGATIVE_CACHE_MAX_ENTRIES,
});

/**
 * Tests that drive the real middleware share this module-level instance; call
 * this in `beforeEach` so one test's cached rejection can't answer another's.
 */
export function __resetAgentAuthNegativeCacheForTests(): void {
  agentAuthNegativeCache.clear();
}
