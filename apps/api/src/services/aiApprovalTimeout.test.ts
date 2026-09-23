import { beforeEach, describe, expect, it, vi } from 'vitest';

const { dbSelect, withSystemDbAccessContext, runOutsideDbContext, captureException } = vi.hoisted(() => ({
  dbSelect: vi.fn(),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  runOutsideDbContext: vi.fn((fn: () => unknown) => fn()),
  captureException: vi.fn(),
}));

vi.mock('../db', () => ({
  getCurrentDbAccessContext: vi.fn(() => ({ scope: 'organization' })),
  runOutsideDbContext,
  db: { select: dbSelect },
  withSystemDbAccessContext,
}));

vi.mock('../db/schema', () => ({
  organizations: { id: 'organizations.id', partnerId: 'organizations.partnerId', settings: 'organizations.settings' },
  partners: { id: 'partners.id', settings: 'partners.settings' },
}));

vi.mock('drizzle-orm', () => ({ eq: vi.fn((l, r) => ({ eq: [l, r] })) }));
vi.mock('./sentry', () => ({ captureException }));

import { getAiApprovalTimeout, loadApprovalWaitBudgetMs } from './aiApprovalTimeout';

function selectReturning(rows: unknown[]) {
  return {
    from: vi.fn(() => ({ where: vi.fn(() => ({ limit: vi.fn().mockResolvedValue(rows) })) })),
  } as any;
}

function mockRows(orgSettings: unknown, partnerSettings: unknown) {
  dbSelect.mockReturnValueOnce(selectReturning([{ settings: orgSettings, partnerId: 'p-1' }]));
  dbSelect.mockReturnValueOnce(selectReturning([{ settings: partnerSettings }]));
}

const minutes = (m: number) => ({ aiApprovals: { interactiveTimeoutMinutes: m } });

describe('getAiApprovalTimeout', () => {
  beforeEach(() => vi.clearAllMocks());

  it('org override wins over the partner default', async () => {
    mockRows(minutes(15), minutes(40));
    await expect(getAiApprovalTimeout('org-1')).resolves.toMatchObject({
      minutes: 15, source: 'org', inheritedMinutes: 40, inheritedSource: 'partner',
    });
  });

  it('reads the partner row through the partner-axis system escape (org-scoped caller)', async () => {
    mockRows({}, minutes(40));
    await expect(getAiApprovalTimeout('org-1')).resolves.toMatchObject({ minutes: 40, source: 'partner' });
    expect(runOutsideDbContext).toHaveBeenCalledTimes(1);
    expect(withSystemDbAccessContext).toHaveBeenCalledTimes(1);
  });

  it('warns (and falls through to the partner value) on an invalid stored org value', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    mockRows(minutes(1440), minutes(40));
    await expect(getAiApprovalTimeout('org-1')).resolves.toMatchObject({ minutes: 40, source: 'partner' });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('invalid organization'));
    warn.mockRestore();
  });

  it('returns null when the org is not visible', async () => {
    dbSelect.mockReturnValueOnce(selectReturning([]));
    await expect(getAiApprovalTimeout('org-x')).resolves.toBeNull();
    expect(dbSelect).toHaveBeenCalledTimes(1);
  });
});

describe('loadApprovalWaitBudgetMs', () => {
  beforeEach(() => vi.clearAllMocks());

  it('converts the resolved minutes to ms', async () => {
    mockRows(minutes(30), {});
    await expect(loadApprovalWaitBudgetMs('org-1')).resolves.toBe(30 * 60_000);
  });

  it('falls back to the 5-minute default when nothing is configured', async () => {
    mockRows({}, {});
    await expect(loadApprovalWaitBudgetMs('org-1')).resolves.toBe(300_000);
  });

  it('fails safe to the 5-minute default (and reports) when the lookup throws', async () => {
    dbSelect.mockImplementationOnce(() => { throw new Error('db down'); });
    await expect(loadApprovalWaitBudgetMs('org-1')).resolves.toBe(300_000);
    expect(captureException).toHaveBeenCalledTimes(1);
  });

  it('falls back to the default when the org is not visible', async () => {
    dbSelect.mockReturnValueOnce(selectReturning([]));
    await expect(loadApprovalWaitBudgetMs('org-x')).resolves.toBe(300_000);
  });
});
