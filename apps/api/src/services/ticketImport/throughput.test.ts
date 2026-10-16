import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ rateLimiter: vi.fn(), getRedis: vi.fn(() => ({}) as unknown) }));
vi.mock('../rate-limit', () => ({ rateLimiter: mocks.rateLimiter }));
vi.mock('../redis', () => ({ getRedis: mocks.getRedis }));
vi.mock('../migrationWindows', () => ({
  MigrationWindowError: class MigrationWindowError extends Error {
    constructor(public code: string, message: string, public status: number, public details?: Record<string, unknown>) {
      super(message);
    }
  },
}));

import { chargeWindowThroughput, migrationWindowRateKey } from './throughput';

const WINDOW = { id: '55555555-5555-4555-8555-555555555555', writesPerHour: 6000 };

describe('the import throughput bucket (spec §4.7)', () => {
  beforeEach(() => {
    mocks.rateLimiter.mockReset();
  });

  it("charges the window's own hourly bucket the transaction's cost, refunding a refused attempt", async () => {
    mocks.rateLimiter.mockResolvedValueOnce({ allowed: true, remaining: 5897, resetAt: new Date() });
    await chargeWindowThroughput(WINDOW, 103);
    expect(mocks.rateLimiter).toHaveBeenCalledWith(expect.anything(), `migration_window_rate:${WINDOW.id}`, 6000, 3600, 103, { refundOnReject: true });
    expect(migrationWindowRateKey(WINDOW.id)).toBe(`migration_window_rate:${WINDOW.id}`);
  });

  it('refuses with 429 MIGRATION_WINDOW_RATE_LIMITED and when to retry', async () => {
    mocks.rateLimiter.mockResolvedValueOnce({ allowed: false, remaining: 0, resetAt: new Date(Date.now() + 90_000) });
    await expect(chargeWindowThroughput(WINDOW, 3)).rejects.toMatchObject({
      code: 'MIGRATION_WINDOW_RATE_LIMITED',
      status: 429,
      details: { writesPerHour: 6000, retryAfterSeconds: expect.any(Number) },
    });
  });

  it('fails closed with no Redis (the limiter denies) and charges nothing for a zero-cost transaction', async () => {
    mocks.getRedis.mockReturnValueOnce(null);
    mocks.rateLimiter.mockResolvedValueOnce({ allowed: false, remaining: 0, resetAt: new Date() });
    await expect(chargeWindowThroughput(WINDOW, 1)).rejects.toMatchObject({ code: 'MIGRATION_WINDOW_RATE_LIMITED' });
    expect(mocks.rateLimiter).toHaveBeenCalledWith(null, expect.any(String), 6000, 3600, 1, { refundOnReject: true });
    mocks.rateLimiter.mockClear();
    await chargeWindowThroughput(WINDOW, 0);
    expect(mocks.rateLimiter).not.toHaveBeenCalled();
  });
});
