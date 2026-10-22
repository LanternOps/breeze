import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { z } from 'zod';
import type { commandResultSchema } from './schemas';


/**
 * #9604 — a CIS remediation the agent did not apply must be recorded as
 * `failed`, carry the agent's error text, and must NOT publish
 * `compliance.cis_remediation_applied`.
 *
 * Two agent generations report the same failure differently:
 *   - fixed agents: command status `failed`, `error` set, remediation JSON
 *     (with `success:false`) still on stdout;
 *   - older agents: command status `completed`, failure only inside stdout as
 *     `{ success: false, error: "..." }`.
 * Both must land as `failed`.
 */

const { dbMock, insertValuesMock, updateSetMock, selectQueue } = vi.hoisted(() => {
  // Each db.select() call shifts one queued row-set, mirroring the handlers'
  // fixed lookup order.
  const selectQueue: unknown[][] = [];
  const shift = () => selectQueue.shift() ?? [];

  const insertValuesMock = vi.fn();
  const updateSetMock = vi.fn().mockReturnValue({
    where: vi.fn().mockResolvedValue(undefined),
  });

  const dbMock = {
    select: vi.fn(() => {
      const rows = shift();
      const terminal = Object.assign(Promise.resolve(rows), {
        limit: vi.fn().mockResolvedValue(rows),
        orderBy: vi.fn().mockReturnValue({ limit: vi.fn().mockResolvedValue(rows) }),
      });
      return { from: vi.fn().mockReturnValue({ where: vi.fn().mockReturnValue(terminal) }) };
    }),
    insert: vi.fn(() => ({
      values: vi.fn((vals: unknown) => {
        insertValuesMock(vals);
        const returning = vi.fn().mockResolvedValue([
          { id: 'result-1', score: 10, failedChecks: 0, checkedAt: new Date() },
        ]);
        return Object.assign(Promise.resolve(undefined), {
          returning,
          onConflictDoUpdate: vi.fn().mockResolvedValue(undefined),
          onConflictDoNothing: vi.fn().mockResolvedValue(undefined),
        });
      }),
    })),
    update: vi.fn(() => ({ set: updateSetMock })),
  };

  return { dbMock, insertValuesMock, updateSetMock, selectQueue };
});

vi.mock('../../db', () => ({
  db: dbMock,
  runOutsideDbContext: vi.fn((fn: () => unknown) => fn()),
  withDbAccessContext: vi.fn(async (_ctx: unknown, fn: () => Promise<unknown>) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => fn()),
}));

vi.mock('../../db/schema', () => new Proxy({}, {
  get: (_t, prop: string) => (prop === 'then' ? undefined : { $inferSelect: {}, name: prop }),
  has: () => true,
}));

vi.mock('../../services/redis', () => ({ getRedis: vi.fn(() => null) }));
vi.mock('../../services/eventBus', () => ({
  publishEvent: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../jobs/softwareComplianceWorker', () => ({
  scheduleSoftwareComplianceCheck: vi.fn(),
}));
vi.mock('../../services/softwarePolicyService', () => ({
  recordSoftwarePolicyAudit: vi.fn(),
}));
vi.mock('../../services/commandQueue', () => ({ queueCommandForExecution: vi.fn() }));
vi.mock('../../services/filesystemAnalysis', () => ({
  getFilesystemScanState: vi.fn(),
  mergeFilesystemAnalysisPayload: vi.fn(),
  parseFilesystemAnalysisStdout: vi.fn(),
  readCheckpointPendingDirectories: vi.fn(),
  readHotDirectories: vi.fn(),
  saveFilesystemSnapshot: vi.fn(),
  upsertFilesystemScanState: vi.fn(),
}));
vi.mock('../../services/cloudflareMtls', () => ({ CloudflareMtlsService: vi.fn() }));
vi.mock('../../services/sentry', () => ({ captureException: vi.fn() }));
vi.mock('../metrics', () => ({ recordSoftwareRemediationDecision: vi.fn() }));

import { publishEvent } from '../../services/eventBus';
import { handleCisCommandResult } from './helpers';

const DEVICE_ID = '00000000-0000-4000-8000-000000000001';
const ORG_ID = '00000000-0000-4000-8000-000000000002';
const BASELINE_ID = '00000000-0000-4000-8000-000000000003';
const COMMAND_ID = '00000000-0000-4000-8000-000000000004';
const ACTION_ID = '00000000-0000-4000-8000-000000000006';

const ACTION_ROW = {
  id: ACTION_ID,
  orgId: ORG_ID,
  baselineId: BASELINE_ID,
  baselineResultId: null,
  checkId: '2.3.7',
  actionName: 'apply',
  details: {},
  beforeState: null,
  afterState: null,
  rollbackHint: null,
};

