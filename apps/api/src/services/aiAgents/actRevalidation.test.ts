import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AI_AGENT_LIMIT_DEFAULTS, type AiAgentPolicy, type AiAgentPolicySnapshot } from '@breeze/shared';

// ---------------------------------------------------------------------------
// db mock — table-name-keyed, same shape as effectivePolicy.test.ts.
// ---------------------------------------------------------------------------
const dbMockState = vi.hoisted(() => ({
  cleanupRunRows: [] as unknown[],
  playbookRows: [] as unknown[],
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
            throw new Error(`Unexpected table: ${tableName}`);
          }),
        };
        return builder;
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

const resolveEffectiveAgentSystem = vi.hoisted(() =>
  vi.fn<(orgId: string, kind: string) => Promise<AiAgentPolicySnapshot | null>>());
vi.mock('./effectivePolicy', () => ({ resolveEffectiveAgentSystem }));

const computeEffectDigestForRelease = vi.hoisted(() =>
  vi.fn<(toolName: string, args: Record<string, unknown>, database: unknown) => Promise<
    { digest: string | null; context?: { verifiedRunScript?: unknown } }
  >>());
vi.mock('../actionIntents/effectDigest', () => ({ computeEffectDigestForRelease }));

import { ACT_MANIFEST } from './actManifest';
import { ACT_DISK_CLEANUP_MAX_BYTES_V1, revalidateActExecution, type ActReservationState } from './actRevalidation';

const ORG_ID = '00000000-0000-4000-8000-0000000000f1';
const AGENT_ID = '00000000-0000-4000-8000-0000000000f2';
const DEVICE_ID = '00000000-0000-4000-8000-0000000000f3';
const SITE_ID = '00000000-0000-4000-8000-0000000000f4';
const RUN_ID = '00000000-0000-4000-8000-0000000000f5';
const SCRIPT_ID = '00000000-0000-4000-8000-0000000000f6';
const PLAYBOOK_ID = '00000000-0000-4000-8000-0000000000f7';

const restartOp = ACT_MANIFEST.find((op) => op.key === 'manage_services.restart')!;
const diskCleanupOp = ACT_MANIFEST.find((op) => op.key === 'disk_cleanup.execute')!;
const killOp = ACT_MANIFEST.find((op) => op.key === 'manage_processes.kill')!;
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
  dbMockState.cleanupRunRows = [];
  dbMockState.playbookRows = [];
  dbMockState.ambientContext = undefined;
  resolveEffectiveAgentSystem.mockReset().mockResolvedValue(liveSnapshot(basePolicy()));
  computeEffectDigestForRelease.mockReset();
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

describe('revalidateActExecution — step 4: manage_processes.kill / manage_services.restart need no extra pin', () => {
  it('kill: identity already validated by normalizeTarget — no DB read', async () => {
    const { db } = await import('../../db');
    const result = await revalidateActExecution({
      run: runArgs(), op: killOp, toolName: 'manage_processes',
      input: { deviceId: DEVICE_ID, action: 'kill', processId: '4242', processName: 'notepad.exe' },
      reserved: reservation(),
    });
    expect(result).toEqual({
      ok: true,
      pin: { op: killOp, target: { kind: 'process', pid: '4242', processName: 'notepad.exe' } },
    });
    expect(db.select).not.toHaveBeenCalled();
  });

  it('restart: no DB read either', async () => {
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
    expect(db.select).not.toHaveBeenCalled();
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
