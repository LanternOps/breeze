/**
 * Execution plane W04 (spec §8 "Caps everywhere", §9) — the typed failures a
 * workspace tool reports BACK TO THE MODEL. Every cap failure is a code the
 * model can read and reason about ("I am out of compute, conclude with what I
 * have"), never a bare string it has to pattern-match, and never a stack
 * trace: `toToolResult()` is the only serialization, and it emits the code
 * plus a short message with no provider ids, no blob keys and no paths
 * outside `/work`.
 */
export const WORKSPACE_ERROR_CODES = [
  /** Called outside an `analysis` run (chat/MCP path) — there is no sandbox. */
  'workspace_requires_run',
  /** Backend create failed or the circuit is open (spec §9 row 1). */
  'workspace_unavailable',
  /** The provider deadline fired; the sandbox is gone (spec §9 row 4). */
  'workspace_expired',
  /** `workspace_cancel` already destroyed it (spec §5.3 last row). */
  'workspace_cancelled',
  /** `analysisMaxComputeSeconds` exhausted (spec §9 row 3). */
  'compute_cap_reached',
  'staged_bytes_cap',
  'staged_file_cap',
  /** Handle is neither in the run's frozen `staged_inputs` nor produced here. */
  'staged_handle_not_allowed',
  'artifact_bytes_cap',
  'collect_file_cap',
  /** `..`, an absolute path outside `/work/out`, or a symlink escaping it. */
  'collect_path_rejected',
  /** Resolve returned null: not found OR another org's. Never distinguished. */
  'artifact_forbidden',
  'artifact_store_unavailable',
  'step_cap_reached',
  /** The run's region is not this deployment's (spec §8 "Residency"). */
  'region_mismatch',
] as const;

export type WorkspaceErrorCode = (typeof WORKSPACE_ERROR_CODES)[number];

export class WorkspaceToolError extends Error {
  constructor(public readonly code: WorkspaceErrorCode, message: string) {
    super(message);
    this.name = 'WorkspaceToolError';
  }

  /** The model-facing wire form. Tool handlers return this verbatim. */
  toToolResult(): string {
    return JSON.stringify({ error: this.code, message: this.message });
  }
}

export function isWorkspaceToolError(error: unknown): error is WorkspaceToolError {
  return error instanceof WorkspaceToolError;
}
