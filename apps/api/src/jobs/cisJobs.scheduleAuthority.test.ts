import { beforeEach, describe, expect, it, vi } from 'vitest';

const { addMock, queueCommandMock, selectMock, updateMock, resolveAuthorityMock } = vi.hoisted(() => ({
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
  resolveCisBaselineScheduleAuthority: resolveAuthorityMock,
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
    updateMock.mockReturnValue(chain(undefined));
    resolveAuthorityMock.mockImplementation(async (row: { executionAuthorityGeneration: string | null }) =>
      row.executionAuthorityGeneration === 'gen-1' ? AUTHORITY : null);
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
    resolveAuthorityMock.mockResolvedValueOnce(null);

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
});
