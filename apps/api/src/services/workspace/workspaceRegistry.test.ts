/**
 * Execution plane W04 — the per-run WorkspaceService registry. A module-level
 * Map is the only way a `workspace_*` tool handler (which receives an
 * AuthContext, not a run object) can reach the run's live sandbox; the tests
 * pin that a miss is null (so the tool returns `workspace_requires_run`
 * rather than throwing) and that unregister actually frees the entry.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import {
  __resetWorkspaceRegistry, getWorkspaceForRun, registerWorkspace, unregisterWorkspace,
} from './workspaceRegistry';
import type { WorkspaceService } from './workspaceService';

const fakeSvc = { id: 'svc-1' } as unknown as WorkspaceService;

describe('workspaceRegistry', () => {
  beforeEach(() => { __resetWorkspaceRegistry(); });

  it('returns null for an unknown run', () => {
    expect(getWorkspaceForRun('run-missing')).toBeNull();
  });

  it('round-trips a registration and frees it on unregister', () => {
    registerWorkspace('run-1', fakeSvc);
    expect(getWorkspaceForRun('run-1')).toBe(fakeSvc);
    unregisterWorkspace('run-1');
    expect(getWorkspaceForRun('run-1')).toBeNull();
  });

  it('keeps two concurrent runs apart', () => {
    const other = { id: 'svc-2' } as unknown as WorkspaceService;
    registerWorkspace('run-1', fakeSvc);
    registerWorkspace('run-2', other);
    expect(getWorkspaceForRun('run-1')).toBe(fakeSvc);
    expect(getWorkspaceForRun('run-2')).toBe(other);
  });
});
