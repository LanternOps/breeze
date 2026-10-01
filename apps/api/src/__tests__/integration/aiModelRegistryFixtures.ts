/**
 * Shared seeds for the AI model registry integration suites (#7600 W02;
 * Tasks 3 and 6 extend it).
 * Seeds go through a superuser client (bypasses RLS); code under test goes
 * through `db` from ../../db (the breeze_app pool, FORCE RLS applies).
 * Not a test file: nothing here registers a describe/it.
 */
import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import type { DbAccessContext } from '../../db';
import { columnAad, encryptedColumnRegistry, type EncryptedColumnSpec } from '../../services/encryptedColumnRegistry';
import { encryptSecret } from '../../services/secretCrypto';

export const fixtureSql = postgres(process.env.DATABASE_URL ?? '', { max: 1 });
export async function closeRegistryFixtures(): Promise<void> {
  await fixtureSql.end({ timeout: 5 });
}

export function partnerContext(partnerId: string, orgIds: string[] = []): DbAccessContext {
  return { scope: 'partner', orgId: null, accessibleOrgIds: orgIds, accessiblePartnerIds: [partnerId], currentPartnerId: partnerId, userId: null };
}

export function orgContext(orgId: string, partnerId: string): DbAccessContext {
  return { scope: 'organization', orgId, accessibleOrgIds: [orgId], accessiblePartnerIds: [], currentPartnerId: partnerId, userId: null };
}

export function keySpec(table: 'partner_llm_configs' | 'partner_ai_connections'): EncryptedColumnSpec {
  const found = encryptedColumnRegistry.find((s) => s.table === table && s.column === 'api_key_encrypted');
  if (!found) throw new Error(`${table}.api_key_encrypted is not registered`);
  return found;
}

/** Seeds a BYOK connection directly (superuser) and returns its id. */
export async function seedByokConnection(partnerId: string, id: string = randomUUID()): Promise<string> {
  const sealed = encryptSecret('sk-ant-api03-forgery-fixture-0000', { aad: columnAad(keySpec('partner_ai_connections'), id) });
  await fixtureSql`
    INSERT INTO partner_ai_connections (id, partner_id, kind, name, api_key_encrypted, key_last4, key_fingerprint)
    VALUES (${id}, ${partnerId}, 'anthropic_byok', 'Fixture key', ${sealed!}, '0000', 'fp-fixture')`;
  return id;
}
