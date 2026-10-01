/**
 * AI model registry W04 (#7602) Task 10: the /ai/models write and read paths
 * against real Postgres, as breeze_app (`db` from ../../db, FORCE RLS).
 *
 * The unit suites mock the DB, so they cannot prove what this suite does:
 *  - cross-tenant ids never write. W04 writes run in their OWN system
 *    transaction (inPartnerRegistryWrite, which bypasses RLS), so the app-layer
 *    partner pin on every statement IS the guard. The pin tests call the
 *    conditional writers directly with a forged owner to prove it;
 *  - tighten-only and the ownership trigger hold together;
 *  - stale-write tokens match at ms precision, including a row whose
 *    updated_at carries microseconds;
 *  - the residency writer merges exactly one jsonb key;
 *  - the usage breakdown counts authoritative rows only, is bounded by the
 *    caller's org list AND by RLS, and books a refusal-fallback leg under the
 *    model that served it;
 *  - the partner snapshot sees org-level assignment rows (defaultFor,
 *    orgOverrideCount).
 *
 * The global beforeEach (./setup) truncates the tenant tables, so every test
 * seeds its own world.
 */
import './setup';
import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { sql } from 'drizzle-orm';
import type { OrgAssignmentInput, PartnerAssignmentInput } from '@breeze/shared';
import { db, runOutsideDbContext, withDbAccessContext, withSystemDbAccessContext } from '../../db';
import { aiModelsRoutes } from '../../routes/aiModels';
import { createAccessToken } from '../../services/jwt';
import {
  conditionalDeleteOrgRow,
  conditionalUpsert,
  putOrgAssignments,
  putPartnerAssignments,
} from '../../services/aiModels/assignmentWrites';
import { setOfferingEnabled, updateOfferingDetails } from '../../services/aiModels/offeringWrites';
import { setResidencyRequired } from '../../services/aiModels/residency';
import { updateConnectionSettings } from '../../services/aiModels/connectionSettings';
import { buildPartnerModelsSnapshot } from '../../services/aiModels/registryView';
import { queryAiUsageBreakdown } from '../../services/aiModels/usageQueries';
import { assignUserToPartner, createOrganization, createPartner, createRole, createUser, grantRolePermissions } from './db-utils';
import {
  closeRegistryFixtures,
  fixtureSql,
  orgContext,
  partnerContext,
  seedByokConnection,
  seedOffering,
} from './aiModelRegistryFixtures';
import { seedPricedPlatformModel } from './helpers/aiModelRegistrySeed';

const RUN = !!process.env.DATABASE_URL;
afterAll(closeRegistryFixtures);

interface World {
  pA: string; pB: string; orgA: string; orgB: string;
  offA: string; offA2: string; offB: string;
}

/** Two cut-over partners, one org each, two enabled platform offerings on A and one on B. */
async function seedWorld(): Promise<World> {
  const pA = (await createPartner()).id;
  const pB = (await createPartner()).id;
  const orgA = (await createOrganization({ partnerId: pA })).id;
  const orgB = (await createOrganization({ partnerId: pB })).id;
  const pm = await seedPricedPlatformModel();
  const pm2 = await seedPricedPlatformModel();
  const offA = await seedOffering({ partnerId: pA, platformModelId: pm, enabled: true });
  const offA2 = await seedOffering({ partnerId: pA, platformModelId: pm2, enabled: true });
  const offB = await seedOffering({ partnerId: pB, platformModelId: pm, enabled: true });
  // Mark both cut over (W03 Task 6A) so the route's ensurePartnerCutover is a no-op.
  await fixtureSql`INSERT INTO ai_model_registry_partner_cutover (partner_id) VALUES (${pA}), (${pB}) ON CONFLICT DO NOTHING`;
  return { pA, pB, orgA, orgB, offA, offA2, offB };
}

const asPartner = <T>(p: string, orgs: string[], fn: () => Promise<T>) => withDbAccessContext(partnerContext(p, orgs), fn);
const asOrg = <T>(o: string, p: string, fn: () => Promise<T>) => withDbAccessContext(orgContext(o, p), fn);
const caught = (p: Promise<unknown>) => p.then(() => { throw new Error('expected a rejection'); }, (e: unknown) => e as { status?: number; code?: string; details?: Record<string, unknown> });
/** A fresh system transaction, as inPartnerRegistryWrite runs the conditional writers. */
const inSystem = <T>(fn: () => Promise<T>) => runOutsideDbContext(() => withSystemDbAccessContext(fn));

type PartnerSurface = 'catalog_enrichment' | 'extension_content';
const partnerRow = (surface: PartnerSurface, def: string, permitted: string[] | null = null, expectedUpdatedAt: string | null = null): PartnerAssignmentInput => ({
  surface, role: 'default', defaultOfferingId: def, permittedOfferingIds: permitted,
  allowUserChoice: true, options: null, expectedUpdatedAt,
});
const orgRow = (surface: PartnerSurface, o: Partial<OrgAssignmentInput> = {}): OrgAssignmentInput => ({
  surface, role: 'default', defaultOfferingId: null, permittedOfferingIds: null,
  allowUserChoice: null, options: null, expectedUpdatedAt: null, ...o,
});

/** The single row a fixture query returns; throws (instead of a TypeError) when it returned none. */
function firstRow<T>(rows: readonly unknown[]): T {
  if (rows.length === 0) throw new Error('fixture query returned no row');
  return rows[0] as T;
}