function makeCommand() {
  return {
    id: COMMAND_ID,
    deviceId: DEVICE_ID,
    type: 'apply_cis_remediation',
    payload: { actionId: ACTION_ID, checkId: '2.3.7' },
    status: 'completed',
    result: null,
  } as any;
}

function makeResult(
  overrides: Partial<z.infer<typeof commandResultSchema>> = {},
): z.infer<typeof commandResultSchema> {
  return {
    commandId: COMMAND_ID,
    status: 'completed',
    exitCode: 0,
    ...overrides,
  } as z.infer<typeof commandResultSchema>;
}

async function runWith(result: z.infer<typeof commandResultSchema>) {
  selectQueue.push([ACTION_ROW]);
  await handleCisCommandResult(makeCommand(), result);
  expect(updateSetMock).toHaveBeenCalledTimes(1);
  return updateSetMock.mock.calls[0]![0] as {
    status: string;
    details: Record<string, unknown>;
    beforeState: Record<string, unknown> | null;
  };
}

function appliedEventCalls() {
  return vi.mocked(publishEvent).mock.calls.filter(
    ([type]) => type === 'compliance.cis_remediation_applied',
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  selectQueue.length = 0;
});

describe('#9604 — apply_cis_remediation outcome classification', () => {
  const cases: Array<{
    name: string;
    result: Partial<z.infer<typeof commandResultSchema>>;
    wantStatus: 'completed' | 'failed';
    wantError: string | null;
  }> = [
    {
      name: 'fixed agent: failed command with error and success:false stdout',
      result: {
        status: 'failed',
        exitCode: 1,
        error: 'no Windows remediation implemented for check 2.3.7',
        stdout: JSON.stringify({
          checkId: '2.3.7',
          action: 'apply',
          success: false,
          error: 'no Windows remediation implemented for check 2.3.7',
        }),
      },
      wantStatus: 'failed',
      wantError: 'no Windows remediation implemented for check 2.3.7',
    },
    {
      name: 'older agent: completed command whose stdout says success:false',
      result: {
        status: 'completed',
        exitCode: 0,
        stdout: JSON.stringify({
          checkId: '2.3.7',
          action: 'apply',
          success: false,
          error: 'no Windows remediation implemented for check 2.3.7',
        }),
      },
      wantStatus: 'failed',
      wantError: 'no Windows remediation implemented for check 2.3.7',
    },
    {
      name: 'older agent: success:false with no embedded error still gets a reason',
      result: {
        status: 'completed',
        exitCode: 0,
        stdout: JSON.stringify({ checkId: '2.3.7', action: 'apply', success: false }),
      },
      wantStatus: 'failed',
      wantError: 'Agent reported the remediation was not applied',
    },
    {
      name: 'failed command with no stdout at all',
      result: { status: 'failed', exitCode: 1, error: 'agent crashed' },
      wantStatus: 'failed',
      wantError: 'agent crashed',
    },
    {
      name: 'applied remediation',
      result: {
        status: 'completed',
        exitCode: 0,
        stdout: JSON.stringify({ checkId: '2.3.7', action: 'apply', success: true }),
      },
      wantStatus: 'completed',
      wantError: null,
    },
    {
      name: 'completed command whose stdout carries no success field stays completed',
      result: {
        status: 'completed',
        exitCode: 0,
        stdout: JSON.stringify({ checkId: '2.3.7', action: 'apply' }),
      },
      wantStatus: 'completed',
      wantError: null,
    },
  ];

  it.each(cases)('$name', async ({ result, wantStatus, wantError }) => {
    const stored = await runWith(makeResult(result));

    expect(stored.status).toBe(wantStatus);
    expect(stored.details.error ?? null).toBe(wantError);
    expect(appliedEventCalls()).toHaveLength(wantStatus === 'completed' ? 1 : 0);
  });

  it('keeps the before-state a failed remediation reported', async () => {
    const stored = await runWith(makeResult({
      status: 'failed',
      exitCode: 1,
      error: 'failed to write HKLM\\...\\LimitBlankPasswordUse',
      stdout: JSON.stringify({
        checkId: '2.3.7',
        action: 'apply',
        success: false,
        beforeState: { LimitBlankPasswordUse: 0 },
        error: 'failed to write HKLM\\...\\LimitBlankPasswordUse',
      }),
    }));

    expect(stored.status).toBe('failed');
    expect(stored.beforeState).toEqual({ LimitBlankPasswordUse: 0 });
  });
});
