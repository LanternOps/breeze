import { beforeEach, describe, expect, it, vi } from 'vitest';

const repo = vi.hoisted(() => ({
  findCalendar: vi.fn(),
  currentRevisions: vi.fn(),
  listApplyCandidates: vi.fn(),
  lockApplyBatch: vi.fn(),
  applyTicketRevision: vi.fn(),
}));
const { audit, loadCalendars } = vi.hoisted(() => ({ audit: vi.fn(), loadCalendars: vi.fn() }));

vi.mock('./repository', () => repo);
vi.mock('../auditEvents', () => ({ writeAuditEvent: audit, requestLikeFromSnapshot: () => ({}) }));
vi.mock('../ticketSlaDeadlines', async () => {
  const actual = await vi.importActual<typeof import('../ticketSlaDeadlines')>('../ticketSlaDeadlines');
  return { ...actual, loadTicketCalendars: loadCalendars };
});
vi.mock('../../db', () => ({ db: {} }));
vi.mock('../../jobs/businessCalendarRecomputeWorker', () => ({ enqueueBusinessCalendarRecompute: vi.fn() }));

import { applyRevision, previewApplyRevision } from './applyRevision';
import { BusinessCalendarError, type CalendarAuth } from './service';
import { PartnerWideWriteDeniedError } from '../partnerWideAccess';

const P = 'p-1';
const CAL = 'cal-1';
const auth = (over: Partial<CalendarAuth> = {}) => ({
  scope: 'partner', partnerId: P, orgId: null, partnerOrgAccess: 'all', accessibleOrgIds: null,
  canAccessOrg: () => true, user: { id: 'u-1', email: 'u@example.com' }, ...over,
}) as CalendarAuth;

const now = new Date('2030-06-04T14:00:00Z'); // Tue 10:00 New York
const created = new Date('2030-06-03T13:00:00Z'); // Mon 09:00 New York
const NY = {
  revision: { timezone: 'America/New_York', intervals: [1, 2, 3, 4, 5].map((weekday) => ({ weekday: weekday as 1, startMinute: 540, endMinute: 1020 })) },
  holidays: [] as string[],
};

function ticket(id: string, over: Record<string, unknown> = {}) {
  return {
    id, status: 'open', createdAt: created, slaCalendarRevisionId: 'rev-1',
    responseSlaMinutes: 60, resolutionSlaMinutes: 2400,
    slaPausedAt: null, slaPausedBusinessMinutes: 0,
    firstResponseAt: null, resolvedAt: null, slaBreachReason: null,
    responseDueAt: created, responseWarnAt: created, resolutionDueAt: created, resolutionWarnAt: created,
    slaPausedMinutes: 0, revisionCalendarId: CAL, revisionNumber: 1,
    ...over,
  };
}

// The fixture: two open never-paused tickets (one would breach immediately on
// the new hours: its response target of 60 business minutes ended Mon 10:00),
// one paused now, one with pause history, one answered (response frozen).
const fixtureRows = [
  ticket('t-1'), // response due Mon 10:00 < now → immediately breached
  ticket('t-2', { responseSlaMinutes: 1440 }), // due Wed 15:00 → on track
  ticket('t-3', { slaPausedAt: new Date('2030-06-04T13:00:00Z') }),
  ticket('t-4', { slaPausedBusinessMinutes: 30 }),
  ticket('t-5', { firstResponseAt: new Date('2030-06-03T13:10:00Z'), responseSlaMinutes: 60 }),
  // Paused only outside business hours: 0 business minutes but wall-clock
  // pause history, which other hours WOULD count — not exact, so skipped.
  ticket('t-6', { slaPausedMinutes: 3600 }),
];

beforeEach(() => {
  vi.clearAllMocks();
  repo.findCalendar.mockResolvedValue({ id: CAL, orgId: null, partnerId: P, isPartnerDefault: true, archivedAt: null });
  repo.currentRevisions.mockResolvedValue(new Map([[CAL, { revision: { id: 'rev-2', revision: 2, timezone: 'America/New_York' }, intervals: [] }]]));
  repo.listApplyCandidates.mockImplementation(async (_cal: string, _rev: unknown, afterId: string | null) =>
    afterId === null ? fixtureRows : []);
  loadCalendars.mockResolvedValue(new Map([['rev-2', NY]]));
});

describe('previewApplyRevision (D12)', () => {
  it('counts eligible, immediately-breached and skipped-paused tickets for the current revision', async () => {
    expect(await previewApplyRevision(auth(), CAL, now)).toEqual({
      revisionId: 'rev-2',
      eligibleCount: 3, // t-1, t-2, t-5 (never paused)
      immediatelyBreachedCount: 1, // t-1; t-5's response arm is frozen
      skippedPausedCount: 3, // t-3 paused now, t-4 business pause history, t-6 wall-clock pause history
    });
    expect(repo.listApplyCandidates).toHaveBeenCalledWith(CAL, { id: 'rev-2', revision: 2 }, null, 500);
  });

  it('a partner-wide calendar needs the partner-wide capability', async () => {
    await expect(previewApplyRevision(auth({ partnerOrgAccess: 'selected' }), CAL, now)).rejects.toBeInstanceOf(PartnerWideWriteDeniedError);
  });
});

