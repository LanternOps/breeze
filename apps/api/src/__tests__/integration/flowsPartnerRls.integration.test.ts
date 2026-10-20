/**
 * flows RLS — dual-axis (org XOR partner) enforcement and the service's
 * caller-context writes (Tool Catalog W03, #5218, plan Task A11).
 *
 * Migration under test: 2027-01-02-130000-flows.sql.
 *   flows_isolation (FOR ALL):
 *     system OR (org_id IS NOT NULL AND breeze_has_org_access(org_id))
 *            OR (partner_id IS NOT NULL AND breeze_has_partner_access(partner_id))
 *   flows_partner_wide_select (FOR SELECT):
 *     org_id IS NULL AND partner_id = breeze_current_partner_id()
 *
 * `rls-coverage.integration.test.ts` proves the policies exist; this suite
 * drives the real driver as breeze_app under FORCE RLS to prove they enforce,
 * plus the CHECKs, plus `saveDraftFlow` against a real database (slug shadow
 * rule across owners, the advisory lock, and an org token's update of a
 * partner-wide row).
 */
import './setup';
import { afterEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq, inArray, sql } from 'drizzle-orm';
import { db, withDbAccessContext, type DbAccessContext } from '../../db';
import { flows } from '../../db/schema';
import { pgErrorCode } from '../../utils/pgErrors';
import { createDevice, createOrganization, createPartner, createSite, createUser } from './db-utils';
import { getFlow, listFlows, saveDraftFlow } from '../../services/flows/service';
import { validateFlowDocument } from '../../services/flowValidator';
import { CUSTOM_EXECUTORS, CUSTOM_RESOLVE_EXECUTORS } from '../../services/orgMergeCustomExecutors';
import type { AuthContext } from '../../middleware/auth';

const SYSTEM_CTX: DbAccessContext = {
  scope: 'system',
  orgId: null,
  accessibleOrgIds: null,
  accessiblePartnerIds: null,
  userId: null,
};

function partnerContext(partnerId: string, orgIds: string[], userId: string | null = null): DbAccessContext {
  return { scope: 'partner', orgId: null, accessibleOrgIds: orgIds, accessiblePartnerIds: [partnerId], userId, currentPartnerId: partnerId };
}

/** Org sessions carry their partner id (the SELECT branch keys on it) but never pass breeze_has_partner_access. */
function orgContext(orgId: string, partnerId: string, userId: string | null = null): DbAccessContext {
  return { scope: 'organization', orgId, accessibleOrgIds: [orgId], accessiblePartnerIds: [], userId, currentPartnerId: partnerId };
}

function orgAuth(orgId: string, partnerId: string, userId: string): AuthContext {
  return {
    scope: 'organization', orgId, partnerId, partnerOrgAccess: null, accessibleOrgIds: [orgId],
    canAccessOrg: (id: string) => id === orgId, user: { id: userId, email: 'flows-it@example.com' },
  } as unknown as AuthContext;
}

function partnerAuth(partnerId: string, orgIds: string[], userId: string): AuthContext {
  return {
    scope: 'partner', orgId: null, partnerId, partnerOrgAccess: 'all', accessibleOrgIds: orgIds,
    canAccessOrg: (id: string) => orgIds.includes(id), user: { id: userId, email: 'flows-it@example.com' },
  } as unknown as AuthContext;
}

async function expectSqlState(fn: () => Promise<unknown>, code: string): Promise<void> {
  let raised: unknown;
  try {
    await fn();
  } catch (err) {
    raised = err;
  }
  expect(raised, `expected SQLSTATE ${code}, but the statement succeeded`).toBeDefined();
  expect(pgErrorCode(raised)).toBe(code);
}

const DEFINITION = { version: 1, name: 'Seeded', trigger: { type: 'manual' }, inputs: [], steps: [{ id: 'a', tool: 'wait', input: { minutes: 1 } }] };
const created: string[] = [];

afterEach(async () => {
  const ids = [...new Set(created)];
  created.length = 0;
  if (ids.length === 0) return;
  await withDbAccessContext(SYSTEM_CTX, async () => {
    await db.delete(flows).where(inArray(flows.id, ids));
  });
});

