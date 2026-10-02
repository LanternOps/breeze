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

/** Seeds an ai_platform_models row with a per-test unique model id (W01 defaults fill the rest). */
export async function seedPlatformModel(modelId = `w02-test-${randomUUID()}`): Promise<string> {
  const [row] = await fixtureSql`
    INSERT INTO ai_platform_models (provider, model_id, display_name)
    VALUES ('anthropic', ${modelId}, ${modelId})
    RETURNING id`;
  return String(row!.id);
}

/**
 * A priced, offered platform model, optionally the platform default (W08 #7606).
 * Clears any other default first (partial unique index ai_platform_models_one_default_uq);
 * a suite that sets a default restores the previous one itself.
 */
export async function seedPricedPlatformModel(input: { modelId?: string; isPlatformDefault?: boolean } = {}): Promise<{ id: string; modelId: string }> {
  const modelId = input.modelId ?? `w08-model-${randomUUID()}`;
  if (input.isPlatformDefault) await fixtureSql`UPDATE ai_platform_models SET is_platform_default = false WHERE is_platform_default`;
  const [row] = await fixtureSql`
    INSERT INTO ai_platform_models (provider, model_id, display_name, platform_offered, is_platform_default, lifecycle,
                                    input_cents_per_m, output_cents_per_m, cache_read_cents_per_m, cache_write_cents_per_m)
    VALUES ('anthropic', ${modelId}, ${modelId}, true, ${input.isPlatformDefault ?? false}, 'available', 300, 1500, 30, 375)
    RETURNING id`;
  return { id: String(row!.id), modelId };
}

export async function seedOffering(input: {
  partnerId: string;
  connectionId?: string | null;
  platformModelId?: string | null;
  modelId?: string | null;
  source?: 'platform' | 'discovered' | 'manual' | 'catalog';
  enabled?: boolean;
}): Promise<string> {
  const [row] = await fixtureSql`
    INSERT INTO partner_ai_models (partner_id, connection_id, platform_model_id, model_id, source, enabled)
    VALUES (${input.partnerId}, ${input.connectionId ?? null}, ${input.platformModelId ?? null},
            ${input.modelId ?? null}, ${input.source ?? (input.connectionId ? 'manual' : 'platform')},
            ${input.enabled ?? true})
    RETURNING id`;
  return String(row!.id);
}

/** Seeds a live ai_agents row (kind 'triage') owned by a partner OR an org. */
export async function seedAgent(input: { partnerId?: string; orgId?: string; createdBy: string; model?: string | null }): Promise<string> {
  const [row] = await fixtureSql`
    INSERT INTO ai_agents (partner_id, org_id, kind, name, created_by, model)
    VALUES (${input.partnerId ?? null}, ${input.orgId ?? null}, 'triage', 'W02 fixture', ${input.createdBy}, ${input.model ?? null})
    RETURNING id`;
  return String(row!.id);
}