describe('applyRevision (D12)', () => {
  const run = <T>(fn: () => Promise<T>) => fn();

  beforeEach(() => {
    // Locking returns only the unpaused rows it was asked for.
    repo.lockApplyBatch.mockImplementation(async (_cal: string, _rev: unknown, ids: string[]) =>
      fixtureRows.filter((r) => ids.includes(r.id)));
    repo.applyTicketRevision.mockResolvedValue(undefined);
  });

  it('moves only never-paused open tickets to the current revision, recomputing unfrozen arms, and audits', async () => {
    const res = await applyRevision(auth(), CAL, { expectedRevisionId: 'rev-2' }, { run, now });
    expect(res).toEqual({ updated: 3, skippedLocked: 0 });
    // Only the eligible ids are ever locked.
    expect(repo.lockApplyBatch.mock.calls[0]![2]).toEqual(['t-1', 't-2', 't-5']);
    const writes = new Map(repo.applyTicketRevision.mock.calls.map((c) => [c[0], c[1]]));
    expect([...writes.keys()].sort()).toEqual(['t-1', 't-2', 't-5']);
    for (const patch of writes.values()) expect(patch.slaCalendarRevisionId).toBe('rev-2');
    // Frozen response arm untouched.
    expect(writes.get('t-5')).not.toHaveProperty('responseDueAt');
    expect(writes.get('t-5')).toHaveProperty('resolutionDueAt');
    // Recomputed on the new hours: Mon 09:00 + 60 → Mon 10:00 NY.
    expect(writes.get('t-1')!.responseDueAt).toEqual(new Date('2030-06-03T14:00:00Z'));
    expect(audit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      action: 'business_calendar.apply_revision',
      resourceType: 'business_calendar',
      resourceId: CAL,
      partnerId: P,
      details: expect.objectContaining({ revisionId: 'rev-2', updated: 3, skippedPausedCount: 3, skippedLocked: 0 }),
    }));
  });

  it('re-checks under the row lock: a ticket moved to another calendar or already on the target is left alone', async () => {
    repo.lockApplyBatch.mockImplementation(async (_cal: string, _rev: unknown, ids: string[]) =>
      fixtureRows.filter((r) => ids.includes(r.id)).map((r) =>
        r.id === 't-1' ? { ...r, slaCalendarRevisionId: 'rev-other', revisionCalendarId: 'cal-other', revisionNumber: 1 }
          : r.id === 't-2' ? { ...r, slaCalendarRevisionId: 'rev-3', revisionNumber: 3 }
          : r));
    const res = await applyRevision(auth(), CAL, { expectedRevisionId: 'rev-2' }, { run, now });
    expect(res.updated).toBe(1);
    expect(repo.applyTicketRevision.mock.calls.map((c) => c[0])).toEqual(['t-5']);
  });

  it('a stale expected revision is 409 REVISION_CHANGED and writes nothing', async () => {
    const err = await applyRevision(auth(), CAL, { expectedRevisionId: 'rev-1' }, { run, now }).catch((e) => e);
    expect(err).toBeInstanceOf(BusinessCalendarError);
    expect(err).toMatchObject({ status: 409, code: 'REVISION_CHANGED' });
    expect(repo.lockApplyBatch).not.toHaveBeenCalled();
    expect(repo.applyTicketRevision).not.toHaveBeenCalled();
    expect(audit).not.toHaveBeenCalled();
  });

  it('rows a concurrent writer holds are retried, then reported as skipped', async () => {
    repo.lockApplyBatch.mockImplementation(async (_cal: string, _rev: unknown, ids: string[]) =>
      fixtureRows.filter((r) => ids.includes(r.id) && r.id !== 't-2'));
    const res = await applyRevision(auth(), CAL, { expectedRevisionId: 'rev-2' }, { run, now, sleep: async () => {} });
    expect(res).toEqual({ updated: 2, skippedLocked: 1 });
    expect(repo.lockApplyBatch.mock.calls.length).toBeGreaterThan(1);
    expect(repo.lockApplyBatch.mock.calls.at(-1)![2]).toEqual(['t-2']);
  });

  it('a selected-access partner user is refused', async () => {
    await expect(applyRevision(auth({ partnerOrgAccess: 'selected' }), CAL, { expectedRevisionId: 'rev-2' }, { run, now }))
      .rejects.toBeInstanceOf(PartnerWideWriteDeniedError);
  });
});
