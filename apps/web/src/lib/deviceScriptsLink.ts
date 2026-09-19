/**
 * The device-Scripts-tab link shape (`/devices/:id#scripts[/:executionId]`)
 * introduced for #4885/#4886, and the script execution-history link. One
 * chokepoint for both so the percent-encoding can't drift between call sites
 * — CodeQL's `js/xss-through-dom` flagged the first inline template-literal
 * `href` this PR wrote (ScriptTestRunner.tsx) because an unescaped
 * interpolation into a URL/HTML sink is exactly its taint pattern, regardless
 * of whether the source value can practically carry anything dangerous.
 * `deviceId`/`executionId` are always server-issued UUIDs today, so this adds
 * no behavior change for real values — it's correctness (a path/fragment
 * segment should be percent-encoded on principle) and it satisfies the
 * scanner, which does not reason about what a UUID can contain.
 */

/** Full href to a device's Scripts tab, optionally highlighting one execution. */
export function deviceScriptsHref(deviceId: string, executionId?: string): string {
  return `/devices/${encodeURIComponent(deviceId)}#${deviceScriptsHash(executionId)}`;
}

/**
 * Just the `#scripts[/executionId]` fragment, for a same-page hash write
 * (the caller is already on that device's page and knows it).
 */
export function deviceScriptsHash(executionId?: string): string {
  return executionId ? `scripts/${encodeURIComponent(executionId)}` : 'scripts';
}

/** Href to a script's execution-history page. */
export function scriptExecutionsHref(scriptId: string): string {
  return `/scripts/${encodeURIComponent(scriptId)}/executions`;
}

/**
 * Reverses `deviceScriptsHash`'s executionId encoding. Pass the raw
 * `window.location.hash` segment (the part after `scripts/`, `#` and the
 * `scripts` tab segment already stripped by the caller). Returns undefined
 * for an unparseable/empty segment rather than throwing — a malformed or
 * externally-edited hash must fall back to "no highlight", not crash the tab.
 */
export function decodeScriptExecutionId(rawSegment: string | undefined): string | undefined {
  if (!rawSegment) return undefined;
  try {
    return decodeURIComponent(rawSegment);
  } catch {
    return undefined;
  }
}
