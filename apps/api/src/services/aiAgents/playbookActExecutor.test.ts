import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AiAgentKind } from '@breeze/shared';
import type { PlaybookStep } from '../../db/schema/playbooks';
import type { AuthContext } from '../../middleware/auth';

// ---------------------------------------------------------------------------
// db mock — table-name-keyed select (same shape as actRevalidation.test.ts),
// plus insert/update capture for the playbook_executions row.
// ---------------------------------------------------------------------------
const dbMockState = vi.hoisted(() => ({
  playbookRows: [] as unknown[],
  userRows: [] as unknown[],
  diskRows: [] as unknown[],
  ambientContext: undefined as { scope: string } | undefined,
  insertedExecutions: [] as Record<string, unknown>[],
  updatedExecutions: [] as Array<{ id: unknown; set: Record<string, unknown> }>,
  insertShouldThrow: false,
}));

vi.mock('../../db', () => ({
  db: {
    select: vi.fn(() => ({
      from: vi.fn((table: unknown) => {
        const tableName = String((table as Record<symbol, unknown>)[Symbol.for('drizzle:Name')]);
        const builder: Record<string, unknown> = {
          where: vi.fn(() => builder),
          orderBy: vi.fn(() => builder),
          limit: vi.fn(async () => {
            if (tableName === 'playbook_definitions') return dbMockState.playbookRows;
            if (tableName === 'users') return dbMockState.userRows;
            if (tableName === 'device_disks') return dbMockState.diskRows;
            throw new Error(`Unexpected table: ${tableName}`);
          }),
        };
        return builder;
      }),
    })),
    insert: vi.fn(() => ({
      values: vi.fn((row: Record<string, unknown>) => ({
        returning: vi.fn(async () => {
          if (dbMockState.insertShouldThrow) throw new Error('insert failed');
          const id = `exec-${dbMockState.insertedExecutions.length + 1}`;
          dbMockState.insertedExecutions.push({ ...row, id });
          return [{ id }];
        }),
      })),
    })),
    update: vi.fn(() => ({
      set: vi.fn((set: Record<string, unknown>) => ({
        where: vi.fn(async () => {
          dbMockState.updatedExecutions.push({ id: undefined, set });
        }),
      })),
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
  // Review fix (#3826 final-review): `withAuthDbAccessContext`
  // (middleware/auth.ts) — which every `executeToolFn` dispatch now goes
  // through — calls this directly. Mirrors `withSystemDbAccessContext`'s
  // save/restore shape but records whatever context object it was given so
  // tests can assert a non-system, agent-scoped context was active at
  // dispatch time.
  withDbAccessContext: vi.fn(async (ctx: unknown, fn: () => Promise<unknown>) => {
    const previous = dbMockState.ambientContext;
    dbMockState.ambientContext = ctx as { scope: string };
    try {
      return await fn();
    } finally {
      dbMockState.ambientContext = previous;
    }
  }),
}));

import { ACT_MANIFEST } from './actManifest';
import type { ActRevalidationResult } from './actRevalidation';
import {
  executeBuiltInPlaybookForRun,
  runPlaybookSteps,
  type PlaybookExecutorDeps,
} from './playbookActExecutor';

const RUN = {
  id: 'run-1',
  orgId: 'org-1',
  agentId: 'agent-1',
  agentKind: 'triage' as AiAgentKind,
  deviceId: 'device-1',
  deviceSiteId: 'site-1',
};
const AGENT_AUTH = { user: { id: 'agent-1' } } as unknown as AuthContext;
const FAR_FUTURE_DEADLINE = Date.now() + 60_000;

const restartOp = ACT_MANIFEST.find((op) => op.key === 'manage_services.restart')!;
const diskCleanupOp = ACT_MANIFEST.find((op) => op.key === 'disk_cleanup.execute')!;

function okRevalidation(op: typeof restartOp): ActRevalidationResult {
  return { ok: true, pin: { op, target: { kind: 'service', serviceName: 'x' } } };
}

function makeDeps(overrides: Partial<PlaybookExecutorDeps> = {}): PlaybookExecutorDeps {
  return {
    revalidate: vi.fn(async () => okRevalidation(restartOp)),
    executeToolFn: vi.fn(async () => JSON.stringify({ status: 'completed' })),
    executeCommandFn: vi.fn(async () => ({ status: 'completed' as const, stdout: JSON.stringify({ services: [] }) })),
    sleepFn: vi.fn(async () => undefined),
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  dbMockState.playbookRows = [];
  dbMockState.userRows = [];
  dbMockState.diskRows = [];
  dbMockState.ambientContext = undefined;
  dbMockState.insertedExecutions = [];
  dbMockState.updatedExecutions = [];
  dbMockState.insertShouldThrow = false;
});

// ---------------------------------------------------------------------------
// runPlaybookSteps — the core sequencing loop
// ---------------------------------------------------------------------------

describe('runPlaybookSteps — diagnose', () => {
  it('dispatches a plain read-only tool call, no reservation', async () => {
    const deps = makeDeps({
      executeToolFn: vi.fn(async () => JSON.stringify({ ok: true })),
    });
    const steps: PlaybookStep[] = [
      { type: 'diagnose', name: 'baseline', description: '', tool: 'analyze_disk_usage', toolInput: { deviceId: 'device-1' } },
    ];
    const outcome = await runPlaybookSteps(steps, {
      run: RUN, agentAuth: AGENT_AUTH, deps, reserved: { count: 0 }, deadlineMs: FAR_FUTURE_DEADLINE,
    });
    expect(outcome.execution).toBe('succeeded');
    expect(outcome.verification).toBe('skipped');
    expect(deps.revalidate).not.toHaveBeenCalled();
    expect(outcome.results[0]).toMatchObject({ status: 'completed', toolUsed: 'analyze_disk_usage' });
  });
});

// ---------------------------------------------------------------------------
// Final-review fix (#3826): every `executeToolFn` dispatch must run with the
// agent's own tenant-scoped DB access context active — not the system
// context `reloadAndVerifyDigest`/`insertPlaybookExecutionRow` use, and not
// no context at all (which is what `getCurrentDb()` falls back to unscoped,
// and is exactly what made `verifyDeviceAccess` — and every other
// RLS-guarded read `executeTool` performs — deny outright). These tests
// drive `runPlaybookSteps` directly and assert, from INSIDE the stubbed
// `executeToolFn`, that a real (non-system, non-undefined) context is open
// at the moment of dispatch — the thing the pre-fix code never provided.
// ---------------------------------------------------------------------------
describe('runPlaybookSteps — DB access context wiring', () => {
  const SCOPED_AGENT_AUTH = {
    principal: { kind: 'ai_agent', agentId: 'agent-1', runId: 'run-1' },
    user: { id: 'agent-1', email: 'agent+agent-1@breeze.internal', name: 'Agent', isPlatformAdmin: false },
    token: null,
    partnerId: 'partner-1',
    orgId: 'org-1',
    scope: 'organization',
    accessibleOrgIds: ['org-1'],
  } as unknown as AuthContext;

  it('opens an org-scoped DB access context around a diagnose dispatch, and closes it after', async () => {
    let scopeDuringDispatch: string | undefined;
    const deps = makeDeps({
      executeToolFn: vi.fn(async () => {
        scopeDuringDispatch = dbMockState.ambientContext?.scope;
        return JSON.stringify({ ok: true });
      }),
    });
    const steps: PlaybookStep[] = [
      { type: 'diagnose', name: 'baseline', description: '', tool: 'analyze_disk_usage', toolInput: { deviceId: 'device-1' } },
    ];
    await runPlaybookSteps(steps, {
      run: RUN, agentAuth: SCOPED_AGENT_AUTH, deps, reserved: { count: 0 }, deadlineMs: FAR_FUTURE_DEADLINE,
    });
    expect(scopeDuringDispatch).toBe('organization');
    expect(dbMockState.ambientContext).toBeUndefined();
  });

  it('opens an org-scoped DB access context around a mutating act-step dispatch', async () => {
    let scopeDuringDispatch: string | undefined;
    const deps = makeDeps({
      revalidate: vi.fn(async () => okRevalidation(restartOp)),
      executeToolFn: vi.fn(async () => {
        scopeDuringDispatch = dbMockState.ambientContext?.scope;
        return JSON.stringify({ status: 'completed' });
      }),
    });
    const steps: PlaybookStep[] = [
      {
        type: 'act', name: 'restart svc', description: '', tool: 'manage_services',
        toolInput: { deviceId: 'device-1', action: 'restart', serviceName: 'Spooler' },
      },
    ];
    await runPlaybookSteps(steps, {
      run: RUN, agentAuth: SCOPED_AGENT_AUTH, deps, reserved: { count: 0 }, deadlineMs: FAR_FUTURE_DEADLINE,
    });
    expect(scopeDuringDispatch).toBe('organization');
  });

  it('opens an org-scoped DB access context around the known-safe non-mutating disk_cleanup preview read', async () => {
    let scopeDuringDispatch: string | undefined;
    const deps = makeDeps({
      executeToolFn: vi.fn(async () => {
        scopeDuringDispatch = dbMockState.ambientContext?.scope;
        return JSON.stringify({ candidates: [] });
      }),
    });
    const steps: PlaybookStep[] = [
      { type: 'act', name: 'preview', description: '', tool: 'disk_cleanup', toolInput: { deviceId: 'device-1', action: 'preview' } },
    ];
    await runPlaybookSteps(steps, {
      run: RUN, agentAuth: SCOPED_AGENT_AUTH, deps, reserved: { count: 0 }, deadlineMs: FAR_FUTURE_DEADLINE,
    });
    expect(scopeDuringDispatch).toBe('organization');
  });
});

describe('runPlaybookSteps — act (mutating, manifest-admitted)', () => {
  it('revalidates + reserves each mutating step individually, then dispatches', async () => {
    const reserved = { count: 0 };
    const revalidate = vi.fn(async (args: { reserved: { count: number } }) => {
      args.reserved.count += 1;
      return okRevalidation(restartOp);
    });
    const deps = makeDeps({
      revalidate,
      executeToolFn: vi.fn(async () => JSON.stringify({ status: 'completed' })),
    });
    const steps: PlaybookStep[] = [
      {
        type: 'act', name: 'restart svc', description: '', tool: 'manage_services',
        toolInput: { deviceId: 'device-1', action: 'restart', serviceName: 'Spooler' },
      },
    ];
    const outcome = await runPlaybookSteps(steps, {
      run: RUN, agentAuth: AGENT_AUTH, deps, reserved, deadlineMs: FAR_FUTURE_DEADLINE,
    });
    expect(outcome.execution).toBe('succeeded');
    expect(revalidate).toHaveBeenCalledTimes(1);
    expect(revalidate.mock.calls[0]![0]).toMatchObject({
      toolName: 'manage_services',
      input: { deviceId: 'device-1', action: 'restart', serviceName: 'Spooler' },
      reserved,
    });
    expect(reserved.count).toBe(1);
  });

  it('a mutating step whose dispatch reports failed aborts the playbook', async () => {
    const deps = makeDeps({
      revalidate: vi.fn(async () => okRevalidation(restartOp)),
      executeToolFn: vi.fn(async () => JSON.stringify({ status: 'failed', error: 'boom' })),
    });
    const steps: PlaybookStep[] = [
      { type: 'act', name: 'restart svc', description: '', tool: 'manage_services', toolInput: { action: 'restart' } },
      { type: 'wait', name: 'never runs', description: '', waitSeconds: 5 },
    ];
    const outcome = await runPlaybookSteps(steps, {
      run: RUN, agentAuth: AGENT_AUTH, deps, reserved: { count: 0 }, deadlineMs: FAR_FUTURE_DEADLINE,
    });
    expect(outcome.execution).toBe('failed');
    expect(outcome.status).toBe('failed');
    expect(outcome.results).toHaveLength(1);
    expect(deps.sleepFn).not.toHaveBeenCalled();
  });

  it('deny from revalidation aborts the playbook — never a proposal mid-playbook', async () => {
    const deps = makeDeps({
      revalidate: vi.fn(async (): Promise<ActRevalidationResult> => ({ ok: false, deny: 'protected resource' })),
    });
    const steps: PlaybookStep[] = [
      { type: 'act', name: 'restart svc', description: '', tool: 'manage_services', toolInput: { action: 'restart' } },
    ];
    const outcome = await runPlaybookSteps(steps, {
      run: RUN, agentAuth: AGENT_AUTH, deps, reserved: { count: 0 }, deadlineMs: FAR_FUTURE_DEADLINE,
    });
    expect(outcome.execution).toBe('failed');
    expect(outcome.detail).toContain('protected resource');
    expect(deps.executeToolFn).not.toHaveBeenCalled();
  });

  it('cap-exhaustion downgrade also aborts the playbook (no mid-playbook proposal path)', async () => {
    const deps = makeDeps({
      revalidate: vi.fn(async (): Promise<ActRevalidationResult> => ({ ok: false, downgrade: 'propose' })),
    });
    const steps: PlaybookStep[] = [
      { type: 'act', name: 'restart svc', description: '', tool: 'manage_services', toolInput: { action: 'restart' } },
    ];
    const outcome = await runPlaybookSteps(steps, {
      run: RUN, agentAuth: AGENT_AUTH, deps, reserved: { count: 0 }, deadlineMs: FAR_FUTURE_DEADLINE,
    });
    expect(outcome.execution).toBe('failed');
    // No `reason` on this downgrade (drift/cap-exhaustion shape) — falls back
    // to the canned text, exactly as before.
    expect(outcome.detail).toContain('drift or the action cap is exhausted');
  });

  it('#3826 cheap nonblocking fix: a downgrade WITH a reason surfaces that reason, not the canned drift/cap text', async () => {
    const deps = makeDeps({
      revalidate: vi.fn(async (): Promise<ActRevalidationResult> => ({
        ok: false, downgrade: 'propose', reason: 'serviceName is required',
      })),
    });
    const steps: PlaybookStep[] = [
      { type: 'act', name: 'restart svc', description: '', tool: 'manage_services', toolInput: { action: 'restart' } },
    ];
    const outcome = await runPlaybookSteps(steps, {
      run: RUN, agentAuth: AGENT_AUTH, deps, reserved: { count: 0 }, deadlineMs: FAR_FUTURE_DEADLINE,
    });
    expect(outcome.execution).toBe('failed');
    expect(outcome.detail).toContain('serviceName is required');
    expect(outcome.detail).not.toContain('drift or the action cap is exhausted');
  });
});

describe('runPlaybookSteps — act (non-mutating, known-safe): disk_cleanup preview', () => {
  it('dispatches as a plain read, no reservation, playbook continues', async () => {
    const deps = makeDeps({
      executeToolFn: vi.fn(async () => JSON.stringify({ candidates: [] })),
    });
    const steps: PlaybookStep[] = [
      { type: 'act', name: 'preview', description: '', tool: 'disk_cleanup', toolInput: { deviceId: 'device-1', action: 'preview' } },
    ];
    const outcome = await runPlaybookSteps(steps, {
      run: RUN, agentAuth: AGENT_AUTH, deps, reserved: { count: 0 }, deadlineMs: FAR_FUTURE_DEADLINE,
    });
    expect(outcome.execution).toBe('succeeded');
    expect(deps.revalidate).not.toHaveBeenCalled();
  });
});

describe('runPlaybookSteps — act (unadmitted, unvetted): fail closed', () => {
  it('aborts the playbook rather than guessing at safety', async () => {
    const deps = makeDeps();
    const steps: PlaybookStep[] = [
      { type: 'act', name: 'mystery', description: '', tool: 'manage_processes', toolInput: { action: 'list' } },
    ];
    const outcome = await runPlaybookSteps(steps, {
      run: RUN, agentAuth: AGENT_AUTH, deps, reserved: { count: 0 }, deadlineMs: FAR_FUTURE_DEADLINE,
    });
    expect(outcome.execution).toBe('failed');
    expect(outcome.detail).toContain('not a manifest-admitted');
  });
});

describe('runPlaybookSteps — wait', () => {
  it('caps waitSeconds at 60 and never exceeds the remaining deadline', async () => {
    const deps = makeDeps();
    const steps: PlaybookStep[] = [
      { type: 'wait', name: 'long wait', description: '', waitSeconds: 300 },
    ];
    await runPlaybookSteps(steps, {
      run: RUN, agentAuth: AGENT_AUTH, deps, reserved: { count: 0 }, deadlineMs: FAR_FUTURE_DEADLINE,
    });
    const calledWith = (deps.sleepFn as ReturnType<typeof vi.fn>).mock.calls[0]![0] as number;
    expect(calledWith).toBeLessThanOrEqual(60_000);
    expect(calledWith).toBeGreaterThan(58_000);
  });

  it('never sleeps past the deadline even when waitSeconds is under the 60s cap', async () => {
    const deps = makeDeps();
    const steps: PlaybookStep[] = [
      { type: 'wait', name: 'short wait', description: '', waitSeconds: 30 },
    ];
    const deadlineMs = Date.now() + 2_000;
    await runPlaybookSteps(steps, {
      run: RUN, agentAuth: AGENT_AUTH, deps, reserved: { count: 0 }, deadlineMs,
    });
    const calledWith = (deps.sleepFn as ReturnType<typeof vi.fn>).mock.calls[0]![0] as number;
    expect(calledWith).toBeLessThanOrEqual(2_000);
  });
});

describe('runPlaybookSteps — verify (service_status)', () => {
  function serviceStep(onFailure?: 'stop' | 'continue'): PlaybookStep {
    return {
      type: 'verify', name: 'check running', description: '', tool: 'manage_services',
      toolInput: { deviceId: 'device-1', action: 'list', serviceName: 'Spooler' },
      verifyCondition: { metric: 'service_status', operator: 'eq', value: 'running' },
      ...(onFailure ? { onFailure } : {}),
    };
  }

  it('running (case-insensitive) → passed, reads via executeCommandFn with a search filter (not the broken manage_services tool)', async () => {
    const executeCommandFn = vi.fn(async () => ({
      status: 'completed' as const, stdout: JSON.stringify({ services: [{ name: 'Spooler', status: 'Running' }] }),
    }));
    const deps = makeDeps({ executeCommandFn });
    const outcome = await runPlaybookSteps([serviceStep()], {
      run: RUN, agentAuth: AGENT_AUTH, deps, reserved: { count: 0 }, deadlineMs: FAR_FUTURE_DEADLINE,
    });
    expect(outcome.verification).toBe('passed');
    expect(outcome.execution).toBe('succeeded');
    // Review fix regression guard: the manage_services TOOL only forwards
    // `name`, which the agent's ListServices command ignores — the read-back
    // must go through `search` directly, or it silently returns page 1 of an
    // unfiltered list on a real device.
    expect(executeCommandFn).toHaveBeenCalledWith(
      'device-1', 'list_services', { search: 'Spooler' }, expect.objectContaining({ userId: 'agent-1' }),
    );
    expect(deps.executeToolFn).not.toHaveBeenCalled();
  });

  it('stopped → failed, onFailure stop halts remaining steps', async () => {
    const deps = makeDeps({
      executeCommandFn: vi.fn(async () => ({
        status: 'completed' as const, stdout: JSON.stringify({ services: [{ name: 'Spooler', status: 'Stopped' }] }),
      })),
    });
    const steps = [serviceStep('stop'), { type: 'wait' as const, name: 'never', description: '', waitSeconds: 1 }];
    const outcome = await runPlaybookSteps(steps, {
      run: RUN, agentAuth: AGENT_AUTH, deps, reserved: { count: 0 }, deadlineMs: FAR_FUTURE_DEADLINE,
    });
    expect(outcome.verification).toBe('failed');
    // Verify-failure alone does not flip execution — see actVerify.ts's own
    // (execution, verification) pair philosophy.
    expect(outcome.execution).toBe('succeeded');
    expect(outcome.results).toHaveLength(1);
  });

  it('stopped with onFailure continue → failed verification, but the loop continues', async () => {
    const deps = makeDeps({
      executeCommandFn: vi.fn(async () => ({
        status: 'completed' as const, stdout: JSON.stringify({ services: [{ name: 'Spooler', status: 'Stopped' }] }),
      })),
    });
    const steps = [serviceStep('continue'), { type: 'wait' as const, name: 'runs anyway', description: '', waitSeconds: 1 }];
    const outcome = await runPlaybookSteps(steps, {
      run: RUN, agentAuth: AGENT_AUTH, deps, reserved: { count: 0 }, deadlineMs: FAR_FUTURE_DEADLINE,
    });
    expect(outcome.verification).toBe('failed');
    expect(outcome.results).toHaveLength(2);
  });

  it('service not found in the (correctly filtered) read-back → inconclusive, not a false pass', async () => {
    const deps = makeDeps({
      executeCommandFn: vi.fn(async () => ({ status: 'completed' as const, stdout: JSON.stringify({ services: [] }) })),
    });
    const outcome = await runPlaybookSteps([serviceStep('continue')], {
      run: RUN, agentAuth: AGENT_AUTH, deps, reserved: { count: 0 }, deadlineMs: FAR_FUTURE_DEADLINE,
    });
    expect(outcome.verification).toBe('inconclusive');
  });
});

describe('runPlaybookSteps — verify (disk_usage_percent)', () => {
  it('reads deviceDisks directly and evaluates lt', async () => {
    dbMockState.diskRows = [{ usedPercent: 42 }];
    const deps = makeDeps();
    const step: PlaybookStep = {
      type: 'verify', name: 'check disk', description: '', tool: 'analyze_disk_usage', toolInput: {},
      verifyCondition: { metric: 'disk_usage_percent', operator: 'lt', value: 90 }, onFailure: 'stop',
    };
    const outcome = await runPlaybookSteps([step], {
      run: RUN, agentAuth: AGENT_AUTH, deps, reserved: { count: 0 }, deadlineMs: FAR_FUTURE_DEADLINE,
    });
    expect(outcome.verification).toBe('passed');
  });

  it('above threshold → failed', async () => {
    dbMockState.diskRows = [{ usedPercent: 95 }];
    const deps = makeDeps();
    const step: PlaybookStep = {
      type: 'verify', name: 'check disk', description: '', tool: 'analyze_disk_usage', toolInput: {},
      verifyCondition: { metric: 'disk_usage_percent', operator: 'lt', value: 90 }, onFailure: 'stop',
    };
    const outcome = await runPlaybookSteps([step], {
      run: RUN, agentAuth: AGENT_AUTH, deps, reserved: { count: 0 }, deadlineMs: FAR_FUTURE_DEADLINE,
    });
    expect(outcome.verification).toBe('failed');
  });
});

describe('runPlaybookSteps — verify (ram_usage_percent)', () => {
  it('reads analyze_metrics summary.ram.current', async () => {
    const deps = makeDeps({
      executeToolFn: vi.fn(async () => JSON.stringify({ summary: { ram: { current: 60 } } })),
    });
    const step: PlaybookStep = {
      type: 'verify', name: 'check ram', description: '', tool: 'analyze_metrics', toolInput: {},
      verifyCondition: { metric: 'ram_usage_percent', operator: 'lt', value: 85 }, onFailure: 'stop',
    };
    const outcome = await runPlaybookSteps([step], {
      run: RUN, agentAuth: AGENT_AUTH, deps, reserved: { count: 0 }, deadlineMs: FAR_FUTURE_DEADLINE,
    });
    expect(outcome.verification).toBe('passed');
  });
});

describe('runPlaybookSteps — verify (unknown metric)', () => {
  it('inconclusive, onFailure respected', async () => {
    const deps = makeDeps();
    const step: PlaybookStep = {
      type: 'verify', name: 'check mystery', description: '', tool: 'analyze_metrics', toolInput: {},
      verifyCondition: { metric: 'cpu_temperature', operator: 'lt', value: 80 }, onFailure: 'continue',
    };
    const outcome = await runPlaybookSteps([step, { type: 'wait', name: 'w', description: '', waitSeconds: 1 }], {
      run: RUN, agentAuth: AGENT_AUTH, deps, reserved: { count: 0 }, deadlineMs: FAR_FUTURE_DEADLINE,
    });
    expect(outcome.verification).toBe('inconclusive');
    expect(outcome.results).toHaveLength(2);
  });
});

describe('runPlaybookSteps — wall clock', () => {
  it('a step starting after the deadline is skipped, execution = timeout', async () => {
    const deps = makeDeps();
    const steps: PlaybookStep[] = [
      { type: 'wait', name: 'w', description: '', waitSeconds: 1 },
    ];
    const outcome = await runPlaybookSteps(steps, {
      run: RUN, agentAuth: AGENT_AUTH, deps, reserved: { count: 0 }, deadlineMs: Date.now() - 1,
    });
    expect(outcome.execution).toBe('timeout');
    expect(outcome.results[0]!.status).toBe('skipped');
  });
});

describe('runPlaybookSteps — rollback', () => {
  it('a rollback-typed step stops with a note, never attempts to undo anything', async () => {
    const deps = makeDeps();
    const steps: PlaybookStep[] = [{ type: 'rollback', name: 'undo', description: '' }];
    const outcome = await runPlaybookSteps(steps, {
      run: RUN, agentAuth: AGENT_AUTH, deps, reserved: { count: 0 }, deadlineMs: FAR_FUTURE_DEADLINE,
    });
    expect(outcome.execution).toBe('failed');
    expect(outcome.results[0]).toMatchObject({ status: 'skipped' });
  });
});

describe('runPlaybookSteps — exception safety', () => {
  it('a thrown error from a diagnose dispatch aborts as execution: unknown, never throws out', async () => {
    const deps = makeDeps({ executeToolFn: vi.fn(async () => { throw new Error('network blip'); }) });
    const steps: PlaybookStep[] = [
      { type: 'diagnose', name: 'baseline', description: '', tool: 'analyze_disk_usage', toolInput: {} },
    ];
    const outcome = await runPlaybookSteps(steps, {
      run: RUN, agentAuth: AGENT_AUTH, deps, reserved: { count: 0 }, deadlineMs: FAR_FUTURE_DEADLINE,
    });
    expect(outcome.execution).toBe('unknown');
    expect(outcome.detail).toContain('network blip');
  });
});

// ---------------------------------------------------------------------------
// executeBuiltInPlaybookForRun — digest pin + DB row lifecycle
// ---------------------------------------------------------------------------

describe('executeBuiltInPlaybookForRun — digest pin', () => {
  const steps: PlaybookStep[] = [
    { type: 'diagnose', name: 'baseline', description: '', tool: 'analyze_disk_usage', toolInput: { deviceId: '{{deviceId}}' } },
  ];

  it('mismatched digest aborts before any step runs, no DB row created', async () => {
    dbMockState.playbookRows = [{
      id: 'pb-1', name: 'Disk Cleanup', steps, isBuiltIn: true, isActive: true, orgId: null,
    }];
    const result = await executeBuiltInPlaybookForRun({
      run: RUN, agentAuth: AGENT_AUTH, playbookId: 'pb-1', expectedDigest: 'wrong-digest',
      variables: {}, reserved: { count: 0 }, deadlineMs: FAR_FUTURE_DEADLINE,
      deps: { executeToolFn: vi.fn() },
    });
    expect(result.execution).toBe('failed');
    expect(result.verifyDetail).toContain('changed since it was pinned');
    expect(dbMockState.insertedExecutions).toHaveLength(0);
  });

  it('a playbook that is no longer built-in/active aborts', async () => {
    dbMockState.playbookRows = [{
      id: 'pb-1', name: 'Disk Cleanup', steps, isBuiltIn: true, isActive: false, orgId: null,
    }];
    const result = await executeBuiltInPlaybookForRun({
      run: RUN, agentAuth: AGENT_AUTH, playbookId: 'pb-1', expectedDigest: 'anything',
      variables: {}, reserved: { count: 0 }, deadlineMs: FAR_FUTURE_DEADLINE,
    });
    expect(result.execution).toBe('failed');
    expect(result.verifyDetail).toContain('no longer an active built-in');
  });

  it('matching digest proceeds, creates and finalizes the playbook_executions row', async () => {
    const { createHash } = await import('node:crypto');
    const digest = createHash('sha256').update(JSON.stringify(steps)).digest('hex');
    dbMockState.playbookRows = [{
      id: 'pb-1', name: 'Disk Cleanup', steps, isBuiltIn: true, isActive: true, orgId: null,
    }];
    dbMockState.userRows = [{ id: 'agent-1' }];
    const deps = makeDeps({ executeToolFn: vi.fn(async () => JSON.stringify({ ok: true })) });
    const result = await executeBuiltInPlaybookForRun({
      run: RUN, agentAuth: AGENT_AUTH, playbookId: 'pb-1', expectedDigest: digest,
      variables: {}, reserved: { count: 0 }, deadlineMs: FAR_FUTURE_DEADLINE, deps,
    });
    expect(result.execution).toBe('succeeded');
    expect(result.playbookExecutionId).toBe('exec-1');
    expect(dbMockState.insertedExecutions).toHaveLength(1);
    expect(dbMockState.insertedExecutions[0]).toMatchObject({ orgId: 'org-1', deviceId: 'device-1', triggeredBy: 'ai', triggeredByUserId: 'agent-1' });
    expect(dbMockState.updatedExecutions).toHaveLength(1);
    expect(dbMockState.updatedExecutions[0]!.set).toMatchObject({ status: 'completed' });
  });

  it('an insert failure is non-fatal — the playbook still executes for real', async () => {
    const { createHash } = await import('node:crypto');
    const digest = createHash('sha256').update(JSON.stringify(steps)).digest('hex');
    dbMockState.playbookRows = [{
      id: 'pb-1', name: 'Disk Cleanup', steps, isBuiltIn: true, isActive: true, orgId: null,
    }];
    dbMockState.insertShouldThrow = true;
    const deps = makeDeps({ executeToolFn: vi.fn(async () => JSON.stringify({ ok: true })) });
    const result = await executeBuiltInPlaybookForRun({
      run: RUN, agentAuth: AGENT_AUTH, playbookId: 'pb-1', expectedDigest: digest,
      variables: {}, reserved: { count: 0 }, deadlineMs: FAR_FUTURE_DEADLINE, deps,
    });
    expect(result.execution).toBe('succeeded');
    expect(result.playbookExecutionId).toBeNull();
    expect(deps.executeToolFn).toHaveBeenCalled();
  });
});

describe('executeBuiltInPlaybookForRun — the run device cannot be overridden by model-supplied variables', () => {
  it('a model-sent variables.deviceId is ignored — every step still dispatches against run.deviceId', async () => {
    const steps: PlaybookStep[] = [
      { type: 'diagnose', name: 'baseline', description: '', tool: 'analyze_disk_usage', toolInput: { deviceId: '{{deviceId}}' } },
    ];
    const { createHash } = await import('node:crypto');
    const digest = createHash('sha256').update(JSON.stringify(steps)).digest('hex');
    dbMockState.playbookRows = [{
      id: 'pb-3', name: 'Disk Cleanup', steps, isBuiltIn: true, isActive: true, orgId: null,
    }];
    const executeToolFn = vi.fn(async () => JSON.stringify({ ok: true }));
    const deps = makeDeps({ executeToolFn });
    const result = await executeBuiltInPlaybookForRun({
      run: RUN, agentAuth: AGENT_AUTH, playbookId: 'pb-3', expectedDigest: digest,
      // A cross-device redirect attempt smuggled in through the model's own
      // execute_playbook tool input — RUN.deviceId is 'device-1'.
      variables: { deviceId: 'attacker-controlled-device' },
      reserved: { count: 0 }, deadlineMs: FAR_FUTURE_DEADLINE, deps,
    });
    expect(result.execution).toBe('succeeded');
    expect(executeToolFn).toHaveBeenCalledWith(
      'analyze_disk_usage', { deviceId: 'device-1' }, AGENT_AUTH,
    );
  });
});

describe('executeBuiltInPlaybookForRun — variable substitution preserves array type', () => {
  it('a bare {{cleanupPaths}} token resolves to the real array, not a comma-joined string', async () => {
    const steps: PlaybookStep[] = [
      {
        type: 'act', name: 'execute cleanup', description: '', tool: 'disk_cleanup',
        toolInput: { deviceId: '{{deviceId}}', action: 'execute', paths: '{{cleanupPaths}}' },
      },
    ];
    const { createHash } = await import('node:crypto');
    const digest = createHash('sha256').update(JSON.stringify(steps)).digest('hex');
    dbMockState.playbookRows = [{
      id: 'pb-2', name: 'Disk Cleanup', steps, isBuiltIn: true, isActive: true, orgId: null,
    }];
    let capturedInput: unknown;
    const deps = makeDeps({
      revalidate: vi.fn(async (revalidateArgs: { input: Record<string, unknown> }) => {
        capturedInput = revalidateArgs.input;
        return okRevalidation(diskCleanupOp);
      }),
      executeToolFn: vi.fn(async () => JSON.stringify({ status: 'executed' })),
    });
    const result = await executeBuiltInPlaybookForRun({
      run: RUN, agentAuth: AGENT_AUTH, playbookId: 'pb-2', expectedDigest: digest,
      variables: { cleanupPaths: ['/tmp/a', '/tmp/b'] }, reserved: { count: 0 }, deadlineMs: FAR_FUTURE_DEADLINE, deps,
    });
    expect(result.execution).toBe('succeeded');
    expect(capturedInput).toMatchObject({ deviceId: 'device-1', action: 'execute', paths: ['/tmp/a', '/tmp/b'] });
  });
});
