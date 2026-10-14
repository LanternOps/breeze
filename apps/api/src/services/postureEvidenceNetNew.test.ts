import { describe, it, expect, vi, beforeEach } from 'vitest';
vi.mock('../db', () => ({ db: { select: vi.fn() } }));
import { db } from '../db';
import { loadBackupsVerifiedEvidence, loadM365MfaEvidence } from './postureEvidenceNetNew';

function selectChain(rows: unknown) {
  const p: any = Promise.resolve(rows);
  for (const m of ['from', 'where', 'innerJoin', 'leftJoin', 'orderBy', 'groupBy', 'limit']) p[m] = () => p;
  return p;
}
const AS_OF = new Date('2026-10-13T12:00:00.000Z');
const ORG = '00000000-0000-0000-0000-000000000001';

describe('loadM365MfaEvidence', () => {
  beforeEach(() => vi.mocked(db.select).mockReset());
  it('reads the latest rollup: eligible=users_total, assessed=total-unknown, passing=registered, gate=admins_without_mfa===0', async () => {
    vi.mocked(db.select).mockReturnValueOnce(selectChain([{ usersTotal: 50, usersMfaRegistered: 45, usersMfaUnknown: 2, adminsWithoutMfa: 0, computedAt: new Date('2026-10-13T06:00:00.000Z') }]));
    expect(await loadM365MfaEvidence(ORG, AS_OF, 30)).toEqual({ eligible: 50, assessed: 48, passing: 45, aggregatePct: null, newestEvidenceAt: '2026-10-13T06:00:00.000Z', gate: true });
  });
  it('admins without MFA → gate false; stale rollup → not assessed', async () => {
    vi.mocked(db.select).mockReturnValueOnce(selectChain([{ usersTotal: 50, usersMfaRegistered: 50, usersMfaUnknown: 0, adminsWithoutMfa: 1, computedAt: new Date('2026-10-13T06:00:00.000Z') }]));
    expect((await loadM365MfaEvidence(ORG, AS_OF, 30)).gate).toBe(false);
    vi.mocked(db.select).mockReturnValueOnce(selectChain([{ usersTotal: 50, usersMfaRegistered: 50, usersMfaUnknown: 0, adminsWithoutMfa: 0, computedAt: new Date('2026-08-01T00:00:00.000Z') }]));
    expect(await loadM365MfaEvidence(ORG, AS_OF, 30)).toMatchObject({ eligible: 50, assessed: 0, passing: 0 });
  });
  it('no rollup → all zero', async () => {
    vi.mocked(db.select).mockReturnValueOnce(selectChain([]));
    expect(await loadM365MfaEvidence(ORG, AS_OF, 30)).toMatchObject({ eligible: 0, assessed: 0, passing: 0, gate: null });
  });
});

describe('loadBackupsVerifiedEvidence', () => {
  beforeEach(() => vi.mocked(db.select).mockReset());
  it('eligible = assessed = devices with a Breeze backup job; passing = passed verification inside the window (Ruling 22)', async () => {
    vi.mocked(db.select)
      .mockReturnValueOnce(selectChain([{ deviceId: 'd1' }, { deviceId: 'd2' }, { deviceId: 'd3' }]))
      .mockReturnValueOnce(selectChain([
        { deviceId: 'd1', status: 'passed', verificationType: 'test_restore', completedAt: new Date('2026-10-10T00:00:00.000Z') },
        { deviceId: 'd2', status: 'failed', verificationType: 'integrity', completedAt: new Date('2026-10-11T00:00:00.000Z') },
        { deviceId: 'd3', status: 'passed', verificationType: 'integrity', completedAt: new Date('2026-08-01T00:00:00.000Z') },
      ]));
    expect(await loadBackupsVerifiedEvidence(ORG, ['d1', 'd2', 'd3', 'd4'], AS_OF, 30))
      .toEqual({ eligible: 3, assessed: 3, passing: 1, aggregatePct: null, newestEvidenceAt: '2026-10-11T00:00:00.000Z' });
  });
  it('guards: failed+passed on one device passes; non-integrity/test_restore types and null completedAt are ignored', async () => {
    vi.mocked(db.select)
      .mockReturnValueOnce(selectChain([{ deviceId: 'd1' }, { deviceId: 'd2' }, { deviceId: 'd3' }]))
      .mockReturnValueOnce(selectChain([
        // (a) d1: passed, then a LATER failed row must not overwrite the pass -> passing
        { deviceId: 'd1', status: 'passed', verificationType: 'test_restore', completedAt: new Date('2026-10-05T00:00:00.000Z') },
        { deviceId: 'd1', status: 'failed', verificationType: 'integrity', completedAt: new Date('2026-10-08T00:00:00.000Z') },
        // (b) d2: passed but wrong type -> assessed (has a job), not passing
        { deviceId: 'd2', status: 'passed', verificationType: 'metadata', completedAt: new Date('2026-10-12T00:00:00.000Z') },
        // (c) d3: still running -> assessed, not passing
        { deviceId: 'd3', status: 'passed', verificationType: 'integrity', completedAt: null },
      ]));
    expect(await loadBackupsVerifiedEvidence(ORG, ['d1', 'd2', 'd3'], AS_OF, 30))
      .toEqual({ eligible: 3, assessed: 3, passing: 1, aggregatePct: null, newestEvidenceAt: '2026-10-08T00:00:00.000Z' });
  });
  it('a job with no verification at all is assessed and not passing (Not met, never Not assessed)', async () => {
    vi.mocked(db.select).mockReturnValueOnce(selectChain([{ deviceId: 'd1' }])).mockReturnValueOnce(selectChain([]));
    expect(await loadBackupsVerifiedEvidence(ORG, ['d1'], AS_OF, 30))
      .toEqual({ eligible: 1, assessed: 1, passing: 0, aggregatePct: null, newestEvidenceAt: null });
  });
  it('provider-only org (no Breeze jobs) → eligible 0 → not assessed upstream', async () => {
    vi.mocked(db.select).mockReturnValueOnce(selectChain([])).mockReturnValueOnce(selectChain([]));
    expect(await loadBackupsVerifiedEvidence(ORG, ['d1'], AS_OF, 30)).toMatchObject({ eligible: 0, assessed: 0, passing: 0 });
  });
  it('empty device list issues no query', async () => {
    expect(await loadBackupsVerifiedEvidence(ORG, [], AS_OF, 30)).toMatchObject({ eligible: 0 });
    expect(db.select).not.toHaveBeenCalled();
  });
});
