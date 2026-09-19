import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The `warranty` mapping target (#3257 W08 Task 4, Open Decision 7).
 *
 * The property under test that everything else hangs off: the import must write
 * a COMPUTED `status`, not just the date. `evaluateWarrantyAlerts` returns early
 * on `status === 'unknown'` (`warrantyAlertEvaluator.ts:200`) and the column
 * defaults to `'unknown'`, so a date-only write ships the flagship use case
 * inert — and a test that only asserted "a row was written" would pass
 * vacuously against exactly that bug.
 */

const insertMock = vi.fn();
const selectMock = vi.fn();

vi.mock('../../../db', () => ({
  db: {
    insert: (...args: unknown[]) => insertMock(...args),
    select: (...args: unknown[]) => selectMock(...args),
  },
  runOutsideDbContext: <T,>(fn: () => T) => fn(),
  withSystemDbAccessContext: <T,>(fn: () => T) => fn(),
}));

vi.mock('../../../db/schema', () => ({
  deviceWarranty: {
    deviceId: 'deviceWarranty.deviceId',
    dataSource: 'deviceWarranty.dataSource',
  },
  deviceHardware: {
    deviceId: 'deviceHardware.deviceId',
    serialNumber: 'deviceHardware.serialNumber',
    manufacturer: 'deviceHardware.manufacturer',
    model: 'deviceHardware.model',
  },
  devices: {
    id: 'devices.id',
    orgId: 'devices.orgId',
    isEphemeral: 'devices.isEphemeral',
    isVirtual: 'devices.isVirtual',
  },
}));

// warrantySync pulls these in at module load; the real `computeWarrantyStatus`
// is deliberately NOT mocked — it is the function under test's whole point.
vi.mock('../../warrantyProviders', () => ({
  getProviderForManufacturer: vi.fn(),
  normalizeManufacturer: (m: string) => m.trim().toLowerCase(),
}));
vi.mock('../../warrantyAlertEvaluator', () => ({
  evaluateWarrantyAlerts: vi.fn().mockResolvedValue(null),
}));

import { applyWarrantyImport, coerceWarrantyValue } from './warrantyTarget';

const DEVICE = '44444444-4444-4444-8444-444444444444';
const ORG = '11111111-1111-4111-8111-111111111111';

function inDays(days: number): string {
  return new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);
}

interface ExistingWarranty {
  dataSource: string | null;
  warrantyStartDate: string | null;
  warrantyEndDate: string | null;
  manufacturer: string | null;
  status: string;
}

/** Rigs `tx.select(...).from(...).where(...).limit(1)` to return `existing`. */
function rigExisting(existing: ExistingWarranty | null) {
  const limit = vi.fn().mockResolvedValue(existing ? [existing] : []);
  const where = vi.fn().mockReturnValue({ limit });
  const from = vi.fn().mockReturnValue({ where });
  selectMock.mockReturnValue({ from });
}

/** Captures `tx.insert(...).values(v).onConflictDoUpdate(c).returning()`. */
function captureUpsert(returned: unknown[] = [{ id: 'w-1' }]) {
  const returning = vi.fn().mockResolvedValue(returned);
  const onConflictDoUpdate = vi.fn().mockReturnValue({ returning });
  const values = vi.fn().mockReturnValue({ onConflictDoUpdate });
  insertMock.mockReturnValue({ values });
  return { values, onConflictDoUpdate, returning };
}

// The executor the service receives is the nested-transaction handle. Here it
// is the same pair of spies, which is what lets these tests assert the exact
// column payload without a database.
const tx = {
  select: (...args: unknown[]) => selectMock(...args),
  insert: (...args: unknown[]) => insertMock(...args),
} as never;

beforeEach(() => {
  vi.clearAllMocks();
});

