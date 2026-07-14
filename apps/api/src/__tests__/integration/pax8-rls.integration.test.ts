/**
 * Real-driver cross-tenant forge tests for the Pax8 billing-sync tables, plus a
 * functional tests of observation bookkeeping and read-only drift detection
 * against real SQL.
 *
 * Runs under vitest.integration.config.ts — code-under-test connects as the
 * unprivileged `breeze_app` role (rolbypassrls=f), so RLS is actually enforced.
 * If `.env.test` is missing the symlink that pins this to the breeze_app role,
 * these tests would pass vacuously on a BYPASSRLS admin connection (see memory:
 * worktree_env_test_rls_vacuous) — the forged-insert assertions are the guard
 * that catches that. The rls-coverage contract test does NOT catch a missing
 * 2nd axis or a WITH CHECK hole on partner-axis tables; only a functional
 * breeze_app insert (this file) does.
 *
 * All five Pax8 tables are partner-axis (RLS shape 3) and gated by the flat
 * `breeze_has_partner_access(partner_id)` helper.
 *
 * Fixture topology (seeded fresh per test under system scope, which bypasses
 * RLS):
 *   partnerA → orgA → contractA → manual contract line(s)
 *           → integrationA → companyMappingA / snapshotA / productMappingA
 *   partnerB → orgB
 *
 * Why NO memoization: setup.ts runs cleanupDatabase() in a beforeEach that
 * TRUNCATE ... CASCADEs partners/organizations before every test, wiping every
 * seeded row. A module-level cache would hand later cases rows that no longer
 * exist, making the assertions vacuous. Each it() re-seeds fresh — matching
 * every sibling *-rls.integration.test.ts.
 */
