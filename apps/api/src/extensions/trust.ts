/**
 * Publisher trust-anchor resolution for signed runtime extensions.
 *
 * Extracted from reconciler.ts so the OPERATOR CLI (`breezectl extensions
 * verify`) can resolve the same trust anchor the server does WITHOUT importing
 * the reconciler — which transitively pulls in the database pool, Hono, the
 * audit service and the whole application graph. Keeping this in its own tiny
 * module (node:crypto + node:fs only) means the CLI can verify a bundle offline
 * and, more importantly, cannot reach PostgreSQL even by accident.
 *
 * There is exactly ONE implementation of key loading; both the reconciler and
 * the CLI call it, so an operator's pre-flight `verify` is byte-for-byte the
 * same trust decision the server will make at boot.
 */
import { createPublicKey, type KeyObject } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { TrustedPublisher } from './bundleVerifier';
import type { ExtensionDeploymentConfig } from './config';

/**
 * Resolve a declared publisher's public key into a {@link TrustedPublisher}.
 *
 * Throws when the publisher is not declared in the config's publishers map, or
 * when the key file is unreadable / not a valid public key. The error message
 * names only the publisher id — never the key path or key material.
 */
export function resolveTrustedPublisher(
  config: ExtensionDeploymentConfig,
  publisher: string,
): TrustedPublisher {
  // hasOwnProperty guard, not a bare index: indexing config.publishers by a
  // name like "constructor" or "toString" would return an inherited
  // Object.prototype member instead of undefined, turning a clean "unknown
  // publisher" rejection into a confusing downstream TypeError.
  const declared = Object.prototype.hasOwnProperty.call(config.publishers, publisher)
    ? config.publishers[publisher]
    : undefined;
  if (!declared) {
    throw new Error(`unknown publisher "${publisher}"`);
  }
  const pem = readFileSync(declared.publicKeyFile);
  const publicKey: KeyObject = createPublicKey(pem);
  return { publisher, publicKey };
}
