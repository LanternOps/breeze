/**
 * `breeze-ext sign` — signs a `.breeze-ext` bundle's integrity inventory
 * with an Ed25519 private key, per the frozen wire format that
 * `apps/api/src/extensions/bundleVerifier.ts` expects.
 *
 * Not implemented yet: Ed25519 signing lands in Task 5 of this plan.
 */

export interface SignOptions {
  /** Path to the `.breeze-ext` bundle to sign. */
  bundle: string;
  /** Path to the Ed25519 private key used to sign the bundle. */
  key: string;
  /** Output path for the signed bundle. Defaults to signing in place. */
  out?: string;
}

export async function runSign(_options: SignOptions): Promise<never> {
  throw new Error('breeze-ext sign: not implemented yet');
}
