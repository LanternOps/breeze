import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  orgIds: [] as string[],
  run: vi.fn(),
  captureException: vi.fn(),
  captureMessage: vi.fn(),
}));
vi.mock('../db', () => ({
  db: { execute: vi.fn(async () => h.orgIds.map((org_id) => ({ org_id }))) },
  runOutsideDbContext: (fn: () => unknown) => fn(),
  withSystemDbAccessContext: (fn: () => unknown) => fn(),
}));
vi.mock('../services/aiChargeback/chargeRun', () => ({ runOrgChargePeriod: h.run }));
vi.mock('../services/sentry', () => ({ captureException: h.captureException, captureMessage: h.captureMessage }));
vi.mock('../services/redis', () => ({ getBullMQConnection: vi.fn() }));

import { runChargebackSweep } from './aiChargebackWorker';

const charged = (expiredInvocationCount = 0) => ({
  kind: 'charged', runId: 'r', chargeCount: 1, invocationCount: 1,
  unpricedInvocationCount: 0, lateInvocationCount: 0, expiredInvocationCount,
});

let log: ReturnType<typeof vi.spyOn>;
let warn: ReturnType<typeof vi.spyOn>;
let error: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  h.orgIds = []; h.run.mockReset(); h.captureException.mockReset(); h.captureMessage.mockReset();
  log = vi.spyOn(console, 'log').mockImplementation(() => {});
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  error = vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => { log.mockRestore(); warn.mockRestore(); error.mockRestore(); });

describe('runChargebackSweep (#7608)', () => {
  it('closes the most recent closed UTC month for every candidate org', async () => {
    h.orgIds = ['o1', 'o2'];
    h.run.mockResolvedValue(charged());
    const out = await runChargebackSweep(new Date('2026-12-01T05:28:00Z'));
    expect(out).toEqual({ periodStart: '2026-11-01', charged: 2, skipped: 0, failed: 0, expired: 0 });
    expect(h.run).toHaveBeenCalledWith({ orgId: 'o1', periodStart: '2026-11-01', now: new Date('2026-12-01T05:28:00Z') });
    expect(h.run).toHaveBeenCalledWith({ orgId: 'o2', periodStart: '2026-11-01', now: new Date('2026-12-01T05:28:00Z') });
    expect(h.captureMessage).not.toHaveBeenCalled();
  });
  it('inside the close grace on the 1st, closes the month before last (never an open month)', async () => {
    h.orgIds = ['o1'];
    h.run.mockResolvedValue(charged());
    const out = await runChargebackSweep(new Date('2026-12-01T00:30:00Z'));
    expect(out.periodStart).toBe('2026-10-01');
    expect(h.run).toHaveBeenCalledWith(expect.objectContaining({ periodStart: '2026-10-01' }));
  });
  it('one failing org never aborts the rest', async () => {
    h.orgIds = ['bad', 'good'];
    h.run.mockRejectedValueOnce(new Error('boom')).mockResolvedValueOnce(charged());
    expect(await runChargebackSweep(new Date('2026-12-02T00:00:00Z'))).toMatchObject({ charged: 1, failed: 1 });
    expect(h.run).toHaveBeenCalledTimes(2);
  });
  it('reports each failed close to Sentry tagged with its org and billing period', async () => {
    h.orgIds = ['bad', 'good'];
    const boom = new Error('boom');
    h.run.mockRejectedValueOnce(boom).mockResolvedValueOnce(charged());
    await runChargebackSweep(new Date('2026-12-02T00:00:00Z'));
    expect(h.captureException).toHaveBeenCalledTimes(1);
    expect(h.captureException).toHaveBeenCalledWith(boom, undefined, { org_id: 'bad', ai_charge_period_start: '2026-11-01' });
  });
  it('any failed close also raises ONE error-level ai_chargeback_close_failed event for the sweep, with the counts', async () => {
    h.orgIds = ['bad1', 'bad2', 'good'];
    h.run.mockRejectedValueOnce(new Error('a')).mockRejectedValueOnce(new Error('b')).mockResolvedValueOnce(charged());
    await runChargebackSweep(new Date('2026-12-02T00:00:00Z'));
    const failedEvents = h.captureMessage.mock.calls.filter((c) => c[1]?.eventCode === 'ai_chargeback_close_failed');
    expect(failedEvents).toEqual([[
      expect.stringMatching(/2 of 3/),
      { eventCode: 'ai_chargeback_close_failed', level: 'error', tags: { ai_charge_period_start: '2026-11-01' } },
    ]]);
  });
  it('closes that only skip or charge raise no close_failed event', async () => {
    h.orgIds = ['o1', 'o2'];
    h.run.mockResolvedValueOnce(charged()).mockResolvedValueOnce({ kind: 'skipped', reason: 'already_run' });
    await runChargebackSweep(new Date('2026-12-02T00:00:00Z'));
    expect(h.captureMessage).not.toHaveBeenCalled();
  });
  it('usage that aged past the lookback unbilled is a warning event per org, tagged with org and period, and logged', async () => {
    h.orgIds = ['o1', 'o2'];
    h.run.mockResolvedValueOnce(charged(3)).mockResolvedValueOnce(charged(0));
    const out = await runChargebackSweep(new Date('2026-12-02T00:00:00Z'));
    expect(out).toMatchObject({ charged: 2, expired: 3 });
    expect(h.captureMessage).toHaveBeenCalledTimes(1);
    expect(h.captureMessage).toHaveBeenCalledWith(expect.any(String), {
      eventCode: 'ai_chargeback_usage_expired', level: 'warning', tags: { org_id: 'o1', ai_charge_period_start: '2026-11-01' },
    });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/\[AiChargeback\] org o1: 3 chargeable row\(s\) older than the 92-day lookback/));
  });
  it('the summary line carries charged, skipped, failed and expired', async () => {
    h.orgIds = ['o1', 'o2', 'o3'];
    h.run.mockResolvedValueOnce(charged(4)).mockResolvedValueOnce({ kind: 'skipped', reason: 'already_run' })
      .mockRejectedValueOnce(new Error('x'));
    expect(await runChargebackSweep(new Date('2026-12-02T00:00:00Z')))
      .toEqual({ periodStart: '2026-11-01', charged: 1, skipped: 1, failed: 1, expired: 4 });
    expect(log).toHaveBeenCalledWith('[AiChargeback] 2026-11-01: charged 1, skipped 1, failed 1, expired 4');
  });
  it('counts skips', async () => {
    h.orgIds = ['o1'];
    h.run.mockResolvedValue({ kind: 'skipped', reason: 'already_run' });
    expect(await runChargebackSweep(new Date('2026-12-02T00:00:00Z'))).toMatchObject({ charged: 0, skipped: 1 });
  });
  it('no candidate orgs: closes nothing', async () => {
    expect(await runChargebackSweep(new Date('2026-12-02T00:00:00Z')))
      .toEqual({ periodStart: '2026-11-01', charged: 0, skipped: 0, failed: 0, expired: 0 });
    expect(h.run).not.toHaveBeenCalled();
  });
});