async function seedFlow(owner: { orgId?: string | null; partnerId?: string | null }, slug: string): Promise<string> {
  const rows = await withDbAccessContext(SYSTEM_CTX, () =>
    db.insert(flows).values({
      orgId: owner.orgId ?? null,
      partnerId: owner.partnerId ?? null,
      slug,
      name: 'Seeded',
      definition: DEFINITION,
      effectiveTier: 1,
    }).returning({ id: flows.id }),
  );
  created.push(rows[0]!.id);
  return rows[0]!.id;
}

const visible = (ctx: DbAccessContext, id: string) =>
  withDbAccessContext(ctx, async () => (await db.select({ id: flows.id }).from(flows).where(eq(flows.id, id))).length);

const values = (o: Record<string, unknown>) => ({ name: 'F', definition: DEFINITION, effectiveTier: 1, slug: 'forged', ...o });

describe('flows partner RLS (#5218 W03 Task A11)', () => {
  describe('DB-enforced: RLS + CHECK constraints', () => {
    it("partner B forging partner A's partner_id is rejected (42501)", async () => {
      const a = await createPartner();
      const b = await createPartner();
      await expectSqlState(
        () => withDbAccessContext(partnerContext(b.id, []), () => db.insert(flows).values(values({ orgId: null, partnerId: a.id })).returning()),
        '42501',
      );
    });

    it("org B forging org A's org_id is rejected (42501)", async () => {
      const p = await createPartner();
      const orgA = await createOrganization({ partnerId: p.id });
      const orgB = await createOrganization({ partnerId: p.id });
      await expectSqlState(
        () => withDbAccessContext(orgContext(orgB.id, p.id), () => db.insert(flows).values(values({ orgId: orgA.id, partnerId: null })).returning()),
        '42501',
      );
    });

    it('both owners and neither owner violate flows_one_owner_chk (23514)', async () => {
      const p = await createPartner();
      const org = await createOrganization({ partnerId: p.id });
      await expectSqlState(() => withDbAccessContext(SYSTEM_CTX, () => db.insert(flows).values(values({ orgId: org.id, partnerId: p.id }))), '23514');
      await expectSqlState(() => withDbAccessContext(SYSTEM_CTX, () => db.insert(flows).values(values({ orgId: null, partnerId: null }))), '23514');
    });

    it("a slug containing '__' violates flows_slug_chk (23514)", async () => {
      const p = await createPartner();
      await expectSqlState(() => withDbAccessContext(SYSTEM_CTX, () => db.insert(flows).values(values({ partnerId: p.id, slug: 'a__b' }))), '23514');
    });

    it('status paused without paused_reason violates flows_paused_reason_chk (23514)', async () => {
      const p = await createPartner();
      await expectSqlState(() => withDbAccessContext(SYSTEM_CTX, () => db.insert(flows).values(values({ partnerId: p.id, status: 'paused' }))), '23514');
    });

    it("an org token reads its partner's partner-wide flow but its UPDATE affects 0 rows", async () => {
      const p = await createPartner();
      const org = await createOrganization({ partnerId: p.id });
      const id = await seedFlow({ partnerId: p.id }, 'pw_read');
      expect(await visible(orgContext(org.id, p.id), id)).toBe(1);
      const updated = await withDbAccessContext(orgContext(org.id, p.id), () =>
        db.update(flows).set({ name: 'hijacked' }).where(eq(flows.id, id)).returning({ id: flows.id }),
      );
      expect(updated).toHaveLength(0);
      const deleted = await withDbAccessContext(orgContext(org.id, p.id), () =>
        db.delete(flows).where(eq(flows.id, id)).returning({ id: flows.id }),
      );
      expect(deleted).toHaveLength(0);
    });

    it("an org token never sees another partner's partner-wide flow", async () => {
      const p1 = await createPartner();
      const p2 = await createPartner();
      const org = await createOrganization({ partnerId: p1.id });
      const other = await seedFlow({ partnerId: p2.id }, 'pw_other');
      expect(await visible(orgContext(org.id, p1.id), other)).toBe(0);
    });

    it("a partner token sees its orgs' flows and its partner-wide flows, not another partner's", async () => {
      const p = await createPartner();
      const p2 = await createPartner();
      const org = await createOrganization({ partnerId: p.id });
      const orgFlow = await seedFlow({ orgId: org.id }, 'org_flow');
      const pwFlow = await seedFlow({ partnerId: p.id }, 'pw_flow');
      const foreign = await seedFlow({ partnerId: p2.id }, 'pw_foreign');
      const ctx = partnerContext(p.id, [org.id]);
      expect(await visible(ctx, orgFlow)).toBe(1);
      expect(await visible(ctx, pwFlow)).toBe(1);
      expect(await visible(ctx, foreign)).toBe(0);
    });
  });

  describe('saveDraftFlow against a real database', () => {
    it('org auth updating a partner-wide flowId ⇒ flow_not_found, row untouched', async () => {
      const p = await createPartner();
      const org = await createOrganization({ partnerId: p.id });
      const user = await createUser({ partnerId: p.id, orgId: org.id });
      const id = await seedFlow({ partnerId: p.id }, 'pw_update');
      const r = await withDbAccessContext(orgContext(org.id, p.id, user.id), () =>
        saveDraftFlow(orgAuth(org.id, p.id, user.id), { document: DEFINITION, flowId: id }),
      );
      expect(r).toEqual({ saved: false, error: 'flow_not_found' });
      const [row] = await withDbAccessContext(SYSTEM_CTX, () => db.select().from(flows).where(eq(flows.id, id)));
      expect(row!.definitionVersion).toBe(1);
    });

    it("creates an org draft, suffixing a slug its partner's partner-wide flow already holds (shadow rule)", async () => {
      const p = await createPartner();
      const org = await createOrganization({ partnerId: p.id });
      const user = await createUser({ partnerId: p.id, orgId: org.id });
      await seedFlow({ partnerId: p.id }, 'disk_cleanup');
      const doc = { ...DEFINITION, name: 'Disk Cleanup' };
      const r = await withDbAccessContext(orgContext(org.id, p.id, user.id), () =>
        saveDraftFlow(orgAuth(org.id, p.id, user.id), { document: doc }),
      );
      expect(r.saved).toBe(true);
      if (!r.saved) return;
      created.push(r.flow.id);
      expect(r.flow).toMatchObject({ slug: 'disk_cleanup_2', ownerScope: 'organization', orgId: org.id, partnerId: null, status: 'draft', effectiveTier: 1 });
      expect(r.validation.valid).toBe(true);
    });

    it('a partner-wide draft is suffixed against an existing org flow under the same partner (other direction)', async () => {
      const p = await createPartner();
      const org = await createOrganization({ partnerId: p.id });
      const user = await createUser({ partnerId: p.id });
      await seedFlow({ orgId: org.id }, 'patch_report');
      const doc = { ...DEFINITION, name: 'Patch report' };
      const r = await withDbAccessContext(partnerContext(p.id, [org.id], user.id), () =>
        saveDraftFlow(partnerAuth(p.id, [org.id], user.id), { document: doc, ownerScope: 'partner' }),
      );
      expect(r.saved).toBe(true);
      if (!r.saved) return;
      created.push(r.flow.id);
      expect(r.flow).toMatchObject({ slug: 'patch_report_2', ownerScope: 'partner', orgId: null, partnerId: p.id });
    });

    it('an update bumps definition_version and a stale expectedVersion is a conflict', async () => {
      const p = await createPartner();
      const org = await createOrganization({ partnerId: p.id });
      const user = await createUser({ partnerId: p.id, orgId: org.id });
      const id = await seedFlow({ orgId: org.id }, 'versioned');
      const ctx = orgContext(org.id, p.id, user.id);
      const auth = orgAuth(org.id, p.id, user.id);
      const ok = await withDbAccessContext(ctx, () => saveDraftFlow(auth, { document: { ...DEFINITION, name: 'Renamed' }, flowId: id, expectedVersion: 1 }));
      expect(ok.saved).toBe(true);
      if (ok.saved) expect(ok.flow).toMatchObject({ definitionVersion: 2, name: 'Renamed', slug: 'versioned' });
      const stale = await withDbAccessContext(ctx, () => saveDraftFlow(auth, { document: DEFINITION, flowId: id, expectedVersion: 1 }));
      expect(stale).toEqual({ saved: false, error: 'version_conflict' });
    });
  });
});

