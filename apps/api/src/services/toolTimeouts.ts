/**
 * Tool-execution timeouts, extracted from aiAgentSdkTools.ts so the durable
 * release worker (jobs/intentReleaseWorker.ts) can bound tool execution WITHOUT
 * importing the chat-session dependency graph. Single source of truth: the
 * inline chat path and the durable worker use the same timeouts.
 */
import { SYSTEM_CLEANUP_RUN_MAX_TIMEOUT_MS } from './commandTimeouts';

const TOOL_EXECUTION_TIMEOUT_MS = 60_000; // 60s default safety timeout

/**
 * Per-tool timeout overrides for tools that legitimately need more (or less) time.
 * Tools not listed here use TOOL_EXECUTION_TIMEOUT_MS (60s).
 */
const TOOL_TIMEOUT_OVERRIDES: Record<string, number> = {
  // Command execution — waits for agent round-trip
  execute_command: 120_000,
  run_script: 120_000,
  // Disk operations — can scan large filesystems
  analyze_disk_usage: 90_000,
  disk_cleanup: 90_000,
  // OS-native cleaners (Disk Cleanup v2 §5.3). cleanmgr is capped at 60 min and
  // DISM /StartComponentCleanup at 90 min on the agent side, and they run
  // sequentially, so the outer guard has to sit above the sum of the caps or it
  // cancels a run the device is still executing — leaving a `running` row with
  // no terminal result. The handler waits systemCleanupRunBudgetMs(actionIds),
  // whose ceiling is this same constant, so the two clocks cannot disagree.
  system_cleanup: SYSTEM_CLEANUP_RUN_MAX_TIMEOUT_MS,
  // Security scans — multi-step agent operations
  security_scan: 120_000,
  apply_cis_remediation: 120_000,
  // Patching — downloads + installs
  manage_patches: 180_000,
  // Network discovery — port scanning is slow
  network_discovery: 120_000,
  // Desktop / vision — WebRTC negotiation + capture + (for analyze_screen) a
  // model vision pass. #3091: these were 30_000, the only three entries in this
  // table that LOWERED the budget below the 60s default — so the slowest tools
  // here got less time than an unlisted one. `analyze_screen` duly timed out on
  // prod at 30s while ordinary `execute_command` round-trips to the same device
  // in the same window were taking 40s to 6min. They do an agent round-trip like
  // `execute_command` and then more, so they get at least its budget.
  //
  // The timeout covers execution only: `withToolTimeout` wraps the `executeTool`
  // call in `aiAgentSdkTools.ts`, and approval resolution happens earlier in the
  // handler — so approval latency never ate into the 30s, and raising this is a
  // real increase in execution budget rather than a wider window for waiting.
  take_screenshot: 120_000,
  analyze_screen: 120_000,
  computer_control: 120_000,
  // Report generation — aggregates across many devices
  generate_report: 90_000,
  // Execution plane W04 — a workspace step's own timeout is clamped to
  // `analysisMaxStepTimeoutSeconds` (600s ceiling) inside WorkspaceService;
  // this outer guard must sit ABOVE it or it would cancel a legitimate step
  // at 60s, orphaning a sandbox process the run is still paying for.
  workspace_run: 660_000,
  // Staging and collecting stream up to 64 MiB per file through the worker.
  workspace_stage: 180_000,
  workspace_collect: 180_000,
};

export function getToolTimeout(toolName: string): number {
  return TOOL_TIMEOUT_OVERRIDES[toolName] ?? TOOL_EXECUTION_TIMEOUT_MS;
}

/**
 * Rejects with a timeout error after `ms` if `promise` hasn't settled. Does NOT
 * cancel the underlying work (JS promises aren't cancelable) — same semantics as
 * the inline chat path's withTimeout; it bounds when the CALLER gives up.
 */
export function withToolTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Tool execution timed out after ${ms}ms: ${label}`)), ms);
    promise.then(
      (val) => { clearTimeout(timer); resolve(val); },
      (err) => { clearTimeout(timer); reject(err); },
    );
  });
}
