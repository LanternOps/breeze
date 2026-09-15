/**
 * Execution plane W04 — the four `workspace_*` tools (spec §5.3, §12).
 * These handlers are THIN: every cap and every containment rule lives in
 * `WorkspaceService` (Tasks 4-5) so a second caller cannot route around it.
 * What is pinned here is the seam: run resolution, argument pass-through,
 * the typed-error envelope, and `captureExempt`.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthContext } from '../../middleware/auth';
import type { AiTool } from '../aiTools';
import { WorkspaceToolError } from './workspaceErrors';
import { __resetWorkspaceRegistry, registerWorkspace } from './workspaceRegistry';
import type { WorkspaceService } from './workspaceService';
import { registerWorkspaceTools } from './workspaceTools';

vi.mock('../sentry', () => ({ captureException: vi.fn() }));

function agentAuth(runId: string | null): AuthContext {
  return {
    principal: runId ? { kind: 'ai_agent', agentId: 'agent-1', runId } : { kind: 'user' },
    orgId: 'org-1',
  } as unknown as AuthContext;
}

function toolsMap(): Map<string, AiTool> {
  const map = new Map<string, AiTool>();
  registerWorkspaceTools(map);
  return map;
}

describe('workspace tools', () => {
  beforeEach(() => { __resetWorkspaceRegistry(); });

  it('registers exactly the four tools, Tier 1 and captureExempt', () => {
    const map = toolsMap();
    expect([...map.keys()].sort()).toEqual([
      'workspace_cancel', 'workspace_collect', 'workspace_run', 'workspace_stage',
    ]);
    for (const tool of map.values()) {
      expect(tool.tier).toBe(1);
      expect(tool.captureExempt).toBe(true);
      expect(tool.deviceArgs ?? []).toEqual([]);
    }
  });

  it('returns workspace_requires_run off the run path', async () => {
    const map = toolsMap();
    const out = await map.get('workspace_run')!.handler({ script: 'x', language: 'bash' }, agentAuth(null));
    expect(JSON.parse(out)).toEqual({
      error: 'workspace_requires_run',
      message: expect.stringContaining('analysis'),
    });
  });

  it('resolves the run from the ai_agent principal and ignores any third argument', async () => {
    const mine = { cancel: vi.fn(async () => {}) } as unknown as WorkspaceService;
    const other = { cancel: vi.fn(async () => {}) } as unknown as WorkspaceService;
    registerWorkspace('run-mine', mine);
    registerWorkspace('run-other', other);
    const map = toolsMap();

    // Cross-wave decision R2: identity comes from the AuthContext ONLY. A
    // third argument naming a different run must change nothing — it is not
    // read, so a caller that could construct one cannot reach another run's
    // sandbox with it.
    await map.get('workspace_cancel')!.handler({}, agentAuth('run-mine'), { runId: 'run-other' } as never);
    expect(mine.cancel).toHaveBeenCalled();
    expect(other.cancel).not.toHaveBeenCalled();
  });

  it('refuses a non-agent principal even when a workspace is registered for some run', async () => {
    registerWorkspace('run-1', { cancel: vi.fn(async () => {}) } as unknown as WorkspaceService);
    const map = toolsMap();
    const out = await map.get('workspace_cancel')!.handler({}, agentAuth(null));
    expect(JSON.parse(out).error).toBe('workspace_requires_run');
  });

  it('returns workspace_requires_run when the run has no registered workspace', async () => {
    const map = toolsMap();
    const out = await map.get('workspace_cancel')!.handler({}, agentAuth('run-unknown'));
    expect(JSON.parse(out).error).toBe('workspace_requires_run');
  });

  it('forwards stage/run/collect/cancel to the run service', async () => {
    const svc = {
      stage: vi.fn(async () => ({ staged: [{ handle: 'h', path: '/work/in/a.log', bytes: 3 }] })),
      runStep: vi.fn(async () => ({
        ordinal: 1, exitCode: 0, timedOut: false, stdoutHead: 'ok', stderrHead: '',
        stdoutHandle: null, scriptHandle: 'art-1', durationMs: 5,
      })),
      collect: vi.fn(async () => ({ artifacts: [{ handle: 'art-2', name: 'r.csv', bytes: 9 }] })),
      cancel: vi.fn(async () => {}),
    } as unknown as WorkspaceService;
    registerWorkspace('run-1', svc);
    const map = toolsMap();
    const auth = agentAuth('run-1');

    expect(JSON.parse(await map.get('workspace_stage')!.handler({ handles: ['h'] }, auth)).staged).toHaveLength(1);
    expect(svc.stage).toHaveBeenCalledWith(['h'], undefined);

    const run = JSON.parse(await map.get('workspace_run')!.handler(
      { script: 'print(1)', language: 'python', timeoutSeconds: 30 }, auth,
    ));
    expect(run.exitCode).toBe(0);
    expect(svc.runStep).toHaveBeenCalledWith({
      script: 'print(1)', language: 'python', timeoutSeconds: 30, stdinHandle: undefined,
    });

    expect(JSON.parse(await map.get('workspace_collect')!.handler({ paths: ['r.csv'] }, auth)).artifacts)
      .toHaveLength(1);
    expect(JSON.parse(await map.get('workspace_cancel')!.handler({}, auth))).toEqual({ status: 'cancelled' });
    expect(svc.cancel).toHaveBeenCalled();
  });

  it('turns a WorkspaceToolError into the typed envelope and a crash into a generic one', async () => {
    const svc = {
      stage: vi.fn(async () => { throw new WorkspaceToolError('staged_bytes_cap', 'too big'); }),
      runStep: vi.fn(async () => { throw new Error('postgres said no: user=breeze_app'); }),
    } as unknown as WorkspaceService;
    registerWorkspace('run-1', svc);
    const map = toolsMap();

    const capped = JSON.parse(await map.get('workspace_stage')!.handler({ handles: ['h'] }, agentAuth('run-1')));
    expect(capped).toEqual({ error: 'staged_bytes_cap', message: 'too big' });

    const crashed = JSON.parse(await map.get('workspace_run')!.handler(
      { script: 'x', language: 'bash' }, agentAuth('run-1'),
    ));
    expect(crashed.error).toBe('workspace_unavailable');
    expect(JSON.stringify(crashed)).not.toContain('breeze_app');
  });
});
