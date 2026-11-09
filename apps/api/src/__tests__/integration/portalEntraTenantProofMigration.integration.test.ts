/**
 * Portal registration W4 (#11381): Entra tenant proof columns on the org's
 * tenant mapping + the clear-on-repoint trigger
 * (2027-01-22-233500-portal-entra-tenant-proof.sql; plan D1, spec §5.4, inv. 3).
 *
 * Every case runs inside ONE superuser postgres.js transaction that is always
 * rolled back (template: portalAccessPolicyMigration.integration.test.ts).
 *
 * Run:
 *   pnpm test-stack up
 *   cd apps/api && npx vitest run -c vitest.integration.config.ts \
 *     src/__tests__/integration/portalEntraTenantProofMigration.integration.test.ts
 */
import './setup';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import postgres from 'postgres';
import { describe, expect, it } from 'vitest';
import { createOrganization, createPartner, createUser } from './db-utils';

const MIGRATION = '2027-01-22-233500-portal-entra-tenant-proof.sql';
const DATABASE_URL = process.env.DATABASE_URL ?? 'postgresql://breeze_test:breeze_test@localhost:5433/breeze_test';
type Tx = postgres.TransactionSql<Record<string, unknown>>;
class Rollback extends Error { constructor() { super('intentional rollback'); } }

const loadMigration = () => readFile(new URL(`../../../migrations/${MIGRATION}`, import.meta.url), 'utf8');

async function inRolledBackTx(body: (tx: Tx) => Promise<void>): Promise<void> {
  const client = postgres(DATABASE_URL, { max: 1, onnotice: () => {} });
  try {
    await client.begin(async (tx) => {
      // Replay first: a missing file fails every case (red before the migration exists).
      await (tx as unknown as Tx).unsafe(await loadMigration());
      await body(tx as unknown as Tx);
      throw new Rollback();
    });
  } catch (error) {
    if (!(error instanceof Rollback)) throw error;
  } finally {
    await client.end({ timeout: 1 });
  }
}

async function pgErrorOf(tx: Tx, fn: (sp: Tx) => Promise<unknown>): Promise<{ code?: string; constraint_name?: string }> {
  try {
    await tx.savepoint(async (sp) => { await fn(sp as unknown as Tx); });
  } catch (error) {
    return error as { code?: string; constraint_name?: string };
  }
  throw new Error('expected the statement to fail');
}

async function newOrg(): Promise<{ orgId: string; partnerId: string }> {
  const partner = await createPartner();
  const org = await createOrganization({ partnerId: partner.id });
  return { orgId: org.id, partnerId: partner.id };
}

type ProofRow = { proven_at: Date | null; proven_via: string | null; proven_by_user_id: string | null; proven_evidence: unknown };

async function seedProvenMapping(tx: Tx, orgId: string, provenBy: string | null = null): Promise<{ id: string; tenantId: string }> {
  const id = randomUUID();
  const tenantId = randomUUID();
  await tx`
    INSERT INTO client_ai_tenant_mappings (id, org_id, entra_tenant_id, proven_at, proven_via, proven_by_user_id, proven_evidence)
    VALUES (${id}, ${orgId}, ${tenantId}, now(), 'proof_run', ${provenBy},
            ${tx.json({ via: 'proof_run', adminOid: randomUUID(), runId: randomUUID() })})`;
  return { id, tenantId };
}

async function proofOf(tx: Tx, id: string): Promise<ProofRow> {
  const [row] = await tx<ProofRow[]>`
    SELECT proven_at, proven_via, proven_by_user_id, proven_evidence FROM client_ai_tenant_mappings WHERE id = ${id}`;
  return row!;
}