// ---------------------------------------------------------------------------
// Review follow-ups: the SQL the unit tests mock (ownership lookups, slug
// scope, list/get under RLS, the org-merge executor) against real Postgres.
// ---------------------------------------------------------------------------

async function seedScript(owner: { orgId: string | null; partnerId: string }, opts: { deleted?: boolean } = {}): Promise<string> {
  const rows = await withDbAccessContext(SYSTEM_CTX, () => db.execute(sql`
    INSERT INTO scripts (org_id, partner_id, name, os_types, language, content, deleted_at)
    VALUES (${owner.orgId}, ${owner.partnerId}, ${`s-${randomUUID().slice(0, 8)}`}, ARRAY['windows'], 'powershell', 'Write-Output 1',
            ${opts.deleted ? sql`now()` : sql`NULL`})
    RETURNING id`)) as unknown as Array<{ id: string }>;
  return rows[0]!.id;
}

async function seedGroup(orgId: string): Promise<string> {
  const rows = await withDbAccessContext(SYSTEM_CTX, () => db.execute(sql`
    INSERT INTO device_groups (org_id, name) VALUES (${orgId}, ${`g-${randomUUID().slice(0, 8)}`}) RETURNING id`)) as unknown as Array<{ id: string }>;
  return rows[0]!.id;
}

