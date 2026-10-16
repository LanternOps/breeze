import { createHash } from 'node:crypto';
import {
  columnAad,
  encryptedColumnRegistry,
  type EncryptedColumnSpec,
} from '../encryptedColumnRegistry';
import { decryptSecret, encryptSecret } from '../secretCrypto';

export type EdrSecretSpecName = 'connection_credentials' | 'connection_webhook_secret' | 'tenant_installer_secret';

const SPEC_COLUMNS: Record<EdrSecretSpecName, { table: string; column: string }> = {
  connection_credentials: { table: 'edr_connections', column: 'credentials_encrypted' },
  connection_webhook_secret: { table: 'edr_connections', column: 'webhook_secret_encrypted' },
  tenant_installer_secret: { table: 'edr_tenants', column: 'installer_secret_encrypted' },
};

/**
 * All three columns are registered `aadBinding: 'row'`: the AAD embeds the row
 * id, so a blob pasted into another partner's row does not decrypt. Resolved at
 * module load so a missing registry entry fails loudly at boot, not mid-sync.
 */
const SPECS: Record<EdrSecretSpecName, EncryptedColumnSpec> = (() => {
  const out = {} as Record<EdrSecretSpecName, EncryptedColumnSpec>;
  for (const [name, { table, column }] of Object.entries(SPEC_COLUMNS) as [EdrSecretSpecName, { table: string; column: string }][]) {
    const spec = encryptedColumnRegistry.find((e) => e.table === table && e.column === column);
    if (!spec) throw new Error(`${table}.${column} is missing from encryptedColumnRegistry`);
    out[name] = spec;
  }
  return out;
})();

function specFor(spec: EdrSecretSpecName): EncryptedColumnSpec {
  const found = SPECS[spec];
  if (!found) throw new Error(`Unknown EDR secret spec "${String(spec)}"`);
  return found;
}

function assertRowId(rowId: string): void {
  if (!rowId) throw new Error('EDR secrets are row-bound: a row id is required to derive their AAD');
}

export function encryptEdrSecret(spec: EdrSecretSpecName, rowId: string, plaintext: unknown): string {
  assertRowId(rowId);
  const sealed = encryptSecret(JSON.stringify(plaintext), { aad: columnAad(specFor(spec), rowId) });
  if (!sealed) throw new Error(`Could not encrypt EDR secret (${spec}) for row ${rowId}`);
  return sealed;
}

export function decryptEdrSecret(spec: EdrSecretSpecName, rowId: string, ciphertext: string): unknown {
  assertRowId(rowId);
  const plaintext = decryptSecret(ciphertext, { aad: columnAad(specFor(spec), rowId) });
  if (!plaintext) throw new Error(`EDR secret (${spec}) for row ${rowId} has no usable value`);
  try {
    return JSON.parse(plaintext);
  } catch (error) {
    // Never echo the plaintext into the message.
    throw new Error(`EDR secret (${spec}) for row ${rowId} is not valid JSON`, { cause: error });
  }
}

/**
 * Stable identity of a vendor credential, used to key the shared rate budget
 * so two connections holding the same key share one budget. sha256 hex; the
 * secret itself is never exposed.
 */
export function credentialFingerprint(provider: string, rootId: string | null, creds: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify([provider, rootId ?? '', creds]))
    .digest('hex');
}
