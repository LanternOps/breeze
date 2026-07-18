/**
 * `breeze-ext sign` — signs a `.breeze-ext` bundle's integrity inventory
 * with an Ed25519 private key, per the frozen wire format that
 * `apps/api/src/extensions/bundleVerifier.ts` expects.
 *
 * Not implemented yet: Ed25519 signing lands in Task 5 of this plan.
 */

export interface SignOptions {
  /** Path to the `.breeze-ext` artifact to sign. */
  artifact: string;
  /**
   * Path to a file holding the Ed25519 private key. Mutually exclusive with
   * {@link keyEnv}; exactly one is supplied.
   */
  key?: string;
  /**
   * Name of an environment variable holding the Ed25519 private key. The key
   * value is never accepted on argv, which is world-readable via `ps`.
   * Mutually exclusive with {@link key}; exactly one is supplied.
   */
  keyEnv?: string;
  /** Output path for the signed bundle. Defaults to signing in place. */
  out?: string;
}

export async function runSign(_options: SignOptions): Promise<never> {
  throw new Error('breeze-ext sign: not implemented yet');
}
