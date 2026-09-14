import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { mockDb } = vi.hoisted(() => ({
  mockDb: {
    select: vi.fn(),
  },
}));

vi.mock('../../../db', () => ({
  db: mockDb,
}));

vi.mock('../../../db/schema', () => ({
  securityStatus: {
    deviceId: 'securityStatus.deviceId',
    realTimeProtection: 'securityStatus.realTimeProtection',
    definitionsDate: 'securityStatus.definitionsDate',
    threatCount: 'securityStatus.threatCount',
  },
}));

import { antivirusHandler } from './antivirus';

const DEVICE_ID = 'device-1';

// Drives db.select({...}).from(...).where(...).limit(...) to resolve with `rows`.
function setRows(rows: Array<Record<string, unknown>>) {
  mockDb.select.mockReturnValue({
    from: () => ({
      where: () => ({
        limit: () => Promise.resolve(rows),
      }),
    }),
  });
}

function makeStatus(overrides: Record<string, unknown> = {}) {
  return {
    realTimeProtection: true,
    definitionsDate: new Date('2026-09-13T00:00:00.000Z'),
    threatCount: 0,
    ...overrides,
  };
}

describe('antivirusHandler', () => {
  beforeEach(() => {
    mockDb.select.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('realtime_disabled: passes when realTimeProtection is explicitly false', async () => {
    setRows([makeStatus({ realTimeProtection: false })]);

    const result = await antivirusHandler.evaluate({ type: 'antivirus', check: 'realtime_disabled' }, DEVICE_ID);

    expect(result.passed).toBe(true);
  });

  it('realtime_disabled: a null realTimeProtection (never reported) must NOT read as disabled', async () => {
    setRows([makeStatus({ realTimeProtection: null })]);

    const result = await antivirusHandler.evaluate({ type: 'antivirus', check: 'realtime_disabled' }, DEVICE_ID);

    expect(result.passed).toBe(false);
    expect(result.description).toMatch(/no data/i);
  });

  it('definitions_stale: passes when definitionsDate is older than staleAfterDays', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-13T00:00:00.000Z'));
    setRows([makeStatus({ definitionsDate: new Date('2026-09-05T00:00:00.000Z') })]); // 8 days old

    const result = await antivirusHandler.evaluate(
      { type: 'antivirus', check: 'definitions_stale', staleAfterDays: 7 },
      DEVICE_ID
    );

    expect(result.passed).toBe(true);
  });

  it('definitions_stale: does not pass when definitionsDate is within staleAfterDays', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-13T00:00:00.000Z'));
    setRows([makeStatus({ definitionsDate: new Date('2026-09-07T00:00:00.000Z') })]); // 6 days old

    const result = await antivirusHandler.evaluate(
      { type: 'antivirus', check: 'definitions_stale', staleAfterDays: 7 },
      DEVICE_ID
    );

    expect(result.passed).toBe(false);
  });

  it('definitions_stale: a null definitionsDate (never reported) must NOT read as stale', async () => {
    setRows([makeStatus({ definitionsDate: null })]);

    const result = await antivirusHandler.evaluate(
      { type: 'antivirus', check: 'definitions_stale', staleAfterDays: 7 },
      DEVICE_ID
    );

    expect(result.passed).toBe(false);
    expect(result.description).toMatch(/no data/i);
  });

  it('threats_present: does not pass when threatCount is below minThreatCount', async () => {
    setRows([makeStatus({ threatCount: 0 })]);

    const result = await antivirusHandler.evaluate(
      { type: 'antivirus', check: 'threats_present', minThreatCount: 1 },
      DEVICE_ID
    );

    expect(result.passed).toBe(false);
  });

  it('threats_present: passes when threatCount meets or exceeds minThreatCount', async () => {
    setRows([makeStatus({ threatCount: 2 })]);

    const result = await antivirusHandler.evaluate(
      { type: 'antivirus', check: 'threats_present', minThreatCount: 1 },
      DEVICE_ID
    );

    expect(result.passed).toBe(true);
    expect(result.actualValue).toBe(2);
  });

  it('does not pass when no security status row exists for the device', async () => {
    setRows([]);

    const result = await antivirusHandler.evaluate({ type: 'antivirus', check: 'realtime_disabled' }, DEVICE_ID);

    expect(result.passed).toBe(false);
    expect(result.description).toBe('No antivirus status reported');
  });

  describe('validate', () => {
    it('rejects an invalid check', () => {
      const errors = antivirusHandler.validate({ check: 'bogus' }, 'c');
      expect(errors.length).toBeGreaterThan(0);
    });

    it('rejects definitions_stale without a positive staleAfterDays', () => {
      const errors = antivirusHandler.validate({ check: 'definitions_stale' }, 'c');
      expect(errors).toContain('c.staleAfterDays: Must be a positive number');
    });

    it('accepts a valid realtime_disabled condition', () => {
      expect(antivirusHandler.validate({ check: 'realtime_disabled' }, 'c')).toEqual([]);
    });

    it('accepts a valid definitions_stale condition', () => {
      expect(antivirusHandler.validate({ check: 'definitions_stale', staleAfterDays: 7 }, 'c')).toEqual([]);
    });
  });
});
