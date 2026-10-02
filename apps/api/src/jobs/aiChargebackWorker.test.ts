import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  orgIds: [] as string[],
  run: vi.fn(),
}));
vi.mock('../db', () => ({
  db: { execute: vi.fn(async () => h.orgIds.map((org_id) => ({ org_id }))) },
  runOutsideDbContext: (fn: () => unknown) => fn(),
  withSystemDbAccessContext: (fn: () => unknown) => fn(),
}));
vi.mock('../services/aiChargeback/chargeRun', () => ({ runOrgChargePeriod: h.run }));
vi.mock('../services/sentry', () => ({ captureException: vi.fn() }));
vi.mock('../services/redis', () => ({ getBullMQConnection: vi.fn() }));

import { runChargebackSweep } from './aiChargebackWorker';

beforeEach(() => { h.orgIds = []; h.run.mockReset(); });

describe('runChargebackSweep (#7608)', () => {
  it('closes the most recent closed UTC month for every candidate org', async () => {
    h.orgIds = ['o1', 'o2'];
    h.run.mockResolvedValue({ kind: 'charged' });
    const out = await runChargebackSweep(new Date('2026-12-01T05:28:00Z'));
    expect(out).toEqual({ periodStart: '2026-11-01', charged: 2, skipped: 0, failed: 0 });
    expect(h.run).toHaveBeenCalledWith({ orgId: 'o1', periodStart: '2026-11-01', now: new Date('2026-12-01T05:28:00Z') });
    expect(h.run).toHaveBeenCalledWith({ orgId: 'o2', periodStart: '2026-11-01', now: new Date('2026-12-01T05:28:00Z') });
  });
  it('inside the close grace on the 1st, closes the month before last (never an open month)', async () => {
    h.orgIds = ['o1'];
    h.run.mockResolvedValue({ kind: 'charged' });
    const out = await runChargebackSweep(new Date('2026-12-01T00:30:00Z'));
    expect(out.periodStart).toBe('2026-10-01');
    expect(h.run).toHaveBeenCalledWith(expect.objectContaining({ periodStart: '2026-10-01' }));
  });
  it('one failing org never aborts the rest', async () => {
    h.orgIds = ['bad', 'good'];
    h.run.mockRejectedValueOnce(new Error('boom')).mockResolvedValueOnce({ kind: 'charged' });
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect(await runChargebackSweep(new Date('2026-12-02T00:00:00Z'))).toMatchObject({ charged: 1, failed: 1 });
      expect(h.run).toHaveBeenCalledTimes(2);
    } finally {
      error.mockRestore();
    }
  });
  it('counts skips', async () => {
    h.orgIds = ['o1'];
    h.run.mockResolvedValue({ kind: 'skipped', reason: 'already_run' });
    expect(await runChargebackSweep(new Date('2026-12-02T00:00:00Z'))).toMatchObject({ charged: 0, skipped: 1 });
  });
  it('no candidate orgs: closes nothing', async () => {
    expect(await runChargebackSweep(new Date('2026-12-02T00:00:00Z')))
      .toEqual({ periodStart: '2026-11-01', charged: 0, skipped: 0, failed: 0 });
    expect(h.run).not.toHaveBeenCalled();
  });
});