/** A row's stored updated_at as the Date the DTO would carry (ms precision). */
async function versionToken(table: 'ai_model_assignments' | 'partner_ai_models', id: string): Promise<string> {
  const rows = table === 'ai_model_assignments'
    ? await fixtureSql`SELECT updated_at AS v FROM ai_model_assignments WHERE id = ${id}`
    : await fixtureSql`SELECT updated_at AS v FROM partner_ai_models WHERE id = ${id}`;
  return firstRow<{ v: Date }>(rows).v.toISOString();
}

async function assignmentCount(where: { orgId?: string; partnerId?: string }): Promise<number> {
  const rows = where.orgId
    ? await fixtureSql`SELECT count(*)::int n FROM ai_model_assignments WHERE org_id = ${where.orgId}`
    : await fixtureSql`SELECT count(*)::int n FROM ai_model_assignments WHERE partner_id = ${where.partnerId!}`;
  return firstRow<{ n: number }>(rows).n;
}

/** updated_at as stored (µs), for "unchanged" assertions. */
async function rawUpdatedAt(table: 'ai_model_assignments' | 'partner_ai_models', id: string): Promise<string> {
  const rows = table === 'ai_model_assignments'
    ? await fixtureSql`SELECT updated_at::text v FROM ai_model_assignments WHERE id = ${id}`
    : await fixtureSql`SELECT updated_at::text v FROM partner_ai_models WHERE id = ${id}`;
  return firstRow<{ v: string }>(rows).v;
}

/** Seeds an org override row directly (superuser) and returns its id. */
async function seedOrgOverride(orgId: string, partnerId: string, surface: string, def: string | null, permitted: string[] | null = null): Promise<string> {
  const [row] = await fixtureSql`
    INSERT INTO ai_model_assignments (org_id, offering_partner_id, surface, role, default_offering_id, permitted_offering_ids)
    VALUES (${orgId}, ${partnerId}, ${surface}, 'default', ${def}, ${permitted})
    RETURNING id`;
  return String(row!.id);
}

async function seedPartnerDefault(partnerId: string, surface: string, def: string, permitted: string[] | null = null): Promise<string> {
  const [row] = await fixtureSql`
    INSERT INTO ai_model_assignments (partner_id, offering_partner_id, surface, role, default_offering_id, permitted_offering_ids, allow_user_choice)
    VALUES (${partnerId}, ${partnerId}, ${surface}, 'default', ${def}, ${permitted}, true)
    RETURNING id`;
  return String(row!.id);
}

describe.skipIf(!RUN)('cross-tenant offering ids never write (#7602 W04)', () => {
  it('partner A cannot point a default, or a permitted entry, at partner B’s offering', async () => {
    const w = await seedWorld();
    const asDefault = await caught(asPartner(w.pA, [w.orgA], () =>
      putPartnerAssignments({ partnerId: w.pA, rows: [partnerRow('extension_content', w.offB)] })));
    expect([asDefault.status, asDefault.code, asDefault.details?.reason]).toEqual([422, 'not_eligible', 'not_found']);

    const asPermitted = await caught(asPartner(w.pA, [w.orgA], () =>
      putPartnerAssignments({ partnerId: w.pA, rows: [partnerRow('extension_content', w.offA, [w.offA, w.offB])] })));
    expect([asPermitted.status, asPermitted.code, asPermitted.details?.field]).toEqual([422, 'not_eligible', 'permittedOfferingIds']);

    expect(await assignmentCount({ partnerId: w.pA })).toBe(0);
  });

  it('an org write cannot reference another partner’s offering as default or permitted', async () => {
    const w = await seedWorld();
    const asDefault = await caught(asOrg(w.orgA, w.pA, () =>
      putOrgAssignments({ partnerId: w.pA, orgId: w.orgA, rows: [orgRow('extension_content', { defaultOfferingId: w.offB })] })));
    // No partner row for the surface: an own default with nothing to narrow is a widening.
    expect([asDefault.status, asDefault.code]).toEqual([422, 'widens_partner']);

    await seedPartnerDefault(w.pA, 'extension_content', w.offA);
    const asPermitted = await caught(asOrg(w.orgA, w.pA, () =>
      putOrgAssignments({ partnerId: w.pA, orgId: w.orgA, rows: [orgRow('extension_content', { permittedOfferingIds: [w.offB] })] })));
    expect([asPermitted.status, asPermitted.code, asPermitted.details?.reason]).toEqual([422, 'not_eligible', 'not_found']);

    const forgedDefault = await caught(asOrg(w.orgA, w.pA, () =>
      putOrgAssignments({ partnerId: w.pA, orgId: w.orgA, rows: [orgRow('extension_content', { defaultOfferingId: w.offB })] })));
    expect([forgedDefault.status, forgedDefault.code]).toEqual([422, 'not_eligible']);

    expect(await assignmentCount({ orgId: w.orgA })).toBe(0);
  });

  it('a refusal fallback cannot be another partner’s offering, and the offering is unchanged', async () => {
    const w = await seedWorld();
    const before = await rawUpdatedAt('partner_ai_models', w.offA);
    const token = await versionToken('partner_ai_models', w.offA);
    const err = await caught(asPartner(w.pA, [w.orgA], () => updateOfferingDetails({
      partnerId: w.pA, offeringId: w.offA,
      patch: { expectedUpdatedAt: token, refusalFallbackOfferingId: w.offB },
    })));
    expect([err.status, err.code, err.details?.field, err.details?.reason])
      .toEqual([422, 'not_eligible', 'refusalFallbackOfferingId', 'not_found']);
    const [row] = await fixtureSql`SELECT refusal_fallback_offering_id FROM partner_ai_models WHERE id = ${w.offA}`;
    expect(row!.refusal_fallback_offering_id).toBeNull();
    expect(await rawUpdatedAt('partner_ai_models', w.offA)).toBe(before);
  });

  it('partner A cannot enable/disable or edit partner B’s offering (404), and B’s row is unchanged', async () => {
    const w = await seedWorld();
    const before = await rawUpdatedAt('partner_ai_models', w.offB);
    expect((await caught(asPartner(w.pA, [w.orgA], () =>
      setOfferingEnabled({ partnerId: w.pA, offeringId: w.offB, enabled: false, force: true })))).status).toBe(404);
    expect((await caught(asPartner(w.pA, [w.orgA], () =>
      updateOfferingDetails({ partnerId: w.pA, offeringId: w.offB, patch: { expectedUpdatedAt: new Date().toISOString(), displayName: 'forged' } })))).status).toBe(404);
    const [row] = await fixtureSql`SELECT enabled, display_name FROM partner_ai_models WHERE id = ${w.offB}`;
    expect(row).toEqual({ enabled: true, display_name: null });
    expect(await rawUpdatedAt('partner_ai_models', w.offB)).toBe(before);
  });

  it('partner A cannot rename or re-geo partner B’s connection (404), and B’s row is unchanged', async () => {
    const w = await seedWorld();
    const connB = await seedByokConnection(w.pB);
    const err = await caught(asPartner(w.pA, [w.orgA], () =>
      updateConnectionSettings({ partnerId: w.pA, connectionId: connB, patch: { name: 'forged', inferenceGeo: 'eu' } })));
    expect([err.status, err.code]).toEqual([404, 'not_found']);
    const [row] = await fixtureSql`SELECT name, inference_geo, config_version FROM partner_ai_connections WHERE id = ${connB}`;
    expect(row).toEqual({ name: 'Fixture key', inference_geo: null, config_version: 1 });
  });
});