const runScriptDoc = (input: Record<string, unknown>) => ({
  version: 1, name: 'Run', trigger: { type: 'manual' }, inputs: [],
  steps: [{ id: 'a', tool: 'run_script', input }],
});
const issueCodes = (r: { issues: Array<{ code: string }> }) => r.issues.map((i) => i.code);

describe('rule 6 ownership lookups against real Postgres (review follow-up)', () => {
  it('org owner: own + partner-wide scripts pass; foreign, missing and soft-deleted scripts get the same issue', async () => {
    const p = await createPartner();
    const p2 = await createPartner();
    const org = await createOrganization({ partnerId: p.id });
    const other = await createOrganization({ partnerId: p.id });
    const site = await createSite({ orgId: org.id });
    const device = await createDevice({ orgId: org.id, siteId: site!.id });
    const owner = { owner: { orgId: org.id, partnerId: p.id } };

    const own = await seedScript({ orgId: org.id, partnerId: p.id });
    const partnerWide = await seedScript({ orgId: null, partnerId: p.id });
    const foreign = await seedScript({ orgId: other.id, partnerId: p.id });
    const otherPartners = await seedScript({ orgId: null, partnerId: p2.id });
    const deleted = await seedScript({ orgId: org.id, partnerId: p.id }, { deleted: true });

    for (const ok of [own, partnerWide]) {
      const r = await validateFlowDocument(runScriptDoc({ scriptId: ok, deviceIds: [device.id] }), owner);
      expect(r.issues, `script ${ok}`).toEqual([]);
    }
    const bad = await Promise.all([foreign, otherPartners, deleted, randomUUID()].map((id) =>
      validateFlowDocument(runScriptDoc({ scriptId: id, deviceIds: [device.id] }), owner)));
    for (const r of bad) expect(r.issues).toEqual(bad[0]!.issues);
    expect(issueCodes(bad[0]!)).toEqual(['reference_not_owned']);
  });

  it('partner owner: partner-wide script passes, an org script is refused, literal devices/groups are refused', async () => {
    const p = await createPartner();
    const org = await createOrganization({ partnerId: p.id });
    const owner = { owner: { orgId: null, partnerId: p.id } };
    const partnerWide = await seedScript({ orgId: null, partnerId: p.id });
    const orgScript = await seedScript({ orgId: org.id, partnerId: p.id });

    expect((await validateFlowDocument(runScriptDoc({ scriptId: partnerWide, deviceIds: ['{{trigger.device.id}}'] }), owner)).issues).toEqual([]);
    expect(issueCodes(await validateFlowDocument(runScriptDoc({ scriptId: orgScript, deviceIds: ['{{trigger.device.id}}'] }), owner))).toEqual(['reference_not_owned']);
    expect(issueCodes(await validateFlowDocument(runScriptDoc({ scriptId: partnerWide, groupId: randomUUID() }), owner))).toEqual(['group_in_partner_flow']);
    expect(issueCodes(await validateFlowDocument(runScriptDoc({ scriptId: partnerWide, deviceIds: [randomUUID()] }), owner))).toEqual(['device_in_partner_flow']);
  });

  it("org owner: another org's device and group are refused; its own pass", async () => {
    const p = await createPartner();
    const org = await createOrganization({ partnerId: p.id });
    const other = await createOrganization({ partnerId: p.id });
    const site = await createSite({ orgId: org.id });
    const otherSite = await createSite({ orgId: other.id });
    const device = await createDevice({ orgId: org.id, siteId: site!.id });
    const foreignDevice = await createDevice({ orgId: other.id, siteId: otherSite!.id });
    const group = await seedGroup(org.id);
    const foreignGroup = await seedGroup(other.id);
    const script = await seedScript({ orgId: org.id, partnerId: p.id });
    const owner = { owner: { orgId: org.id, partnerId: p.id } };

    expect((await validateFlowDocument(runScriptDoc({ scriptId: script, groupId: group }), owner)).issues).toEqual([]);
    expect(issueCodes(await validateFlowDocument(runScriptDoc({ scriptId: script, groupId: foreignGroup }), owner))).toEqual(['reference_not_owned']);
    expect(issueCodes(await validateFlowDocument(runScriptDoc({ scriptId: script, deviceIds: [device.id, foreignDevice.id] }), owner))).toEqual(['device_not_owned']);
  });
});

