/**
 * Typed errors for the runtime-extension reconciler.
 *
 * These carry a machine-usable identity (and, for the incompatible case, the
 * structured reasons) WITHOUT ever putting untrusted bundle/manifest text into a
 * message that could be logged or persisted. `recordSanitizedFailure` maps them
 * to a coarse category + a fixed generic message — the raw `cause` is never
 * threaded into any persisted string. See reconciler.ts.
 */

/**
 * A REQUIRED extension failed to reconcile. Thrown by the reconciler to abort
 * boot. The message contains `required extension <name>` (the failure-policy
 * contract) and nothing else — the underlying error rides on `cause` only.
 */
export class RequiredExtensionError extends Error {
  readonly extensionName: string;

  constructor(extensionName: string, options?: { cause?: unknown }) {
    super(
      `required extension ${extensionName} failed to reconcile and could not be activated`,
      options,
    );
    this.name = 'RequiredExtensionError';
    this.extensionName = extensionName;
  }
}

/**
 * Host/bundle compatibility mismatch. Carries the structured reasons for a
 * caller that wants them, but its `message` is a fixed generic string so it is
 * safe to surface. Maps to lifecycle_state 'incompatible'.
 */
export class ExtensionIncompatibleError extends Error {
  readonly reasons: readonly string[];

  constructor(reasons: readonly string[]) {
    super('extension is not compatible with this host');
    this.name = 'ExtensionIncompatibleError';
    this.reasons = reasons;
  }
}
