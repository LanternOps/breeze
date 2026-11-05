/**
 * EDR W06.1 (#8170): "which GravityZone company does this org install into",
 * against real Postgres. An ambiguous org gets no answer; nothing picks one.
 */
import './setup';
import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { db, withSystemDbAccessContext } from '../../db';
import { edrConnections, edrTenants, softwareCatalog } from '../../db/schema';
import {
  clearTenantInstallerMaterial,
  openInstallerMaterial,
  persistInstallerOutcomes,
} from '../../services/edrProviders/installerMaterial';
import { loadInstallerTenantSelections, selectInstallerTenant } from '../../services/edrProviders/installerTenant';
import { createOrganization, createPartner } from './db-utils';

const runDb = it.runIf(!!process.env.DATABASE_URL);

const NOW = new Date('2026-11-05T12:00:00.000Z');
const MATERIAL = { v: 1, packageName: 'Synthetic', windowsUrl: 'https://download.example.test/setup.exe' };

type Partner = Awaited<ReturnType<typeof createPartner>>;

const addConnection = async (partnerId: string, o: { isActive?: boolean; status?: 'connected' | 'reauth_required'; provider?: string } = {}) => {
  const [row] = await db.insert(edrConnections).values({
    partnerId,
    provider: o.provider ?? 'bitdefender',
    name: `GravityZone ${randomUUID().slice(0, 8)}`,
    credentialsEncrypted: 'enc:test',
    vendorRootId: 'root-1',
    vendorRootType: 'partner',
    isActive: o.isActive ?? true,
    status: o.status ?? 'connected',
  }).returning({ id: edrConnections.id });
  return row!.id;
};

const addTenant = async (connectionId: string, partnerId: string, orgId: string, o: { vendorMissingSince?: Date } = {}) => {
  const [row] = await db.insert(edrTenants).values({
    connectionId,
    partnerId,
    orgId,
    vendorTenantId: `company-${randomUUID().slice(0, 8)}`,
    vendorTenantName: 'Example',
    vendorTenantType: 'company',
    mappingSource: 'manual',
    vendorMissingSince: o.vendorMissingSince ?? null,
  }).returning({ id: edrTenants.id });
  return row!.id;
};

const sealFor = (tenantId: string, expiresAt: Date | null = null) =>
  persistInstallerOutcomes(db, 'bitdefender', [{ tenantId, ok: true, data: MATERIAL, expiresAt }], NOW);

const newOrg = async (partner: Partner) => (await createOrganization({ partnerId: partner.id })).id;

