import { z } from 'zod';
import {
  columnAad,
  encryptedColumnRegistry,
  type EncryptedColumnSpec,
} from '../encryptedColumnRegistry';
import { decryptSecret, encryptSecret } from '../secretCrypto';
import type { SourceCredentials } from './moduleContract';

/**
 * The only writer and reader of `ticket_import_sources.credentials_encrypted`
 * (#8313 W4; spec 2026-10-19 §5.5, §5.6). The column is registered with
 * `aadBinding: 'row'`, like `backup_provider_connections.credentials_encrypted`
 * (services/backupProviders/credentials.ts): the AAD is bound to the source's
 * row id, so a ciphertext pasted into another partner's source does not
 * decrypt. `encryptColumnValueForWrite` refuses row-bound columns, so the
 * create route generates the id before sealing.
 *
 * Row binding takes effect only with APP_ENCRYPTION_KEY_ID set; without it
 * `encryptSecret` falls back to v1 and drops the AAD (F20). The runbook (§7)
 * says so. The plaintext never leaves this module except through
 * `openSourceCredentials`, and is never logged.
 */
const SOURCE_CREDENTIALS_SPEC: EncryptedColumnSpec = (() => {
  const spec = encryptedColumnRegistry.find(
    (entry) => entry.table === 'ticket_import_sources' && entry.column === 'credentials_encrypted',
  );
  if (!spec) throw new Error('ticket_import_sources.credentials_encrypted is missing from encryptedColumnRegistry');
  return spec;
})();

/** A credential as the routes accept it: one to eight named strings. */
export const sourceCredentialsSchema = z
  .record(z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,63}$/), z.string().min(1).max(4096))
  .refine((value) => {
    const count = Object.keys(value).length;
    return count >= 1 && count <= 8;
  }, 'Credentials must hold one to eight values');

function assertRowId(sourceId: string): void {
  if (!sourceId) throw new Error('ticket import credentials are row-bound: a source id is required to derive their AAD');
}

/** Seals a credential for storage under the source's row id. */
export function sealSourceCredentials(sourceId: string, credentials: SourceCredentials): string {
  assertRowId(sourceId);
  const sealed = encryptSecret(JSON.stringify(credentials), { aad: columnAad(SOURCE_CREDENTIALS_SPEC, sourceId) });
  if (!sealed) throw new Error(`Could not encrypt the credentials of ticket import source ${sourceId}`);
  return sealed;
}

/**
 * Opens a credential. Must be called with the SAME source id it was sealed
 * under: another id fails the AAD check and throws, by design.
 */
export function openSourceCredentials(sourceId: string, ciphertext: string): SourceCredentials {
  assertRowId(sourceId);
  const plaintext = decryptSecret(ciphertext, { aad: columnAad(SOURCE_CREDENTIALS_SPEC, sourceId) });
  if (!plaintext) throw new Error(`Ticket import source ${sourceId} has no usable credentials`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(plaintext);
  } catch (error) {
    // Never echo the plaintext into the message.
    throw new Error(`Ticket import source ${sourceId} credentials are not valid JSON`, { cause: error });
  }
  const checked = sourceCredentialsSchema.safeParse(parsed);
  if (!checked.success) throw new Error(`Ticket import source ${sourceId} credentials have an unexpected shape`);
  return checked.data;
}