describe('slug scope, list and get under real RLS (review follow-up)', () => {
  it("another partner's same slug and look-alike slugs never count as taken", async () => {
    const p = await createPartner();
    const p2 = await createPartner();
    const org = await createOrganization({ partnerId: p.id });
    const user = await createUser({ partnerId: p.id, orgId: org.id });
    await seedFlow({ partnerId: p2.id }, 'nightly');
    await seedFlow({ orgId: org.id }, 'nightly_x');
    await seedFlow({ orgId: org.id }, 'nightlyfoo');
    const r = await withDbAccessContext(orgContext(org.id, p.id, user.id), () =>
      saveDraftFlow(orgAuth(org.id, p.id, user.id), { document: { ...DEFINITION, name: 'Nightly' } }));
    expect(r.saved).toBe(true);
    if (r.saved) {
      created.push(r.flow.id);
      expect(r.flow.slug).toBe('nightly');
    }
  });

  it("a taken _2 moves to _3; a sibling org's flow does not block an org slug", async () => {
    const p = await createPartner();
    const org = await createOrganization({ partnerId: p.id });
    const sibling = await createOrganization({ partnerId: p.id });
    const user = await createUser({ partnerId: p.id, orgId: org.id });
    await seedFlow({ partnerId: p.id }, 'sweep');
    await seedFlow({ orgId: org.id }, 'sweep_2');
    await seedFlow({ orgId: sibling.id }, 'sweep_3');
    const r = await withDbAccessContext(orgContext(org.id, p.id, user.id), () =>
      saveDraftFlow(orgAuth(org.id, p.id, user.id), { document: { ...DEFINITION, name: 'Sweep' } }));
    expect(r.saved).toBe(true);
    if (r.saved) {
      created.push(r.flow.id);
      expect(r.flow.slug).toBe('sweep_3');
    }
  });

  it("listFlows/getFlow as an org token: own + partner-wide visible, another partner's never; inaccessible orgId filter is empty", async () => {
    const p = await createPartner();
    const p2 = await createPartner();
    const org = await createOrganization({ partnerId: p.id });
    const user = await createUser({ partnerId: p.id, orgId: org.id });
    const own = await seedFlow({ orgId: org.id }, 'own_flow');
    const pw = await seedFlow({ partnerId: p.id }, 'pw_flow');
    const foreign = await seedFlow({ partnerId: p2.id }, 'foreign_flow');
    const ctx = orgContext(org.id, p.id, user.id);
    const auth = orgAuth(org.id, p.id, user.id);

    const listed = await withDbAccessContext(ctx, () => listFlows(auth, {}));
    const ids = listed.flows.map((f) => f.id);
    expect(ids).toEqual(expect.arrayContaining([own, pw]));
    expect(ids).not.toContain(foreign);
    expect(listed.flows.find((f) => f.id === pw)).toMatchObject({ ownerScope: 'partner', triggerType: 'manual' });

    const filtered = await withDbAccessContext(ctx, () => listFlows(auth, { orgId: org.id }));
    expect(filtered.flows.map((f) => f.id).sort()).toEqual([own, pw].sort());
    expect(await withDbAccessContext(ctx, () => listFlows(auth, { orgId: randomUUID() }))).toEqual({ flows: [], total: 0 });

    const got = await withDbAccessContext(ctx, () => getFlow(auth, pw));
    expect(got?.flow.id).toBe(pw);
    expect(got?.validation.valid).toBe(true);
    expect(await withDbAccessContext(ctx, () => getFlow(auth, foreign))).toBeNull();
  });
});

