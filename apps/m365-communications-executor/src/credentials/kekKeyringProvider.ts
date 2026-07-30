import { z } from 'zod';
import type { SecretClientPort } from './azureKeyVaultProvider';
import type { KekKeyring } from './tokenCacheCrypto';

const KEK_SECRET_NAME = 'm365-comms-token-cache-kek';

const kekEnvelopeSchema = z.object({
  schemaVersion: z.literal(1),
  domain: z.literal('communications-delegated'),
  material: z.object({
    kind: z.literal('symmetric-key'),
    keyBase64: z.string().min(1),
  }).strict(),
}).strict();

/**
 * Loads every reader version of the token-cache KEK at boot (design §3.2
 * keyring: reader set + single writer). Each version is its own AKV secret
 * version of `m365-comms-token-cache-kek`, wrapping envelope:
 *   { schemaVersion: 1, domain: 'communications-delegated',
 *     material: { kind: 'symmetric-key', keyBase64: <44-char base64 of 32 bytes> } }
 * A version that is missing, malformed, or not 32 bytes fails boot — a replica
 * that cannot read the whole reader set would silently fail on rows wrapped
 * under the version it lacks, which is exactly the rolling-deploy hazard the
 * keyring exists to prevent.
 */
export async function loadKekKeyring(
  config: {
    vaultUrl: string;
    tokenCacheKekVaultRef: string;
    tokenCacheKekWriterVersion: string;
    tokenCacheKekReaderVersions: readonly string[];
  },
  client: SecretClientPort,
): Promise<KekKeyring> {
  const expectedRef = `akv://${new URL(config.vaultUrl).host}/${KEK_SECRET_NAME}/${config.tokenCacheKekWriterVersion}`;
  if (
    config.tokenCacheKekVaultRef !== expectedRef
    || !config.tokenCacheKekReaderVersions.includes(config.tokenCacheKekWriterVersion)
  ) {
    throw new Error('token cache KEK configuration is inconsistent');
  }

  const keys = new Map<string, Uint8Array>();
  for (const version of config.tokenCacheKekReaderVersions) {
    let secret: { value?: string };
    try {
      secret = await client.getSecret(KEK_SECRET_NAME, { version });
    } catch {
      throw new Error(`token cache KEK version unavailable at boot`);
    }
    if (!secret.value) throw new Error('token cache KEK version unavailable at boot');
    let envelope: z.infer<typeof kekEnvelopeSchema>;
    try {
      envelope = kekEnvelopeSchema.parse(JSON.parse(secret.value));
    } catch {
      throw new Error('token cache KEK envelope is malformed');
    }
    const key = Buffer.from(envelope.material.keyBase64, 'base64');
    if (key.byteLength !== 32 || key.toString('base64') !== envelope.material.keyBase64) {
      throw new Error('token cache KEK material must be exactly 32 base64-encoded bytes');
    }
    keys.set(version, new Uint8Array(key));
  }

  return { writerVersion: config.tokenCacheKekWriterVersion, keys };
}
