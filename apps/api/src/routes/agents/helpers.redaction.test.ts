import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { z } from 'zod';
import type { commandResultSchema } from './schemas';

/**
 * #2434 — agent-supplied strings persisted OUTSIDE device_commands must be
 * redacted before they hit the DB.
 *
 * These handlers are the ones that persist values parsed out of RAW `stdout`.
 * stdout is deliberately NOT redacted by the ingest chokepoint (structured-JSON
 * consumers parse it, and capture_pprof artifacts must stay byte-for-byte), so
 * each of these write sites has to redact for itself. This suite proves they do.
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

import {
  handleCisCommandResult,
  handleSecurityCommandResult,
  handleSensitiveDataCommandResult,
} from './helpers';

const DEVICE_ID = '00000000-0000-4000-8000-000000000001';
const ORG_ID = '00000000-0000-4000-8000-000000000002';
const BASELINE_ID = '00000000-0000-4000-8000-000000000003';
const COMMAND_ID = '00000000-0000-4000-8000-000000000004';
const SCAN_ID = '00000000-0000-4000-8000-000000000005';
const ACTION_ID = '00000000-0000-4000-8000-000000000006';

const PEM =
  '-----BEGIN RSA PRIVATE KEY-----\nMIIBOgIBAAJBAKe0m0h\n-----END RSA PRIVATE KEY-----';

function makeCommand(type: string, payload: Record<string, unknown>) {
  return {
    id: COMMAND_ID,
    deviceId: DEVICE_ID,
    type,
    payload,
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

/** Asserts no fragment of the PEM survived anywhere in the persisted value. */
function expectRedacted(value: unknown) {
  const serialized = JSON.stringify(value);
  expect(serialized).toContain('[PRIVATE_KEY_REDACTED]');
  expect(serialized).not.toContain('BEGIN RSA PRIVATE KEY');
  expect(serialized).not.toContain('MIIBOgIBAAJBAKe0m0h');
}

beforeEach(() => {
  vi.clearAllMocks();
  selectQueue.length = 0;
});

