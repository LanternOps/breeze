/**
 * Breeze Assist availability on the device page (#10190 W01, plan P1).
 *
 * Derived from the persisted helper columns: the on-disk Assist version the
 * agent reports and its install-issue code. It describes the installed or
 * last-reported state, not which renderer a session is using right now; that
 * live observation arrives with the prompt host (W02).
 */
export type PromptRendererStatus = 'installed' | 'unavailable' | 'notDeployed';

export interface PromptRenderer {
  status: PromptRendererStatus;
  /** The agent's install-issue code, when that is what makes Assist unavailable. */
  issue?: string;
}

/**
 * Any install issue means Assist cannot draw prompts (they fall back to the
 * native dialogs); otherwise a reported version means it is installed;
 * otherwise it is not deployed.
 */
export function derivePromptRenderer(input: {
  helperVersion?: string | null;
  helperInstallIssue?: string | null;
}): PromptRenderer {
  const issue = input.helperInstallIssue?.trim();
  if (issue) return { status: 'unavailable', issue };
  if (input.helperVersion?.trim()) return { status: 'installed' };
  return { status: 'notDeployed' };
}

/** Install-issue codes the agent reports, mapped to their locale-key suffix. */
const ISSUE_KEYS: Record<string, string> = {
  awaiting_server_offer: 'awaitingServerOffer',
  install_abandoned: 'installAbandoned',
  webview2_outdated: 'webview2Outdated',
  crash_loop: 'crashLoop',
  unmanaged_install: 'unmanagedInstall',
};

export type HelperInstallIssueKey =
  | 'awaitingServerOffer'
  | 'installAbandoned'
  | 'webview2Outdated'
  | 'crashLoop'
  | 'unmanagedInstall'
  | 'unknown';

/** Locale-key suffix for an install-issue code; a code from a newer agent is "unknown". */
export function helperInstallIssueKey(code: string): HelperInstallIssueKey {
  return (ISSUE_KEYS[code] as HelperInstallIssueKey | undefined) ?? 'unknown';
}

/**
 * Codes the agent reports while Assist is on disk but it does not run it: an
 * outdated WebView2 runtime, a crash loop, or an install it did not make with
 * deploy off. The others mean Assist is not installed.
 */
export function helperInstalledDespiteIssue(code: string): boolean {
  return code === 'webview2_outdated' || code === 'crash_loop' || code === 'unmanaged_install';
}
