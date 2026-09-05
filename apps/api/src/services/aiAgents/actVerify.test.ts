import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const dbMockState = vi.hoisted(() => ({
  ambientContext: undefined as { scope: string } | undefined,
  insertedRows: [] as unknown[],
  insertShouldThrow: false,
}));

vi.mock('../../db', () => ({
  db: {
    insert: vi.fn(() => ({
      values: vi.fn(async (row: unknown) => {
        if (dbMockState.insertShouldThrow) throw new Error('alerts table unavailable');
        dbMockState.insertedRows.push(row);
      }),
    })),
  },
  getCurrentDbAccessContext: vi.fn(() => dbMockState.ambientContext),
  runOutsideDbContext: vi.fn((fn: () => unknown) => fn()),
  withSystemDbAccessContext: vi.fn(async (fn: () => Promise<unknown>) => {
    const previous = dbMockState.ambientContext;
    dbMockState.ambientContext = { scope: 'system' };
    try {
      return await fn();
    } finally {
      dbMockState.ambientContext = previous;
    }
  }),
}));

// #4150: the verification reads go through the depth-0-safe entry point, which
// opens the short system context its own precheck needs instead of the caller
// holding one across the whole device round-trip. `actVerify.dbcontext.test.ts`
// asserts the depth; this suite asserts the read semantics.
const executeCommandWithSystemPrecheck = vi.hoisted(() =>
  vi.fn<(deviceId: string, type: string, payload: Record<string, unknown>, options: Record<string, unknown>) =>
    Promise<{ status: string; stdout?: string; error?: string }>>());
vi.mock('../commandQueue', () => ({ executeCommandWithSystemPrecheck }));

import { ACT_MANIFEST } from './actManifest';
import type { ActOperation } from './actManifest';
import { actTargetSummary, recordActVerifyFailureAlert, verifyActExecution } from './actVerify';
import type { ActAssetPin } from './actRevalidation';

const RUN = { id: 'run-1', orgId: 'org-1', agentId: 'agent-1', deviceId: 'device-1' };
const AGENT_USER_ID = 'agent-1';

const restartOp = ACT_MANIFEST.find((op) => op.key === 'manage_services.restart')!;
// manage_processes.kill was removed from ACT_MANIFEST (#3826 scoped
// re-review, deferred out of v1: unreachable + unimplemented identity pin —
// see actManifest.test.ts). `verifyProcessAbsent`/`process_absent` are still
// present in actVerify.ts (kept for whenever the op is re-admitted), so this
// local fixture — not sourced from ACT_MANIFEST — keeps that dead-but-present
// code path unit-tested without claiming the op is reachable in production.
const processAbsentOp: ActOperation = {
  key: 'manage_processes.kill',
  toolName: 'manage_processes',
  matches: () => false,
  normalizeTarget: () => ({ ok: false, reason: 'unreachable — not in ACT_MANIFEST' }),
  verifySpec: { kind: 'process_absent' },
};
const diskCleanupOp = ACT_MANIFEST.find((op) => op.key === 'disk_cleanup.execute')!;
const runScriptOp = ACT_MANIFEST.find((op) => op.key === 'run_script')!;
const playbookOp = ACT_MANIFEST.find((op) => op.key === 'execute_playbook')!;
const suggestionOp = ACT_MANIFEST.find((op) => op.key === 'remediation_suggestion')!;

function pin(op: typeof restartOp, target: ActAssetPin['target']): ActAssetPin {
  return { op, target };
}

