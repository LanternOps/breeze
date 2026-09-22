import {
  columnAad,
  encryptedColumnRegistry,
  type EncryptedColumnSpec,
} from '../encryptedColumnRegistry';
import { decryptSecret, encryptSecret } from '../secretCrypto';

/**
 * `backup_provider_connections.credentials_encrypted` is registered with
 * `aadBinding: 'row'` (see `encryptedColumnRegistry.ts`), exactly like
 * `tool_sources.auth_config_encrypted` and `partner_llm_configs.api_key_encrypted`.
 *
 * A backup-vendor console password is a live capability one MSP supplied for
 * ONE console tenant. A plain `table.column` AAD only stops a blob moving
 * between COLUMNS — someone with DB write access could paste partner A's
 * ciphertext into partner B's connection row and have the application decrypt
 * it back to B. Binding the AAD to the row id is what stops that swap, and is
 * why every function here demands the row id up front instead of accepting it
 * as an optional hint. The create route therefore GENERATES the row id
 * (`crypto.randomUUID()`) before encrypting, rather than letting the database
 * default it.
 */
const PROVIDER_CREDENTIALS_SPEC: EncryptedColumnSpec = (() => {
  const spec = encryptedColumnRegistry.find(
    (entry) => entry.table === 'backup_provider_connections' && entry.column === 'credentials_encrypted',
  );
  if (!spec) {
    throw new Error('backup_provider_connections.credentials_encrypted is missing from encryptedColumnRegistry');
  }
  return spec;
})();

function assertRowId(rowId: string): void {
  if (!rowId) {
    throw new Error('backup provider credentials are row-bound: a row id is required to derive their AAD');
  }
}

/**
 * Seal a credential blob for storage. The plaintext never leaves this module
 * except through `decryptProviderCredentials`, and is never logged.
 */
export function encryptProviderCredentials(connectionId: string, creds: unknown): string {
  assertRowId(connectionId);
  const sealed = encryptSecret(JSON.stringify(creds), {
    aad: columnAad(PROVIDER_CREDENTIALS_SPEC, connectionId),
  });
  if (!sealed) {
    throw new Error(`Could not encrypt backup provider credentials for connection ${connectionId}`);
  }
  return sealed;
}

/**
 * Open a credential blob. MUST be called with the SAME connection id the blob
 * was sealed under — a different id fails the AAD check inside `decryptSecret`
 * and throws, by design.
 */
export function decryptProviderCredentials(connectionId: string, ciphertext: string): unknown {
  assertRowId(connectionId);
  const plaintext = decryptSecret(ciphertext, {
    aad: columnAad(PROVIDER_CREDENTIALS_SPEC, connectionId),
  });
  if (!plaintext) {
    throw new Error(`Backup provider connection ${connectionId} has no usable credentials`);
  }
  try {
    return JSON.parse(plaintext);
  } catch (error) {
    // Never echo the plaintext into the message.
    throw new Error(
      `Backup provider connection ${connectionId} credentials are not valid JSON`,
      { cause: error },
    );
  }
}