import './setup';
import { describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import {
  db,
  withDbAccessContext,
  withSystemDbAccessContext,
  type DbAccessContext,
} from '../../db';
import {
  pax8Integrations,
  pax8CompanyMappings,
  pax8SubscriptionSnapshots,
  pax8ProductMappings,
  pax8ContractLineLinks,
  contracts,
  contractLines,
} from '../../db/schema';
import { linkPax8SubscriptionToContractLine, recordPax8SubscriptionObservations } from '../../services/pax8SyncService';
import { detectPax8Drift } from '../../services/pax8Drift';
import { createPartner, createOrganization } from './db-utils';

const runDb = it.runIf(!!process.env.DATABASE_URL);

function partnerCtx(partnerId: string): DbAccessContext {
  return {
    scope: 'partner',
    orgId: null,
    accessibleOrgIds: null,
    accessiblePartnerIds: [partnerId],
    userId: null,
  };
}

async function seedIntegration(partnerId: string) {
  const [integration] = await db
    .insert(pax8Integrations)
    .values({
      partnerId,
      name: 'Pax8',
      clientIdEncrypted: 'enc:client-id',
      clientSecretEncrypted: 'enc:client-secret',
      tokenUrl: 'https://api.pax8.com/v1/token',
    })
    .returning();
  if (!integration) throw new Error('failed to seed pax8 integration');
  return integration;
}

// Re-seeds fresh on every call. Intentionally NOT memoized (see file header).
async function seed() {
  return withSystemDbAccessContext(async () => {
    const partnerA = await createPartner();
    const orgA = await createOrganization({ partnerId: partnerA.id });
    const partnerB = await createPartner();
    const orgB = await createOrganization({ partnerId: partnerB.id });

    const integrationA = await seedIntegration(partnerA.id);

    const [companyA] = await db.insert(pax8CompanyMappings).values({
      integrationId: integrationA.id,
      partnerId: partnerA.id,
      pax8CompanyId: 'pax8-co-a',
      pax8CompanyName: 'Customer A',
      orgId: orgA.id,
    }).returning();
    if (!companyA) throw new Error('failed to seed company mapping A');

    const [snapshotA] = await db.insert(pax8SubscriptionSnapshots).values({
      integrationId: integrationA.id,
      partnerId: partnerA.id,
      pax8CompanyId: 'pax8-co-a',
      pax8SubscriptionId: 'pax8-sub-a',
      orgId: orgA.id,
      quantity: '7.00',
    }).returning();
    if (!snapshotA) throw new Error('failed to seed snapshot A');

    return { partnerA, orgA, partnerB, orgB, integrationA, companyA, snapshotA };
  });
}

describe('pax8 partner-axis RLS (breeze_app)', () => {
  runDb('partner B cannot read partner A integration', async () => {
    const { partnerB, integrationA } = await seed();
    const rows = await withDbAccessContext(partnerCtx(partnerB.id), () =>
      db.select().from(pax8Integrations).where(eq(pax8Integrations.id, integrationA.id))
    );
    expect(rows).toHaveLength(0);
  });

  runDb('system scope can read the seeded integration (existence probe — not vacuous)', async () => {
    const { integrationA } = await seed();
    const rows = await withSystemDbAccessContext(() =>
      db.select().from(pax8Integrations).where(eq(pax8Integrations.id, integrationA.id))
    );
    expect(rows).toHaveLength(1);
  });

  runDb('forged cross-partner insert into pax8_integrations is rejected', async () => {
    const { partnerA, partnerB } = await seed();
    await expect(
      withDbAccessContext(partnerCtx(partnerB.id), () =>
        db.insert(pax8Integrations).values({
          partnerId: partnerA.id, // forged
          name: 'forge',
          clientIdEncrypted: 'x',
          clientSecretEncrypted: 'y',
          tokenUrl: 'https://api.pax8.com/v1/token',
        })
      )
    ).rejects.toMatchObject({ cause: { code: '42501' } });
  });

  runDb('forged cross-partner insert into pax8_company_mappings is rejected', async () => {
    const { partnerA, partnerB, integrationA } = await seed();
    await expect(
      withDbAccessContext(partnerCtx(partnerB.id), () =>
        db.insert(pax8CompanyMappings).values({
          integrationId: integrationA.id, // real partner-A integration so the FK resolves
          partnerId: partnerA.id, // forged — only RLS WITH CHECK can reject
          pax8CompanyId: 'forge-co',
          pax8CompanyName: 'forge',
        })
      )
    ).rejects.toMatchObject({ cause: { code: '42501' } });
  });

  runDb('forged cross-partner insert into pax8_subscription_snapshots is rejected', async () => {
    const { partnerA, partnerB, integrationA } = await seed();
    await expect(
      withDbAccessContext(partnerCtx(partnerB.id), () =>
        db.insert(pax8SubscriptionSnapshots).values({
          integrationId: integrationA.id,
          partnerId: partnerA.id, // forged
          pax8CompanyId: 'pax8-co-a',
          pax8SubscriptionId: 'forge-sub',
          quantity: '1.00',
        })
      )
    ).rejects.toMatchObject({ cause: { code: '42501' } });
  });

  runDb('forged cross-partner insert into pax8_product_mappings is rejected', async () => {
    const { partnerA, partnerB, integrationA } = await seed();
    await expect(
      withDbAccessContext(partnerCtx(partnerB.id), () =>
        db.insert(pax8ProductMappings).values({
          integrationId: integrationA.id,
          partnerId: partnerA.id, // forged
          pax8ProductId: 'forge-prod',
        })
      )
    ).rejects.toMatchObject({ cause: { code: '42501' } });
  });

  runDb('forged cross-partner insert into pax8_contract_line_links is rejected', async () => {
    const { partnerA, partnerB, orgA, integrationA, snapshotA } = await seed();
    // A real manual contract line under org A so the composite (contract_line_id,
    // org_id) FK resolves — isolating RLS as the only reason the insert fails.
    const lineId = await withSystemDbAccessContext(async () => {
      const [contract] = await db.insert(contracts).values({
        partnerId: partnerA.id, orgId: orgA.id, name: 'C', intervalMonths: 1, startDate: '2026-01-01',
      }).returning({ id: contracts.id });
      const [line] = await db.insert(contractLines).values({
        contractId: contract!.id, orgId: orgA.id, lineType: 'manual', description: 'L', unitPrice: '0.00',
      }).returning({ id: contractLines.id });
      return line!.id;
    });

    await expect(
      withDbAccessContext(partnerCtx(partnerB.id), () =>
        db.insert(pax8ContractLineLinks).values({
          integrationId: integrationA.id,
          partnerId: partnerA.id, // forged
          orgId: orgA.id,
          subscriptionSnapshotId: snapshotA.id,
          contractLineId: lineId,
        })
      )
    ).rejects.toMatchObject({ cause: { code: '42501' } });
  });
});

describe('recordPax8SubscriptionObservations gate (breeze_app, real SQL)', () => {
  runDb('records only enabled, manual, same-org, mapped links without changing billing quantity', async () => {
    const { partnerA, orgA, integrationA, snapshotA } = await seed();

    const result = await withSystemDbAccessContext(async () => {
      await db.update(pax8SubscriptionSnapshots)
        .set({ quantityKnown: true })
        .where(eq(pax8SubscriptionSnapshots.id, snapshotA.id));
      const [contract] = await db.insert(contracts).values({
        partnerId: partnerA.id, orgId: orgA.id, name: 'C', intervalMonths: 1, startDate: '2026-01-01',
      }).returning({ id: contracts.id });

      // (1) manual line linked to a mapped snapshot → observed, never applied
      const [manualLine] = await db.insert(contractLines).values({
        contractId: contract!.id, orgId: orgA.id, lineType: 'manual', description: 'manual', unitPrice: '0.00', manualQuantity: '0.00',
      }).returning({ id: contractLines.id });
      await db.insert(pax8ContractLineLinks).values({
        integrationId: integrationA.id, partnerId: partnerA.id, orgId: orgA.id,
        subscriptionSnapshotId: snapshotA.id, contractLineId: manualLine!.id, syncEnabled: true,
      });

      // (2) a synthetic zero with no Pax8 evidence must preserve the last
      // genuine observation instead of replacing it with 0.00.
      const [unknownLine] = await db.insert(contractLines).values({
        contractId: contract!.id, orgId: orgA.id, lineType: 'manual', description: 'unknown', unitPrice: '0.00', manualQuantity: '6.00',
      }).returning({ id: contractLines.id });
      const [unknownSnapshot] = await db.insert(pax8SubscriptionSnapshots).values({
        integrationId: integrationA.id, partnerId: partnerA.id, pax8CompanyId: 'pax8-co-a',
        pax8SubscriptionId: 'pax8-sub-unknown', orgId: orgA.id, quantity: '0.00', quantityKnown: false,
      }).returning({ id: pax8SubscriptionSnapshots.id });
      const previousObservedAt = new Date('2026-01-02T03:04:05.000Z');
      const [unknownLink] = await db.insert(pax8ContractLineLinks).values({
        integrationId: integrationA.id, partnerId: partnerA.id, orgId: orgA.id,
        subscriptionSnapshotId: unknownSnapshot!.id, contractLineId: unknownLine!.id, syncEnabled: true,
        lastObservedQuantity: '6.00', lastObservedAt: previousObservedAt,
      }).returning({ id: pax8ContractLineLinks.id });

      // (3) NON-manual line → must be skipped even when linked + enabled
      const [flatLine] = await db.insert(contractLines).values({
        contractId: contract!.id, orgId: orgA.id, lineType: 'flat', description: 'flat', unitPrice: '5.00', manualQuantity: null,
      }).returning({ id: contractLines.id });
      const [flatSnapshot] = await db.insert(pax8SubscriptionSnapshots).values({
        integrationId: integrationA.id, partnerId: partnerA.id, pax8CompanyId: 'pax8-co-a',
        pax8SubscriptionId: 'pax8-sub-flat', orgId: orgA.id, quantity: '9.00',
      }).returning({ id: pax8SubscriptionSnapshots.id });
      await db.insert(pax8ContractLineLinks).values({
        integrationId: integrationA.id, partnerId: partnerA.id, orgId: orgA.id,
        subscriptionSnapshotId: flatSnapshot!.id, contractLineId: flatLine!.id, syncEnabled: true,
      });

      // (4) manual line linked to an UNMAPPED snapshot (org_id null) → skipped
      const [unmappedLine] = await db.insert(contractLines).values({
        contractId: contract!.id, orgId: orgA.id, lineType: 'manual', description: 'unmapped', unitPrice: '0.00', manualQuantity: '3.00',
      }).returning({ id: contractLines.id });
      const [unmappedSnapshot] = await db.insert(pax8SubscriptionSnapshots).values({
        integrationId: integrationA.id, partnerId: partnerA.id, pax8CompanyId: 'pax8-co-a',
        pax8SubscriptionId: 'pax8-sub-unmapped', orgId: null, quantity: '4.00',
      }).returning({ id: pax8SubscriptionSnapshots.id });
      await db.insert(pax8ContractLineLinks).values({
        integrationId: integrationA.id, partnerId: partnerA.id, orgId: orgA.id,
        subscriptionSnapshotId: unmappedSnapshot!.id, contractLineId: unmappedLine!.id, syncEnabled: true,
      });

      const observationResult = await recordPax8SubscriptionObservations(integrationA.id);

      const rows = await db.select({ id: contractLines.id, qty: contractLines.manualQuantity, type: contractLines.lineType })
        .from(contractLines).where(eq(contractLines.contractId, contract!.id));
      const [preservedUnknownLink] = await db.select({
        quantity: pax8ContractLineLinks.lastObservedQuantity,
        at: pax8ContractLineLinks.lastObservedAt,
      }).from(pax8ContractLineLinks).where(eq(pax8ContractLineLinks.id, unknownLink!.id));
      const byId = new Map(rows.map((r) => [r.id, r]));
      return {
        observationResult,
        manualQty: byId.get(manualLine!.id)?.qty,
        flatQty: byId.get(flatLine!.id)?.qty,
        unmappedQty: byId.get(unmappedLine!.id)?.qty,
        preservedUnknownLink,
        previousObservedAt,
      };
    });

    expect(result.observationResult).toEqual({ observed: 1, skipped: 3 });
    expect(result.manualQty).toBe('0.00'); // billing ledger remains authoritative
    expect(result.flatQty).toBeNull(); // non-manual untouched
    expect(result.unmappedQty).toBe('3.00'); // unmapped-snapshot link skipped
    expect(result.preservedUnknownLink).toEqual({
      quantity: '6.00',
      at: result.previousObservedAt,
    });
  });

  runDb('linking a second subscription to an already-linked line throws a clear error', async () => {
    const { partnerA, orgA, integrationA, snapshotA } = await seed();

    const { lineId, secondSnapshotId } = await withSystemDbAccessContext(async () => {
      const [contract] = await db.insert(contracts).values({
        partnerId: partnerA.id, orgId: orgA.id, name: 'C', intervalMonths: 1, startDate: '2026-01-01',
      }).returning({ id: contracts.id });
      const [line] = await db.insert(contractLines).values({
        contractId: contract!.id, orgId: orgA.id, lineType: 'manual', description: 'L', unitPrice: '0.00',
      }).returning({ id: contractLines.id });
      const [second] = await db.insert(pax8SubscriptionSnapshots).values({
        integrationId: integrationA.id, partnerId: partnerA.id, pax8CompanyId: 'pax8-co-a',
        pax8SubscriptionId: 'pax8-sub-second', orgId: orgA.id, quantity: '2.00',
      }).returning({ id: pax8SubscriptionSnapshots.id });
      return { lineId: line!.id, secondSnapshotId: second!.id };
    });

    await withSystemDbAccessContext(async () => {
      // First link succeeds.
      await linkPax8SubscriptionToContractLine({
        integrationId: integrationA.id, partnerId: partnerA.id,
        subscriptionSnapshotId: snapshotA.id, contractLineId: lineId, syncEnabled: false,
      });
      // Second subscription onto the same contract line → friendly error, not raw 23505.
      await expect(
        linkPax8SubscriptionToContractLine({
          integrationId: integrationA.id, partnerId: partnerA.id,
          subscriptionSnapshotId: secondSnapshotId, contractLineId: lineId, syncEnabled: false,
        })
      ).rejects.toThrow(/already linked to another Pax8 subscription/);
    });
  });
});

describe('detectPax8Drift (breeze_app, real SQL)', () => {
  runDb('returns only enabled, known, partner-owned quantity disagreements', async () => {
    const { partnerA, partnerB, orgA, orgB, integrationA, snapshotA } = await seed();

    const lineId = await withSystemDbAccessContext(async () => {
      const [contract] = await db.insert(contracts).values({
        partnerId: partnerA.id,
        orgId: orgA.id,
        name: 'Drift contract',
        intervalMonths: 1,
        startDate: '2026-01-01',
      }).returning({ id: contracts.id });
      const [line] = await db.insert(contractLines).values({
        contractId: contract!.id,
        orgId: orgA.id,
        lineType: 'manual',
        description: 'Seats',
        unitPrice: '1.00',
        manualQuantity: '5.00',
      }).returning({ id: contractLines.id });
      await db.insert(pax8ContractLineLinks).values({
        integrationId: integrationA.id,
        partnerId: partnerA.id,
        orgId: orgA.id,
        subscriptionSnapshotId: snapshotA.id,
        contractLineId: line!.id,
        syncEnabled: true,
      });
      return line!.id;
    });

    const input = { partnerId: partnerA.id, integrationId: integrationA.id };
    const partnerAOrgCtx = { ...partnerCtx(partnerA.id), accessibleOrgIds: [orgA.id] };
    const partnerBOrgCtx = { ...partnerCtx(partnerB.id), accessibleOrgIds: [orgB.id] };
    // The pre-column/default row is legacy evidence: its synthetic-looking
    // quantity is unknown until a fresh sync explicitly marks it known.
    await expect(withDbAccessContext(partnerAOrgCtx, () => detectPax8Drift(input)))
      .resolves.toEqual([]);
    await withSystemDbAccessContext(() => db.update(pax8SubscriptionSnapshots)
      .set({ quantityKnown: true })
      .where(eq(pax8SubscriptionSnapshots.id, snapshotA.id)));
    await expect(withDbAccessContext(partnerAOrgCtx, () => detectPax8Drift(input)))
      .resolves.toEqual([expect.objectContaining({
        contractLineId: lineId,
        orgId: orgA.id,
        pax8SubscriptionId: 'pax8-sub-a',
        breezeQuantity: '5.00',
        pax8Quantity: '7.00',
      })]);

    await expect(withDbAccessContext(partnerBOrgCtx, () => detectPax8Drift(input)))
      .resolves.toEqual([]);
    await expect(withSystemDbAccessContext(() => detectPax8Drift({
      partnerId: partnerB.id,
      integrationId: integrationA.id,
    }))).resolves.toEqual([]);

    await withSystemDbAccessContext(() => db.update(pax8SubscriptionSnapshots)
      .set({ orgId: null })
      .where(eq(pax8SubscriptionSnapshots.id, snapshotA.id)));
    await expect(withDbAccessContext(partnerAOrgCtx, () => detectPax8Drift(input)))
      .resolves.toEqual([]);
    await withSystemDbAccessContext(() => db.update(pax8SubscriptionSnapshots)
      .set({ orgId: orgA.id })
      .where(eq(pax8SubscriptionSnapshots.id, snapshotA.id)));

    await withSystemDbAccessContext(() => db.update(pax8SubscriptionSnapshots)
      .set({ quantity: '0.00', quantityKnown: false })
      .where(eq(pax8SubscriptionSnapshots.id, snapshotA.id)));
    await expect(withDbAccessContext(partnerAOrgCtx, () => detectPax8Drift(input)))
      .resolves.toEqual([]);

    await withSystemDbAccessContext(() => db.update(pax8SubscriptionSnapshots)
      .set({ quantity: '5.00', quantityKnown: true })
      .where(eq(pax8SubscriptionSnapshots.id, snapshotA.id)));
    await expect(withDbAccessContext(partnerAOrgCtx, () => detectPax8Drift(input)))
      .resolves.toEqual([]);

    await withSystemDbAccessContext(() => db.update(pax8SubscriptionSnapshots)
      .set({ quantity: '7.00' })
      .where(eq(pax8SubscriptionSnapshots.id, snapshotA.id)));
    await withSystemDbAccessContext(() => db.update(pax8ContractLineLinks)
      .set({ syncEnabled: false })
      .where(eq(pax8ContractLineLinks.contractLineId, lineId)));
    await expect(withDbAccessContext(partnerAOrgCtx, () => detectPax8Drift(input)))
      .resolves.toEqual([]);
  });
});
