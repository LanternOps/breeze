/**
 * Tool-execution timeouts, extracted from aiAgentSdkTools.ts so the durable
 * release worker (jobs/intentReleaseWorker.ts) can bound tool execution WITHOUT
 * importing the chat-session dependency graph. Single source of truth: the
 * inline chat path and the durable worker use the same timeouts.
 */
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
  // Security scans — multi-step agent operations
  security_scan: 120_000,
  apply_cis_remediation: 120_000,
  // Patching — downloads + installs
  manage_patches: 180_000,
  // Network discovery — port scanning is slow
  network_discovery: 120_000,
  // Desktop / vision — WebRTC setup + capture
  take_screenshot: 30_000,
  analyze_screen: 30_000,
  computer_control: 30_000,
  // Report generation — aggregates across many devices
  generate_report: 90_000,
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
