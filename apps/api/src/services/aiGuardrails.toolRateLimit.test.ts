import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./rate-limit', () => ({ rateLimiter: vi.fn() }));
vi.mock('./redis', () => ({ getRedis: vi.fn(() => ({ fake: 'redis' })) }));
vi.mock('./aiToolRateLimits', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./aiToolRateLimits')>()),
  resolveToolRateLimitMultiplier: vi.fn(),
}));

import { rateLimiter } from './rate-limit';
import { resolveToolRateLimitMultiplier } from './aiToolRateLimits';
import { TOOL_RATE_LIMITS, checkToolRateLimit, listEffectiveToolRateLimits } from './aiGuardrails';

const ALLOWED = { allowed: true, remaining: 1, resetAt: new Date('2026-09-23T00:00:00Z') };

describe('checkToolRateLimit — toolRateLimitMultiplier (#6476)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(rateLimiter).mockResolvedValue(ALLOWED as never);
  });

  it('multiplier 1 enforces the shipped limit unchanged', async () => {
    vi.mocked(resolveToolRateLimitMultiplier).mockResolvedValue(1);
    await checkToolRateLimit('run_script', 'user-1', { orgId: 'org-1' });
    expect(rateLimiter).toHaveBeenCalledWith(expect.anything(), 'ai:tool:user-1:run_script', 5, 300);
  });

  it('scales the limit by ceil(limit × multiplier), keeping the window', async () => {
    vi.mocked(resolveToolRateLimitMultiplier).mockResolvedValue(3);
    await checkToolRateLimit('run_script', 'user-1', { orgId: 'org-1' });
    expect(rateLimiter).toHaveBeenCalledWith(expect.anything(), 'ai:tool:user-1:run_script', 15, 300);
  });

  it('resolves the multiplier from the call org and keeps the counter per user per tool', async () => {
    vi.mocked(resolveToolRateLimitMultiplier).mockResolvedValue(2);
    await checkToolRateLimit('network_discovery', 'user-9', { orgId: 'org-A', partnerId: 'p-1' });
    expect(resolveToolRateLimitMultiplier).toHaveBeenCalledWith({ orgId: 'org-A', partnerId: 'p-1' });
    // Key has no org component: one counter per user per tool across orgs.
    expect(rateLimiter).toHaveBeenCalledWith(expect.anything(), 'ai:tool:user-9:network_discovery', 4, 600);
  });

  it('never lowers the limit even if the resolver returned something below 1', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.mocked(resolveToolRateLimitMultiplier).mockResolvedValue(0);
    await checkToolRateLimit('run_script', 'user-1', { orgId: 'org-1' });
    expect(rateLimiter).toHaveBeenCalledWith(expect.anything(), 'ai:tool:user-1:run_script', 5, 300);
  });

  it('does not look up settings for a tool with no rate limit', async () => {
    await expect(checkToolRateLimit('query_devices', 'user-1', { orgId: 'org-1' })).resolves.toBeNull();
    expect(resolveToolRateLimitMultiplier).not.toHaveBeenCalled();
    expect(rateLimiter).not.toHaveBeenCalled();
  });

  it('reports the exceeded state', async () => {
    vi.mocked(resolveToolRateLimitMultiplier).mockResolvedValue(1);
    vi.mocked(rateLimiter).mockResolvedValue({ ...ALLOWED, allowed: false } as never);
    await expect(checkToolRateLimit('run_script', 'user-1', { orgId: 'org-1' })).resolves.toMatch(
      /Tool rate limit exceeded for run_script/,
    );
  });
});

describe('listEffectiveToolRateLimits', () => {
  it('lists every TOOL_RATE_LIMITS entry with base and effective limit', () => {
    const rows = listEffectiveToolRateLimits(2);
    expect(rows).toHaveLength(Object.keys(TOOL_RATE_LIMITS).length);
    expect(rows.find((r) => r.toolName === 'run_script')).toEqual({
      toolName: 'run_script',
      baseLimit: 5,
      limit: 10,
      windowSeconds: 300,
    });
  });

  it('multiplier 1 returns the shipped limits', () => {
    for (const row of listEffectiveToolRateLimits(1)) {
      expect(row.limit).toBe(TOOL_RATE_LIMITS[row.toolName]!.limit);
    }
  });
});
