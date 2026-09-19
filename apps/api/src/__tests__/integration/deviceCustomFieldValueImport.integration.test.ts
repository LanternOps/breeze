/**
 * The value importer's contracts that only a real database can prove
 * (#3257 W08).
 *
 * Five properties, each of which a mocked test would assert vacuously:
 *
 *  1. **Tenant isolation is app-layer, and RLS is still a second control.**
 *     `loadDeviceResolutionSnapshot` runs under
 *     `runOutsideDbContext(() => withSystemDbAccessContext(...))`, where
 *     `breeze_has_org_access` returns TRUE for every row — so an appeal to RLS
 *     on the READ path would be vacuous, and the SQL predicates are the whole
 *     boundary. The WRITES, by contrast, deliberately stay in the request's own
 *     context, and the second test below proves that by widening the app-layer
 *     scope on purpose and watching Postgres refuse the write anyway.
 *  2. **Per-row transaction isolation.** A row that fails leaves the rows before
 *     it committed and does not stop the rows after it — the property a single
 *     request-wide transaction cannot provide, because one failed statement
 *     aborts it and everything later raises 25P02.
 *  3. **Partial application inside one row.**
 *  4. **The durable link makes a re-run exact**, including in the case that
 *     motivates it: a hostname that has since become ambiguous.
 *  5. **The warranty target is not inert.** It writes a COMPUTED `status`, and
 *     `evaluateWarrantyAlerts` — which returns early on `unknown` — actually
 *     fires afterwards. Asserting only that a row was written would pass
 *     against exactly the bug this is guarding.
 */
import './setup';
import { describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { withDbAccessContext, withSystemDbAccessContext, type DbAccessContext } from '../../db';
import {
  configPolicyAssignments,
  configPolicyFeatureLinks,
  configurationPolicies,
  customFieldDefinitions,
  deviceCustomFieldValues,
  deviceExternalLinks,
  deviceHardware,
  deviceWarranty,
  devices,
} from '../../db/schema';
import {
  commitDeviceCustomFieldImport,
  previewDeviceCustomFieldImport,
  type ValueImportContext,
} from '../../services/customFields/import/valueImport';
import { evaluateWarrantyAlerts } from '../../services/warrantyAlertEvaluator';
import type { CommitValueRowInput, MappingTarget } from '../../services/customFields/import/types';
import { createOrganization, createPartner, createSite } from './db-utils';
import { getTestDb } from './setup';

const runDb = it.runIf(!!process.env.DATABASE_URL);

let seq = 0;

const actor = { userId: null };

const v = (fieldKey: string, value: unknown) => ({
  target: { kind: 'customField', fieldKey } as MappingTarget,
  value,
});
const w = (field: 'warrantyEndDate' | 'warrantyStartDate' | 'manufacturer', value: unknown) => ({
  target: { kind: 'warranty', field } as MappingTarget,
  value,
});

function inDays(days: number): string {
  return new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);
}

/** The RLS context a partner-scoped request would establish. */
function partnerCtx(partnerId: string, accessibleOrgIds: string[]): DbAccessContext {
  return {
    scope: 'partner',
    orgId: null,
    accessibleOrgIds,
    accessiblePartnerIds: [partnerId],
    currentPartnerId: partnerId,
    userId: null,
  };
}

async function seedDevice(input: {
  orgId: string;
  siteId: string;
  hostname: string;
  serialNumber?: string | null;
  osType?: 'windows' | 'macos' | 'linux';
}): Promise<string> {
  seq += 1;
  const db = getTestDb();
  const [device] = await db.insert(devices).values({
    orgId: input.orgId,
    siteId: input.siteId,
    agentId: `agent-w08-${Date.now()}-${seq}`,
    hostname: input.hostname,
    displayName: input.hostname.toUpperCase(),
    osType: input.osType ?? 'windows',
    osVersion: '11',
    architecture: 'x64',
    agentVersion: '1.0.0',
    status: 'online',
  }).returning({ id: devices.id });
  if (input.serialNumber) {
    await db.insert(deviceHardware).values({
      deviceId: device!.id,
      orgId: input.orgId,
      serialNumber: input.serialNumber,
    });
  }
  return device!.id;
}

