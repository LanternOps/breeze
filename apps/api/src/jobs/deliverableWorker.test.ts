import { describe, it, expect, vi, beforeEach } from 'vitest';

const { captureExceptionMock } = vi.hoisted(() => ({ captureExceptionMock: vi.fn() }));
vi.mock('../services/sentry', () => ({ captureException: captureExceptionMock }));
vi.mock('../services/redis', () => ({ getBullMQConnection: () => ({}) }));
vi.mock('bullmq', () => ({ Queue: class {}, Worker: class {}, Job: class {} }));
vi.mock('./workerObservability', () => ({ attachWorkerObservability: vi.fn() }));

const { resultQueue, capturedWhere, contextLabels } = vi.hoisted(() => ({
  resultQueue: [] as unknown[][], capturedWhere: [] as unknown[], contextLabels: [] as Array<string | undefined>,
}));
vi.mock('../db', () => {
  const chain: Record<string, unknown> = {};
  for (const m of ['select', 'from', 'orderBy', 'limit', 'innerJoin', 'update', 'set', 'insert', 'values', 'returning']) chain[m] = vi.fn(() => chain);
  chain.where = vi.fn((w: unknown) => { capturedWhere.push(w); return chain; });
  (chain as { then: unknown }).then = (r: (v: unknown) => unknown) => Promise.resolve(resultQueue.shift() ?? []).then(r);
  return {
    db: chain,
    runOutsideDbContext: (fn: () => unknown) => fn(),
    withSystemDbAccessContext: (fn: () => unknown, label?: string) => { contextLabels.push(label); return fn(); },
  };
});

const { materializeMock, openMock, missMock, autoEvidenceMock, keyDateMock, cancelMock } = vi.hoisted(() => ({
  materializeMock: vi.fn(async (): Promise<unknown[]> => []), openMock: vi.fn(async () => 0),
  missMock: vi.fn(async () => 0), autoEvidenceMock: vi.fn(async () => 0), keyDateMock: vi.fn(async () => 0),
  cancelMock: vi.fn(async () => 0),
}));
vi.mock('../services/serviceDeliverableService', () => ({
  materializeOccurrences: materializeMock,
  openDueOccurrencesForDeliverable: openMock,
  markDueOccurrencesMissedForDeliverable: missMock,
  applyContractCancelledToDeliverables: cancelMock,
}));
vi.mock('../services/deliverableAutoEvidence', () => ({ generateAutoEvidenceForDeliverable: autoEvidenceMock }));
vi.mock('../services/orgKeyDateService', () => ({ sweepKeyDateReminders: keyDateMock }));

import { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { runDeliverableSweep, handleContractEvent } from './deliverableWorker';

const D = { id: 'd1', orgId: 'org1', name: 'Sign-in log review', cadence: 'monthly' as const,
  anchorDueDate: '2026-10-31', effectiveFrom: '2026-10-01', effectiveUntil: null,
  leadDays: 7, graceDays: 14, autoEvidenceReportId: null };
const AS_OF = new Date('2026-10-25T05:18:00Z');

describe('runDeliverableSweep', () => {
  beforeEach(() => { vi.clearAllMocks(); resultQueue.length = 0; capturedWhere.length = 0; contextLabels.length = 0; });

  it('filters the eligible select on active, the effective window (today, UTC) and automation-eligible orgs', async () => {
    resultQueue.push([]);
    await runDeliverableSweep(AS_OF);
    const q = new PgDialect().sqlToQuery(capturedWhere[0] as SQL);
    expect(q.sql).toContain('automation_eligible_org');
    expect(q.sql).toContain('"effective_from" <=');
    expect(q.sql).toContain('"effective_until" is null');
    expect(q.params).toContain('2026-10-25');
    expect(q.params).toContain(true);
  });

  it('runs every step for each deliverable and totals the counts', async () => {
    resultQueue.push([D]);
    materializeMock.mockResolvedValueOnce([{ id: 'o1' }, { id: 'o2' }]);
    openMock.mockResolvedValueOnce(2); missMock.mockResolvedValueOnce(1); keyDateMock.mockResolvedValueOnce(3);
    expect(await runDeliverableSweep(AS_OF)).toEqual({ deliverables: 1, materialized: 2, opened: 2, missed: 1, autoEvidence: 0, keyDateReminders: 3, failed: 0 });
    expect(materializeMock).toHaveBeenCalledWith('d1', '2026-10-25');
    expect(openMock).toHaveBeenCalledWith(D, '2026-10-25', expect.any(Set));
    expect(missMock).toHaveBeenCalledWith(D, '2026-10-25');
    expect(autoEvidenceMock).not.toHaveBeenCalled();   // autoEvidenceReportId is null
  });

  it('opens every system context with a label (a bare index frame is unattributable)', async () => {
    resultQueue.push([D]);
    await runDeliverableSweep(AS_OF);
    expect(contextLabels.length).toBeGreaterThanOrEqual(3);
    for (const l of contextLabels) expect(l).toMatch(/^deliverableSweep\./);
  });

  it('runs auto-evidence only when a report is configured', async () => {
    resultQueue.push([{ ...D, autoEvidenceReportId: 'r1' }]);
    autoEvidenceMock.mockResolvedValueOnce(1);
    const res = await runDeliverableSweep(AS_OF);
    expect(autoEvidenceMock).toHaveBeenCalledWith({ ...D, autoEvidenceReportId: 'r1' }, '2026-10-25');
    expect(res.autoEvidence).toBe(1);
  });

  it('one failing deliverable does not abort the sweep', async () => {
    resultQueue.push([D, { ...D, id: 'd2' }]);
    materializeMock.mockRejectedValueOnce(new Error('boom'));
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const res = await runDeliverableSweep(AS_OF);
      expect(res.failed).toBe(1);
      expect(res.deliverables).toBe(2);
      expect(materializeMock).toHaveBeenCalledTimes(2);
      expect(captureExceptionMock).toHaveBeenCalledTimes(1);
      expect(err).toHaveBeenCalledWith(expect.stringContaining('[DeliverableWorker]'), 'deliverableId=d1', 'orgId=org1', 'boom');
    } finally { err.mockRestore(); }
  });

  it('still sweeps key dates when no deliverable is eligible', async () => {
    resultQueue.push([]); keyDateMock.mockResolvedValueOnce(2);
    expect((await runDeliverableSweep(AS_OF)).keyDateReminders).toBe(2);
    expect(keyDateMock).toHaveBeenCalledWith('2026-10-25');
  });

  it('a failing key-date sweep is counted, not thrown', async () => {
    resultQueue.push([]); keyDateMock.mockRejectedValueOnce(new Error('kd'));
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect((await runDeliverableSweep(AS_OF)).failed).toBe(1);
      expect(captureExceptionMock).toHaveBeenCalledTimes(1);
    } finally { err.mockRestore(); }
  });
});

describe('handleContractEvent (contract-events consumer, spec §5.4)', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('applies contract.cancelled to the deliverables of that contract, dated today (UTC)', async () => {
    await handleContractEvent({ type: 'contract.cancelled', contractId: 'c1', orgId: 'org1', partnerId: 'p1' }, AS_OF);
    expect(cancelMock).toHaveBeenCalledWith('c1', '2026-10-25');
  });

  it('ignores every other contract event type', async () => {
    for (const type of ['contract.activated', 'contract.invoiced', 'contract.paused', 'contract.expired', 'contract.auto_renewed', 'contract.renewal_notice'] as const) {
      await handleContractEvent({ type, contractId: 'c1', orgId: 'org1', partnerId: 'p1' }, AS_OF);
    }
    expect(cancelMock).not.toHaveBeenCalled();
  });

  it('drops a malformed cancel loudly instead of throwing into retries', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await handleContractEvent({ type: 'contract.cancelled' } as never, AS_OF);
      expect(cancelMock).not.toHaveBeenCalled();
      expect(err).toHaveBeenCalled();
    } finally { err.mockRestore(); }
  });
});
