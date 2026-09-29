/**
 * In-memory stand-in for the sorted-set subset of ioredis that the sliding-
 * window limiters use (`services/rate-limit.ts` rateLimiter and
 * `services/agentStorageSessionRateLimit.ts`): a `multi()` pipeline of
 * zremrangebyscore / zadd / zcard / zrange(start, stop, 'WITHSCORES') /
 * expire / pexpire / zrem, plus standalone zrem / zrange / zcard.
 *
 * Real sliding-window semantics — members are ordered by score (then member,
 * as Redis does), pruning removes every score <= max — so a test against it
 * exercises the configured limit and window instead of a canned response.
 * Expiry (EXPIRE/PEXPIRE) is accepted and ignored: every limiter here prunes by
 * score before counting, so a stale key never changes a decision.
 */
export class SortedSetRedisFake {
  private sets = new Map<string, Map<string, number>>();

  /** Members of `key` in Redis order (score asc, then member lexicographic). */
  private ordered(key: string): Array<[string, number]> {
    const set = this.sets.get(key);
    if (!set) return [];
    return [...set.entries()].sort((a, b) => (a[1] - b[1]) || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  }

  private zremrangebyscoreNow(key: string, max: number): number {
    const set = this.sets.get(key);
    if (!set) return 0;
    let removed = 0;
    for (const [member, score] of set) {
      if (score <= max) {
        set.delete(member);
        removed += 1;
      }
    }
    return removed;
  }

  private zaddNow(key: string, args: Array<string | number>): number {
    let set = this.sets.get(key);
    if (!set) {
      set = new Map();
      this.sets.set(key, set);
    }
    let added = 0;
    for (let i = 0; i < args.length; i += 2) {
      const member = String(args[i + 1]);
      if (!set.has(member)) added += 1;
      set.set(member, Number(args[i]));
    }
    return added;
  }

  private zrangeNow(key: string, start: number, stop: number, withScores?: string): string[] {
    const all = this.ordered(key);
    const len = all.length;
    const from = start < 0 ? Math.max(0, len + start) : start;
    const to = stop < 0 ? len + stop : Math.min(stop, len - 1);
    const out: string[] = [];
    for (let i = from; i <= to; i += 1) {
      const [member, score] = all[i]!;
      out.push(member);
      if (withScores) out.push(String(score));
    }
    return out;
  }

  private zremNow(key: string, members: string[]): number {
    const set = this.sets.get(key);
    if (!set) return 0;
    let removed = 0;
    for (const m of members) if (set.delete(m)) removed += 1;
    return removed;
  }

  multi() {
    const ops: Array<() => unknown> = [];
    const builder = {
      zremrangebyscore: (key: string, _min: string | number, max: string | number) => {
        ops.push(() => this.zremrangebyscoreNow(key, Number(max)));
        return builder;
      },
      zadd: (key: string, ...args: Array<string | number>) => {
        ops.push(() => this.zaddNow(key, args));
        return builder;
      },
      zcard: (key: string) => {
        ops.push(() => this.sets.get(key)?.size ?? 0);
        return builder;
      },
      zrange: (key: string, start: number, stop: number, withScores?: string) => {
        ops.push(() => this.zrangeNow(key, start, stop, withScores));
        return builder;
      },
      zrem: (key: string, ...members: string[]) => {
        ops.push(() => this.zremNow(key, members));
        return builder;
      },
      expire: (_key: string, _seconds: number) => {
        ops.push(() => 1);
        return builder;
      },
      pexpire: (_key: string, _ms: number) => {
        ops.push(() => 1);
        return builder;
      },
      exec: async (): Promise<Array<[Error | null, unknown]>> => ops.map((op) => [null, op()]),
    };
    return builder;
  }

  async zrem(key: string, ...members: string[]): Promise<number> {
    return this.zremNow(key, members);
  }

  async zrange(key: string, start: number, stop: number, withScores?: string): Promise<string[]> {
    return this.zrangeNow(key, start, stop, withScores);
  }

  async zcard(key: string): Promise<number> {
    return this.sets.get(key)?.size ?? 0;
  }

  /** Test-only: every key currently holding members. */
  keys(): string[] {
    return [...this.sets.entries()].filter(([, s]) => s.size > 0).map(([k]) => k);
  }

  reset(): void {
    this.sets.clear();
  }
}
