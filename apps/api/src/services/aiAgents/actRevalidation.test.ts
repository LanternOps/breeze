import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AI_AGENT_LIMIT_DEFAULTS, type AiAgentPolicy, type AiAgentPolicySnapshot } from '@breeze/shared';

// ---------------------------------------------------------------------------
// db mock — table-name-keyed, same shape as effectivePolicy.test.ts.
// ---------------------------------------------------------------------------
const dbMockState = vi.hoisted(() => ({
  cleanupRunRows: [] as unknown[],
  playbookRows: [] as unknown[],
  // Wave 5A Task 2 (#3827): `ai_kill_state` table branch for the (real,
  // unmocked) `readAiKillState()` this suite exercises through
  // `revalidateActExecution`'s Step 2 refresh — see the "DB kill-state gate"
  // describe block below.
  killStateRows: [{ killed: false, epoch: 0 }] as unknown[],
  killStateShouldThrow: false,
  // Wave 5B Task 4 (#3827): `organizations` (partnerId lookup) and
  // `ai_unattended_exposure` (fleet-percent cap read) table branches for
  // `reserveActUnattendedExposure` — see the "exposure ledger accounting"
  // describe block below.
  organizationRows: [] as unknown[],
  exposureDeviceRows: [] as unknown[],
  // Review fixes (#3827 Task 4): fault-injection flags for the "reserve call
  // is best-effort on flag-off, fail-closed on flag-on" contract.
  exposureReadShouldThrow: false,
  insertExposureShouldThrow: false,
  insertedExposureRows: [] as Record<string, unknown>[],
  advisoryLockCalls: 0,
  ambientContext: undefined as { scope: string } | undefined,
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
            if (tableName === 'device_filesystem_cleanup_runs') return dbMockState.cleanupRunRows;
            if (tableName === 'playbook_definitions') return dbMockState.playbookRows;
            if (tableName === 'ai_kill_state') {
              if (dbMockState.killStateShouldThrow) throw new Error('ai_kill_state read failed (test)');
              return dbMockState.killStateRows;
            }
            if (tableName === 'organizations') return dbMockState.organizationRows;
            throw new Error(`Unexpected table (with limit): ${tableName}`);
          }),
          // `ai_unattended_exposure`'s fleet-check select has no `.limit()`
          // (it reads every exposed device row in the trailing window) — the
          // `where(...)` result itself must be awaitable.
          then: (resolve: (value: unknown[]) => void) => {
            if (tableName === 'ai_unattended_exposure') {
              if (dbMockState.exposureReadShouldThrow) throw new Error('ai_unattended_exposure read failed (test)');
              return resolve(dbMockState.exposureDeviceRows);
            }
            throw new Error(`Unexpected table (awaited without limit): ${tableName}`);
          },
        };
        return builder;
      }),
    })),
    insert: vi.fn((table: unknown) => {
      const tableName = String((table as Record<symbol, unknown>)[Symbol.for('drizzle:Name')]);
      return {
        values: vi.fn(async (values: Record<string, unknown>) => {
          if (tableName === 'ai_unattended_exposure') {
            if (dbMockState.insertExposureShouldThrow) throw new Error('ai_unattended_exposure insert failed (test)');
            dbMockState.insertedExposureRows.push(values);
            return [];
          }
          throw new Error(`Unexpected insert table: ${tableName}`);
        }),
      };
    }),
    execute: vi.fn(async () => {
      dbMockState.advisoryLockCalls += 1;
      return { rows: [] };
    }),
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

const resolveEffectiveAgentSystem = vi.hoisted(() =>
  vi.fn<(orgId: string, kind: string) => Promise<AiAgentPolicySnapshot | null>>());
vi.mock('./effectivePolicy', () => ({ resolveEffectiveAgentSystem }));

const computeEffectDigestForRelease = vi.hoisted(() =>
  vi.fn<(toolName: string, args: Record<string, unknown>, database: unknown) => Promise<
    { digest: string | null; context?: { verifiedRunScript?: unknown } }
  >>());
vi.mock('../actionIntents/effectDigest', () => ({ computeEffectDigestForRelease }));

// `countContractDevices` mocked at the module boundary (like effectivePolicy/
// effectDigest above) rather than growing the hand-rolled `../../db` mock to
// cover the `devices` table's own aggregate-count query shape.
const countContractDevices = vi.hoisted(() => vi.fn<(orgId: string, siteId: string | null) => Promise<number>>());
vi.mock('../contractQuantities', () => ({ countContractDevices }));

