import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { z } from 'zod';
import type { commandResultSchema } from './schemas';

/**
 * #6263 W05-9 — `handleSecurityCommandResult` binds a result to the scan the
 * COMMAND was dispatched for (security_scans.command_id, then the command's
 * own payload scanRecordId), never to an id the agent reports, and stamps
 * `details.ruleSetVersion` on threats from a set the scan was dispatched with.
 * Harness copied from helpers.securityScan.test.ts.
 */

const { dbMock, insertValuesMock, updateSetMock, selectQueue, whereLog } = vi.hoisted(() => {
  const selectQueue: unknown[][] = [];
  const whereLog: unknown[] = [];
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
      const where = vi.fn((cond: unknown) => {
        whereLog.push(cond);
        return terminal;
      });
      return { from: vi.fn().mockReturnValue({ where }) };
    }),
    insert: vi.fn(() => ({
      values: vi.fn((vals: unknown) => {
        insertValuesMock(vals);
        const returning = vi.fn().mockResolvedValue([]);
        return Object.assign(Promise.resolve(undefined), {
          returning,
          onConflictDoUpdate: vi.fn().mockResolvedValue(undefined),
          onConflictDoNothing: vi.fn().mockResolvedValue(undefined),
        });
      }),
    })),
    update: vi.fn(() => ({ set: updateSetMock })),
  };

  return { dbMock, insertValuesMock, updateSetMock, selectQueue, whereLog };
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

import { handleSecurityCommandResult } from './helpers';

const DEVICE_ID = '00000000-0000-4000-8000-000000000001';
const ORG_ID = '00000000-0000-4000-8000-000000000002';
const COMMAND_ID = '00000000-0000-4000-8000-000000000004';
const SCAN_ID = '00000000-0000-4000-8000-000000000005';

