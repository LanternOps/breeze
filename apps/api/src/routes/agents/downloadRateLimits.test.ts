import { beforeEach, describe, expect, it, vi } from 'vitest';

// Exercises the REAL rateLimiter sliding-window math (not the mocked stub
// download.test.ts uses) against an in-memory fake Redis, so these tests
// prove the actual sizing of the public download routes' per-IP buckets —
// not just that some limiter function was called.

vi.mock('../../services/installerBuilder', () => ({
  fetchVerifiedMacosPkg: vi.fn(async () => {
    throw new Error('package unavailable');
  }),
}));

vi.mock('../../services/s3Storage', () => ({
  isS3Configured: vi.fn(() => false),
  getPresignedUrl: vi.fn(),
  isS3NotFound: () => false,
}));

vi.mock('../../services/binarySource', () => ({
  getBinarySource: vi.fn(() => 'local'),
  getGithubReleaseVersion: vi.fn(() => 'latest'),
  getGithubAgentUrl: vi.fn(),
  getGithubHelperUrl: vi.fn(),
  getGithubUserHelperUrl: vi.fn(),
  getGithubWatchdogUrl: vi.fn(),
  getGithubBackupUrl: vi.fn(),
  getGithubRecoveryIsoUrl: vi.fn(),
  HELPER_FILENAMES: {
    linux: 'breeze-desktop-helper-linux-amd64',
    darwin: 'breeze-desktop-helper-darwin',
    windows: 'breeze-desktop-helper-windows.exe',
  },
}));

vi.mock('../../services/promotedAgentVersion', () => ({
  getPromotedComponentVersion: vi.fn(async () => null),
  getRegisteredComponentVersion: vi.fn(async () => null),
}));

/**
 * Minimal in-memory stand-in for the one Redis shape `rateLimiter` (services/
 * rate-limit.ts) actually uses: a sorted-set `multi()` pipeline of
 * zremrangebyscore → zadd → zcard → zrange(0,0,WITHSCORES) → expire, plus a
 * standalone `zrem`. Real sliding-window semantics (entries older than the
 * window are pruned before counting), not a canned mock response — so a test
 * against this fake actually exercises the configured limit/window.
 */
class FakeRedis {
  private sets = new Map<string, Map<string, number>>();

  multi() {
    const ops: Array<() => void> = [];
    const results: Array<[Error | null, unknown]> = [];
    const self = this;
    const builder = {
      zremrangebyscore(key: string, _min: string, max: number) {
        ops.push(() => {
          const set = self.sets.get(key);
          if (set) {
            for (const [member, score] of set) {
              if (score <= max) set.delete(member);
            }
          }
          results.push([null, 0]);
        });
        return builder;
      },
      zadd(key: string, ...args: Array<string | number>) {
        ops.push(() => {
          let set = self.sets.get(key);
          if (!set) {
            set = new Map();
            self.sets.set(key, set);
          }
          for (let i = 0; i < args.length; i += 2) {
            const score = Number(args[i]);
            const member = String(args[i + 1]);
            set.set(member, score);
          }
          results.push([null, args.length / 2]);
        });
        return builder;
      },
      zcard(key: string) {
        ops.push(() => {
          const set = self.sets.get(key);
          results.push([null, set ? set.size : 0]);
        });
        return builder;
      },
      zrange(key: string, _start: number, _stop: number, _withScores: string) {
        ops.push(() => {
          const set = self.sets.get(key);
          if (!set || set.size === 0) {
            results.push([null, []]);
            return;
          }
          let oldestMember = '';
          let oldestScore = Infinity;
          for (const [member, score] of set) {
            if (score < oldestScore) {
              oldestScore = score;
              oldestMember = member;
            }
          }
          results.push([null, [oldestMember, String(oldestScore)]]);
        });
        return builder;
      },
      expire(_key: string, _seconds: number) {
        ops.push(() => {
          results.push([null, 1]);
        });
        return builder;
      },
      async exec() {
        for (const op of ops) op();
        return results;
      },
    };
    return builder;
  }

  async zrem(key: string, ...members: string[]) {
    const set = this.sets.get(key);
    if (!set) return 0;
    let removed = 0;
    for (const m of members) {
      if (set.delete(m)) removed += 1;
    }
    return removed;
  }
}

const fakeRedis = new FakeRedis();

vi.mock('../../services', () => ({
  getRedis: vi.fn(() => fakeRedis),
}));

import { downloadRoutes } from './download';

const MASS_ROLLOUT_IP = '203.0.113.50';

function requestAs(path: string) {
  return downloadRoutes.request(path, {
    headers: { 'x-forwarded-for': MASS_ROLLOUT_IP },
  });
}

describe('public download route rate limits — real sliding-window sizing', () => {
  beforeEach(() => {
    // Fresh fake Redis state per test — reach into the mocked module's
    // singleton and clear its backing sets rather than constructing a new
    // instance (the route file captured a reference to `fakeRedis` at mock
    // time).
    (fakeRedis as unknown as { sets: Map<string, unknown> }).sets.clear();
  });

  it('lets 500 install.sh requests from one office NAT IP succeed within a few minutes', async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 500; i += 1) {
      const res = await requestAs('/install.sh');
      statuses.push(res.status);
    }
    const rejected = statuses.filter((s) => s === 429);
    expect(rejected).toEqual([]);
    expect(statuses.every((s) => s === 200 || s === 503)).toBe(true);
    // Should genuinely have succeeded (503 would mean the fake Redis wiring
    // is broken, not that the limiter passed) — most of this repo's runtime
    // config isn't set here, so assert on the limiter's own effect (no 429s)
    // rather than requiring every route dependency to be fully wired.
    expect(statuses.filter((s) => s === 200).length).toBe(500);
  });

  it('lets 500 same-artifact agent-binary requests from one office NAT IP succeed within a few minutes', async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 500; i += 1) {
      const res = await requestAs('/download/linux/amd64');
      statuses.push(res.status);
    }
    expect(statuses.filter((s) => s === 429)).toEqual([]);
  });

  it('still caps sustained abuse on install.sh from one IP past the configured ceiling', async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 700; i += 1) {
      const res = await requestAs('/install.sh');
      statuses.push(res.status);
    }
    const rejected = statuses.filter((s) => s === 429);
    expect(rejected.length).toBeGreaterThan(0);
    // The 601st request onward (limit is 600/window) must be rejected.
    expect(statuses[600]).toBe(429);
  });

  it('does not let a flood on one route drain another route\'s budget on the same IP', async () => {
    // Saturate install.sh's bucket …
    for (let i = 0; i < 600; i += 1) {
      await requestAs('/install.sh');
    }
    const saturated = await requestAs('/install.sh');
    expect(saturated.status).toBe(429);

    // … the agent binary route, a DIFFERENT bucket, must still be open.
    const stillOpen = await requestAs('/download/linux/amd64');
    expect(stillOpen.status).not.toBe(429);
  });
});