describe.skipIf(!RUN)('org overrides for another partner’s org never write (#7602 W04)', () => {
  it('a forged org override for partner B’s org (no existing row) fails and writes nothing', async () => {
    const w = await seedWorld();
    await seedPartnerDefault(w.pA, 'extension_content', w.offA);
    const err = await caught(asPartner(w.pA, [w.orgA], () => putOrgAssignments({
      partnerId: w.pA, orgId: w.orgB, rows: [orgRow('extension_content', { allowUserChoice: false })],
    })));
    // The composite FK (org_id, offering_partner_id) → organizations(id, partner_id) refuses it.
    expect([err.status, err.code, err.details?.constraint]).toEqual([422, 'invalid', 'ai_model_assignments_org_partner_fk']);
    expect(await assignmentCount({ orgId: w.orgB })).toBe(0);
  });

  it('a forged org write cannot update or delete partner B’s existing org override (pinned → stale)', async () => {
    const w = await seedWorld();
    const rowB = await seedOrgOverride(w.orgB, w.pB, 'extension_content', w.offB);
    const token = await versionToken('ai_model_assignments', rowB);
    const before = await rawUpdatedAt('ai_model_assignments', rowB);

    // Through the service: B's row is invisible to the pinned read → stale.
    const viaService = await caught(asPartner(w.pA, [w.orgA], () => putOrgAssignments({
      partnerId: w.pA, orgId: w.orgB, rows: [orgRow('extension_content', { allowUserChoice: false, expectedUpdatedAt: token })],
    })));
    expect([viaService.status, viaService.code]).toEqual([409, 'stale_write']);
    const blankDelete = await caught(asPartner(w.pA, [w.orgA], () => putOrgAssignments({
      partnerId: w.pA, orgId: w.orgB, rows: [orgRow('extension_content', { expectedUpdatedAt: token })],
    })));
    expect([blankDelete.status, blankDelete.code]).toEqual([409, 'stale_write']);

    // The conditional writers themselves, in system scope (RLS bypassed), with
    // the right version token: the partner pin alone refuses them.
    const upd = await caught(inSystem(() => conditionalUpsert({ kind: 'org', orgId: w.orgB, partnerId: w.pA },
      { surface: 'extension_content', role: 'default', expectedUpdatedAt: token },
      { defaultOfferingId: null, permittedOfferingIds: null, allowUserChoice: false, options: null })));
    expect([upd.status, upd.code]).toEqual([409, 'stale_write']);
    const del = await caught(inSystem(() => conditionalDeleteOrgRow(w.orgB, w.pA,
      { surface: 'extension_content', role: 'default', expectedUpdatedAt: token })));
    expect([del.status, del.code]).toEqual([409, 'stale_write']);

    const [row] = await fixtureSql`SELECT default_offering_id, allow_user_choice FROM ai_model_assignments WHERE id = ${rowB}`;
    expect(row).toEqual({ default_offering_id: w.offB, allow_user_choice: null });
    expect(await rawUpdatedAt('ai_model_assignments', rowB)).toBe(before);
  });

  it('a partner-owner conditional update is pinned to its partner (B’s partner row survives in system scope)', async () => {
    const w = await seedWorld();
    const rowB = await seedPartnerDefault(w.pB, 'extension_content', w.offB);
    const token = await versionToken('ai_model_assignments', rowB);
    const err = await caught(inSystem(() => conditionalUpsert({ kind: 'partner', partnerId: w.pA },
      { surface: 'extension_content', role: 'default', expectedUpdatedAt: token },
      { defaultOfferingId: w.offA, permittedOfferingIds: null, allowUserChoice: false, options: null })));
    expect([err.status, err.code]).toEqual([409, 'stale_write']);
    const [row] = await fixtureSql`SELECT default_offering_id, allow_user_choice FROM ai_model_assignments WHERE id = ${rowB}`;
    expect(row).toEqual({ default_offering_id: w.offB, allow_user_choice: true });
  });
});

