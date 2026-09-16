/**
 * Execution plane W04 — run id → live `WorkspaceService`.
 *
 * A tool handler in the `aiTools` registry is called as `(input, auth)`: it
 * has no run object and no way to construct a sandbox lifecycle of its own.
 * The run loop owns the lifecycle (create lazily, destroy in a `finally`) and
 * publishes the instance here for the duration of the run; the four
 * `workspace_*` handlers look it up by the run id on the caller principal. A
 * miss is `null`, never a throw — the handler turns it into the typed
 * `workspace_requires_run`, which is exactly what a chat-path call must get.
 *
 * Process-local on purpose. A run executes inside ONE worker process from
 * `executeAgentRun` to its `finally`; a crashed process leaves no entry to
 * clean up here, and the durable cleanup path is `ai_run_workspaces` +
 * the reaper (W02), not this map.
 */
import type { WorkspaceService } from './workspaceService';

const workspacesByRunId = new Map<string, WorkspaceService>();

export function registerWorkspace(runId: string, svc: WorkspaceService): void {
  workspacesByRunId.set(runId, svc);
}

export function getWorkspaceForRun(runId: string): WorkspaceService | null {
  return workspacesByRunId.get(runId) ?? null;
}

export function unregisterWorkspace(runId: string): void {
  workspacesByRunId.delete(runId);
}

/** Tests only — a leaked entry between suites would cross-contaminate them. */
export function __resetWorkspaceRegistry(): void {
  workspacesByRunId.clear();
}