/**
 * A PARTNER-WIDE definition, deliberately: it is visible to every organization
 * under the partner, which is what an MSP importing one incumbent field list
 * across their whole book actually has — and it exercises the dual-axis branch
 * of the coherence trigger rather than the trivial same-org one.
 */
async function seedDefinition(input: {
  partnerId: string;
  fieldKey: string;
  type: 'text' | 'number' | 'boolean' | 'dropdown' | 'date';
  deviceTypes?: string[] | null;
}): Promise<string> {
  const [definition] = await getTestDb().insert(customFieldDefinitions).values({
    orgId: null,
    partnerId: input.partnerId,
    name: input.fieldKey,
    fieldKey: input.fieldKey,
    type: input.type,
    deviceTypes: input.deviceTypes ?? null,
  }).returning({ id: customFieldDefinitions.id });
  return definition!.id;
}

async function storedValues(deviceId: string) {
  return getTestDb()
    .select({
      fieldKey: deviceCustomFieldValues.fieldKey,
      valueText: deviceCustomFieldValues.valueText,
      valueNumber: deviceCustomFieldValues.valueNumber,
      source: deviceCustomFieldValues.source,
    })
    .from(deviceCustomFieldValues)
    .where(eq(deviceCustomFieldValues.deviceId, deviceId));
}

async function seedWorld() {
  const partnerA = await createPartner();
  const orgA = await createOrganization({ partnerId: partnerA!.id });
  const orgA2 = await createOrganization({ partnerId: partnerA!.id });
  const siteA = await createSite({ orgId: orgA!.id, name: 'Site A' });
  const siteA2 = await createSite({ orgId: orgA2!.id, name: 'Site A2' });

  const partnerB = await createPartner();
  const orgB = await createOrganization({ partnerId: partnerB!.id });
  const siteB = await createSite({ orgId: orgB!.id });

  await seedDefinition({ partnerId: partnerA!.id, fieldKey: 'asset_tag', type: 'text' });
  await seedDefinition({ partnerId: partnerA!.id, fieldKey: 'rack_units', type: 'number' });
  await seedDefinition({ partnerId: partnerB!.id, fieldKey: 'asset_tag', type: 'text' });

  return {
    partnerA: partnerA!.id,
    partnerB: partnerB!.id,
    orgA: orgA!.id,
    orgA2: orgA2!.id,
    orgB: orgB!.id,
    siteA: siteA!.id,
    siteA2: siteA2!.id,
    siteB: siteB!.id,
  };
}