class Rollback extends Error {}

describe('org merge flows executor against real Postgres (review follow-up)', () => {
  it('renames a colliding loser flow and rewrites its step tool to the source name mergeToolSources actually gives', async () => {
    const P = randomUUID();
    const L = randomUUID();
    const S = randomUUID();
    const suffix = L.slice(0, 8);
    let asserted = false;
    try {
      await withDbAccessContext(SYSTEM_CTX, async () => {
        await db.execute(sql`INSERT INTO partners (id, name, slug) VALUES (${P}::uuid, 'Merge MSP', ${`merge-${suffix}`})`);
        await db.execute(sql`
          INSERT INTO organizations (id, partner_id, name, slug, status, currency_code)
          VALUES (${L}::uuid, ${P}::uuid, 'Loser', ${`loser-${suffix}`}, 'active', 'USD'),
                 (${S}::uuid, ${P}::uuid, 'Survivor', ${`survivor-${suffix}`}, 'active', 'USD')`);
        await db.execute(sql`
          INSERT INTO tool_sources (org_id, slug, name, kind, endpoint_url, credential_origin)
          VALUES (${L}::uuid, 'hudu', 'L Hudu', 'mcp', 'https://l.example.test/mcp', 'https://l.example.test'),
                 (${S}::uuid, 'hudu', 'S Hudu', 'mcp', 'https://s.example.test/mcp', 'https://s.example.test')`);
        const def = (tools: string[]) => JSON.stringify({ ...DEFINITION, steps: tools.map((tool, i) => ({ id: `s${i}`, tool, input: {} })) });
        await db.execute(sql`
          INSERT INTO flows (org_id, slug, name, definition, effective_tier) VALUES
            (${L}::uuid, 'asset_sync', 'L sync', ${def(['hudu__get_asset', 'wait'])}::jsonb, 1),
            (${L}::uuid, 'asset_sync_m1', 'L other', ${def(['wait'])}::jsonb, 1),
            (${S}::uuid, 'asset_sync', 'S sync', ${def(['hudu__get_asset'])}::jsonb, 1)`);
        await db.execute(sql`INSERT INTO flows (partner_id, slug, name, definition, effective_tier) VALUES (${P}::uuid, 'pw_merge', 'PW', ${def(['wait'])}::jsonb, 1)`);

        await db.execute(sql`SET CONSTRAINTS ALL DEFERRED`);
        const resolved = await CUSTOM_RESOLVE_EXECUTORS.flows!(L, S);
        await CUSTOM_EXECUTORS.tool_sources!(L, S);
        const moved = await CUSTOM_EXECUTORS.flows!(L, S);
        expect(moved.moved).toBe(2);
        expect(resolved.notes.join(' ')).toMatch(/renamed 1/);

        const rows = (await db.execute(sql`
          SELECT slug, definition, definition_version, org_id, partner_id FROM flows
           WHERE org_id = ${S}::uuid OR partner_id = ${P}::uuid ORDER BY slug`)) as unknown as Array<{
          slug: string; definition: { steps: Array<{ tool: string }> }; definition_version: number; org_id: string | null; partner_id: string | null;
        }>;
        const renamedSource = ((await db.execute(sql`
          SELECT slug FROM tool_sources WHERE org_id = ${S}::uuid AND name = 'L Hudu'`)) as unknown as Array<{ slug: string }>)[0]!.slug;
        expect(renamedSource).not.toBe('hudu');

        const bySlug = new Map(rows.map((r) => [r.slug, r]));
        // The colliding loser flow skips the taken _m1 (another loser flow) and lands on _m2.
        expect(bySlug.get('asset_sync_m2')!.definition.steps.map((st) => st.tool)).toEqual([`${renamedSource}__get_asset`, 'wait']);
        expect(bySlug.get('asset_sync_m2')!.definition_version).toBe(2);
        expect(bySlug.get('asset_sync')!.definition.steps[0]!.tool).toBe('hudu__get_asset');
        expect(bySlug.get('asset_sync_m1')!.org_id).toBe(S);
        expect(bySlug.get('pw_merge')).toMatchObject({ org_id: null, partner_id: P, definition_version: 1 });
        asserted = true;
        throw new Rollback();
      });
    } catch (err) {
      if (!(err instanceof Rollback)) throw err;
    }
    expect(asserted).toBe(true);
  });
});
