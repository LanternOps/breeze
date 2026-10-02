/**
 * Connection key sealing (#7600 W02; split out as a leaf in #7601 Task 6B so
 * a connection key can be decrypted without importing the
 * connection service and its schema graph). Row-bound AAD under the legacy
 * tag 'partner_llm_configs.api_key_encrypted': W02 copied the retired legacy
 * table's rows with the same id, so every stored ciphertext decrypts unchanged.
 */
import { columnAad, encryptedColumnRegistry, type EncryptedColumnSpec } from '../encryptedColumnRegistry';
import { decryptSecret, encryptSecret } from '../secretCrypto';

export const PARTNER_AI_CONNECTION_KEY_SPEC: EncryptedColumnSpec = (() => {
  const spec = encryptedColumnRegistry.find(
    (entry) => entry.table === 'partner_ai_connections' && entry.column === 'api_key_encrypted',
  );
  if (!spec) throw new Error('partner_ai_connections.api_key_encrypted is missing from encryptedColumnRegistry');
  return spec;
})();

export class ConnectionKeyError extends Error {
  constructor(message: string, readonly code: 'key_missing' | 'key_empty' | 'key_rejected') {
    super(message);
    this.name = 'ConnectionKeyError';
  }
}

export function encryptConnectionKey(id: string, apiKey: string): string {
  const sealed = encryptSecret(apiKey, { aad: columnAad(PARTNER_AI_CONNECTION_KEY_SPEC, id) });
  if (!sealed) throw new ConnectionKeyError('Could not encrypt the connection key.', 'key_rejected');
  return sealed;
}

export function decryptConnectionKey(conn: { id: string; apiKeyEncrypted: string | null }): string {
  if (!conn.apiKeyEncrypted) throw new ConnectionKeyError('This connection has no stored key.', 'key_missing');
  const apiKey = decryptSecret(conn.apiKeyEncrypted, { aad: columnAad(PARTNER_AI_CONNECTION_KEY_SPEC, conn.id) });
  if (!apiKey) throw new ConnectionKeyError('The stored connection key decrypted to an empty value.', 'key_empty');
  return apiKey;
}