describe('device custom-field VALUE import (real Postgres)', () => {
  runDb('refuses a cross-partner forge: another partner\'s device is not-found, never written', async () => {
    const world = await seedWorld();
    const mine = await seedDevice({ orgId: world.orgA, siteId: world.siteA, hostname: 'mine-1', serialNumber: 'sn-mine-1' });
    const theirs = await seedDevice({ orgId: world.orgB, siteId: world.siteB, hostname: 'theirs-1', serialNumber: 'sn-theirs-1' });

    const ctx: ValueImportContext = {
      partnerId: world.partnerA,
      accessibleOrgIds: [world.orgA],
      allowedSiteIds: null,
      mode: 'update',
    };

    const summary = await withDbAccessContext(partnerCtx(world.partnerA, [world.orgA]), () =>
      commitDeviceCustomFieldImport(
        [
          { hostname: 'mine-1', values: [v('asset_tag', 'MINE')] },
          // Every identifier the forger could reach for, all naming partner B.
          { deviceId: theirs, values: [v('asset_tag', 'STOLEN')] },
          { hostname: 'theirs-1', serialNumber: 'sn-theirs-1', values: [v('asset_tag', 'STOLEN')] },
          { organizationId: world.orgB, hostname: 'theirs-1', values: [v('asset_tag', 'STOLEN')] },
        ] as CommitValueRowInput[],
        ctx,
        actor,
      ),
    );

    expect(summary.rows.map((r) => r.index)).toEqual([0]);
    // `org-not-found` for the row that NAMED the foreign org, `not-found` for
    // the rest — never `write-failed`, which would mean the write was tried.
    expect(summary.errors.map((e) => ({ index: e.index, code: e.code }))).toEqual([
      { index: 1, code: 'not-found' },
      { index: 2, code: 'not-found' },
      { index: 3, code: 'org-not-found' },
    ]);
    expect(await storedValues(theirs)).toHaveLength(0);
    expect(await storedValues(mine)).toHaveLength(1);
  });

  runDb('RLS still refuses a write the app-layer scope wrongly admitted, and the row is isolated', async () => {
    // The app-layer scope below is DELIBERATELY wider than the request's RLS
    // context — the shape a caller bug would have. The resolver admits the
    // orgA2 device, and Postgres refuses its INSERT anyway. That is the whole
    // point of keeping the writes inside the request context instead of
    // escaping to a system one.
    const world = await seedWorld();
    const first = await seedDevice({ orgId: world.orgA, siteId: world.siteA, hostname: 'row-a', serialNumber: 'sn-row-a' });
    const outside = await seedDevice({ orgId: world.orgA2, siteId: world.siteA2, hostname: 'row-b', serialNumber: 'sn-row-b' });
    const last = await seedDevice({ orgId: world.orgA, siteId: world.siteA, hostname: 'row-c', serialNumber: 'sn-row-c' });

    const ctx: ValueImportContext = {
      partnerId: world.partnerA,
      accessibleOrgIds: [world.orgA, world.orgA2],
      allowedSiteIds: null,
      mode: 'update',
    };

    const summary = await withDbAccessContext(partnerCtx(world.partnerA, [world.orgA]), () =>
      commitDeviceCustomFieldImport(
        [
          { hostname: 'row-a', values: [v('asset_tag', 'A')] },
          { hostname: 'row-b', values: [v('asset_tag', 'B')] },
          { hostname: 'row-c', values: [v('asset_tag', 'C')] },
        ] as CommitValueRowInput[],
        ctx,
        actor,
      ),
    );

    expect(summary.errors.map((e) => ({ index: e.index, code: e.code }))).toEqual([
      { index: 1, code: 'write-failed' },
    ]);
    // The failing row rolled back to its own savepoint: the row BEFORE it is
    // committed and the row AFTER it still ran.
    expect(summary.rows.map((r) => r.index)).toEqual([0, 2]);
    expect((await storedValues(first))[0]).toMatchObject({ valueText: 'A' });
    expect(await storedValues(outside)).toHaveLength(0);
    expect((await storedValues(last))[0]).toMatchObject({ valueText: 'C' });

    // And no driver text escaped into the operator-facing copy.
    expect(summary.errors[0]!.error).not.toMatch(/row-level security|policy|INSERT/i);
  });

  runDb('applies the good values on a row and reports the rest, in one transaction', async () => {
    const world = await seedWorld();
    const device = await seedDevice({ orgId: world.orgA, siteId: world.siteA, hostname: 'partial-1', serialNumber: 'sn-partial-1' });
    await seedDefinition({ partnerId: world.partnerA, fieldKey: 'bitlocker_status', type: 'text', deviceTypes: ['macos'] });
    await seedDefinition({ partnerId: world.partnerA, fieldKey: 'rack_position', type: 'number' });

    const ctx: ValueImportContext = {
      partnerId: world.partnerA, accessibleOrgIds: [world.orgA], allowedSiteIds: null, mode: 'update',
    };

    const summary = await withDbAccessContext(partnerCtx(world.partnerA, [world.orgA]), () =>
      commitDeviceCustomFieldImport(
        [{
          hostname: 'partial-1',
          values: [
            v('asset_tag', 'AB-1'),
            v('rack_units', 4),
            v('never_defined', 'x'),
            v('rack_position', 'not a number'),
            v('bitlocker_status', 'on'),
          ],
        }] as CommitValueRowInput[],
        ctx,
        actor,
      ),
    );

    expect(summary.errors).toHaveLength(0);
    // 2 applied; no-definition, type-error and not-applicable-to-device are the
    // three failures — and the two that DID land are still committed.
    expect(summary.rows[0]).toMatchObject({ applied: 2, failed: 3 });
    const stored = await storedValues(device);
    expect(stored.map((s) => s.fieldKey).sort()).toEqual(['asset_tag', 'rack_units']);
    expect(stored.every((s) => s.source === 'import')).toBe(true);

    // The projection trigger rebuilt devices.custom_fields from the table.
    const [projected] = await getTestDb()
      .select({ customFields: devices.customFields })
      .from(devices)
      .where(eq(devices.id, device));
    expect(projected!.customFields).toMatchObject({ asset_tag: 'AB-1', rack_units: 4 });
  });

  runDb('the durable link makes the SECOND run exact, even after the hostname turns ambiguous', async () => {
    const world = await seedWorld();
    const device = await seedDevice({ orgId: world.orgA, siteId: world.siteA, hostname: 'shared-name', serialNumber: 'sn-link-1' });

    const ctx: ValueImportContext = {
      partnerId: world.partnerA, accessibleOrgIds: [world.orgA], allowedSiteIds: null, mode: 'update',
    };
    const row = {
      externalSystem: 'datto_rmm',
      externalId: 'uid-link-1',
      hostname: 'shared-name',
      values: [v('asset_tag', 'AB-1')],
    } as CommitValueRowInput;

    const first = await withDbAccessContext(partnerCtx(world.partnerA, [world.orgA]), () =>
      commitDeviceCustomFieldImport([row], ctx, actor));

    expect(first.rows[0]).toMatchObject({ deviceId: device, method: 'hostname', linkCreated: true });
    expect(first.linksCreated).toBe(1);
    const [link] = await getTestDb()
      .select({ deviceId: deviceExternalLinks.deviceId, system: deviceExternalLinks.system })
      .from(deviceExternalLinks)
      .where(and(
        eq(deviceExternalLinks.partnerId, world.partnerA),
        eq(deviceExternalLinks.externalId, 'uid-link-1'),
      ));
    expect(link).toMatchObject({ deviceId: device, system: 'datto_rmm' });

    // A second machine takes the same hostname — the case the link exists for.
    await seedDevice({ orgId: world.orgA, siteId: world.siteA, hostname: 'shared-name', serialNumber: 'sn-link-2' });

    // CONTROL: without the external id, the row is now unresolvable and the
    // importer refuses to guess.
    const control = await withDbAccessContext(partnerCtx(world.partnerA, [world.orgA]), () =>
      commitDeviceCustomFieldImport(
        [{ hostname: 'shared-name', values: [v('asset_tag', 'AB-2')] }] as CommitValueRowInput[],
        ctx,
        actor,
      ));
    expect(control.errors.map((e) => e.code)).toEqual(['match-unconfirmed']);

    // WITH the external id, the link pins it exactly — and needs no
    // acknowledgement, because the link IS the earlier acknowledgement.
    const second = await withDbAccessContext(partnerCtx(world.partnerA, [world.orgA]), () =>
      commitDeviceCustomFieldImport([{ ...row, values: [v('asset_tag', 'AB-2')] }], ctx, actor));

    expect(second.errors).toHaveLength(0);
    expect(second.rows[0]).toMatchObject({ deviceId: device, method: 'link', linkCreated: false });
    expect(second.linksCreated).toBe(0);
    expect((await storedValues(device))[0]).toMatchObject({ valueText: 'AB-2' });
  });

  runDb('re-running an identical file in the default skip mode writes nothing', async () => {
    const world = await seedWorld();
    const device = await seedDevice({ orgId: world.orgA, siteId: world.siteA, hostname: 'idempotent-1', serialNumber: 'sn-idem-1' });

    const ctx: ValueImportContext = {
      partnerId: world.partnerA, accessibleOrgIds: [world.orgA], allowedSiteIds: null,
    };
    const rows = [{
      hostname: 'idempotent-1',
      values: [v('asset_tag', 'AB-1'), v('rack_units', 4)],
    }] as CommitValueRowInput[];

    await withDbAccessContext(partnerCtx(world.partnerA, [world.orgA]), () =>
      commitDeviceCustomFieldImport(rows, ctx, actor));
    const again = await withDbAccessContext(partnerCtx(world.partnerA, [world.orgA]), () =>
      commitDeviceCustomFieldImport(rows, ctx, actor));

    expect(again.appliedValues).toBe(0);
    expect(again.skippedValues).toBe(2);
    expect(await storedValues(device)).toHaveLength(2);

    const annotated = await withDbAccessContext(partnerCtx(world.partnerA, [world.orgA]), () =>
      previewDeviceCustomFieldImport(rows, ctx));
    expect(annotated[0]!.values.map((x) => x.outcome)).toEqual(['skipped-already-set', 'skipped-already-set']);
  });

  runDb('re-running an identical WARRANTY file previews and commits as already-set', async () => {
    // Preview and commit must agree on warranty exactly as they do on custom
    // fields; before the review pass, preview promised `applied` here.
    const world = await seedWorld();
    const device = await seedDevice({ orgId: world.orgA, siteId: world.siteA, hostname: 'warranty-3', serialNumber: 'sn-warranty-3' });

    const ctx: ValueImportContext = {
      partnerId: world.partnerA, accessibleOrgIds: [world.orgA], allowedSiteIds: null, mode: 'update',
    };
    const rows = [{
      hostname: 'warranty-3', values: [w('warrantyEndDate', inDays(30)), w('manufacturer', 'Dell')],
    }] as CommitValueRowInput[];

    const first = await withDbAccessContext(partnerCtx(world.partnerA, [world.orgA]), () =>
      commitDeviceCustomFieldImport(rows, ctx, actor));
    expect(first.rows[0]!.warranty).toBe('applied');

    const annotated = await withDbAccessContext(partnerCtx(world.partnerA, [world.orgA]), () =>
      previewDeviceCustomFieldImport(rows, ctx));
    expect(annotated[0]!.values.map((x) => x.outcome)).toEqual(['skipped-already-set', 'skipped-already-set']);

    const again = await withDbAccessContext(partnerCtx(world.partnerA, [world.orgA]), () =>
      commitDeviceCustomFieldImport(rows, ctx, actor));
    expect(again.rows[0]!.warranty).toBe('skipped-already-set');
    expect(again.appliedValues).toBe(0);

    // And nothing was rewritten.
    const [row] = await getTestDb()
      .select({ endDate: deviceWarranty.warrantyEndDate })
      .from(deviceWarranty)
      .where(eq(deviceWarranty.deviceId, device));
    expect(row).toMatchObject({ endDate: inDays(30) });
  });

  runDb('the durable link key round-trips through externalSourceInstance', async () => {
    const world = await seedWorld();
    const device = await seedDevice({ orgId: world.orgA, siteId: world.siteA, hostname: 'si-1', serialNumber: 'sn-si-1' });

    const ctx: ValueImportContext = {
      partnerId: world.partnerA, accessibleOrgIds: [world.orgA], allowedSiteIds: null, mode: 'update',
    };
    const row = {
      externalSystem: 'datto_rmm',
      externalId: 'uid-si-1',
      externalSourceInstance: 'tenant-a',
      hostname: 'si-1',
      values: [v('asset_tag', 'AB-1')],
    } as CommitValueRowInput;

    const first = await withDbAccessContext(partnerCtx(world.partnerA, [world.orgA]), () =>
      commitDeviceCustomFieldImport([row], ctx, actor));
    expect(first.rows[0]).toMatchObject({ method: 'hostname', linkCreated: true });

    // Second run, same row: the link written above must be the one the resolver
    // reads back — proving the write side and W06's read side build the SAME
    // composite key including the reserved discriminator.
    const second = await withDbAccessContext(partnerCtx(world.partnerA, [world.orgA]), () =>
      commitDeviceCustomFieldImport([{ ...row, values: [v('asset_tag', 'AB-2')] }], ctx, actor));
    expect(second.rows[0]).toMatchObject({ deviceId: device, method: 'link', linkCreated: false });

    // A DIFFERENT source instance is a different key and must not match it.
    const other = await withDbAccessContext(partnerCtx(world.partnerA, [world.orgA]), () =>
      commitDeviceCustomFieldImport(
        [{ ...row, externalSourceInstance: 'tenant-b', values: [v('asset_tag', 'AB-3')] }],
        ctx,
        actor,
      ));
    expect(other.rows[0]).toMatchObject({ method: 'hostname', linkCreated: true });

    const links = await getTestDb()
      .select({ sourceInstance: deviceExternalLinks.sourceInstance })
      .from(deviceExternalLinks)
      .where(eq(deviceExternalLinks.deviceId, device));
    expect(links.map((l) => l.sourceInstance).sort()).toEqual(['tenant-a', 'tenant-b']);
  });

  runDb('the warranty target writes a COMPUTED status, so evaluateWarrantyAlerts actually fires', async () => {
    const world = await seedWorld();
    const device = await seedDevice({ orgId: world.orgA, siteId: world.siteA, hostname: 'warranty-1', serialNumber: 'sn-warranty-1' });

    // Warranty alerting is opt-in: without an active, assigned warranty policy
    // the evaluator resolves to DISABLED_SETTINGS and would return null no
    // matter what the import wrote — which is how a vacuous version of this
    // test passes.
    const testDb = getTestDb();
    const [policy] = await testDb.insert(configurationPolicies).values({
      orgId: world.orgA, partnerId: null, name: 'Warranty', status: 'active',
    }).returning({ id: configurationPolicies.id });
    await testDb.insert(configPolicyFeatureLinks).values({
      configPolicyId: policy!.id,
      featureType: 'warranty',
      inlineSettings: { enabled: true, warnDays: 90, criticalDays: 30 },
    });
    await testDb.insert(configPolicyAssignments).values({
      configPolicyId: policy!.id, level: 'organization', targetId: world.orgA, priority: 0,
    });

    // Nothing to alert on before the import.
    expect(await withSystemDbAccessContext(() => evaluateWarrantyAlerts(device))).toBeNull();

    const ctx: ValueImportContext = {
      partnerId: world.partnerA, accessibleOrgIds: [world.orgA], allowedSiteIds: null, mode: 'update',
    };
    const summary = await withDbAccessContext(partnerCtx(world.partnerA, [world.orgA]), () =>
      commitDeviceCustomFieldImport(
        [{
          hostname: 'warranty-1',
          values: [w('warrantyEndDate', inDays(30)), w('manufacturer', 'Dell')],
        }] as CommitValueRowInput[],
        ctx,
        actor,
      ));

    expect(summary.errors).toHaveLength(0);
    expect(summary.rows[0]).toMatchObject({ warranty: 'applied', applied: 2 });

    const [warranty] = await testDb
      .select({
        status: deviceWarranty.status,
        endDate: deviceWarranty.warrantyEndDate,
        isSubscription: deviceWarranty.isSubscription,
        dataSource: deviceWarranty.dataSource,
        manufacturer: deviceWarranty.manufacturer,
      })
      .from(deviceWarranty)
      .where(eq(deviceWarranty.deviceId, device));

    // The status is the load-bearing column: the evaluator returns early on
    // 'unknown', which is what this column defaults to.
    expect(warranty).toMatchObject({
      status: 'expiring',
      endDate: inDays(30),
      isSubscription: false,
      dataSource: 'import',
      manufacturer: 'dell',
    });

    expect(await withSystemDbAccessContext(() => evaluateWarrantyAlerts(device))).not.toBeNull();
  });

  runDb('refuses to clobber a provider-sourced warranty row without the opt-in', async () => {
    const world = await seedWorld();
    const device = await seedDevice({ orgId: world.orgA, siteId: world.siteA, hostname: 'warranty-2', serialNumber: 'sn-warranty-2' });
    await getTestDb().insert(deviceWarranty).values({
      deviceId: device,
      orgId: world.orgA,
      manufacturer: 'dell',
      serialNumber: 'sn-warranty-2',
      status: 'active',
      warrantyEndDate: inDays(400),
      dataSource: 'provider',
    });

    const base: ValueImportContext = {
      partnerId: world.partnerA, accessibleOrgIds: [world.orgA], allowedSiteIds: null, mode: 'update',
    };
    const rows = [{
      hostname: 'warranty-2', values: [w('warrantyEndDate', inDays(30))],
    }] as CommitValueRowInput[];

    const guardedPreview = await withDbAccessContext(partnerCtx(world.partnerA, [world.orgA]), () =>
      previewDeviceCustomFieldImport(rows, base));
    expect(guardedPreview[0]!.values[0]!.outcome).toBe('skipped-provider-owned');

    const guarded = await withDbAccessContext(partnerCtx(world.partnerA, [world.orgA]), () =>
      commitDeviceCustomFieldImport(rows, base, actor));
    // The ROW-level outcome names the reason. Reporting `none` here would tell
    // the operator their warranty column was never mapped.
    expect(guarded.rows[0]!.warranty).toBe('skipped-provider-owned');
    let [row] = await getTestDb()
      .select({ endDate: deviceWarranty.warrantyEndDate, dataSource: deviceWarranty.dataSource })
      .from(deviceWarranty)
      .where(eq(deviceWarranty.deviceId, device));
    expect(row).toMatchObject({ endDate: inDays(400), dataSource: 'provider' });

    const opted = await withDbAccessContext(partnerCtx(world.partnerA, [world.orgA]), () =>
      commitDeviceCustomFieldImport(rows, { ...base, overrideProviderWarranty: true }, actor));
    expect(opted.rows[0]!.warranty).toBe('applied');
    [row] = await getTestDb()
      .select({ endDate: deviceWarranty.warrantyEndDate, dataSource: deviceWarranty.dataSource })
      .from(deviceWarranty)
      .where(eq(deviceWarranty.deviceId, device));
    expect(row).toMatchObject({ endDate: inDays(30), dataSource: 'import' });
  });

  runDb('honours an ambiguous acknowledgement only when it is pinned to a current candidate', async () => {
    const world = await seedWorld();
    const one = await seedDevice({ orgId: world.orgA, siteId: world.siteA, hostname: 'twin', serialNumber: 'sn-twin-1' });
    const two = await seedDevice({ orgId: world.orgA, siteId: world.siteA, hostname: 'twin', serialNumber: 'sn-twin-2' });

    const ctx: ValueImportContext = {
      partnerId: world.partnerA, accessibleOrgIds: [world.orgA], allowedSiteIds: null, mode: 'update',
    };

    const annotated = await withDbAccessContext(partnerCtx(world.partnerA, [world.orgA]), () =>
      previewDeviceCustomFieldImport([{ hostname: 'twin', values: [v('asset_tag', 'AB-1')] }], ctx));
    expect(annotated[0]!.outcome).toBe('ambiguous');
    expect(annotated[0]!.candidates.map((c) => c.deviceId).sort()).toEqual([one, two].sort());
    expect(annotated[0]!.values[0]!.outcome).toBe('device-unresolved');

    const stale = await withDbAccessContext(partnerCtx(world.partnerA, [world.orgA]), () =>
      commitDeviceCustomFieldImport(
        [{
          hostname: 'twin',
          expectedOutcome: 'ambiguous',
          expectedDeviceId: '00000000-0000-4000-8000-000000000000',
          values: [v('asset_tag', 'AB-1')],
        }] as CommitValueRowInput[],
        ctx,
        actor,
      ));
    expect(stale.errors.map((e) => e.code)).toEqual(['match-changed']);
    expect(await storedValues(one)).toHaveLength(0);
    expect(await storedValues(two)).toHaveLength(0);

    const pinned = await withDbAccessContext(partnerCtx(world.partnerA, [world.orgA]), () =>
      commitDeviceCustomFieldImport(
        [{
          hostname: 'twin',
          expectedOutcome: 'ambiguous',
          expectedDeviceId: two,
          values: [v('asset_tag', 'AB-1')],
        }] as CommitValueRowInput[],
        ctx,
        actor,
      ));
    expect(pinned.errors).toHaveLength(0);
    expect(pinned.rows[0]).toMatchObject({ deviceId: two, applied: 1 });
    expect(await storedValues(one)).toHaveLength(0);
    expect((await storedValues(two))[0]).toMatchObject({ valueText: 'AB-1' });
  });
});
