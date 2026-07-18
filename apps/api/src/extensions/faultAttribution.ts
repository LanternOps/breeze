/**
 * Fault attribution for runtime extensions.
 *
 * When an unhandled rejection or uncaught exception tears through the process,
 * this names the extension whose loaded code is implicated — by matching the
 * extension's on-disk EXTRACTED ROOT against the frames in the error stack.
 *
 * CRITICAL CONTRACT: attribution ADDS a name (for a log line / Sentry tag) and
 * NOTHING ELSE. It never inspects, swallows, or resolves the fault. The process
 * crash/exit(1)/captureException behavior in the fault handlers is unchanged;
 * this only enriches the telemetry so an operator can see WHICH extension is
 * the likely culprit instead of an anonymous stack.
 */

/**
 * Return the extension name whose extracted-root path appears in the error's
 * stack, or null when there is no match (or the value is not an Error). The
 * first matching root in iteration order wins.
 */
export function attributeExtensionError(
  error: unknown,
  roots: ReadonlyMap<string, string>,
): string | null {
  const stack = error instanceof Error ? error.stack ?? '' : '';
  if (stack.length === 0) return null;
  for (const [name, root] of roots) {
    if (root.length > 0 && stack.includes(root)) return name;
  }
  return null;
}

/**
 * The live extension name → extracted-root map. The reconciler POPULATES an
 * entry the instant an extension activates and CLEARS it on withdraw, so the
 * snapshot handed to {@link attributeExtensionError} always reflects the set of
 * extensions whose code is actually loaded in this process.
 */
const extractedRoots = new Map<string, string>();

/** Record the extracted root for an activated extension. */
export function registerExtensionRoot(name: string, root: string): void {
  extractedRoots.set(name, root);
}

/** Drop an extension's root when it is withdrawn / fails reconciliation. */
export function clearExtensionRoot(name: string): void {
  extractedRoots.delete(name);
}

/** An isolated copy of the current roots map (safe to iterate concurrently). */
export function extensionRootsSnapshot(): ReadonlyMap<string, string> {
  return new Map(extractedRoots);
}