import { ACT_MANIFEST } from './actManifest';
import { ACT_DISK_CLEANUP_MAX_BYTES_V1, revalidateActExecution, type ActReservationState } from './actRevalidation';
// Real (unmocked) module — `revalidateActExecution` imports it for real, and
// the "DB kill-state gate" describe block below drives it through the
// `../../db` mock above rather than mocking `../aiKillState` itself, so this
// is genuine coverage of `readAiKillState`'s fail-closed/TTL behavior in
// integration, not a stand-in.
import { _resetAiKillStateCacheForTest } from '../aiKillState';

const ORG_ID = '00000000-0000-4000-8000-0000000000f1';
const AGENT_ID = '00000000-0000-4000-8000-0000000000f2';
const DEVICE_ID = '00000000-0000-4000-8000-0000000000f3';
const SITE_ID = '00000000-0000-4000-8000-0000000000f4';
const RUN_ID = '00000000-0000-4000-8000-0000000000f5';
const SCRIPT_ID = '00000000-0000-4000-8000-0000000000f6';
const PLAYBOOK_ID = '00000000-0000-4000-8000-0000000000f7';
const PARTNER_ID = '00000000-0000-4000-8000-0000000000f8';

const restartOp = ACT_MANIFEST.find((op) => op.key === 'manage_services.restart')!;
const diskCleanupOp = ACT_MANIFEST.find((op) => op.key === 'disk_cleanup.execute')!;
// manage_processes.kill was removed from ACT_MANIFEST (#3826 scoped
// re-review, deferred out of v1: unreachable + unimplemented identity pin)
// — no `killOp` fixture exists anymore; see actManifest.test.ts for its
// unreachability coverage.
const runScriptOp = ACT_MANIFEST.find((op) => op.key === 'run_script')!;
const playbookOp = ACT_MANIFEST.find((op) => op.key === 'execute_playbook')!;

function basePolicy(overrides: Partial<AiAgentPolicy> = {}): AiAgentPolicy {
  return {
    enabled: true,
    mode: 'act',
    model: 'claude-test-model',
    toolAllowlist: ['manage_services', 'disk_cleanup', 'manage_processes', 'run_script', 'execute_playbook'],
    protectedResources: { services: [], paths: [], registryKeys: [], deviceTags: [] },
    limits: { ...AI_AGENT_LIMIT_DEFAULTS, maxActionsPerRun: 3 },
    triggers: { alertSeverities: ['critical', 'high'], respectMaintenanceWindows: true },
    recipients: { userIds: [], roleIds: [] },
    // Task 6 (#3826): SCRIPT_ID pre-authorized by default so the existing
    // run_script pin tests below (written before actAssets existed) keep
    // exercising the asset-pin step, not this gate. Tests of the gate itself
    // override this back to [] / a different id.
    actAssets: { scriptIds: [SCRIPT_ID] },
    instructions: null,
    cooldownSeconds: 900,
    ...overrides,
  };
}

function liveSnapshot(effective: AiAgentPolicy, agentId = AGENT_ID): AiAgentPolicySnapshot {
  return {
    schemaVersion: 2,
    agentId,
    kind: 'triage',
    effective,
    provenance: {} as AiAgentPolicySnapshot['provenance'],
    resolvedAt: new Date('2026-08-27T00:00:00Z').toISOString(),
  };
}

function runArgs(overrides: Partial<Parameters<typeof revalidateActExecution>[0]['run']> = {}) {
  return {
    id: RUN_ID,
    orgId: ORG_ID,
    agentId: AGENT_ID,
    agentKind: 'triage' as const,
    deviceId: DEVICE_ID,
    deviceSiteId: SITE_ID,
    ...overrides,
  };
}

