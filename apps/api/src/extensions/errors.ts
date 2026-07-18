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
 * contract) plus the COARSE pipeline phase, and nothing else.
 *
 * Deliberately carries NO `cause`: the raw underlying error is consumed at the
 * catch site to produce the sanitized DB failure record, and must never ride
 * along here. Node's default error printer walks the `[cause]` chain, so a raw
 * cause on this error would let a migration SQL string, a public-key file path
 * (ENOENT), or an exception stack reach the boot logger — a Global-Constraint
 * violation. Only the extension name + coarse `phase` are exposed.
 */
export class RequiredExtensionError extends Error {
  readonly extensionName: string;
  /** Coarse pipeline phase at which the extension failed. NEVER the raw error. */
  readonly phase: string;

  constructor(extensionName: string, phase: string) {
    super(`required extension ${extensionName} failed during ${phase}`);
    this.name = 'RequiredExtensionError';
    this.extensionName = extensionName;
    this.phase = phase;
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