describe('applyWarrantyImport', () => {
  it('writes a COMPUTED status alongside the imported end date, sourced as import', async () => {
    rigExisting(null);
    const upsert = captureUpsert();

    const outcome = await applyWarrantyImport(
      tx,
      { deviceId: DEVICE, orgId: ORG, warrantyEndDate: inDays(30) },
      { overrideProvider: false },
    );

    expect(outcome).toBe('applied');
    expect(upsert.values).toHaveBeenCalledTimes(1);
    expect(upsert.values.mock.calls[0]![0]).toMatchObject({
      deviceId: DEVICE,
      orgId: ORG,
      status: 'expiring',
      warrantyEndDate: inDays(30),
      dataSource: 'import',
    });
  });

  it('computes expired and active from the same end date column', async () => {
    rigExisting(null);
    const past = captureUpsert();
    await applyWarrantyImport(tx, { deviceId: DEVICE, orgId: ORG, warrantyEndDate: inDays(-5) }, { overrideProvider: false });
    expect(past.values.mock.calls[0]![0]).toMatchObject({ status: 'expired' });

    rigExisting(null);
    const future = captureUpsert();
    await applyWarrantyImport(tx, { deviceId: DEVICE, orgId: ORG, warrantyEndDate: inDays(400) }, { overrideProvider: false });
    expect(future.values.mock.calls[0]![0]).toMatchObject({ status: 'active' });
  });

  it('NEVER sets is_subscription — an import cannot know it, and true suppresses expiry alerts', async () => {
    rigExisting(null);
    const upsert = captureUpsert();

    await applyWarrantyImport(tx, { deviceId: DEVICE, orgId: ORG, warrantyEndDate: inDays(30) }, { overrideProvider: false });

    expect(upsert.values.mock.calls[0]![0]).not.toHaveProperty('isSubscription');
    expect(upsert.onConflictDoUpdate.mock.calls[0]![0].set).not.toHaveProperty('isSubscription');
  });

  it('refuses to clobber a provider-sourced row without an explicit opt-in, and writes nothing', async () => {
    rigExisting({
      dataSource: 'provider',
      warrantyStartDate: null,
      warrantyEndDate: inDays(400),
      manufacturer: 'dell',
      status: 'active',
    });
    const upsert = captureUpsert();

    const outcome = await applyWarrantyImport(
      tx,
      { deviceId: DEVICE, orgId: ORG, warrantyEndDate: inDays(30) },
      { overrideProvider: false },
    );

    expect(outcome).toBe('skipped-provider-owned');
    expect(upsert.values).not.toHaveBeenCalled();
  });

  it('overrides a provider row when the operator opted in', async () => {
    rigExisting({
      dataSource: 'provider',
      warrantyStartDate: null,
      warrantyEndDate: inDays(400),
      manufacturer: 'dell',
      status: 'active',
    });
    const upsert = captureUpsert();

    const outcome = await applyWarrantyImport(
      tx,
      { deviceId: DEVICE, orgId: ORG, warrantyEndDate: inDays(30) },
      { overrideProvider: true },
    );

    expect(outcome).toBe('applied');
    expect(upsert.values.mock.calls[0]![0]).toMatchObject({ status: 'expiring', dataSource: 'import' });
  });

  it('keeps the provider guard on the WRITE too, so a row that turns provider-owned mid-transaction is still refused', async () => {
    // The read above is advisory; the setWhere is the authority. A statement
    // that the guard blocks returns no row, and that must not read as applied.
    rigExisting(null);
    const upsert = captureUpsert([]);

    const outcome = await applyWarrantyImport(
      tx,
      { deviceId: DEVICE, orgId: ORG, warrantyEndDate: inDays(30) },
      { overrideProvider: false },
    );

    expect(outcome).toBe('skipped-provider-owned');
    expect(upsert.onConflictDoUpdate.mock.calls[0]![0].setWhere).toBeDefined();
  });

  it('drops the guard from the statement when the operator opted in', async () => {
    rigExisting(null);
    const upsert = captureUpsert();

    await applyWarrantyImport(tx, { deviceId: DEVICE, orgId: ORG, warrantyEndDate: inDays(30) }, { overrideProvider: true });

    expect(upsert.onConflictDoUpdate.mock.calls[0]![0].setWhere).toBeUndefined();
  });

  it('reports an identical re-import as skipped-already-set and issues no write', async () => {
    const end = inDays(30);
    rigExisting({
      dataSource: 'import',
      warrantyStartDate: null,
      warrantyEndDate: end,
      manufacturer: null,
      status: 'expiring',
    });
    const upsert = captureUpsert();

    const outcome = await applyWarrantyImport(tx, { deviceId: DEVICE, orgId: ORG, warrantyEndDate: end }, { overrideProvider: false });

    expect(outcome).toBe('skipped-already-set');
    expect(upsert.values).not.toHaveBeenCalled();
  });

  it('recomputes status from the MERGED end date when only the manufacturer is imported', async () => {
    // A file that maps only a manufacturer column must not blank the stored
    // dates, and must not leave a status that contradicts them.
    rigExisting({
      dataSource: 'import',
      warrantyStartDate: null,
      warrantyEndDate: inDays(10),
      manufacturer: null,
      status: 'unknown',
    });
    const upsert = captureUpsert();

    const outcome = await applyWarrantyImport(tx, { deviceId: DEVICE, orgId: ORG, manufacturer: 'Dell  ' }, { overrideProvider: false });

    expect(outcome).toBe('applied');
    expect(upsert.values.mock.calls[0]![0]).toMatchObject({
      manufacturer: 'dell',
      warrantyEndDate: inDays(10),
      status: 'expiring',
    });
  });

  it('does nothing at all when the row carries no warranty columns', async () => {
    rigExisting(null);
    const upsert = captureUpsert();

    const outcome = await applyWarrantyImport(tx, { deviceId: DEVICE, orgId: ORG }, { overrideProvider: false });

    expect(outcome).toBe('none');
    expect(selectMock).not.toHaveBeenCalled();
    expect(upsert.values).not.toHaveBeenCalled();
  });

  it('clears a date when the file explicitly maps an empty cell, and recomputes status to unknown', async () => {
    rigExisting({
      dataSource: 'import',
      warrantyStartDate: null,
      warrantyEndDate: inDays(30),
      manufacturer: null,
      status: 'expiring',
    });
    const upsert = captureUpsert();

    const outcome = await applyWarrantyImport(tx, { deviceId: DEVICE, orgId: ORG, warrantyEndDate: null }, { overrideProvider: false });

    expect(outcome).toBe('applied');
    expect(upsert.values.mock.calls[0]![0]).toMatchObject({ warrantyEndDate: null, status: 'unknown' });
  });
});