describe('2027-01-22-233500-portal-entra-tenant-proof.sql', () => {
  it('starts with the system-scope line', async () => {
    const text = await loadMigration();
    const firstStatement = text
      .split('\n')
      .map((line) => line.trim())
      .find((line) => line.length > 0 && !line.startsWith('--'));
    expect(firstStatement).toBe("SELECT set_config('breeze.scope', 'system', true);");
  });

  it('refuses proven_via "manual" (23514 client_ai_tenant_mappings_proven_via_chk)', async () => {
    const { orgId } = await newOrg();
    await inRolledBackTx(async (tx) => {
      const err = await pgErrorOf(tx, (sp) => sp`
        INSERT INTO client_ai_tenant_mappings (org_id, entra_tenant_id, proven_at, proven_via, proven_evidence)
        VALUES (${orgId}, ${randomUUID()}, now(), 'manual', ${sp.json({ via: 'manual' })})`);
      expect(err).toMatchObject({ code: '23514', constraint_name: 'client_ai_tenant_mappings_proven_via_chk' });
    });
  });

  it('refuses proven_at set with proven_via or proven_evidence NULL, and the reverse (23514 client_ai_tenant_mappings_proof_shape_chk)', async () => {
    const { orgId } = await newOrg();
    await inRolledBackTx(async (tx) => {
      const noVia = await pgErrorOf(tx, (sp) => sp`
        INSERT INTO client_ai_tenant_mappings (org_id, entra_tenant_id, proven_at, proven_evidence)
        VALUES (${orgId}, ${randomUUID()}, now(), ${sp.json({ via: 'proof_run' })})`);
      expect(noVia).toMatchObject({ code: '23514', constraint_name: 'client_ai_tenant_mappings_proof_shape_chk' });
      const noEvidence = await pgErrorOf(tx, (sp) => sp`
        INSERT INTO client_ai_tenant_mappings (org_id, entra_tenant_id, proven_at, proven_via)
        VALUES (${orgId}, ${randomUUID()}, now(), 'proof_run')`);
      expect(noEvidence).toMatchObject({ code: '23514', constraint_name: 'client_ai_tenant_mappings_proof_shape_chk' });
      // Complete evidence, so only the missing proven_at is wrong (the evidence check is its own case below).
      const viaWithoutAt = await pgErrorOf(tx, (sp) => sp`
        INSERT INTO client_ai_tenant_mappings (org_id, entra_tenant_id, proven_via, proven_evidence)
        VALUES (${orgId}, ${randomUUID()}, 'proof_run', ${sp.json({ via: 'proof_run', adminOid: randomUUID(), runId: randomUUID() })})`);
      expect(viaWithoutAt).toMatchObject({ code: '23514', constraint_name: 'client_ai_tenant_mappings_proof_shape_chk' });
      // An unproven mapping (all four NULL) is the pre-W4 shape and stays valid.
      await tx`INSERT INTO client_ai_tenant_mappings (org_id, entra_tenant_id) VALUES (${orgId}, ${randomUUID()})`;
    });
  });

  it('ties proven_evidence to proven_via (23514 client_ai_tenant_mappings_proof_evidence_chk)', async () => {
    const { orgId } = await newOrg();
    const { orgId: secondOrgId } = await newOrg();
    const { orgId: thirdOrgId } = await newOrg();
    const run = () => ({ adminOid: randomUUID(), runId: randomUUID() });
    const conn = () => ({ connectionId: randomUUID(), profile: 'customer-graph-read' });
    const cases: Array<[string, string, postgres.JSONValue]> = [
      ['proof-run evidence recorded as m365_connection', 'm365_connection', { via: 'proof_run', ...run() }],
      ['connection evidence recorded as proof_run', 'proof_run', { via: 'm365_connection', ...conn() }],
      ['evidence.via disagrees with proven_via although the keys fit', 'proof_run', { via: 'm365_connection', ...run() }],
      ['proof_run without runId', 'proof_run', { via: 'proof_run', adminOid: randomUUID() }],
      ['proof_run without adminOid', 'proof_run', { via: 'proof_run', runId: randomUUID() }],
      ['m365_connection without profile', 'm365_connection', { via: 'm365_connection', connectionId: randomUUID() }],
      ['m365_connection without connectionId', 'm365_connection', { via: 'm365_connection', profile: 'customer-graph-read' }],
      // These two would read NULL (which passes a CHECK) under a plain `->>'via' = proven_via`.
      ['evidence with no via key', 'proof_run', run()],
      ['evidence that is an array of the key names', 'proof_run', ['via', 'adminOid', 'runId']],
    ];
    await inRolledBackTx(async (tx) => {
      for (const [name, via, evidence] of cases) {
        const err = await pgErrorOf(tx, (sp) => sp`
          INSERT INTO client_ai_tenant_mappings (org_id, entra_tenant_id, proven_at, proven_via, proven_evidence)
          VALUES (${orgId}, ${randomUUID()}, now(), ${via}, ${sp.json(evidence)})`);
        expect(err, name).toMatchObject({ code: '23514', constraint_name: 'client_ai_tenant_mappings_proof_evidence_chk' });
      }

      // Both real shapes (what recordEntraTenantProof writes) are accepted.
      await tx`
        INSERT INTO client_ai_tenant_mappings (org_id, entra_tenant_id, proven_at, proven_via, proven_evidence)
        VALUES (${secondOrgId}, ${randomUUID()}, now(), 'proof_run', ${tx.json({ via: 'proof_run', ...run() })})`;
      const { id } = await seedProvenMapping(tx, orgId);
      await tx`
        INSERT INTO client_ai_tenant_mappings (org_id, entra_tenant_id, proven_at, proven_via, proven_evidence)
        VALUES (${thirdOrgId}, ${randomUUID()}, now(), 'm365_connection', ${tx.json({ via: 'm365_connection', ...conn() })})`;

      // A writer that changes the method without the evidence is refused too.
      const swapped = await pgErrorOf(tx, (sp) => sp`
        UPDATE client_ai_tenant_mappings SET proven_via = 'm365_connection' WHERE id = ${id}`);
      expect(swapped).toMatchObject({ code: '23514', constraint_name: 'client_ai_tenant_mappings_proof_evidence_chk' });
    });
  });

  it('changing entra_tenant_id on a proven row clears all four proof columns', async () => {
    const { orgId, partnerId } = await newOrg();
    const user = await createUser({ partnerId });
    await inRolledBackTx(async (tx) => {
      const { id } = await seedProvenMapping(tx, orgId, user.id);
      // The AI for Office PUT /tenant-mapping upsert shape: tenant + updated_at, no proof columns.
      await tx`UPDATE client_ai_tenant_mappings SET entra_tenant_id = ${randomUUID()}, updated_at = now() WHERE id = ${id}`;
      expect(await proofOf(tx, id)).toEqual({ proven_at: null, proven_via: null, proven_by_user_id: null, proven_evidence: null });
    });
  });

  it('an update that changes entra_tenant_id AND sets a new proven_at keeps the new proof', async () => {
    const { orgId } = await newOrg();
    await inRolledBackTx(async (tx) => {
      const { id } = await seedProvenMapping(tx, orgId);
      const newTenant = randomUUID();
      const evidence = { via: 'm365_connection', connectionId: randomUUID(), profile: 'customer-graph-read' };
      await tx`
        UPDATE client_ai_tenant_mappings
           SET entra_tenant_id = ${newTenant}, proven_at = now() + interval '1 second', proven_via = 'm365_connection',
               proven_evidence = ${tx.json(evidence)}, updated_at = now()
         WHERE id = ${id}`;
      const row = await proofOf(tx, id);
      expect(row.proven_via).toBe('m365_connection');
      expect(row.proven_at).not.toBeNull();
      expect(row.proven_evidence).toEqual(evidence);
    });
  });

  it('changing only updated_at (or org_id) keeps the proof', async () => {
    const { orgId } = await newOrg();
    const { orgId: otherOrgId } = await newOrg();
    await inRolledBackTx(async (tx) => {
      const { id } = await seedProvenMapping(tx, orgId);
      await tx`UPDATE client_ai_tenant_mappings SET updated_at = now() + interval '1 minute' WHERE id = ${id}`;
      expect((await proofOf(tx, id)).proven_via).toBe('proof_run');
      // D8 merge adoption: keep-survivor repoints org_id; the tenant does not change.
      await tx`UPDATE client_ai_tenant_mappings SET org_id = ${otherOrgId} WHERE id = ${id}`;
      const row = await proofOf(tx, id);
      expect(row.proven_via).toBe('proof_run');
      expect(row.proven_at).not.toBeNull();
    });
  });

  it('deleting the proving user nulls proven_by_user_id and keeps the proof', async () => {
    const { orgId, partnerId } = await newOrg();
    const user = await createUser({ partnerId });
    await inRolledBackTx(async (tx) => {
      const { id } = await seedProvenMapping(tx, orgId, user.id);
      await tx`DELETE FROM users WHERE id = ${user.id}`;
      const row = await proofOf(tx, id);
      expect(row.proven_by_user_id).toBeNull();
      expect(row.proven_via).toBe('proof_run');
      expect(row.proven_at).not.toBeNull();
    });
  });

  it('is idempotent: a second replay changes nothing', async () => {
    const { orgId } = await newOrg();
    await inRolledBackTx(async (tx) => {
      const { id } = await seedProvenMapping(tx, orgId);
      const snapshot = async () => ({
        columns: await tx`
          SELECT column_name, data_type, is_nullable FROM information_schema.columns
           WHERE table_schema = 'public' AND table_name = 'client_ai_tenant_mappings' ORDER BY column_name`,
        checks: await tx`
          SELECT conname, pg_get_constraintdef(oid) AS def FROM pg_constraint
           WHERE conrelid = 'public.client_ai_tenant_mappings'::regclass ORDER BY conname`,
        triggers: await tx`
          SELECT tgname FROM pg_trigger WHERE tgrelid = 'public.client_ai_tenant_mappings'::regclass AND NOT tgisinternal ORDER BY tgname`,
        row: await proofOf(tx, id),
      });
      const first = await snapshot();
      await tx.unsafe(await loadMigration());
      expect(await snapshot()).toEqual(first);
    });
  });
});
