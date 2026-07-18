import { createPrivateKey, sign as cryptoSign, type KeyObject } from 'node:crypto';
import { readFile } from 'node:fs/promises';

/**
 * Where to load an Ed25519 private key from: a file path, or the NAME of an
 * environment variable holding it. The key value itself must never be
 * accepted on argv -- process arguments are world-readable via `ps` -- so
 * `--key-env` on the CLI carries a variable name, never a key
 * (see `src/commands/sign.ts`, `src/cli.ts`). Exactly one of the two is
 * expected to be set; that "exactly one" rule is enforced by the CLI action,
 * not here.
 */
export interface PrivateKeySource {
  /** Path to a file holding the PEM-encoded private key. */
  key?: string;
  /** Name of an environment variable holding the PEM-encoded private key. */
  keyEnv?: string;
}

async function readKeyMaterial(source: PrivateKeySource): Promise<Buffer> {
  if (source.key !== undefined) {
    return readFile(source.key);
  }
  if (source.keyEnv !== undefined) {
    const value = process.env[source.keyEnv];
    if (value === undefined) {
      throw new Error(`environment variable "${source.keyEnv}" is not set`);
    }
    return Buffer.from(value, 'utf8');
  }
  throw new Error('no private key source provided: supply "key" or "keyEnv"');
}

/**
 * Load a private key from `source` and require that it be Ed25519.
 *
 * SECURITY: never surfaces key material, key bytes, or a raw `createPrivateKey`
 * exception (which can otherwise echo back fragments of malformed input) --
 * both are caught here and replaced with a sanitized message.
 */
export async function loadEd25519PrivateKey(source: PrivateKeySource): Promise<KeyObject> {
  const material = await readKeyMaterial(source);

  let privateKey: KeyObject;
  try {
    privateKey = createPrivateKey(material);
  } catch {
    throw new Error('failed to load private key: not a valid private key');
  }

  if (privateKey.asymmetricKeyType !== 'ed25519') {
    throw new Error(
      `private key must be Ed25519, got "${privateKey.asymmetricKeyType ?? 'unknown'}"`,
    );
  }

  return privateKey;
}

/**
 * Sign `payload` with `privateKey`, returning the RAW Ed25519 signature bytes
 * -- NOT a JSON envelope, no keyId, no algorithm field. Per the frozen
 * verifier (`apps/api/src/extensions/bundleVerifier.ts`, which does
 * `crypto.verify(null, payload, publicKey, signatureBytes)`), the archive's
 * `signature` member is exactly these bytes.
 */
export function signEd25519(privateKey: KeyObject, payload: Buffer): Buffer {
  try {
    return cryptoSign(null, payload, privateKey);
  } catch {
    // Never surface a raw crypto exception.
    throw new Error('failed to sign payload');
  }
}