function makeCommand(type: string, payload: Record<string, unknown>) {
  return {
    id: COMMAND_ID,
    deviceId: DEVICE_ID,
    type,
    payload,
    status: 'completed',
    result: null,
    createdAt: new Date('2026-09-18T00:00:00Z'),
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

const SET_ID = '00000000-0000-4000-8000-00000000000a';
const OTHER_SCAN_ID = '00000000-0000-4000-8000-000000000009';

/** Every primitive value in a drizzle SQL tree (the mocked schema columns are plain objects). */
function sqlValues(node: unknown, out: unknown[] = [], seen = new Set<unknown>()): unknown[] {
  if (node === null || node === undefined) return out;
  if (typeof node !== 'object') {
    out.push(node);
    return out;
  }
  if (seen.has(node)) return out;
  seen.add(node);
  const record = node as Record<string, unknown>;
  if (Array.isArray(node)) node.forEach((n) => sqlValues(n, out, seen));
  else if ('queryChunks' in record) sqlValues(record.queryChunks, out, seen);
  else if ('value' in record) sqlValues(record.value, out, seen);
  return out;
}

const threatInserts = () =>
  insertValuesMock.mock.calls
    .map((c) => c[0])
    .filter((v): v is Array<Record<string, unknown>> => Array.isArray(v) && v.some((r) => 'threatName' in r))
    .flat();

beforeEach(() => {
  vi.clearAllMocks();
  selectQueue.length = 0;
  whereLog.length = 0;
});

describe('security_scan result binding (#6263 W05-9)', () => {
  it("scan resolved by the command's scanRecordId even when the agent reports another", async () => {
    selectQueue.push([{ orgId: ORG_ID }], [{ id: SCAN_ID, engine: 'yara', ruleSetErrors: null, dispatchedRuleSets: null }]);
    await handleSecurityCommandResult(
      makeCommand('security_scan', { scanRecordId: SCAN_ID }),
      makeResult({ stdout: JSON.stringify({ scanRecordId: OTHER_SCAN_ID, threatsFound: 0, threats: [] }) }),
    );
    const scanLookup = sqlValues(whereLog[1]);
    expect(scanLookup).toContain(COMMAND_ID);
    expect(scanLookup).toContain(SCAN_ID);
    expect(scanLookup).not.toContain(OTHER_SCAN_ID);
    expect(updateSetMock).toHaveBeenCalledWith(expect.objectContaining({ status: 'completed' }));
  });

  it('a command bound by security_scans.command_id needs no payload (erased after a timeout)', async () => {
    selectQueue.push([{ orgId: ORG_ID }], [{ id: SCAN_ID, engine: 'yara', ruleSetErrors: null, dispatchedRuleSets: null }]);
    await handleSecurityCommandResult(
      makeCommand('security_scan', {}),
      makeResult({ stdout: JSON.stringify({ scanRecordId: SCAN_ID, threatsFound: 0, threats: [] }) }),
    );
    expect(sqlValues(whereLog[1])).toContain(COMMAND_ID);
    expect(updateSetMock).toHaveBeenCalledWith(expect.objectContaining({ status: 'completed' }));
  });

  it('threat on ruleSetId S gets details.ruleSetVersion', async () => {
    selectQueue.push(
      [{ orgId: ORG_ID }],
      [{ id: SCAN_ID, engine: 'yara', ruleSetErrors: null, dispatchedRuleSets: [{ id: SET_ID, version: 3, sha256: 'a'.repeat(64) }] }],
    );
    await handleSecurityCommandResult(
      makeCommand('security_scan', { scanRecordId: SCAN_ID }),
      makeResult({
        stdout: JSON.stringify({
          scanRecordId: SCAN_ID,
          engine: 'yara',
          threatsFound: 1,
          threats: [{ name: 'Hit', path: '/tmp/x', severity: 'high', ruleName: 'r_one', ruleSetId: SET_ID.toUpperCase() }],
        }),
      }),
    );
    const [threat] = threatInserts();
    expect(threat!.details).toMatchObject({ ruleSetId: SET_ID.toUpperCase(), ruleName: 'r_one', ruleSetVersion: 3 });
  });

  it('legacy threat / null dispatched_rule_sets → no key; an agent-supplied ruleSetVersion is dropped', async () => {
    selectQueue.push([{ orgId: ORG_ID }], [{ id: SCAN_ID, engine: 'legacy', ruleSetErrors: null, dispatchedRuleSets: null }]);
    await handleSecurityCommandResult(
      makeCommand('security_scan', { scanRecordId: SCAN_ID }),
      makeResult({
        stdout: JSON.stringify({
          scanRecordId: SCAN_ID,
          threatsFound: 2,
          threats: [
            { name: 'Sig', path: '/a', severity: 'low' },
            { name: 'Forged', path: '/b', severity: 'low', ruleSetId: SET_ID, ruleSetVersion: 99 },
          ],
        }),
      }),
    );
    const threats = threatInserts();
    expect(threats).toHaveLength(2);
    for (const t of threats) expect(t.details).not.toHaveProperty('ruleSetVersion');
  });

  it('a threat from a set the scan was not dispatched with gets no version', async () => {
    selectQueue.push(
      [{ orgId: ORG_ID }],
      [{ id: SCAN_ID, engine: 'yara', ruleSetErrors: null, dispatchedRuleSets: [{ id: SET_ID, version: 3, sha256: 'a'.repeat(64) }] }],
    );
    await handleSecurityCommandResult(
      makeCommand('security_scan', { scanRecordId: SCAN_ID }),
      makeResult({
        stdout: JSON.stringify({
          scanRecordId: SCAN_ID,
          threatsFound: 1,
          threats: [{ name: 'Hit', path: '/x', severity: 'high', ruleSetId: '00000000-0000-4000-8000-00000000000b' }],
        }),
      }),
    );
    expect(threatInserts()[0]!.details).not.toHaveProperty('ruleSetVersion');
  });
});
