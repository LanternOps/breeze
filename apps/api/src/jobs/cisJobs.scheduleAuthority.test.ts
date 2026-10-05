import { beforeEach, describe, expect, it, vi } from 'vitest';

const { addMock, queueCommandMock, selectMock, updateMock, resolveAuthorityMock, setMock } = vi.hoisted(() => ({
  setMock: vi.fn(),
  addMock: vi.fn(),
  queueCommandMock: vi.fn(),
  selectMock: vi.fn(),
  updateMock: vi.fn(),
  resolveAuthorityMock: vi.fn(),
}));

vi.mock('bullmq', () => ({
  Queue: class {
    add = addMock;
    getJob = vi.fn();
    close = vi.fn();
  },
  Worker: class { close = vi.fn(); on = vi.fn(); },
  Job: class {},
}));

vi.mock('../db', () => ({
  db: { select: selectMock, update: updateMock },
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
}));

vi.mock('../db/schema', () => ({
  cisBaselines: {},
  cisRemediationActions: {},
  devices: {},
  organizations: {},
}));

vi.mock('../services/commandQueue', () => ({ queueCommand: queueCommandMock }));
vi.mock('../services/cisHardening', () => ({
  normalizeCisSchedule: vi.fn((s: any) => ({ enabled: true, intervalHours: 24, nextScanAt: null, ...(s ?? {}) })),
}));
vi.mock('../services/cisCatalog', () => ({ seedDefaultCisCheckCatalog: vi.fn() }));
vi.mock('../services/eventBus', () => ({ publishEvent: vi.fn() }));
vi.mock('../services/redis', () => ({
  getRedisConnection: vi.fn(() => ({})),
  getBullMQConnection: vi.fn(() => ({ host: 'localhost', port: 6379 })),
  isBullMQAvailable: vi.fn(() => true),
}));
vi.mock('../services/sentry', () => ({ captureException: vi.fn() }));
vi.mock('../services/cisBaselineScheduleAuthority', () => ({
  resolveCisScheduleDispatch: resolveAuthorityMock,
}));

import { __testOnly } from './cisJobs';

function chain(rows: unknown): any {
  const result: any = Promise.resolve(rows);
  for (const method of ['from', 'innerJoin', 'leftJoin', 'where', 'limit', 'orderBy', 'for', 'returning', 'set']) {
    result[method] = () => result;
  }
  return result;
}

const LEGACY = {
  id: 'baseline-legacy',
  orgId: 'org-1',
  partnerId: null,
  osType: 'windows',
  benchmarkVersion: '3.0.0',
  level: 'l1',
  customExclusions: [],
  scanSchedule: { enabled: true, intervalHours: 24, nextScanAt: null },
  isActive: true,
  executionAuthorityGeneration: null,
};
const APPROVED = { ...LEGACY, id: 'baseline-approved', executionAuthorityGeneration: 'gen-1' };
const GRANDFATHERED = { ...LEGACY, id: 'baseline-grandfathered', executionAuthorityLegacy: 'grandfathered', createdBy: 'creator-1' };
const CREATOR_AUTHORITY = { kind: 'organization_unrestricted', siteIds: null, userId: 'creator-1', principalKind: 'user', fingerprint: 'x', generation: '00000000-0000-0000-0000-000000000000' };
const AUTHORITY = {
  kind: 'organization_unrestricted',
  siteIds: null,
  userId: 'approver-1',
  principalKind: 'user',
  fingerprint: 'f'.repeat(64),
  generation: 'gen-1',
};