beforeEach(() => {
  vi.clearAllMocks();
  dbMockState.ambientContext = undefined;
  dbMockState.insertedRows = [];
  dbMockState.insertShouldThrow = false;
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('verifyActExecution — manage_services.restart (service_running)', () => {
  const target = { kind: 'service' as const, serviceName: 'Spooler' };

  it('completed + running read-back → succeeded/passed', async () => {
    executeCommandWithSystemPrecheck.mockResolvedValue({
      status: 'completed',
      stdout: JSON.stringify({ services: [{ name: 'Spooler', status: 'Running' }] }),
    });
    const result = await verifyActExecution({
      pin: pin(restartOp, target), toolOutput: JSON.stringify({ status: 'completed', exitCode: 0 }),
      isError: false, run: RUN, agentUserId: AGENT_USER_ID,
    });
    expect(result).toEqual({ execution: 'succeeded', verification: 'passed' });
    expect(executeCommandWithSystemPrecheck).toHaveBeenCalledWith('device-1', 'list_services', { search: 'Spooler' }, {
      userId: AGENT_USER_ID, timeoutMs: 8_000,
    });
  });

  it('service found but not running → failed with detail', async () => {
    executeCommandWithSystemPrecheck.mockResolvedValue({
      status: 'completed',
      stdout: JSON.stringify({ services: [{ name: 'Spooler', status: 'Stopped' }] }),
    });
    const result = await verifyActExecution({
      pin: pin(restartOp, target), toolOutput: JSON.stringify({ status: 'completed', exitCode: 0 }),
      isError: false, run: RUN, agentUserId: AGENT_USER_ID,
    });
    expect(result).toEqual({ execution: 'succeeded', verification: 'failed', verifyDetail: 'service status is "Stopped"' });
  });

  it('service missing from the read-back entirely → failed', async () => {
    executeCommandWithSystemPrecheck.mockResolvedValue({ status: 'completed', stdout: JSON.stringify({ services: [] }) });
    const result = await verifyActExecution({
      pin: pin(restartOp, target), toolOutput: JSON.stringify({ status: 'completed', exitCode: 0 }),
      isError: false, run: RUN, agentUserId: AGENT_USER_ID,
    });
    expect(result.verification).toBe('failed');
  });

  it('the read-back itself times out → inconclusive, not failed', async () => {
    executeCommandWithSystemPrecheck.mockResolvedValue({ status: 'timeout', error: 'Command timed out after 30000ms' });
    const result = await verifyActExecution({
      pin: pin(restartOp, target), toolOutput: JSON.stringify({ status: 'completed', exitCode: 0 }),
      isError: false, run: RUN, agentUserId: AGENT_USER_ID,
    });
    expect(result.verification).toBe('inconclusive');
  });

  it('the restart command itself timed out → execution: timeout', async () => {
    executeCommandWithSystemPrecheck.mockResolvedValue({ status: 'completed', stdout: JSON.stringify({ services: [] }) });
    const result = await verifyActExecution({
      pin: pin(restartOp, target),
      toolOutput: JSON.stringify({ status: 'timeout', error: 'Command timed out after 30000ms' }),
      isError: true, run: RUN, agentUserId: AGENT_USER_ID,
    });
    expect(result.execution).toBe('timeout');
  });

  it('an unparseable execution output falls back to the SDK isError flag, not unknown', async () => {
    executeCommandWithSystemPrecheck.mockResolvedValue({ status: 'completed', stdout: JSON.stringify({ services: [] }) });
    const okResult = await verifyActExecution({
      pin: pin(restartOp, target), toolOutput: 'not json', isError: false, run: RUN, agentUserId: AGENT_USER_ID,
    });
    expect(okResult.execution).toBe('succeeded');
    const errResult = await verifyActExecution({
      pin: pin(restartOp, target), toolOutput: 'not json', isError: true, run: RUN, agentUserId: AGENT_USER_ID,
    });
    expect(errResult.execution).toBe('failed');
  });

  it('a thrown verification read degrades to inconclusive, never throws', async () => {
    executeCommandWithSystemPrecheck.mockRejectedValue(new Error('WS connection lost'));
    const result = await verifyActExecution({
      pin: pin(restartOp, target), toolOutput: JSON.stringify({ status: 'completed', exitCode: 0 }),
      isError: false, run: RUN, agentUserId: AGENT_USER_ID,
    });
    expect(result).toEqual({ execution: 'unknown', verification: 'inconclusive', verifyDetail: 'verification read failed' });
  });
});

describe('verifyActExecution — process_absent (manage_processes.kill is deferred out of v1, #3826 — this exercises the still-present-but-currently-unreachable verifyProcessAbsent code path)', () => {
  const target = { kind: 'process' as const, pid: '4242', processName: 'notepad.exe' };

  it('pid still present in the read-back → failed', async () => {
    executeCommandWithSystemPrecheck.mockResolvedValue({
      status: 'completed',
      stdout: JSON.stringify({ processes: [{ pid: 4242, name: 'notepad.exe' }] }),
    });
    const result = await verifyActExecution({
      pin: pin(processAbsentOp, target), toolOutput: JSON.stringify({ status: 'completed', exitCode: 0 }),
      isError: false, run: RUN, agentUserId: AGENT_USER_ID,
    });
    expect(result).toEqual({ execution: 'succeeded', verification: 'failed', verifyDetail: 'process with the pinned pid is still present' });
    expect(executeCommandWithSystemPrecheck).toHaveBeenCalledWith('device-1', 'list_processes', { search: 'notepad.exe', limit: 200 }, {
      userId: AGENT_USER_ID, timeoutMs: 8_000,
    });
  });

  it('pid absent from the read-back → passed', async () => {
    executeCommandWithSystemPrecheck.mockResolvedValue({ status: 'completed', stdout: JSON.stringify({ processes: [] }) });
    const result = await verifyActExecution({
      pin: pin(processAbsentOp, target), toolOutput: JSON.stringify({ status: 'completed', exitCode: 0 }),
      isError: false, run: RUN, agentUserId: AGENT_USER_ID,
    });
    expect(result).toEqual({ execution: 'succeeded', verification: 'passed' });
  });

  // Review fix: an unparseable read-back must never be scored as "absence
  // proven" — that is absence of evidence, not evidence of absence, and the
  // sibling verifyServiceRunning already treats it conservatively.
  it('read-back stdout is not JSON at all → inconclusive, not passed', async () => {
    executeCommandWithSystemPrecheck.mockResolvedValue({ status: 'completed', stdout: 'not json' });
    const result = await verifyActExecution({
      pin: pin(processAbsentOp, target), toolOutput: JSON.stringify({ status: 'completed', exitCode: 0 }),
      isError: false, run: RUN, agentUserId: AGENT_USER_ID,
    });
    expect(result).toEqual({
      execution: 'succeeded',
      verification: 'inconclusive',
      verifyDetail: 'process list read-back was not parseable',
    });
  });

  it('read-back stdout parses but carries no `processes` array → inconclusive, not passed', async () => {
    executeCommandWithSystemPrecheck.mockResolvedValue({ status: 'completed', stdout: '{}' });
    const result = await verifyActExecution({
      pin: pin(processAbsentOp, target), toolOutput: JSON.stringify({ status: 'completed', exitCode: 0 }),
      isError: false, run: RUN, agentUserId: AGENT_USER_ID,
    });
    expect(result).toEqual({
      execution: 'succeeded',
      verification: 'inconclusive',
      verifyDetail: 'process list read-back was not parseable',
    });
  });
});

describe('verifyActExecution — disk_cleanup.execute (disk_usage_improved)', () => {
  const target = { kind: 'disk_cleanup' as const, paths: ['/tmp/a'] };

  it('executed with zero failures → succeeded/passed', async () => {
    const result = await verifyActExecution({
      pin: pin(diskCleanupOp, target),
      toolOutput: JSON.stringify({ status: 'executed', bytesReclaimed: 1024, failedCount: 0 }),
      isError: false, run: RUN, agentUserId: AGENT_USER_ID,
    });
    expect(result).toEqual({ execution: 'succeeded', verification: 'passed' });
    // Purely output-derived — no extra read for this op family.
    expect(executeCommandWithSystemPrecheck).not.toHaveBeenCalled();
  });

  it('failed status → failed/failed', async () => {
    const result = await verifyActExecution({
      pin: pin(diskCleanupOp, target),
      toolOutput: JSON.stringify({ status: 'failed', bytesReclaimed: 0, failedCount: 2 }),
      isError: true, run: RUN, agentUserId: AGENT_USER_ID,
    });
    expect(result.execution).toBe('failed');
    expect(result.verification).toBe('failed');
  });

  it('partial success (some candidates failed) → inconclusive, not failed', async () => {
    const result = await verifyActExecution({
      pin: pin(diskCleanupOp, target),
      toolOutput: JSON.stringify({ status: 'executed', bytesReclaimed: 512, failedCount: 1 }),
      isError: false, run: RUN, agentUserId: AGENT_USER_ID,
    });
    expect(result.verification).toBe('inconclusive');
  });
});

describe('verifyActExecution — run_script (script_exit_code)', () => {
  const target = { kind: 'script' as const, scriptId: 'script-1' };

  it('exit code 0 → passed', async () => {
    const result = await verifyActExecution({
      pin: pin(runScriptOp, target),
      toolOutput: JSON.stringify({ results: { [RUN.deviceId]: { status: 'completed', exitCode: 0 } } }),
      isError: false, run: RUN, agentUserId: AGENT_USER_ID,
    });
    expect(result).toEqual({ execution: 'succeeded', verification: 'passed' });
  });

  it('non-zero exit code → failed', async () => {
    const result = await verifyActExecution({
      pin: pin(runScriptOp, target),
      toolOutput: JSON.stringify({ results: { [RUN.deviceId]: { status: 'completed', exitCode: 1 } } }),
      isError: true, run: RUN, agentUserId: AGENT_USER_ID,
    });
    expect(result).toEqual({ execution: 'succeeded', verification: 'failed', verifyDetail: 'script exited with code 1' });
  });

  it('script execution timed out → inconclusive (a timeout, not a failure verdict)', async () => {
    const result = await verifyActExecution({
      pin: pin(runScriptOp, target),
      toolOutput: JSON.stringify({ results: { [RUN.deviceId]: { status: 'timeout' } } }),
      isError: true, run: RUN, agentUserId: AGENT_USER_ID,
    });
    expect(result).toEqual({ execution: 'timeout', verification: 'inconclusive', verifyDetail: 'script execution timed out' });
  });

  it('no exit code and no timeout (dispatch failed before running) → skipped', async () => {
    const result = await verifyActExecution({
      pin: pin(runScriptOp, target),
      toolOutput: JSON.stringify({ results: { [RUN.deviceId]: { error: 'Device not found or access denied' } } }),
      isError: true, run: RUN, agentUserId: AGENT_USER_ID,
    });
    expect(result.verification).toBe('skipped');
    expect(result.execution).toBe('failed');
  });
});

describe('verifyActExecution — execute_playbook (deferred to Task 5) and the virtual remediation_suggestion op', () => {
  it('playbook_aggregate has no real postcondition check yet — surfaces as inconclusive, never a silent pass', async () => {
    const result = await verifyActExecution({
      pin: pin(playbookOp, { kind: 'playbook', playbookId: 'pb-1' }),
      toolOutput: JSON.stringify({ status: 'completed' }),
      isError: false, run: RUN, agentUserId: AGENT_USER_ID,
    });
    expect(result.execution).toBe('succeeded');
    expect(result.verification).toBe('inconclusive');
  });

  it('remediation_suggestion (verifySpec.kind "none") is a defensive fallback, never reached for real', async () => {
    const result = await verifyActExecution({
      pin: pin(suggestionOp, { kind: 'suggestion', suggestionId: 'sugg-1' }),
      toolOutput: '{}', isError: false, run: RUN, agentUserId: AGENT_USER_ID,
    });
    expect(result).toEqual({ execution: 'unknown', verification: 'inconclusive', verifyDetail: 'no verify spec for this op' });
  });
});

describe('actTargetSummary — sanitized identity, never a full input/output blob', () => {
  it('summarizes every target kind without leaking a full path list', () => {
    expect(actTargetSummary({ kind: 'service', serviceName: 'Spooler' })).toBe('Spooler');
    expect(actTargetSummary({ kind: 'process', pid: '1', processName: 'notepad.exe' })).toBe('notepad.exe');
    expect(actTargetSummary({ kind: 'script', scriptId: 'script-1' })).toBe('script-1');
    expect(actTargetSummary({ kind: 'playbook', playbookId: 'pb-1' })).toBe('pb-1');
    expect(actTargetSummary({ kind: 'suggestion', suggestionId: 'sugg-1' })).toBe('sugg-1');
    expect(actTargetSummary({ kind: 'disk_cleanup', paths: ['/tmp/a', '/tmp/b', '/tmp/c'] })).toBe('3 path(s)');
  });
});

describe('recordActVerifyFailureAlert', () => {
  it('inserts a rule-less, high-severity alert carrying the run/op/target context', async () => {
    await recordActVerifyFailureAlert({
      run: RUN,
      op: { key: 'manage_services.restart' },
      target: { kind: 'service', serviceName: 'Spooler' },
      detail: 'service status is "stopped"',
    });

    expect(dbMockState.insertedRows).toHaveLength(1);
    expect(dbMockState.insertedRows[0]).toMatchObject({
      ruleId: null,
      deviceId: RUN.deviceId,
      orgId: RUN.orgId,
      severity: 'high',
      status: 'active',
      context: {
        source: 'ai_agent_act_verify',
        runId: RUN.id,
        agentId: RUN.agentId,
        opKey: 'manage_services.restart',
        target: { kind: 'service', serviceName: 'Spooler' },
      },
    });
  });

  it('is best-effort — a DB failure is logged and swallowed, never thrown', async () => {
    dbMockState.insertShouldThrow = true;
    await expect(recordActVerifyFailureAlert({
      run: RUN,
      op: { key: 'manage_services.restart' },
      target: { kind: 'service', serviceName: 'Spooler' },
    })).resolves.toBeUndefined();
  });
});
