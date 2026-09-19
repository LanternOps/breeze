import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockDb, whereSpy } = vi.hoisted(() => ({
  mockDb: { select: vi.fn() },
  whereSpy: vi.fn(),
}));

vi.mock('../../../db', () => ({
  db: mockDb,
}));

vi.mock('../../../db/schema', () => ({
  softwareInventory: {
    deviceId: 'softwareInventory.deviceId',
    name: 'softwareInventory.name',
    vendor: 'softwareInventory.vendor',
    version: 'softwareInventory.version',
    lastSeen: 'softwareInventory.lastSeen',
  },
}));

import { softwarePresenceHandler } from './softwarePresence';

const DEVICE_ID = 'device-1';

// Drives db.select({...}).from(...).where(...).orderBy(...).limit(...) to
// resolve with `rows`, while recording what `.where()` was called with so
// the vendor-narrowing test can inspect the built predicate.
function setRows(rows: Array<Record<string, unknown>>) {
  mockDb.select.mockReturnValue({
    from: () => ({
      where: (...args: unknown[]) => {
        whereSpy(...args);
        return { orderBy: () => ({ limit: () => Promise.resolve(rows) }) };
      },
    }),
  });
}

describe('softwarePresenceHandler', () => {
  beforeEach(() => {
    mockDb.select.mockReset();
    whereSpy.mockReset();
  });

  it('declares the type "software_presence"', () => {
    expect(softwarePresenceHandler.type).toBe('software_presence');
  });

  it('not_installed: breaches (passed true) when no row matches', async () => {
    setRows([]);

    const result = await softwarePresenceHandler.evaluate(
      { type: 'software_presence', name: 'TeamViewer', presence: 'not_installed' },
      DEVICE_ID
    );

    expect(result.passed).toBe(true);
  });

  it('installed means alert me that it IS installed — breaches (passed true) when a matching row exists', async () => {
    setRows([{ name: 'TeamViewer', version: '15.0' }]);

    const result = await softwarePresenceHandler.evaluate(
      { type: 'software_presence', name: 'TeamViewer', presence: 'installed' },
      DEVICE_ID
    );

    expect(result.passed).toBe(true);
  });

  it('installed: does NOT breach when nothing matches', async () => {
    setRows([]);

    const result = await softwarePresenceHandler.evaluate(
      { type: 'software_presence', name: 'TeamViewer', presence: 'installed' },
      DEVICE_ID
    );

    expect(result.passed).toBe(false);
  });

  it('version_below: breaches when the installed version is numerically below the threshold (9.8 < 10.2)', async () => {
    setRows([{ name: 'Java', version: '9.8' }]);

    const result = await softwarePresenceHandler.evaluate(
      { type: 'software_presence', name: 'Java', presence: 'version_below', version: '10.2' },
      DEVICE_ID
    );

    expect(result.passed).toBe(true);
  });

  it('version_below: does NOT breach for 10.10 vs 10.2 — numeric 10.10 > 10.2 even though it sorts lower lexicographically', async () => {
    // The whole point of this test: a naive string compare would say
    // '10.10' < '10.2' (lexicographic) and incorrectly fire. Numerically,
    // 10.10 is a newer/higher version than 10.2, so this must NOT breach.
    setRows([{ name: 'Java', version: '10.10' }]);

    const result = await softwarePresenceHandler.evaluate(
      { type: 'software_presence', name: 'Java', presence: 'version_below', version: '10.2' },
      DEVICE_ID
    );

    expect(result.passed).toBe(false);
  });

  it('version_below: a non-numeric installed version is not comparable — does not guess, does not breach', async () => {
    setRows([{ name: 'Java', version: '2021-R2' }]);

    const result = await softwarePresenceHandler.evaluate(
      { type: 'software_presence', name: 'Java', presence: 'version_below', version: '10.2' },
      DEVICE_ID
    );

    expect(result.passed).toBe(false);
    expect(result.description).toMatch(/not comparable/);
  });

  it('version_below: no matching row at all does not breach (nothing installed is not "below")', async () => {
    setRows([]);

    const result = await softwarePresenceHandler.evaluate(
      { type: 'software_presence', name: 'Java', presence: 'version_below', version: '10.2' },
      DEVICE_ID
    );

    expect(result.passed).toBe(false);
  });

  it('vendor narrows the match: supplying vendor changes the built where() predicate vs omitting it', async () => {
    setRows([]);
    await softwarePresenceHandler.evaluate(
      { type: 'software_presence', name: 'Chrome', presence: 'not_installed' },
      DEVICE_ID
    );
    const withoutVendor = JSON.stringify(whereSpy.mock.calls[0]);

    whereSpy.mockClear();
    setRows([]);
    await softwarePresenceHandler.evaluate(
      { type: 'software_presence', name: 'Chrome', vendor: 'Google', presence: 'not_installed' },
      DEVICE_ID
    );
    const withVendor = JSON.stringify(whereSpy.mock.calls[0]);

    // A genuinely narrower predicate must differ from the unvendored one and
    // reference the vendor column — this fails if vendor is silently dropped.
    expect(withVendor).not.toBe(withoutVendor);
    expect(withVendor).toContain('softwareInventory.vendor');
  });

  describe('validate', () => {
    it('accepts a well-formed not_installed condition', () => {
      expect(
        softwarePresenceHandler.validate(
          { type: 'software_presence', name: 'TeamViewer', presence: 'not_installed' },
          'cond'
        )
      ).toEqual([]);
    });

    it('rejects an empty name', () => {
      const errors = softwarePresenceHandler.validate(
        { type: 'software_presence', name: '', presence: 'installed' },
        'cond'
      );
      expect(errors).toContain('cond.name: Must be a non-empty string');
    });

    it('rejects an invalid presence value', () => {
      const errors = softwarePresenceHandler.validate(
        { type: 'software_presence', name: 'Java', presence: 'sometimes' },
        'cond'
      );
      expect(errors).toContain('cond.presence: Must be one of installed, not_installed, version_below');
    });

    it('rejects version_below without a version', () => {
      const errors = softwarePresenceHandler.validate(
        { type: 'software_presence', name: 'Java', presence: 'version_below' },
        'cond'
      );
      expect(errors).toContain('cond.version: Required when presence is version_below');
    });

    it('accepts version_below with a version', () => {
      expect(
        softwarePresenceHandler.validate(
          { type: 'software_presence', name: 'Java', presence: 'version_below', version: '10.2' },
          'cond'
        )
      ).toEqual([]);
    });
  });
});