describe('CIS scheduled scans require a valid stored authority', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    addMock.mockResolvedValue({ id: 'job-1' });
    queueCommandMock.mockResolvedValue({ id: 'cmd-1' });
    setMock.mockImplementation(() => chain(undefined));
    updateMock.mockReturnValue({ set: setMock });
    resolveAuthorityMock.mockImplementation(async (row: { executionAuthorityGeneration: string | null; executionAuthorityLegacy?: string }) => {
      if (row.executionAuthorityGeneration === 'gen-1') return { ok: true, mode: 'stamped', authority: AUTHORITY, checkStatus: 'ok' };
      if (row.executionAuthorityLegacy === 'grandfathered') return { ok: true, mode: 'legacy', authority: CREATOR_AUTHORITY, checkStatus: 'ok' };
      return { ok: false, reason: 'reapproval_required' };
    });
  });

  it('does not enqueue a due legacy baseline that carries no authority stamp', async () => {
    selectMock.mockReturnValueOnce(chain([LEGACY, APPROVED]));

    const result = await __testOnly.processScheduleScans();

    expect(result.enqueued).toBe(1);
    expect(addMock).toHaveBeenCalledTimes(1);
    expect(addMock).toHaveBeenCalledWith(
      'run-baseline-scan',
      expect.objectContaining({ baselineId: APPROVED.id, origin: 'scheduled', authorityGeneration: 'gen-1' }),
      expect.anything(),
    );
    expect(result.reapprovalRequired).toBe(1);
  });

  it('a scheduled run job without an authority generation queues nothing', async () => {
    selectMock.mockReturnValueOnce(chain([APPROVED]));

    const result = await __testOnly.processRunBaselineScan({
      type: 'run-baseline-scan',
      baselineId: APPROVED.id,
      origin: 'scheduled',
    });

    expect(result.commandsQueued).toBe(0);
    expect(queueCommandMock).not.toHaveBeenCalled();
  });

  it('a scheduled run job whose generation no longer matches the baseline queues nothing', async () => {
    selectMock.mockReturnValueOnce(chain([APPROVED]));

    const result = await __testOnly.processRunBaselineScan({
      type: 'run-baseline-scan',
      baselineId: APPROVED.id,
      origin: 'scheduled',
      authorityGeneration: 'gen-0',
    });

    expect(result.commandsQueued).toBe(0);
    expect(queueCommandMock).not.toHaveBeenCalled();
  });

  it('a scheduled run whose approver no longer resolves queues nothing', async () => {
    selectMock.mockReturnValueOnce(chain([APPROVED]));
    resolveAuthorityMock.mockResolvedValueOnce({ ok: false, reason: 'reapproval_required' });

    const result = await __testOnly.processRunBaselineScan({
      type: 'run-baseline-scan',
      baselineId: APPROVED.id,
      origin: 'scheduled',
      authorityGeneration: 'gen-1',
    });

    expect(result.commandsQueued).toBe(0);
    expect(queueCommandMock).not.toHaveBeenCalled();
  });

  it('a valid scheduled run queues commands attributed to the approving user', async () => {
    selectMock
      .mockReturnValueOnce(chain([APPROVED]))
      .mockReturnValueOnce(chain([{ id: 'device-1', orgId: 'org-1' }]));

    const result = await __testOnly.processRunBaselineScan({
      type: 'run-baseline-scan',
      baselineId: APPROVED.id,
      origin: 'scheduled',
      authorityGeneration: 'gen-1',
    });

    expect(result.commandsQueued).toBe(1);
    expect(queueCommandMock).toHaveBeenCalledWith(
      'device-1',
      'cis_benchmark',
      expect.objectContaining({ baselineId: APPROVED.id, orgId: 'org-1' }),
      'approver-1',
    );
  });

  it('a manual run is unaffected by the schedule authority', async () => {
    selectMock
      .mockReturnValueOnce(chain([LEGACY]))
      .mockReturnValueOnce(chain([{ id: 'device-1', orgId: 'org-1' }]));

    const result = await __testOnly.processRunBaselineScan({
      type: 'run-baseline-scan',
      baselineId: LEGACY.id,
      origin: 'manual',
      requestedBy: 'user-9',
    });

    expect(result.commandsQueued).toBe(1);
    expect(resolveAuthorityMock).not.toHaveBeenCalled();
  });

  it('grandfathers a legacy schedule whose creator still holds devices:execute', async () => {
    selectMock.mockReturnValueOnce(chain([GRANDFATHERED]));

    const result = await __testOnly.processScheduleScans();

    expect(result.enqueued).toBe(1);
    expect(addMock).toHaveBeenCalledWith(
      'run-baseline-scan',
      expect.objectContaining({ baselineId: GRANDFATHERED.id, origin: 'scheduled', legacyAuthority: true }),
      expect.anything(),
    );
  });

  it('pauses and flags a legacy schedule whose creator no longer qualifies', async () => {
    selectMock.mockReturnValueOnce(chain([GRANDFATHERED]));
    resolveAuthorityMock.mockResolvedValueOnce({ ok: false, reason: 'reapproval_required', revokeLegacy: true, checkStatus: 'approver_invalid' });

    const result = await __testOnly.processScheduleScans();

    expect(result.enqueued).toBe(0);
    expect(result.reapprovalRequired).toBe(1);
    expect(addMock).not.toHaveBeenCalled();
    expect(setMock).toHaveBeenCalledWith({
      executionAuthorityLegacy: 'revoked',
      executionAuthorityStatus: 'approver_invalid',
      executionAuthorityStatusAt: expect.any(Date),
    });
  });

  it('a legacy run job dispatches under the creator, attributed to them', async () => {
    selectMock
      .mockReturnValueOnce(chain([GRANDFATHERED]))
      .mockReturnValueOnce(chain([{ id: 'device-1', orgId: 'org-1' }]));

    const result = await __testOnly.processRunBaselineScan({
      type: 'run-baseline-scan',
      baselineId: GRANDFATHERED.id,
      origin: 'scheduled',
      legacyAuthority: true,
    });

    expect(result.commandsQueued).toBe(1);
    expect(queueCommandMock).toHaveBeenCalledWith('device-1', 'cis_benchmark', expect.anything(), 'creator-1');
  });

  it('a legacy run job queues nothing once the baseline has been stamped', async () => {
    selectMock.mockReturnValueOnce(chain([APPROVED]));

    const result = await __testOnly.processRunBaselineScan({
      type: 'run-baseline-scan',
      baselineId: APPROVED.id,
      origin: 'scheduled',
      legacyAuthority: true,
    });

    expect(result.commandsQueued).toBe(0);
  });

  it('persists the check outcome when a stamped approver stops qualifying, and only on change', async () => {
    const revokedApprover = { ...APPROVED, id: 'baseline-stamped-bad', executionAuthorityStatus: 'ok' };
    const alreadyFlagged = { ...APPROVED, id: 'baseline-stamped-flagged', executionAuthorityStatus: 'approver_invalid' };
    selectMock.mockReturnValueOnce(chain([revokedApprover, alreadyFlagged]));
    resolveAuthorityMock.mockResolvedValue({ ok: false, reason: 'reapproval_required', checkStatus: 'approver_invalid' });

    const result = await __testOnly.processScheduleScans();

    expect(result.enqueued).toBe(0);
    expect(setMock).toHaveBeenCalledTimes(1);
    expect(setMock).toHaveBeenCalledWith({
      executionAuthorityStatus: 'approver_invalid',
      executionAuthorityStatusAt: expect.any(Date),
    });
  });

  it('records a recovered check as ok', async () => {
    selectMock.mockReturnValueOnce(chain([{ ...APPROVED, executionAuthorityStatus: 'lookup_failed' }]));

    await __testOnly.processScheduleScans();

    expect(setMock).toHaveBeenCalledWith(expect.objectContaining({ executionAuthorityStatus: 'ok' }));
  });
});