describe('coerceWarrantyValue', () => {
  it('normalises a date cell to a plain calendar date', () => {
    expect(coerceWarrantyValue('warrantyEndDate', '2027-03-04T00:00:00Z')).toEqual({ ok: true, value: '2027-03-04' });
    expect(coerceWarrantyValue('warrantyStartDate', '2027-03-04')).toEqual({ ok: true, value: '2027-03-04' });
  });

  it('rejects an unparseable date with invalid_date', () => {
    expect(coerceWarrantyValue('warrantyEndDate', 'not a date')).toEqual({ ok: false, reason: 'invalid_date' });
    expect(coerceWarrantyValue('warrantyEndDate', 42)).toEqual({ ok: false, reason: 'invalid_date' });
  });

  it('treats an empty cell as an explicit clear, not an error', () => {
    expect(coerceWarrantyValue('warrantyEndDate', '')).toEqual({ ok: true, value: null });
    expect(coerceWarrantyValue('manufacturer', null)).toEqual({ ok: true, value: null });
  });

  it('accepts a manufacturer string and rejects a non-scalar', () => {
    expect(coerceWarrantyValue('manufacturer', 'Dell')).toEqual({ ok: true, value: 'Dell' });
    expect(coerceWarrantyValue('manufacturer', { a: 1 })).toEqual({ ok: false, reason: 'invalid_type' });
  });

  it('rejects a manufacturer longer than the column', () => {
    expect(coerceWarrantyValue('manufacturer', 'x'.repeat(101))).toEqual({ ok: false, reason: 'too_long' });
  });
});
