/**
 * Execution plane W04 (R5, spec §9) — the sandbox backend circuit breaker.
 *
 * The failure it exists for: the provider starts refusing creates (quota,
 * region outage). Without a breaker, every admitted analysis run spends its
 * token budget orienting itself and then dies at its first `workspace_*`
 * call. Pinned here: consecutive counting (a success clears the run), the
 * threshold, the TTL, and that a Redis outage reports CLOSED rather than
 * taking analysis down on its own.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const redisMock = {
  get: vi.fn(),
  set: vi.fn(),
  del: vi.fn(),
  incr: vi.fn(),
  expire: vi.fn(),
};

vi.mock('../redis', () => ({ getRedis: vi.fn(() => redisMock) }));
vi.mock('../sentry', () => ({ captureMessage: vi.fn() }));

import { getRedis } from '../redis';
import { captureMessage } from '../sentry';
import {
  isWorkspaceBreakerOpen,
  recordWorkspaceCreateFailure,
  recordWorkspaceCreateSuccess,
  WORKSPACE_BREAKER_OPEN_SECONDS,
  WORKSPACE_BREAKER_THRESHOLD,
} from './workspaceBreaker';

beforeEach(() => {
  vi.clearAllMocks();
  // clearAllMocks resets history but not a prior mockReturnValue — re-anchor.
  vi.mocked(getRedis).mockReturnValue(redisMock as never);
  redisMock.get.mockResolvedValue(null);
  redisMock.set.mockResolvedValue('OK');
  redisMock.del.mockResolvedValue(1);
  redisMock.incr.mockResolvedValue(1);
  redisMock.expire.mockResolvedValue(1);
});

describe('workspaceBreaker', () => {
  it('reports closed when no open key is set and open when one is', async () => {
    expect(await isWorkspaceBreakerOpen('vercel')).toBe(false);
    redisMock.get.mockResolvedValueOnce('1757800000000');
    expect(await isWorkspaceBreakerOpen('vercel')).toBe(true);
    expect(redisMock.get).toHaveBeenLastCalledWith('breeze:ai:workspace:breaker:vercel');
  });

  it('reports CLOSED when redis is unavailable or throws', async () => {
    vi.mocked(getRedis).mockReturnValueOnce(null as never);
    expect(await isWorkspaceBreakerOpen('vercel')).toBe(false);
    redisMock.get.mockRejectedValueOnce(new Error('connection reset'));
    expect(await isWorkspaceBreakerOpen('vercel')).toBe(false);
  });

  it('does not open below the threshold', async () => {
    redisMock.incr.mockResolvedValueOnce(WORKSPACE_BREAKER_THRESHOLD - 1);
    await recordWorkspaceCreateFailure('vercel');
    expect(redisMock.set).not.toHaveBeenCalled();
    expect(captureMessage).not.toHaveBeenCalled();
    // The counter itself expires, so isolated failures never accumulate.
    expect(redisMock.expire).toHaveBeenCalledWith(
      'breeze:ai:workspace:breaker:vercel:failures', WORKSPACE_BREAKER_OPEN_SECONDS,
    );
  });

  it('opens for ten minutes and pages at the threshold', async () => {
    redisMock.incr.mockResolvedValueOnce(WORKSPACE_BREAKER_THRESHOLD);
    await recordWorkspaceCreateFailure('vercel');
    expect(redisMock.set).toHaveBeenCalledWith(
      'breeze:ai:workspace:breaker:vercel', expect.any(String), 'EX', WORKSPACE_BREAKER_OPEN_SECONDS,
    );
    expect(captureMessage).toHaveBeenCalled();
  });

  it('a success clears the consecutive-failure run', async () => {
    await recordWorkspaceCreateSuccess('vercel');
    expect(redisMock.del).toHaveBeenCalledWith('breeze:ai:workspace:breaker:vercel:failures');
  });

  it('keys per backend so one provider does not gate another', async () => {
    redisMock.incr.mockResolvedValueOnce(WORKSPACE_BREAKER_THRESHOLD);
    await recordWorkspaceCreateFailure('fake');
    expect(redisMock.set).toHaveBeenCalledWith(
      'breeze:ai:workspace:breaker:fake', expect.any(String), 'EX', WORKSPACE_BREAKER_OPEN_SECONDS,
    );
  });

  it('never throws when redis rejects a write', async () => {
    redisMock.incr.mockRejectedValueOnce(new Error('down'));
    await expect(recordWorkspaceCreateFailure('vercel')).resolves.toBeUndefined();
    redisMock.del.mockRejectedValueOnce(new Error('down'));
    await expect(recordWorkspaceCreateSuccess('vercel')).resolves.toBeUndefined();
  });
});
