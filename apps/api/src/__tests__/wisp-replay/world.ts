/**
 * #10432 (W09) — the in-memory world a replay runs against: the data stores
 * and the model replies that sit behind the boundaries replay.test.ts mocks
 * (Postgres, Redis, the grant ceiling and fact reads, the extractor model).
 *
 * A leaf module with type-only imports, so a hoisted `vi.mock` factory can
 * `await import('./world')` without loading any service graph.
 */
import type { GrantCeiling } from '../../services/wisp/grantAuthority';
import type { StandingStateFacts } from '../../services/wisp/standingLoop';

/** A row of `ai_memory_blocks` as the standing-instruction matcher selects it. */
export type ReplayMemoryRow = {
  id: string;
  status: 'confirmed' | 'unconfirmed' | 'retracted';
  blockType: string;
  content: Record<string, unknown>;
};

/** A row of `devices` as the extractor's name resolution selects it. */
export type ReplayDeviceRow = { id: string; orgId: string; siteId: string | null; hostname: string; displayName: string | null };

/** The subset of ioredis the Wisp turn paths use: get, set (EX, NX), del and a MULTI of INCR/EXPIRE. */
export class FakeRedis {
  readonly store = new Map<string, string>();

  async get(key: string): Promise<string | null> {
    return this.store.get(key) ?? null;
  }

  async set(key: string, value: string, ...args: Array<string | number>): Promise<'OK' | null> {
    if (args.some((a) => String(a).toUpperCase() === 'NX') && this.store.has(key)) return null;
    this.store.set(key, value);
    return 'OK';
  }

  async del(...keys: string[]): Promise<number> {
    let n = 0;
    for (const key of keys) if (this.store.delete(key)) n += 1;
    return n;
  }

  multi() {
    const ops: Array<() => [null, unknown]> = [];
    const chain = {
      incr: (key: string) => {
        ops.push(() => {
          const next = Number(this.store.get(key) ?? '0') + 1;
          this.store.set(key, String(next));
          return [null, next];
        });
        return chain;
      },
      expire: (_key: string, _seconds: number) => {
        ops.push(() => [null, 1]);
        return chain;
      },
      exec: async () => ops.map((op) => op()),
    };
    return chain;
  }
}

export type ReplayWorld = {
  redis: FakeRedis;
  ceiling: GrantCeiling | null;
  standingFacts: StandingStateFacts | null;
  memoryRows: ReplayMemoryRow[];
  deviceRows: ReplayDeviceRow[];
  /** The extractor model's replies, in order (one per capture). */
  extractorReplies: unknown[];
  /** Rows written through `db.insert(...).values(...)` (assistant corrections among them). */
  inserted: Array<Record<string, unknown>>;
  /** Tables read through the fake `db` that the world holds no rows for (the suite asserts none). */
  unexpectedReads: string[];
  /** Errors production code reported through `captureException` (the suite asserts none). */
  reported: unknown[];
  /** Set by the harness for the session it is driving: the fake Agent SDK `query()`. */
  sdkQuery: ((args: { prompt: AsyncIterable<unknown>; options?: unknown }) => unknown) | null;
};

export const replayWorld: ReplayWorld = {
  redis: new FakeRedis(),
  ceiling: null,
  standingFacts: null,
  memoryRows: [],
  deviceRows: [],
  extractorReplies: [],
  inserted: [],
  unexpectedReads: [],
  reported: [],
  sdkQuery: null,
};

export function resetReplayWorld(): void {
  replayWorld.redis = new FakeRedis();
  replayWorld.ceiling = null;
  replayWorld.standingFacts = null;
  replayWorld.memoryRows = [];
  replayWorld.deviceRows = [];
  replayWorld.extractorReplies = [];
  replayWorld.inserted = [];
  replayWorld.unexpectedReads = [];
  replayWorld.reported = [];
  replayWorld.sdkQuery = null;
}