describe('#2434 — handleCisCommandResult redacts stdout-derived CIS state', () => {
  it('redacts secrets in baseline findings parsed from raw stdout', async () => {
    // baseline → device org → idempotency probe → previous result
    selectQueue.push(
      [{ id: BASELINE_ID, orgId: ORG_ID, name: 'CIS L1' }],
      [{ orgId: ORG_ID }],
      [],
      [],
    );

    // The collector's own JSON, carrying a secret in a finding's evidence —
    // exactly the shape a failing check produces when it quotes the offending
    // config value.
    const stdout = JSON.stringify({
      checkedAt: '2026-07-13T00:00:00Z',
      totalChecks: 1,
      passedChecks: 0,
      failedChecks: 1,
      score: 0,
      findings: [{
        checkId: '1.1.1',
        title: 'Ensure key material is not stored on disk',
        severity: 'high',
        status: 'fail',
        message: `found key material: ${PEM}`,
        evidence: `C:\\keys\\id_rsa contains:\n${PEM}`,
        remediation: 'Remove the key',
      }],
    });

    await handleCisCommandResult(
      makeCommand('cis_benchmark', { baselineId: BASELINE_ID }),
      makeResult({ stdout }),
    );

    expect(insertValuesMock).toHaveBeenCalledTimes(1);
    const inserted = insertValuesMock.mock.calls[0]![0] as {
      findings: unknown;
      checkedAt: unknown;
    };
    expectRedacted(inserted.findings);

    // Regression: redaction must not flatten the Date. `db.insert` is mocked
    // here, so Drizzle's timestamp mapper never runs — without this assertion a
    // `checkedAt` of `{}` sails through the test and only explodes in prod,
    // where the throw is swallowed and successful CIS scans stop persisting.
    expect(inserted.checkedAt).toBeInstanceOf(Date);
  });

  it('redacts error/stderr on the FAILURE branch (no reliance on the ingest chokepoint)', async () => {
    // baseline → device org → idempotency probe → previous result
    selectQueue.push(
      [{ id: BASELINE_ID, orgId: ORG_ID, name: 'CIS L1' }],
      [{ orgId: ORG_ID }],
      [],
      [],
    );

    // A failed collector run: the finding's `message` and the summary are built
    // straight from the agent's error/stderr. This handler must self-redact —
    // if it only worked because a caller two modules away redacted first, then
    // deleting that call would silently leak a raw key into
    // cis_baseline_results with a fully green test suite.
    await handleCisCommandResult(
      makeCommand('cis_benchmark', { baselineId: BASELINE_ID }),
      makeResult({
        status: 'failed',
        exitCode: 1,
        error: `collector died: ${PEM}`,
        stderr: `stderr: ${PEM}`,
      }),
    );

    expect(insertValuesMock).toHaveBeenCalledTimes(1);
    const inserted = insertValuesMock.mock.calls[0]![0] as {
      findings: unknown;
      summary: unknown;
    };
    expectRedacted(inserted.findings);
    expectRedacted(inserted.summary);
  });

  it('redacts remediation details/beforeState/afterState/rollbackHint parsed from raw stdout', async () => {
    // action lookup for apply_cis_remediation
    selectQueue.push([
      {
        id: ACTION_ID,
        orgId: ORG_ID,
        deviceId: DEVICE_ID,
        details: {},
        beforeState: null,
        afterState: null,
        rollbackHint: null,
      },
    ]);

    // beforeState/afterState are the ACTUAL config values the remediation
    // touched — a registry value holding a service-account credential lands
    // here verbatim unless redacted.
    const stdout = JSON.stringify({
      details: { note: `applied with key ${PEM}` },
      beforeState: { 'HKLM\\Svc\\Password': `${PEM}` },
      afterState: { 'HKLM\\Svc\\Password': 'password=NewSecretValue123' },
      rollbackHint: `restore with ${PEM}`,
    });

    await handleCisCommandResult(
      makeCommand('apply_cis_remediation', { actionId: ACTION_ID }),
      makeResult({ stdout }),
    );

    expect(updateSetMock).toHaveBeenCalledTimes(1);
    const stored = updateSetMock.mock.calls[0]![0] as Record<string, unknown>;
    expectRedacted(stored.details);
    expectRedacted(stored.beforeState);
    expectRedacted(stored.rollbackHint);
    // afterState carried a `password=` pair rather than a PEM.
    expect(JSON.stringify(stored.afterState)).not.toContain('NewSecretValue123');
  });
});

describe('#2434 — handleSecurityCommandResult redacts the raw threat blob', () => {
  it('redacts secrets in security_threats.details', async () => {
    // device org lookup, then the security-scan record lookup
    selectQueue.push([{ orgId: ORG_ID }], []);

    // AV threat records routinely embed the offending command line / script.
    const stdout = JSON.stringify({
      threats: [{
        name: 'Suspicious.Script',
        type: 'script',
        severity: 'high',
        path: 'C:\\tmp\\evil.ps1',
        commandLine: `powershell -c "$k='${PEM}'"`,
      }],
      threatsFound: 1,
    });

    await handleSecurityCommandResult(
      makeCommand('security_scan', {}),
      makeResult({ stdout }),
    );

    // Threat rows are inserted with details = the raw threat object.
    const threatInsert = insertValuesMock.mock.calls
      .map((call) => call[0])
      .find((vals) => Array.isArray(vals) && vals.some((v: any) => v?.details));
    expect(threatInsert).toBeDefined();
    expectRedacted(threatInsert);
  });
});

describe('#2434 — handleSensitiveDataCommandResult redacts the agent summary', () => {
  it('redacts secrets in sensitive_data_scans.summary.agentSummary', async () => {
    selectQueue.push([
      { id: SCAN_ID, orgId: ORG_ID, deviceId: DEVICE_ID, summary: {} },
    ]);

    const stdout = JSON.stringify({
      scanId: SCAN_ID,
      summary: { note: `scanner dump: ${PEM}` },
      findings: [],
    });

    await handleSensitiveDataCommandResult(
      makeCommand('sensitive_data_scan', { scanId: SCAN_ID }),
      makeResult({ stdout }),
    );

    expect(updateSetMock).toHaveBeenCalled();
    const stored = updateSetMock.mock.calls[0]![0] as { summary: { agentSummary: unknown } };
    expectRedacted(stored.summary.agentSummary);
  });
});
