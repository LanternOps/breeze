/**
 * AI model registry W02 (#7600): direct-SQL forgery and RLS proofs for every
 * registry table, composite FK and trigger, run through the breeze_app pool
 * (`db` from ../../db) so FORCE RLS applies.
 */
import './setup';
import { afterAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { sql } from 'drizzle-orm';
import { db, withDbAccessContext, withSystemDbAccessContext } from '../../db';
import { columnAad } from '../../services/encryptedColumnRegistry';
import { decryptSecret, encryptSecret } from '../../services/secretCrypto';
import { createOrganization, createPartner } from './db-utils';
import {
  closeRegistryFixtures,
  fixtureSql as adminSql,
  keySpec,
  orgContext,
  partnerContext,
  seedByokConnection,
} from './aiModelRegistryFixtures';

const RUN = !!process.env.DATABASE_URL;
afterAll(closeRegistryFixtures);

const CONNECTIONS_MIGRATION = readFileSync(
  join(__dirname, '../../../migrations', '2026-11-14-100000-ai-model-registry-connections.sql'),
  'utf8',
);

describe.skipIf(!RUN)('partner_ai_connections (#7600 W02)', () => {
  it('partner A cannot INSERT a connection for partner B (42501)', async () => {
    const [a, b] = [await createPartner(), await createPartner()];
    await expect(withDbAccessContext(partnerContext(a.id), () => db.execute(sql`
      INSERT INTO partner_ai_connections (partner_id, kind, name, api_key_encrypted, key_last4, key_fingerprint)
      VALUES (${b.id}, 'anthropic_byok', 'forged', 'enc:x', 'x', 'x')`)))
      .rejects.toMatchObject({ cause: { code: '42501' } });
  });

  it('partner A cannot SELECT partner B connections, and an org token cannot read any', async () => {
    const [a, b] = [await createPartner(), await createPartner()];
    const orgB = await createOrganization({ partnerId: b.id });
    const id = await seedByokConnection(b.id);
    const asA = await withDbAccessContext(partnerContext(a.id), () =>
      db.execute(sql`SELECT id FROM partner_ai_connections WHERE id = ${id}`));
    const asOrgB = await withDbAccessContext(orgContext(orgB.id, b.id), () =>
      db.execute(sql`SELECT id FROM partner_ai_connections WHERE id = ${id}`));
    expect([...asA]).toEqual([]);
    expect([...asOrgB]).toEqual([]);
  });

  it('rejects a catalog connection without a catalog entry (23514)', async () => {
    const p = await createPartner();
    await expect(withSystemDbAccessContext(() => db.execute(sql`
      INSERT INTO partner_ai_connections (partner_id, kind, name, api_key_encrypted, key_last4, key_fingerprint)
      VALUES (${p.id}, 'catalog', 'no entry', 'enc:x', 'x', 'x')`)))
      .rejects.toMatchObject({ cause: { code: '23514' } });
  });

  it('copies a legacy config with the same id and byte-identical ciphertext that still decrypts (quorum #13)', async () => {
    const partner = await createPartner();
    const legacyId = randomUUID();
    const plaintext = 'sk-ant-api03-pre-migration-key-4242';
    const sealed = encryptSecret(plaintext, { aad: columnAad(keySpec('partner_llm_configs'), legacyId) });
    expect(sealed).toBeTruthy();
    await adminSql`
      INSERT INTO partner_llm_configs (id, partner_id, api_key_encrypted, key_last4, key_fingerprint, default_model)
      VALUES (${legacyId}, ${partner.id}, ${sealed!}, '4242', 'fp-legacy', NULL)`;

    await adminSql.unsafe(CONNECTIONS_MIGRATION);

    const [row] = await adminSql`SELECT * FROM partner_ai_connections WHERE id = ${legacyId}`;
    expect(row).toMatchObject({
      partner_id: partner.id,
      kind: 'anthropic_byok',
      api_key_encrypted: sealed,
      key_last4: '4242',
      legacy_default_model: null,
      status: 'active',
    });
    expect(decryptSecret(String(row!.api_key_encrypted), { aad: columnAad(keySpec('partner_ai_connections'), legacyId) }))
      .toBe(plaintext);
    expect(() => decryptSecret(String(row!.api_key_encrypted), { aad: columnAad(keySpec('partner_ai_connections'), randomUUID()) }))
      .toThrow();

    // Re-applying is a no-op.
    await adminSql.unsafe(CONNECTIONS_MIGRATION);
    const [count] = await adminSql`SELECT count(*)::int AS n FROM partner_ai_connections WHERE partner_id = ${partner.id}`;
    expect(count!.n).toBe(1);
  });

  it('enforces one compat (anthropic_byok|catalog) connection per partner during W02–W03 (23505)', async () => {
    const p = await createPartner();
    await seedByokConnection(p.id);
    await expect(seedByokConnection(p.id)).rejects.toMatchObject({ code: '23505' });
  });

  it('a legacy UPDATE (e.g. markPartnerLlmError) is mirrored onto the same-id connection in the same statement', async () => {
    const partner = await createPartner();
    const legacyId = randomUUID();
    const sealed = encryptSecret('sk-ant-api03-mirror-5151', { aad: columnAad(keySpec('partner_llm_configs'), legacyId) })!;
    await adminSql`INSERT INTO partner_llm_configs (id, partner_id, api_key_encrypted, key_last4, key_fingerprint)
                   VALUES (${legacyId}, ${partner.id}, ${sealed}, '5151', 'fp')`;
    await adminSql.unsafe(CONNECTIONS_MIGRATION);
    await withSystemDbAccessContext(() => db.execute(sql`
      UPDATE partner_llm_configs SET status = 'error', last_error = 'auth_rejected' WHERE id = ${legacyId} AND config_version = 1`));
    const [row] = await adminSql`SELECT status, last_error FROM partner_ai_connections WHERE id = ${legacyId}`;
    expect(row).toEqual({ status: 'error', last_error: 'auth_rejected' });
  });

  it('the copy works for a NOSUPERUSER NOBYPASSRLS role under system scope (no role-restricted-policy blind spot)', async () => {
    // A non-owner, non-breeze_app role is always subject to RLS, so it proves
    // what a NOBYPASSRLS migration owner would see: only policies without a
    // TO clause apply to it.
    const partner = await createPartner();
    const legacyId = randomUUID();
    const sealed = encryptSecret('sk-ant-api03-probe-role-7777', { aad: columnAad(keySpec('partner_llm_configs'), legacyId) })!;
    await adminSql`
      INSERT INTO partner_llm_configs (id, partner_id, api_key_encrypted, key_last4, key_fingerprint)
      VALUES (${legacyId}, ${partner.id}, ${sealed}, '7777', 'fp-probe')`;
    const copyBlock = CONNECTIONS_MIGRATION.slice(CONNECTIONS_MIGRATION.indexOf('DO $copy$'));
    await adminSql.begin(async (tx) => {
      await tx.unsafe(`DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'w02_rls_probe') THEN
          CREATE ROLE w02_rls_probe NOLOGIN NOSUPERUSER NOBYPASSRLS;
        END IF; END $$`);
      await tx.unsafe('GRANT SELECT ON partner_llm_configs, llm_provider_catalog TO w02_rls_probe');
      await tx.unsafe('GRANT SELECT, INSERT ON partner_ai_connections TO w02_rls_probe');
      await tx.unsafe('SET LOCAL ROLE w02_rls_probe');
      await tx.unsafe(copyBlock);
    });
    const [row] = await adminSql`SELECT api_key_encrypted FROM partner_ai_connections WHERE id = ${legacyId}`;
    expect(row?.api_key_encrypted).toBe(sealed);
  });
});