describe.skipIf(!RUN)('tighten-only + ownership trigger, under an org token (#7602 W04)', () => {
  it('an org admin narrows within the partner set; a widening is 422 and leaves the row unchanged', async () => {
    const w = await seedWorld();
    await asPartner(w.pA, [w.orgA], () => putPartnerAssignments({ partnerId: w.pA, rows: [partnerRow('catalog_enrichment', w.offA, [w.offA, w.offA2])] }));
    const [narrowed] = await asOrg(w.orgA, w.pA, () => putOrgAssignments({ partnerId: w.pA, orgId: w.orgA, rows: [
      orgRow('catalog_enrichment', { defaultOfferingId: w.offA2, permittedOfferingIds: [w.offA2], allowUserChoice: false }),
    ] }));
    expect(narrowed).toMatchObject({ orgId: w.orgA, offeringPartnerId: w.pA, partnerId: null, defaultOfferingId: w.offA2 });

    const offA3 = await seedOffering({ partnerId: w.pA, platformModelId: await seedPricedPlatformModel(), enabled: true });
    const before = await rawUpdatedAt('ai_model_assignments', narrowed!.id);
    const err = await caught(asOrg(w.orgA, w.pA, () => putOrgAssignments({ partnerId: w.pA, orgId: w.orgA, rows: [
      orgRow('catalog_enrichment', { permittedOfferingIds: [offA3], expectedUpdatedAt: narrowed!.updatedAt.toISOString() }),
    ] })));
    expect([err.status, err.code, err.details?.field]).toEqual([422, 'widens_partner', 'permittedOfferingIds']);
    const [row] = await fixtureSql`SELECT permitted_offering_ids FROM ai_model_assignments WHERE id = ${narrowed!.id}`;
    expect(row!.permitted_offering_ids).toEqual([w.offA2]);
    expect(await rawUpdatedAt('ai_model_assignments', narrowed!.id)).toBe(before);
  });

  it('against a partner row with permitted = null (every enabled model), an org narrows to any enabled offering', async () => {
    const w = await seedWorld();
    await seedPartnerDefault(w.pA, 'catalog_enrichment', w.offA, null);
    const [row] = await asOrg(w.orgA, w.pA, () => putOrgAssignments({ partnerId: w.pA, orgId: w.orgA, rows: [
      orgRow('catalog_enrichment', { defaultOfferingId: w.offA2, permittedOfferingIds: [w.offA2] }),
    ] }));
    expect(row).toMatchObject({ orgId: w.orgA, offeringPartnerId: w.pA, defaultOfferingId: w.offA2, permittedOfferingIds: [w.offA2] });
  });

  it('an org cannot reference a disabled offering: the write check refuses it, and so does the trigger under org RLS', async () => {
    const w = await seedWorld();
    const offOff = await seedOffering({ partnerId: w.pA, platformModelId: await seedPricedPlatformModel(), enabled: false });
    const err = await caught(asOrg(w.orgA, w.pA, () => putOrgAssignments({ partnerId: w.pA, orgId: w.orgA, rows: [
      orgRow('extension_content', { permittedOfferingIds: [offOff] }),
    ] })));
    expect([err.status, err.code, err.details?.reason]).toEqual([422, 'not_eligible', 'disabled']);

    // The ownership trigger runs with the writer's RLS: an org token sees only
    // enabled offerings, so a direct insert naming the disabled one is refused.
    await expect(asOrg(w.orgA, w.pA, () => db.execute(sql`
      INSERT INTO ai_model_assignments (org_id, offering_partner_id, surface, role, permitted_offering_ids)
      VALUES (${w.orgA}, ${w.pA}, 'extension_content', 'default', ARRAY[${offOff}]::uuid[])`)))
      .rejects.toMatchObject({ cause: { code: '23503' } });
    expect(await assignmentCount({ orgId: w.orgA })).toBe(0);
  });
});