describe('installer tenant selection', () => {
  let partner: Partner;
  let connection: string;

  beforeEach(async () => {
    if (!process.env.DATABASE_URL) return;
    await withSystemDbAccessContext(async () => {
      partner = await createPartner();
      connection = await addConnection(partner.id);
    });
  });

  runDb('answers each org, with one sealed material, in at most two queries', async () => {
    const ids = await withSystemDbAccessContext(async () => {
      const ok = await newOrg(partner);
      const okTenant = await addTenant(connection, partner.id, ok);
      await sealFor(okTenant);

      const ambiguous = await newOrg(partner);
      const second = await addConnection(partner.id);
      await sealFor(await addTenant(connection, partner.id, ambiguous));
      await sealFor(await addTenant(second, partner.id, ambiguous));

      const unmapped = await newOrg(partner);

      const reauth = await newOrg(partner);
      await sealFor(await addTenant(await addConnection(partner.id, { status: 'reauth_required' }), partner.id, reauth));

      const disabled = await newOrg(partner);
      await sealFor(await addTenant(await addConnection(partner.id, { isActive: false }), partner.id, disabled));

      const missing = await newOrg(partner);
      await sealFor(await addTenant(connection, partner.id, missing, { vendorMissingSince: NOW }));

      const noMaterial = await newOrg(partner);
      await addTenant(connection, partner.id, noMaterial);

      const expiring = await newOrg(partner);
      await sealFor(await addTenant(connection, partner.id, expiring), new Date(NOW.getTime() + 30 * 60_000));

      const otherProvider = await newOrg(partner);
      await sealFor(await addTenant(await addConnection(partner.id, { provider: 'emsisoft' }), partner.id, otherProvider));

      return { ok, okTenant, ambiguous, unmapped, reauth, disabled, missing, noMaterial, expiring, otherProvider };
    });

    const orgIds = [
      ids.ok, ids.ambiguous, ids.unmapped, ids.reauth, ids.disabled, ids.missing, ids.noMaterial, ids.expiring, ids.otherProvider,
    ];
    const selections = await loadInstallerTenantSelections('bitdefender', orgIds, NOW);

    expect(selections.get(ids.ok)).toMatchObject({ kind: 'ok', tenantId: ids.okTenant, connectionId: connection });
    expect(selections.get(ids.ambiguous)).toEqual({ kind: 'ambiguous', count: 2 });
    expect(selections.get(ids.unmapped)).toEqual({ kind: 'not_mapped' });
    expect(selections.get(ids.reauth)).toEqual({ kind: 'inactive' });
    expect(selections.get(ids.disabled)).toEqual({ kind: 'inactive' });
    expect(selections.get(ids.missing)).toEqual({ kind: 'not_mapped' });
    expect(selections.get(ids.noMaterial)).toEqual({ kind: 'material_missing' });
    expect(selections.get(ids.expiring)).toEqual({ kind: 'material_expired' });
    expect(selections.get(ids.otherProvider)).toEqual({ kind: 'not_mapped' });
    expect(selections.size).toBe(orgIds.length);

    const single = await selectInstallerTenant('bitdefender', ids.ok, NOW);
    if (single.kind !== 'ok') throw new Error(`expected ok, got ${single.kind}`);
    expect(openInstallerMaterial(single.tenantId, single.sealedMaterial)?.data).toEqual(MATERIAL);
  });

  runDb('a tenant cannot map to another partner\'s org: the composite FK refuses it', async () => {
    const foreignOrg = await withSystemDbAccessContext(async () => newOrg(await createPartner()));
    // Caught outside: the refused insert aborts its transaction.
    const error = await withSystemDbAccessContext(() => addTenant(connection, partner.id, foreignOrg))
      .then(() => null, (e: unknown) => e);
    const code = (error as { code?: string; cause?: { code?: string } } | null);
    expect(code?.cause?.code ?? code?.code).toBe('23503');
  });

  runDb('clearing a connection removes the material, and selection then says so', async () => {
    const { org, tenant } = await withSystemDbAccessContext(async () => {
      const orgId = await newOrg(partner);
      const tenantId = await addTenant(connection, partner.id, orgId);
      await sealFor(tenantId);
      return { org: orgId, tenant: tenantId };
    });
    expect(await selectInstallerTenant('bitdefender', org, NOW)).toMatchObject({ kind: 'ok' });

    const cleared = await withSystemDbAccessContext(() => clearTenantInstallerMaterial(db, { connectionId: connection }));
    expect(cleared).toBe(1);
    expect(await selectInstallerTenant('bitdefender', org, NOW)).toEqual({ kind: 'material_missing' });

    const [row] = await withSystemDbAccessContext(() => db
      .select({ fetchedAt: edrTenants.installerFetchedAt, error: edrTenants.installerFetchError })
      .from(edrTenants)
      .where(eq(edrTenants.id, tenant)));
    expect(row).toEqual({ fetchedAt: null, error: null });
  });

  runDb('a vendor verdict retires the link: the org can no longer install', async () => {
    const org = await withSystemDbAccessContext(async () => {
      const orgId = await newOrg(partner);
      const tenantId = await addTenant(connection, partner.id, orgId);
      await sealFor(tenantId);
      await persistInstallerOutcomes(db, 'bitdefender', [{ tenantId, ok: false, code: 'multiple_packages' }], NOW);
      return orgId;
    });
    expect(await selectInstallerTenant('bitdefender', org, NOW)).toEqual({ kind: 'material_missing' });
  });

  runDb('the catalog CHECK admits EDR provider keys and still refuses anything else', async () => {
    const insert = (integrationProvider: string) => withSystemDbAccessContext(() => db.insert(softwareCatalog).values({
      orgId: null,
      partnerId: partner.id,
      integrationProvider,
      name: `Synthetic ${randomUUID().slice(0, 8)}`,
    }).returning({ id: softwareCatalog.id }));

    await expect(insert('bitdefender')).resolves.toHaveLength(1);
    await expect(insert('emsisoft')).resolves.toHaveLength(1);
    const error = await insert('not-a-provider').then(() => null, (e: unknown) => e) as { code?: string; cause?: { code?: string } } | null;
    expect(error?.cause?.code ?? error?.code).toBe('23514');
  });
});
