import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ rateLimiter: vi.fn(), getRedis: vi.fn(() => ({}) as unknown), assertOutside: vi.fn() }));
vi.mock('../rate-limit', () => ({ rateLimiter: mocks.rateLimiter, assertOutsideHeldDbContextSafe: mocks.assertOutside }));
vi.mock('../redis', () => ({ getRedis: mocks.getRedis }));
vi.mock('../migrationWindows', () => ({
  MigrationWindowError: class MigrationWindowError extends Error {
    constructor(public code: string, message: string, public status: number, public details?: Record<string, unknown>) {
      super(message);
    }
  },
}));

import { BYTE_BUCKET_LUA, chargeWindowBytes, chargeWindowThroughput, migrationWindowBytesKey, migrationWindowRateKey } from './throughput';

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
      details: { kind: 'writes', writesPerHour: 6000, retryAfterSeconds: expect.any(Number) },
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

describe('the import byte bucket (spec 2026-10-19 §4.5)', () => {
  const GIB = 1024 * 1024 * 1024;
  const MIB = 1024 * 1024;
  let evalMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    delete process.env.TICKET_IMPORT_MAX_BYTES_PER_HOUR;
    evalMock = vi.fn();
    mocks.getRedis.mockReturnValue({ eval: evalMock });
    mocks.assertOutside.mockClear();
  });

  it("charges the window's own byte bucket, migration_window_bytes:{windowId}, against 2 GiB an hour by default", async () => {
    evalMock.mockResolvedValueOnce([1, 0]);
    await chargeWindowBytes(WINDOW, 4 * MIB);
    expect(evalMock).toHaveBeenCalledWith(BYTE_BUCKET_LUA, 1, `migration_window_bytes:${WINDOW.id}`, String(2 * GIB), String(4 * MIB), String(7_200_000));
    expect(migrationWindowBytesKey(WINDOW.id)).toBe(`migration_window_bytes:${WINDOW.id}`);
    // A Redis round trip: never inside a held DB context (#1105).
    expect(mocks.assertOutside).toHaveBeenCalledWith('chargeWindowBytes');
  });

  it('refuses with 429 MIGRATION_WINDOW_RATE_LIMITED, kind bytes, and when the charge will fit', async () => {
    evalMock.mockResolvedValueOnce([0, 90_500]);
    await expect(chargeWindowBytes(WINDOW, 10 * MIB)).rejects.toMatchObject({
      code: 'MIGRATION_WINDOW_RATE_LIMITED',
      status: 429,
      details: { kind: 'bytes', bytesPerHour: 2 * GIB, retryAfterSeconds: 91 },
    });
  });

  it('takes TICKET_IMPORT_MAX_BYTES_PER_HOUR, never below one 10 MiB file, and clamps a charge to it', async () => {
    process.env.TICKET_IMPORT_MAX_BYTES_PER_HOUR = String(500 * MIB);
    evalMock.mockResolvedValue([1, 0]);
    await chargeWindowBytes(WINDOW, MIB);
    expect(evalMock).toHaveBeenLastCalledWith(BYTE_BUCKET_LUA, 1, expect.any(String), String(500 * MIB), String(MIB), expect.any(String));
    process.env.TICKET_IMPORT_MAX_BYTES_PER_HOUR = '1024';
    await chargeWindowBytes(WINDOW, 10 * MIB);
    expect(evalMock).toHaveBeenLastCalledWith(BYTE_BUCKET_LUA, 1, expect.any(String), String(10 * MIB), String(10 * MIB), expect.any(String));
  });

  // Review finding 6: only a plain positive integer counts (the repo's
  // positiveIntEnv); anything else is the 2 GiB default.
  it.each(['2e9', '2GiB', '2_147_483_648', '12abc', '-5', '0', '1.5', ' '])('ignores TICKET_IMPORT_MAX_BYTES_PER_HOUR=%j: the 2 GiB default applies', async (value) => {
    process.env.TICKET_IMPORT_MAX_BYTES_PER_HOUR = value;
    evalMock.mockResolvedValueOnce([1, 0]);
    await chargeWindowBytes(WINDOW, MIB);
    expect(evalMock).toHaveBeenLastCalledWith(BYTE_BUCKET_LUA, 1, expect.any(String), String(2 * GIB), String(MIB), expect.any(String));
  });

  it('takes a plain integer with surrounding spaces', async () => {
    process.env.TICKET_IMPORT_MAX_BYTES_PER_HOUR = ' 52428800 ';
    evalMock.mockResolvedValueOnce([1, 0]);
    await chargeWindowBytes(WINDOW, MIB);
    expect(evalMock).toHaveBeenLastCalledWith(BYTE_BUCKET_LUA, 1, expect.any(String), String(50 * MIB), String(MIB), expect.any(String));
  });

  it('fails closed with no Redis, and on a Redis error', async () => {
    mocks.getRedis.mockReturnValueOnce(null);
    await expect(chargeWindowBytes(WINDOW, MIB)).rejects.toMatchObject({ code: 'MIGRATION_WINDOW_RATE_LIMITED', details: { kind: 'bytes', retryAfterSeconds: 60 } });
    evalMock.mockRejectedValueOnce(new Error('READONLY'));
    await expect(chargeWindowBytes(WINDOW, MIB)).rejects.toMatchObject({ code: 'MIGRATION_WINDOW_RATE_LIMITED', details: { kind: 'bytes', retryAfterSeconds: 60 } });
  });

  it('charges nothing for nothing', async () => {
    await chargeWindowBytes(WINDOW, 0);
    expect(evalMock).not.toHaveBeenCalled();
  });

  it('the script refills at the hourly rate from the Redis clock and takes nothing on refusal', () => {
    expect(BYTE_BUCKET_LUA).toContain("redis.call('TIME')");
    expect(BYTE_BUCKET_LUA).toContain('local rate = capacity / 3600000');
    expect(BYTE_BUCKET_LUA).toMatch(/if tokens >= cost then\s+tokens = tokens - cost/);
  });
});