describe.skipIf(!RUN)('already-stored permitted ids and the non-blocking registry lock (#7602 W04)', () => {
  it('a partner row whose stored permitted id was disabled since stays saveable; a newly added disabled id is still refused', async () => {
    const w = await seedWorld();
    const rowId = await seedPartnerDefault(w.pA, 'catalog_enrichment', w.offA, [w.offA, w.offA2]);
    await fixtureSql`UPDATE partner_ai_models SET enabled = false WHERE id = ${w.offA2}`;
    const offOff = await seedOffering({ partnerId: w.pA, platformModelId: await seedPricedPlatformModel(), enabled: false });

    const token = await versionToken('ai_model_assignments', rowId);
    const err = await caught(asPartner(w.pA, [w.orgA], () => putPartnerAssignments({ partnerId: w.pA, rows: [
      partnerRow('catalog_enrichment', w.offA, [w.offA, w.offA2, offOff], token),
    ] })));
    expect([err.status, err.code, err.details?.offeringId]).toEqual([422, 'not_eligible', offOff]);

    const [saved] = await asPartner(w.pA, [w.orgA], () => putPartnerAssignments({ partnerId: w.pA, rows: [
      { ...partnerRow('catalog_enrichment', w.offA, [w.offA, w.offA2], token), allowUserChoice: false },
    ] }));
    expect(saved).toMatchObject({ id: rowId, permittedOfferingIds: [w.offA, w.offA2], allowUserChoice: false });
  });

  it('an org override whose stored permitted id was disabled since stays saveable (and can drop it)', async () => {
    const w = await seedWorld();
    await seedPartnerDefault(w.pA, 'catalog_enrichment', w.offA, null);
    const rowId = await seedOrgOverride(w.orgA, w.pA, 'catalog_enrichment', null, [w.offA, w.offA2]);
    await fixtureSql`UPDATE partner_ai_models SET enabled = false WHERE id = ${w.offA2}`;

    const first = await versionToken('ai_model_assignments', rowId);
    const [kept] = await asOrg(w.orgA, w.pA, () => putOrgAssignments({ partnerId: w.pA, orgId: w.orgA, rows: [
      orgRow('catalog_enrichment', { permittedOfferingIds: [w.offA, w.offA2], allowUserChoice: false, expectedUpdatedAt: first }),
    ] }));
    expect(kept).toMatchObject({ id: rowId, permittedOfferingIds: [w.offA, w.offA2], allowUserChoice: false });

    const second = await versionToken('ai_model_assignments', rowId);
    const [dropped] = await asOrg(w.orgA, w.pA, () => putOrgAssignments({ partnerId: w.pA, orgId: w.orgA, rows: [
      orgRow('catalog_enrichment', { permittedOfferingIds: [w.offA], allowUserChoice: false, expectedUpdatedAt: second }),
    ] }));
    expect(dropped).toMatchObject({ id: rowId, permittedOfferingIds: [w.offA] });
  });

  it('a write while another transaction holds the partner registry lock is 503 registry_busy and writes nothing', async () => {
    const w = await seedWorld();
    await fixtureSql.begin(async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(hashtextextended(${`ai_model_registry_reconcile:${w.pA}`}, 0))`;
      const err = await caught(asPartner(w.pA, [w.orgA], () => putPartnerAssignments({ partnerId: w.pA, rows: [
        partnerRow('catalog_enrichment', w.offA),
      ] })));
      expect([err.status, err.code]).toEqual([503, 'registry_busy']);
    });
    expect(await assignmentCount({ partnerId: w.pA })).toBe(0);
    // Lock released at commit: the same write now goes through.
    await asPartner(w.pA, [w.orgA], () => putPartnerAssignments({ partnerId: w.pA, rows: [partnerRow('catalog_enrichment', w.offA)] }));
    expect(await assignmentCount({ partnerId: w.pA })).toBe(1);
  });
});

describe.skipIf(!RUN)('stale-write tokens at ms precision (#7602 W04)', () => {
  it('an org row whose updated_at carries microseconds matches its ms token; an off-by-one ms token is stale', async () => {
    const w = await seedWorld();
    await seedPartnerDefault(w.pA, 'catalog_enrichment', w.offA, [w.offA, w.offA2]);
    const id = await seedOrgOverride(w.orgA, w.pA, 'catalog_enrichment', w.offA2, [w.offA2]);
    // .123999 also guards against a reader that ROUNDS instead of truncating.
    await fixtureSql`UPDATE ai_model_assignments SET updated_at = '2026-10-01T10:00:00.123999Z' WHERE id = ${id}`;

    const stale = await caught(asOrg(w.orgA, w.pA, () => putOrgAssignments({ partnerId: w.pA, orgId: w.orgA, rows: [
      orgRow('catalog_enrichment', { defaultOfferingId: w.offA, expectedUpdatedAt: '2026-10-01T10:00:00.124Z' }),
    ] })));
    expect([stale.status, stale.code]).toEqual([409, 'stale_write']);
    expect(await rawUpdatedAt('ai_model_assignments', id)).toBe('2026-10-01 10:00:00.123999+00');

    const rows = await asOrg(w.orgA, w.pA, () => putOrgAssignments({ partnerId: w.pA, orgId: w.orgA, rows: [
      orgRow('catalog_enrichment', { defaultOfferingId: w.offA, expectedUpdatedAt: '2026-10-01T10:00:00.123Z' }),
    ] }));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.defaultOfferingId).toBe(w.offA);

    // Delete (blank row) at a µs version.
    await fixtureSql`UPDATE ai_model_assignments SET updated_at = '2026-10-01T11:00:00.500700Z' WHERE id = ${id}`;
    await asOrg(w.orgA, w.pA, () => putOrgAssignments({ partnerId: w.pA, orgId: w.orgA, rows: [
      orgRow('catalog_enrichment', { expectedUpdatedAt: '2026-10-01T11:00:00.500Z' }),
    ] }));
    expect(await assignmentCount({ orgId: w.orgA })).toBe(0);
  });

  it('a partner row and an offering with microsecond updated_at match their ms tokens', async () => {
    const w = await seedWorld();
    const id = await seedPartnerDefault(w.pA, 'extension_content', w.offA);
    await fixtureSql`UPDATE ai_model_assignments SET updated_at = '2026-10-01T12:00:00.987654Z' WHERE id = ${id}`;
    const stale = await caught(asPartner(w.pA, [w.orgA], () => putPartnerAssignments({ partnerId: w.pA, rows: [
      partnerRow('extension_content', w.offA2, null, '2026-10-01T12:00:00.988Z'),
    ] })));
    expect([stale.status, stale.code]).toEqual([409, 'stale_write']);
    const [saved] = await asPartner(w.pA, [w.orgA], () => putPartnerAssignments({ partnerId: w.pA, rows: [
      partnerRow('extension_content', w.offA2, null, '2026-10-01T12:00:00.987Z'),
    ] }));
    expect(saved!.defaultOfferingId).toBe(w.offA2);

    await fixtureSql`UPDATE partner_ai_models SET updated_at = '2026-10-01T13:00:00.000999Z' WHERE id = ${w.offA}`;
    const staleOffering = await caught(asPartner(w.pA, [w.orgA], () => updateOfferingDetails({
      partnerId: w.pA, offeringId: w.offA, patch: { expectedUpdatedAt: '2026-10-01T13:00:00.001Z', displayName: 'Renamed' },
    })));
    expect([staleOffering.status, staleOffering.code]).toEqual([409, 'stale_write']);
    const renamed = await asPartner(w.pA, [w.orgA], () => updateOfferingDetails({
      partnerId: w.pA, offeringId: w.offA, patch: { expectedUpdatedAt: '2026-10-01T13:00:00.000Z', displayName: 'Renamed' },
    }));
    expect(renamed.displayName).toBe('Renamed');
  });
});

describe.skipIf(!RUN)('residency writer (#7602 W04)', () => {
  it('merges only settings.ai.residencyRequired, keeping sibling keys at both levels', async () => {
    const w = await seedWorld();
    await fixtureSql`UPDATE partners SET settings = '{"ml": {"x": 1}, "ai": {"other": "kept"}}'::jsonb WHERE id = ${w.pA}`;
    await fixtureSql`UPDATE partners SET settings = '{"ml": {"y": 2}}'::jsonb WHERE id = ${w.pB}`;

    await asPartner(w.pA, [w.orgA], () => setResidencyRequired({ partnerId: w.pA, required: true, acknowledgeImpact: true }));
    const [a] = await fixtureSql`SELECT settings FROM partners WHERE id = ${w.pA}`;
    expect(a!.settings).toEqual({ ml: { x: 1 }, ai: { other: 'kept', residencyRequired: true } });

    await asPartner(w.pA, [w.orgA], () => setResidencyRequired({ partnerId: w.pA, required: false, acknowledgeImpact: false }));
    const [a2] = await fixtureSql`SELECT settings FROM partners WHERE id = ${w.pA}`;
    expect(a2!.settings).toEqual({ ml: { x: 1 }, ai: { other: 'kept', residencyRequired: false } });

    // Partner B was never written.
    const [b] = await fixtureSql`SELECT settings FROM partners WHERE id = ${w.pB}`;
    expect(b!.settings).toEqual({ ml: { y: 2 } });
  });

  it('creates settings.ai when the partner has none (and when settings is NULL)', async () => {
    const w = await seedWorld();
    await fixtureSql`UPDATE partners SET settings = '{"ml": {"x": 1}}'::jsonb WHERE id = ${w.pB}`;
    await asPartner(w.pB, [w.orgB], () => setResidencyRequired({ partnerId: w.pB, required: false, acknowledgeImpact: false }));
    const [b] = await fixtureSql`SELECT settings FROM partners WHERE id = ${w.pB}`;
    expect(b!.settings).toEqual({ ml: { x: 1 }, ai: { residencyRequired: false } });

    await fixtureSql`UPDATE partners SET settings = NULL WHERE id = ${w.pA}`;
    await asPartner(w.pA, [w.orgA], () => setResidencyRequired({ partnerId: w.pA, required: false, acknowledgeImpact: false }));
    const [a] = await fixtureSql`SELECT settings FROM partners WHERE id = ${w.pA}`;
    expect(a!.settings).toEqual({ ai: { residencyRequired: false } });
  });
});

describe.skipIf(!RUN)('usage breakdown against real ledger rows (#7602 W04)', () => {
  // Fixed UTC day, set explicitly on every row: no flake near midnight.
  const DAY = '2026-09-15';
  const today = () => DAY;

  async function seedLedger(w: World & { orgA2: string }) {
    await fixtureSql`
      INSERT INTO ai_invocations (org_id, surface, funding_source, requested_model, served_model, ledger_mode, rate_snapshot, cost_cents, offering_id, stop_reason, fallback_used, created_at)
      VALUES (${w.orgA}, 'chat', 'platform', 'm-primary', 'm-primary', 'authoritative', '{}'::jsonb, 5, ${w.offA}, 'refusal', false, ${`${DAY}T12:00:00Z`}::timestamptz),
             (${w.orgA}, 'chat', 'platform', 'm-primary', 'm-fallback', 'authoritative', '{}'::jsonb, 11, ${w.offA}, 'end_turn', true, ${`${DAY}T12:00:00Z`}::timestamptz),
             (${w.orgA2}, 'chat', 'platform', 'm-primary', 'm-primary', 'authoritative', '{}'::jsonb, 3, ${w.offA}, 'end_turn', false, ${`${DAY}T00:00:00Z`}::timestamptz),
             (${w.orgB}, 'chat', 'platform', 'm-primary', 'm-primary', 'authoritative', '{}'::jsonb, 7, ${w.offB}, 'end_turn', false, ${`${DAY}T23:59:59Z`}::timestamptz),
             (${w.orgA}, 'chat', 'platform', 'm-primary', 'm-primary', 'shadow', NULL, NULL, ${w.offA}, 'end_turn', false, ${`${DAY}T12:00:00Z`}::timestamptz),
             -- outside the range (next UTC day): never counted
             (${w.orgA}, 'chat', 'platform', 'm-primary', 'm-primary', 'authoritative', '{}'::jsonb, 1000, ${w.offA}, 'end_turn', false, ${`2026-09-16T00:00:00Z`}::timestamptz)`;
  }

  async function world2() {
    const w = await seedWorld();
    const orgA2 = (await createOrganization({ partnerId: w.pA })).id;
    return { ...w, orgA2 };
  }

  it('counts only authoritative rows of the caller’s accessible orgs', async () => {
    const w = await world2();
    await seedLedger(w);
    const r = await asPartner(w.pA, [w.orgA, w.orgA2], () => queryAiUsageBreakdown({
      groupBy: 'org', from: today(), to: today(), orgId: null, accessibleOrgIds: [w.orgA, w.orgA2],
    }));
    expect(r.rows.map((x) => [x.key, x.invocations, x.costCents])).toEqual([[w.orgA, 2, 16], [w.orgA2, 1, 3]]);
    expect(r.totals).toMatchObject({ invocations: 3, costCents: 19, refusals: 1, fallbacks: 1 });
  });

  it('the caller’s accessibleOrgIds narrows below what RLS allows', async () => {
    const w = await world2();
    await seedLedger(w);
    const r = await asPartner(w.pA, [w.orgA, w.orgA2], () => queryAiUsageBreakdown({
      groupBy: 'org', from: today(), to: today(), orgId: null, accessibleOrgIds: [w.orgA2],
    }));
    expect(r.rows.map((x) => x.key)).toEqual([w.orgA2]);
    expect(r.totals.costCents).toBe(3);
  });

  it('RLS alone bounds the query: an unrestricted org list still sees only the partner’s orgs', async () => {
    const w = await world2();
    await seedLedger(w);
    const asA = await asPartner(w.pA, [w.orgA, w.orgA2], () => queryAiUsageBreakdown({
      groupBy: 'org', from: today(), to: today(), orgId: null, accessibleOrgIds: null,
    }));
    expect(asA.rows.map((x) => x.key).sort()).toEqual([w.orgA, w.orgA2].sort());
    expect(asA.totals.costCents).toBe(19);

    // An explicit orgId of another partner's org returns nothing under RLS.
    const forged = await asPartner(w.pA, [w.orgA, w.orgA2], () => queryAiUsageBreakdown({
      groupBy: 'org', from: today(), to: today(), orgId: w.orgB, accessibleOrgIds: null,
    }));
    expect(forged.rows).toEqual([]);
    expect(forged.totals.invocations).toBe(0);
  });

  // System scope (platform admin): RLS does not bound ai_invocations, so the
  // app-layer org list is the ONLY tenant guard. queryAiUsageBreakdown has no
  // partnerId parameter — the route passes auth.accessibleOrgIds, which is the
  // only filter there is (Task 9 deferred item, closed here).
  it('system scope: the caller org list is the only guard, and it excludes partner B’s org', async () => {
    const w = await world2();
    await seedLedger(w);
    const r = await inSystem(() => queryAiUsageBreakdown({
      groupBy: 'org', from: today(), to: today(), orgId: null, accessibleOrgIds: [w.orgA, w.orgA2],
    }));
    expect(r.rows.map((x) => x.key).sort()).toEqual([w.orgA, w.orgA2].sort());
    expect(r.rows.map((x) => x.key)).not.toContain(w.orgB);
    expect(r.totals.costCents).toBe(19);

    // orgId of partner B's org outside the caller's list: still nothing.
    const forged = await inSystem(() => queryAiUsageBreakdown({
      groupBy: 'org', from: today(), to: today(), orgId: w.orgB, accessibleOrgIds: [w.orgA, w.orgA2],
    }));
    expect(forged.totals.invocations).toBe(0);
  });

  it('system scope with an unrestricted org list (accessibleOrgIds null) is platform-wide by design', async () => {
    const w = await world2();
    await seedLedger(w);
    const r = await inSystem(() => queryAiUsageBreakdown({
      groupBy: 'org', from: today(), to: today(), orgId: null, accessibleOrgIds: null,
    }));
    const keys = r.rows.map((x) => x.key);
    expect(keys).toEqual(expect.arrayContaining([w.orgA, w.orgA2, w.orgB]));
    const onlyB = await inSystem(() => queryAiUsageBreakdown({
      groupBy: 'org', from: today(), to: today(), orgId: w.orgB, accessibleOrgIds: null,
    }));
    expect(onlyB.rows.map((x) => [x.key, x.costCents])).toEqual([[w.orgB, 7]]);
  });

  it('groupBy=model books a refusal-fallback leg under the model that served it', async () => {
    const w = await world2();
    await seedLedger(w);
    const r = await asPartner(w.pA, [w.orgA, w.orgA2], () => queryAiUsageBreakdown({
      groupBy: 'model', from: today(), to: today(), orgId: w.orgA, accessibleOrgIds: [w.orgA, w.orgA2],
    }));
    const byKey = Object.fromEntries(r.rows.map((x) => [x.key, x]));
    expect(Object.keys(byKey).sort()).toEqual(['platform:platform:m-fallback', 'platform:platform:m-primary']);
    expect(byKey['platform:platform:m-fallback']).toMatchObject({ invocations: 1, costCents: 11, fallbacks: 1, refusals: 0 });
    expect(byKey['platform:platform:m-primary']).toMatchObject({ invocations: 1, costCents: 5, refusals: 1, refusalRate: 1 });
  });
});

describe.skipIf(!RUN)('partner snapshot sees org-level rows (#7602 W04)', () => {
  it('defaultFor and orgOverrideCount include org overrides for a partner-scope caller', async () => {
    const w = await seedWorld();
    const orgA2 = (await createOrganization({ partnerId: w.pA })).id;
    await seedPartnerDefault(w.pA, 'extension_content', w.offA);
    await seedOrgOverride(w.orgA, w.pA, 'extension_content', w.offA2);
    await seedOrgOverride(orgA2, w.pA, 'extension_content', null, [w.offA]);
    // Partner B's org override must not be counted.
    await seedOrgOverride(w.orgB, w.pB, 'extension_content', w.offB);

    const snap = await asPartner(w.pA, [w.orgA, orgA2], () => buildPartnerModelsSnapshot(w.pA));
    const ext = snap.defaults.find((d) => d.surface === 'extension_content')!;
    expect(ext.partner?.defaultOfferingId).toBe(w.offA);
    expect(ext.orgOverrideCount).toBe(2);
    const off2 = snap.offerings.find((o) => o.id === w.offA2)!;
    expect(off2.defaultFor).toEqual([{ surface: 'extension_content', level: 'org', orgId: w.orgA }]);
    const off1 = snap.offerings.find((o) => o.id === w.offA)!;
    expect(off1.defaultFor).toEqual([{ surface: 'extension_content', level: 'partner', orgId: null }]);
    expect(snap.offerings.some((o) => o.id === w.offB)).toBe(false);
  });
});

describe.skipIf(!RUN)('/ai/models routes refuse another partner’s ids (#7602 W04)', () => {
  function buildApp(): Hono {
    const app = new Hono();
    app.route('/api/v1/ai/models', aiModelsRoutes);
    return app;
  }

  /** A partner admin (orgAccess 'all', wildcard role) with an MFA-satisfied token. */
  async function partnerAdmin(partnerId: string) {
    const user = await createUser({ partnerId, orgId: null, email: `w04-${randomUUID()}@example.com` });
    const role = await createRole({ scope: 'partner', partnerId });
    await grantRolePermissions(role.id, [{ resource: '*', action: '*' }]);
    await assignUserToPartner(user.id, partnerId, role.id, 'all');
    return client(await createAccessToken({
      sub: user.id, email: user.email, roleId: role.id, orgId: null, partnerId, scope: 'partner',
      mfa: true, aep: 1, mep: 1, sid: randomUUID(),
    }));
  }

  /**
   * A platform admin's system-scope token, as login issues it: no partnerId,
   * no orgId (permissions come from users.is_platform_admin). The route must
   * take the org's partner from the org row — auth carries none.
   */
  async function systemAdmin(homePartnerId: string) {
    const user = await createUser({ partnerId: homePartnerId, orgId: null, email: `w04-sys-${randomUUID()}@example.com` });
    await fixtureSql`UPDATE users SET is_platform_admin = true WHERE id = ${user.id}`;
    const role = await createRole({ scope: 'system' });
    return client(await createAccessToken({
      sub: user.id, email: user.email, roleId: role.id, orgId: null, partnerId: null, scope: 'system',
      mfa: true, aep: 1, mep: 1, sid: randomUUID(),
    }));
  }

  function client(token: string) {
    const app = buildApp();
    return (method: string, path: string, body?: unknown): Promise<Response> => Promise.resolve(app.request(path, {
      method,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }));
  }

  it('PATCH /connections/:id with partner B’s connection id → 404, nothing written', async () => {
    const w = await seedWorld();
    await seedByokConnection(w.pA);
    const connB = await seedByokConnection(w.pB);
    const req = await partnerAdmin(w.pA);
    const res = await req('PATCH', `/api/v1/ai/models/connections/${connB}`, { name: 'forged' });
    expect(res.status).toBe(404);
    const [row] = await fixtureSql`SELECT name, config_version FROM partner_ai_connections WHERE id = ${connB}`;
    expect(row).toEqual({ name: 'Fixture key', config_version: 1 });
  });

  it('PUT /orgs/:orgId/assignments for partner B’s org is denied, nothing written', async () => {
    const w = await seedWorld();
    await seedPartnerDefault(w.pA, 'extension_content', w.offA);
    const req = await partnerAdmin(w.pA);
    const res = await req('PUT', `/api/v1/ai/models/orgs/${w.orgB}/assignments`, {
      assignments: [orgRow('extension_content', { allowUserChoice: false })],
    });
    // The caller's org-access check (canAccessOrg) refuses it with 403 before
    // the partner-match 404 branch is reached.
    expect(res.status).toBe(403);
    expect(await assignmentCount({ orgId: w.orgB })).toBe(0);

    const read = await req('GET', `/api/v1/ai/models/orgs/${w.orgB}/assignments`);
    expect(read.status).toBe(403);
  });

  it('system scope: PUT /orgs/:orgId/assignments takes the partner from the org row, never from auth', async () => {
    const w = await seedWorld();
    await seedPartnerDefault(w.pA, 'extension_content', w.offA);
    const req = await systemAdmin(w.pB);
    const res = await req('PUT', `/api/v1/ai/models/orgs/${w.orgA}/assignments`, {
      assignments: [orgRow('extension_content', { allowUserChoice: false })],
    });
    expect({ status: res.status, body: res.status === 200 ? null : await res.text() }).toEqual({ status: 200, body: null });
    const rows = await fixtureSql`SELECT offering_partner_id, partner_id, allow_user_choice FROM ai_model_assignments WHERE org_id = ${w.orgA}`;
    expect(rows).toEqual([{ offering_partner_id: w.pA, partner_id: null, allow_user_choice: false }]);
    expect(await assignmentCount({ orgId: w.orgB })).toBe(0);
  });

  it('PUT /orgs/:orgId/assignments for its own org succeeds (control)', async () => {
    const w = await seedWorld();
    await seedPartnerDefault(w.pA, 'extension_content', w.offA);
    const req = await partnerAdmin(w.pA);
    const res = await req('PUT', `/api/v1/ai/models/orgs/${w.orgA}/assignments`, {
      assignments: [orgRow('extension_content', { allowUserChoice: false })],
    });
    expect(res.status).toBe(200);
    expect(await assignmentCount({ orgId: w.orgA })).toBe(1);
  });
});