function reservation(count = 0): ActReservationState {
  return { count };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('BREEZE_AI_AGENTS_ENABLED', 'true');
  // Default OFF — matches production default (dark-ship) and keeps every
  // pre-existing test in this file exercising wave-4 behavior (no fleet-cap
  // enforcement) unless a test in the "exposure ledger accounting" block
  // below explicitly stubs it on.
  vi.stubEnv('BREEZE_AI_AGENTS_POLICY_DECIDE_ENABLED', 'false');
  dbMockState.cleanupRunRows = [];
  dbMockState.playbookRows = [];
  dbMockState.killStateRows = [{ killed: false, epoch: 0 }];
  dbMockState.killStateShouldThrow = false;
  dbMockState.organizationRows = [{ partnerId: PARTNER_ID }];
  dbMockState.exposureDeviceRows = [];
  dbMockState.exposureReadShouldThrow = false;
  dbMockState.insertExposureShouldThrow = false;
  dbMockState.insertedExposureRows = [];
  dbMockState.advisoryLockCalls = 0;
  dbMockState.ambientContext = undefined;
  // A prior test's kill state must never leak into the next one via the 5s
  // in-process TTL cache — `readAiKillState` is a real module-level
  // singleton across every test in this file.
  _resetAiKillStateCacheForTest();
  resolveEffectiveAgentSystem.mockReset().mockResolvedValue(liveSnapshot(basePolicy()));
  computeEffectDigestForRelease.mockReset();
  // Large enough that the default AI_AGENT_LIMIT_DEFAULTS.maxFleetPercentPerDay
  // (5%) never exhausts in a pre-existing test even when a test opts the
  // flag on without overriding this — see the ledger describe block for
  // deliberately small values.
  countContractDevices.mockReset().mockResolvedValue(1000);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('revalidateActExecution — step 1: live policy re-resolve', () => {
  it('mode drifted act → shadow converts to a proposal, never a deny', async () => {
    resolveEffectiveAgentSystem.mockResolvedValue(liveSnapshot(basePolicy({ mode: 'shadow' })));
    const result = await revalidateActExecution({
      run: runArgs(), op: restartOp, toolName: 'manage_services',
      input: { deviceId: DEVICE_ID, action: 'restart', serviceName: 'Spooler' },
      reserved: reservation(),
    });
    expect(result).toEqual({ ok: false, downgrade: 'propose' });
  });

  it('agent disabled → deny (fail closed, never a proposal)', async () => {
    resolveEffectiveAgentSystem.mockResolvedValue(liveSnapshot(basePolicy({ enabled: false })));
    const result = await revalidateActExecution({
      run: runArgs(), op: restartOp, toolName: 'manage_services',
      input: { deviceId: DEVICE_ID, action: 'restart', serviceName: 'Spooler' },
      reserved: reservation(),
    });
    expect(result).toEqual({ ok: false, deny: expect.stringMatching(/disabled/i) });
  });

  it('agent mode off → deny', async () => {
    resolveEffectiveAgentSystem.mockResolvedValue(liveSnapshot(basePolicy({ mode: 'off' })));
    const result = await revalidateActExecution({
      run: runArgs(), op: restartOp, toolName: 'manage_services',
      input: { deviceId: DEVICE_ID, action: 'restart', serviceName: 'Spooler' },
      reserved: reservation(),
    });
    expect(result).toEqual({ ok: false, deny: expect.stringMatching(/off/i) });
  });

  it('a same-kind replacement agent (identity mismatch) → deny', async () => {
    resolveEffectiveAgentSystem.mockResolvedValue(liveSnapshot(basePolicy(), 'a-different-agent-id'));
    const result = await revalidateActExecution({
      run: runArgs(), op: restartOp, toolName: 'manage_services',
      input: { deviceId: DEVICE_ID, action: 'restart', serviceName: 'Spooler' },
      reserved: reservation(),
    });
    expect(result).toEqual({ ok: false, deny: expect.stringMatching(/no longer the effective agent/i) });
  });

  it('no effective agent policy resolves (kill switch / no partner baseline) → deny', async () => {
    resolveEffectiveAgentSystem.mockResolvedValue(null);
    const result = await revalidateActExecution({
      run: runArgs(), op: restartOp, toolName: 'manage_services',
      input: { deviceId: DEVICE_ID, action: 'restart', serviceName: 'Spooler' },
      reserved: reservation(),
    });
    expect(result).toEqual({ ok: false, deny: expect.any(String) });
  });

  it('resolveEffectiveAgentSystem throwing → deny, never propagates', async () => {
    resolveEffectiveAgentSystem.mockRejectedValue(new Error('db unavailable'));
    const result = await revalidateActExecution({
      run: runArgs(), op: restartOp, toolName: 'manage_services',
      input: { deviceId: DEVICE_ID, action: 'restart', serviceName: 'Spooler' },
      reserved: reservation(),
    });
    expect(result).toEqual({ ok: false, deny: expect.any(String) });
  });
});

describe('revalidateActExecution — step 2: live guardrail re-run', () => {
  it('allowlist narrowed since admission → deny', async () => {
    resolveEffectiveAgentSystem.mockResolvedValue(liveSnapshot(basePolicy({ toolAllowlist: [] })));
    const result = await revalidateActExecution({
      run: runArgs(), op: restartOp, toolName: 'manage_services',
      input: { deviceId: DEVICE_ID, action: 'restart', serviceName: 'Spooler' },
      reserved: reservation(),
    });
    expect(result).toEqual({ ok: false, deny: expect.stringMatching(/allowlist/i) });
  });

  it('the target service became protected since admission → deny', async () => {
    resolveEffectiveAgentSystem.mockResolvedValue(liveSnapshot(basePolicy({
      protectedResources: { services: ['Spooler'], paths: [], registryKeys: [], deviceTags: [] },
    })));
    const result = await revalidateActExecution({
      run: runArgs(), op: restartOp, toolName: 'manage_services',
      input: { deviceId: DEVICE_ID, action: 'restart', serviceName: 'Spooler' },
      reserved: reservation(),
    });
    expect(result).toEqual({ ok: false, deny: expect.stringMatching(/protected/i) });
  });

  it('an unmatched call under the live policy downgrades to a proposal (isolated mapping check)', async () => {
    // White-box: `op` and `toolName` are independently supplied by the
    // caller (the real pre-hook always derives both from the SAME
    // `resolveActOperation` call, so they never disagree in production) —
    // this exercises step 2's OWN mapping in isolation by giving it a
    // toolName that resolveActOperation can never match (execute_command has
    // no manifest entry), which is exactly what makes checkAgentGuardrails'
    // own act branch return 'propose'.
    resolveEffectiveAgentSystem.mockResolvedValue(liveSnapshot(basePolicy({
      toolAllowlist: [...basePolicy().toolAllowlist, 'execute_command'],
    })));
    const result = await revalidateActExecution({
      run: runArgs(), op: restartOp, toolName: 'execute_command',
      input: { deviceId: DEVICE_ID, commandType: 'restart_service' },
      reserved: reservation(),
    });
    expect(result).toEqual({ ok: false, downgrade: 'propose' });
  });
});

describe('revalidateActExecution — DB kill-state gate (wave 5A Task 2, #3827)', () => {
  it('default (not-killed) row → inert, execution reaches the ok tail exactly as before this PR', async () => {
    const result = await revalidateActExecution({
      run: runArgs(), op: restartOp, toolName: 'manage_services',
      input: { deviceId: DEVICE_ID, action: 'restart', serviceName: 'Spooler' },
      reserved: reservation(),
    });
    expect(result.ok).toBe(true);
  });

  it('refreshes the kill-state cache before the step-2 guardrail re-run: DB read happens exactly once per call', async () => {
    const selectSpy = (await import('../../db')).db.select as unknown as { mock: { calls: unknown[] } };
    const callsBefore = selectSpy.mock.calls.length;
    await revalidateActExecution({
      run: runArgs(), op: restartOp, toolName: 'manage_services',
      input: { deviceId: DEVICE_ID, action: 'restart', serviceName: 'Spooler' },
      reserved: reservation(),
    });
    // One extra `db.select` beyond whatever step 1/3/4 already issue for this
    // op (manage_services.restart needs no asset pin, so the ONLY select this
    // path adds is the kill-state read) — confirms the refresh actually fires
    // rather than silently no-op'ing.
    expect(selectSpy.mock.calls.length).toBeGreaterThan(callsBefore);
  });

  it('kill switch engaged since admission → the live guardrail re-run denies, epoch in the reason', async () => {
    dbMockState.killStateRows = [{ killed: true, epoch: 7 }];
    const result = await revalidateActExecution({
      run: runArgs(), op: restartOp, toolName: 'manage_services',
      input: { deviceId: DEVICE_ID, action: 'restart', serviceName: 'Spooler' },
      reserved: reservation(),
    });
    expect(result).toEqual({
      ok: false,
      deny: expect.stringMatching(/kill-switched/i),
    });
    expect((result as { deny: string }).deny).toContain('7');
  });

  it('kill-state read failure fails closed → denies rather than executing unattended', async () => {
    dbMockState.killStateShouldThrow = true;
    const result = await revalidateActExecution({
      run: runArgs(), op: restartOp, toolName: 'manage_services',
      input: { deviceId: DEVICE_ID, action: 'restart', serviceName: 'Spooler' },
      reserved: reservation(),
    });
    expect(result).toEqual({
      ok: false,
      deny: expect.stringMatching(/kill-switched/i),
    });
  });
});

describe('revalidateActExecution — step 3: device pinning', () => {
  it('a device argument that does not match the run device → deny', async () => {
    const result = await revalidateActExecution({
      run: runArgs(), op: restartOp, toolName: 'manage_services',
      input: { deviceId: 'some-other-device', action: 'restart', serviceName: 'Spooler' },
      reserved: reservation(),
    });
    expect(result.ok).toBe(false);
    expect((result as { deny: string }).deny).toMatch(/Act revalidation/);
  });

  it('run_script targeting a sibling device (deviceIds mismatch) still hard-denies — never softened', async () => {
    const result = await revalidateActExecution({
      run: runArgs(), op: runScriptOp, toolName: 'run_script',
      input: { scriptId: SCRIPT_ID, deviceIds: ['some-other-device'] },
      reserved: reservation(),
    });
    expect(result.ok).toBe(false);
    expect((result as { deny: string }).deny).toMatch(/Act revalidation/);
  });

  // #3826 cheap nonblocking fix: a missing/malformed identity field (NOT a
  // device mismatch) downgrades to a proposal, and the proposal must carry
  // WHY it wasn't auto-executed — the raw `normalized.reason` from
  // `normalizeTarget`, not a blank downgrade a reviewer can't act on.
  it('a missing identity field (not a device mismatch) downgrades to a proposal carrying the normalizeTarget reason', async () => {
    const result = await revalidateActExecution({
      run: runArgs(), op: restartOp, toolName: 'manage_services',
      input: { deviceId: DEVICE_ID, action: 'restart' }, // no serviceName
      reserved: reservation(),
    });
    expect(result).toEqual({ ok: false, downgrade: 'propose', reason: 'serviceName is required' });
  });
});

describe('revalidateActExecution — step 4: run_script asset pin', () => {
  const scriptInput = { scriptId: SCRIPT_ID, deviceIds: [DEVICE_ID] };

  it('an unpinnable script (missing/unreadable) → deny — never falls back to unpinned content', async () => {
    computeEffectDigestForRelease.mockResolvedValue({ digest: null });
    const result = await revalidateActExecution({
      run: runArgs(), op: runScriptOp, toolName: 'run_script', input: scriptInput, reserved: reservation(),
    });
    expect(result).toEqual({ ok: false, deny: expect.stringMatching(/pinned/i) });
  });

  it('a successfully pinned script → ok, carrying the verified content as the tool execution context', async () => {
    const verifiedRunScript = { scriptRow: { id: SCRIPT_ID } };
    computeEffectDigestForRelease.mockResolvedValue({ digest: 'abc123', context: { verifiedRunScript } });
    const result = await revalidateActExecution({
      run: runArgs(), op: runScriptOp, toolName: 'run_script', input: scriptInput, reserved: reservation(),
    });
    expect(result.ok).toBe(true);
    const pin = (result as { ok: true; pin: { toolExecutionContext?: { verifiedRunScript?: unknown } } }).pin;
    expect(pin.toolExecutionContext?.verifiedRunScript).toBe(verifiedRunScript);
    // The digest resolver is given a minimal, rebuilt argument set — never
    // the model's raw input verbatim.
    expect(computeEffectDigestForRelease).toHaveBeenCalledWith(
      'run_script', { scriptId: SCRIPT_ID, deviceIds: [DEVICE_ID] }, expect.anything(),
    );
  });
});

describe('revalidateActExecution — step 3.5: per-script act authorization (Task 6, #3826)', () => {
  const scriptInput = { scriptId: SCRIPT_ID, deviceIds: [DEVICE_ID] };

  it('a script not in actAssets.scriptIds downgrades to a proposal, never a deny', async () => {
    resolveEffectiveAgentSystem.mockResolvedValue(liveSnapshot(basePolicy({ actAssets: { scriptIds: [] } })));
    const result = await revalidateActExecution({
      run: runArgs(), op: runScriptOp, toolName: 'run_script', input: scriptInput, reserved: reservation(),
    });
    expect(result).toEqual({ ok: false, downgrade: 'propose' });
    // Never reaches the I/O asset pin for an unauthorized script.
    expect(computeEffectDigestForRelease).not.toHaveBeenCalled();
  });

  it('a DIFFERENT authorized script does not authorize this one', async () => {
    resolveEffectiveAgentSystem.mockResolvedValue(
      liveSnapshot(basePolicy({ actAssets: { scriptIds: ['00000000-0000-4000-8000-0000000000aa'] } })),
    );
    const result = await revalidateActExecution({
      run: runArgs(), op: runScriptOp, toolName: 'run_script', input: scriptInput, reserved: reservation(),
    });
    expect(result).toEqual({ ok: false, downgrade: 'propose' });
  });

  it('scriptId present in actAssets.scriptIds proceeds to the asset pin', async () => {
    computeEffectDigestForRelease.mockResolvedValue({
      digest: 'abc123', context: { verifiedRunScript: { scriptRow: { id: SCRIPT_ID } } },
    });
    resolveEffectiveAgentSystem.mockResolvedValue(liveSnapshot(basePolicy({ actAssets: { scriptIds: [SCRIPT_ID] } })));
    const result = await revalidateActExecution({
      run: runArgs(), op: runScriptOp, toolName: 'run_script', input: scriptInput, reserved: reservation(),
    });
    expect(result.ok).toBe(true);
  });

  it('does not gate any non-script op', async () => {
    // basePolicy()'s default actAssets ({ scriptIds: [SCRIPT_ID] }) must not
    // accidentally become a dependency for manage_services — the gate only
    // ever inspects a `script` target.
    const result = await revalidateActExecution({
      run: runArgs(), op: restartOp, toolName: 'manage_services',
      input: { deviceId: DEVICE_ID, action: 'restart', serviceName: 'Spooler' },
      reserved: reservation(),
    });
    expect(result.ok).toBe(true);
  });
});

describe('revalidateActExecution — step 4: disk_cleanup asset pin', () => {
  const executeInput = { deviceId: DEVICE_ID, action: 'execute', paths: ['/tmp/a'] };

  function previewRow(overrides: { estimatedBytes?: number; candidatePaths?: string[] } = {}) {
    const candidatePaths = overrides.candidatePaths ?? ['/tmp/a', '/tmp/b'];
    return {
      plan: {
        preview: {
          estimatedBytes: overrides.estimatedBytes ?? 1024,
          candidates: candidatePaths.map((path) => ({
            path, category: 'temp_files', sizeBytes: 512, safe: true,
          })),
        },
      },
    };
  }

  it('no preview plan exists for this device → deny', async () => {
    dbMockState.cleanupRunRows = [];
    const result = await revalidateActExecution({
      run: runArgs(), op: diskCleanupOp, toolName: 'disk_cleanup', input: executeInput, reserved: reservation(),
    });
    expect(result).toEqual({ ok: false, deny: expect.stringMatching(/no disk-cleanup preview plan/i) });
  });

  it('a requested path outside the latest preview → deny', async () => {
    dbMockState.cleanupRunRows = [previewRow({ candidatePaths: ['/tmp/other'] })];
    const result = await revalidateActExecution({
      run: runArgs(), op: diskCleanupOp, toolName: 'disk_cleanup', input: executeInput, reserved: reservation(),
    });
    expect(result).toEqual({ ok: false, deny: expect.stringMatching(/not part of the latest cleanup preview/i) });
  });

  it('a plan exceeding the v1 byte bound → deny', async () => {
    dbMockState.cleanupRunRows = [previewRow({ estimatedBytes: ACT_DISK_CLEANUP_MAX_BYTES_V1 + 1 })];
    const result = await revalidateActExecution({
      run: runArgs(), op: diskCleanupOp, toolName: 'disk_cleanup', input: executeInput, reserved: reservation(),
    });
    expect(result).toEqual({ ok: false, deny: expect.stringMatching(/byte bound/i) });
  });

  it('a valid, in-bound preview plan → ok', async () => {
    dbMockState.cleanupRunRows = [previewRow()];
    const result = await revalidateActExecution({
      run: runArgs(), op: diskCleanupOp, toolName: 'disk_cleanup', input: executeInput, reserved: reservation(),
    });
    expect(result.ok).toBe(true);
  });
});

describe('revalidateActExecution — step 4: execute_playbook asset pin', () => {
  const playbookInput = { deviceId: DEVICE_ID, playbookId: PLAYBOOK_ID };

  it('no such playbook row → downgrades to a proposal, never a deny', async () => {
    dbMockState.playbookRows = [];
    const result = await revalidateActExecution({
      run: runArgs(), op: playbookOp, toolName: 'execute_playbook', input: playbookInput, reserved: reservation(),
    });
    expect(result).toEqual({ ok: false, downgrade: 'propose' });
  });

  it('a custom (org-authored) playbook → downgrades to a proposal — built-ins only execute', async () => {
    dbMockState.playbookRows = [{ isBuiltIn: false, isActive: true, orgId: ORG_ID, steps: [] }];
    const result = await revalidateActExecution({
      run: runArgs(), op: playbookOp, toolName: 'execute_playbook', input: playbookInput, reserved: reservation(),
    });
    expect(result).toEqual({ ok: false, downgrade: 'propose' });
  });

  it('a deactivated built-in playbook → downgrades to a proposal', async () => {
    dbMockState.playbookRows = [{ isBuiltIn: true, isActive: false, orgId: null, steps: [] }];
    const result = await revalidateActExecution({
      run: runArgs(), op: playbookOp, toolName: 'execute_playbook', input: playbookInput, reserved: reservation(),
    });
    expect(result).toEqual({ ok: false, downgrade: 'propose' });
  });

  it('an active built-in playbook → ok, carrying a content digest', async () => {
    dbMockState.playbookRows = [{
      isBuiltIn: true, isActive: true, orgId: null,
      steps: [{ type: 'diagnose', name: 'x' }],
    }];
    const result = await revalidateActExecution({
      run: runArgs(), op: playbookOp, toolName: 'execute_playbook', input: playbookInput, reserved: reservation(),
    });
    expect(result.ok).toBe(true);
    expect((result as { ok: true; pin: { playbookDigest?: string } }).pin.playbookDigest).toEqual(expect.any(String));
  });
});

describe('revalidateActExecution — step 4: manage_services.restart needs no extra pin', () => {
  it('restart: no ASSET-PIN DB read (the only selects are the wave-5A kill-state refresh, step 2, and the wave-5B exposure-ledger org lookup, step 5.5)', async () => {
    const { db } = await import('../../db');
    const result = await revalidateActExecution({
      run: runArgs(), op: restartOp, toolName: 'manage_services',
      input: { deviceId: DEVICE_ID, action: 'restart', serviceName: 'Spooler' },
      reserved: reservation(),
    });
    expect(result).toEqual({
      ok: true,
      pin: { op: restartOp, target: { kind: 'service', serviceName: 'Spooler' } },
    });
    // Exactly two — the kill-state read (#3827 Task 2) and the exposure-
    // ledger org/partner lookup (#3827 Task 4, unconditional regardless of
    // the flag). A 'service' target needs no asset pin (see pinAsset's
    // 'service' branch), so a third select here would mean step 4
    // regressed into doing I/O it doesn't need.
    expect(db.select).toHaveBeenCalledTimes(2);
  });
});

describe('revalidateActExecution — step 5: maxActionsPerRun reservation', () => {
  it('reserves a slot (increments the shared counter) only on a real ok', async () => {
    const reserved = reservation(0);
    await revalidateActExecution({
      run: runArgs(), op: restartOp, toolName: 'manage_services',
      input: { deviceId: DEVICE_ID, action: 'restart', serviceName: 'Spooler' },
      reserved,
    });
    expect(reserved.count).toBe(1);
  });

  it('a deny never consumes a reservation slot', async () => {
    resolveEffectiveAgentSystem.mockResolvedValue(liveSnapshot(basePolicy({ enabled: false })));
    const reserved = reservation(0);
    await revalidateActExecution({
      run: runArgs(), op: restartOp, toolName: 'manage_services',
      input: { deviceId: DEVICE_ID, action: 'restart', serviceName: 'Spooler' },
      reserved,
    });
    expect(reserved.count).toBe(0);
  });

  it('an exhausted cap downgrades to a proposal instead of executing', async () => {
    resolveEffectiveAgentSystem.mockResolvedValue(liveSnapshot(basePolicy({
      limits: { ...AI_AGENT_LIMIT_DEFAULTS, maxActionsPerRun: 1 },
    })));
    const reserved = reservation(1); // already at the cap
    const result = await revalidateActExecution({
      run: runArgs(), op: restartOp, toolName: 'manage_services',
      input: { deviceId: DEVICE_ID, action: 'restart', serviceName: 'Spooler' },
      reserved,
    });
    expect(result).toEqual({ ok: false, downgrade: 'propose' });
    expect(reserved.count).toBe(1); // unchanged — never double-reserved
  });

  it('the cap is read from the LIVE resolved policy, not a stale caller value', async () => {
    resolveEffectiveAgentSystem.mockResolvedValue(liveSnapshot(basePolicy({
      limits: { ...AI_AGENT_LIMIT_DEFAULTS, maxActionsPerRun: 5 },
    })));
    const reserved = reservation(4);
    const result = await revalidateActExecution({
      run: runArgs(), op: restartOp, toolName: 'manage_services',
      input: { deviceId: DEVICE_ID, action: 'restart', serviceName: 'Spooler' },
      reserved,
    });
    expect(result.ok).toBe(true);
    expect(reserved.count).toBe(5);
  });
});

describe('revalidateActExecution — step 5.5: unattended-exposure ledger accounting (#3827 Task 4)', () => {
  it('flag off: still writes the exposure row (accounting is truth, flag-independent)', async () => {
    const reserved = reservation(0);
    const result = await revalidateActExecution({
      run: runArgs(), op: restartOp, toolName: 'manage_services',
      input: { deviceId: DEVICE_ID, action: 'restart', serviceName: 'Spooler' },
      reserved,
    });
    expect(result.ok).toBe(true);
    expect(dbMockState.insertedExposureRows).toEqual([
      {
        orgId: ORG_ID,
        partnerId: PARTNER_ID,
        agentId: AGENT_ID,
        runId: RUN_ID,
        deviceId: DEVICE_ID,
        intentId: null,
        source: 'act',
      },
    ]);
  });

  it('flag off: no fleet-percent cap enforced — a scenario that WOULD exceed it still succeeds, and no advisory lock is taken', async () => {
    countContractDevices.mockResolvedValue(1); // allowance = floor(1 * 5 / 100) = 0
    dbMockState.exposureDeviceRows = [{ deviceId: 'already-exposed-device' }];
    const reserved = reservation(0);
    const result = await revalidateActExecution({
      run: runArgs(), op: restartOp, toolName: 'manage_services',
      input: { deviceId: DEVICE_ID, action: 'restart', serviceName: 'Spooler' },
      reserved,
    });
    expect(result.ok).toBe(true);
    expect(dbMockState.advisoryLockCalls).toBe(0);
    expect(dbMockState.insertedExposureRows.length).toBe(1);
  });

  it('flag on: an exhausted fleet-percent cap downgrades to a proposal, writes no row, and does not consume a maxActionsPerRun slot', async () => {
    vi.stubEnv('BREEZE_AI_AGENTS_POLICY_DECIDE_ENABLED', 'true');
    countContractDevices.mockResolvedValue(10); // allowance = floor(10 * 5 / 100) = 0
    const reserved = reservation(0);
    const result = await revalidateActExecution({
      run: runArgs(), op: restartOp, toolName: 'manage_services',
      input: { deviceId: DEVICE_ID, action: 'restart', serviceName: 'Spooler' },
      reserved,
    });
    expect(result).toEqual({ ok: false, downgrade: 'propose' });
    expect(dbMockState.advisoryLockCalls).toBe(1);
    expect(dbMockState.insertedExposureRows).toEqual([]);
    expect(reserved.count).toBe(0);
  });

  it('flag on: within the fleet-percent cap → the exposure row is written and the call executes', async () => {
    vi.stubEnv('BREEZE_AI_AGENTS_POLICY_DECIDE_ENABLED', 'true');
    countContractDevices.mockResolvedValue(100); // allowance = floor(100 * 5 / 100) = 5
    const reserved = reservation(0);
    const result = await revalidateActExecution({
      run: runArgs(), op: restartOp, toolName: 'manage_services',
      input: { deviceId: DEVICE_ID, action: 'restart', serviceName: 'Spooler' },
      reserved,
    });
    expect(result.ok).toBe(true);
    expect(dbMockState.advisoryLockCalls).toBe(1);
    expect(dbMockState.insertedExposureRows.length).toBe(1);
    expect(reserved.count).toBe(1);
  });

  it('flag on: a device already exposed in the trailing 24h does not double-count against the fleet cap', async () => {
    vi.stubEnv('BREEZE_AI_AGENTS_POLICY_DECIDE_ENABLED', 'true');
    countContractDevices.mockResolvedValue(20); // allowance = floor(20 * 5 / 100) = 1
    // This run's OWN device is already in the exposed set — re-exposing it
    // must not push the projected count to 2 and exhaust a 1-device
    // allowance.
    dbMockState.exposureDeviceRows = [{ deviceId: DEVICE_ID }];
    const result = await revalidateActExecution({
      run: runArgs(), op: restartOp, toolName: 'manage_services',
      input: { deviceId: DEVICE_ID, action: 'restart', serviceName: 'Spooler' },
      reserved: reservation(0),
    });
    expect(result.ok).toBe(true);
  });

  it('an exhausted maxActionsPerRun cap is checked first — the cheap in-memory check never reaches the DB-backed fleet check', async () => {
    vi.stubEnv('BREEZE_AI_AGENTS_POLICY_DECIDE_ENABLED', 'true');
    resolveEffectiveAgentSystem.mockResolvedValue(liveSnapshot(basePolicy({
      limits: { ...AI_AGENT_LIMIT_DEFAULTS, maxActionsPerRun: 1 },
    })));
    const reserved = reservation(1); // already at the cap
    const result = await revalidateActExecution({
      run: runArgs(), op: restartOp, toolName: 'manage_services',
      input: { deviceId: DEVICE_ID, action: 'restart', serviceName: 'Spooler' },
      reserved,
    });
    expect(result).toEqual({ ok: false, downgrade: 'propose' });
    expect(dbMockState.advisoryLockCalls).toBe(0);
    expect(dbMockState.insertedExposureRows).toEqual([]);
  });

  it('review fix: flag off + ledger insert throws → accounting failure is best-effort, the act call still executes and reserves its slot', async () => {
    dbMockState.insertExposureShouldThrow = true;
    const reserved = reservation(0);
    const result = await revalidateActExecution({
      run: runArgs(), op: restartOp, toolName: 'manage_services',
      input: { deviceId: DEVICE_ID, action: 'restart', serviceName: 'Spooler' },
      reserved,
    });
    expect(result.ok).toBe(true);
    expect(reserved.count).toBe(1);
    expect(dbMockState.insertedExposureRows).toEqual([]);
  });

  it('review fix: flag on + fleet-cap read throws → fails CLOSED (downgrades to a proposal), writes no row, and never grants capacity', async () => {
    vi.stubEnv('BREEZE_AI_AGENTS_POLICY_DECIDE_ENABLED', 'true');
    dbMockState.exposureReadShouldThrow = true;
    const reserved = reservation(0);
    const result = await revalidateActExecution({
      run: runArgs(), op: restartOp, toolName: 'manage_services',
      input: { deviceId: DEVICE_ID, action: 'restart', serviceName: 'Spooler' },
      reserved,
    });
    expect(result).toEqual({ ok: false, downgrade: 'propose' });
    expect(dbMockState.insertedExposureRows).toEqual([]);
    expect(reserved.count).toBe(0);
  });
});
