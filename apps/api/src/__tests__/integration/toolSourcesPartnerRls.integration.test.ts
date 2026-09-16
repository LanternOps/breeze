/**
 * tool_sources / tool_source_tools RLS — dual-axis (org XOR partner)
 * enforcement, child-owner integrity, and the resolver's app-layer predicate
 * (Task A11, plan docs/superpowers/plans/ai-mcp/2026-09-07-tool-catalog-w1-tool-sources-mcp.md).
 *
 * Migration under test: 2026-10-16-193500-tool-sources.sql. Both tables
 * follow CLAUDE.md "Partner-Wide First": org_id XOR partner_id, ONE dual-axis
 * `FOR ALL` policy, plus a SEPARATE additive `FOR SELECT` partner-wide branch
 * keyed on `breeze_current_partner_id()`:
 *
 *   tool_sources_isolation / tool_source_tools_isolation (FOR ALL):
 *     system OR (org_id IS NOT NULL AND breeze_has_org_access(org_id))
 *            OR (partner_id IS NOT NULL AND breeze_has_partner_access(partner_id))
 *   tool_sources_partner_wide_select / tool_source_tools_partner_wide_select (FOR SELECT):
 *     org_id IS NULL AND partner_id = breeze_current_partner_id()
 *
 * `tool_source_tools` also denormalises its owner from the parent
 * `tool_sources` row and is kept in step by a DEFERRABLE INITIALLY IMMEDIATE
 * constraint trigger (`tool_source_tools_owner_guard_trg`) rather than a
 * branch FK — a mismatch raises 23514, not 23503.
 *
 * `rls-coverage.integration.test.ts` proves the policies EXIST by reading
 * pg_catalog; it cannot prove either branch enforces anything, and it cannot
 * see the trigger at all. This suite drives the real postgres.js driver as
 * `breeze_app` under FORCE RLS — the only thing that does.
 *
 * IMPORTANT split: cases 1-5 below run through `withDbAccessContext` and
 * assert what the DATABASE itself enforces (RLS policies, the two XOR CHECK
 * constraints, the owner-guard trigger) — the DB layer is the source of
 * truth for those. Case 6 calls `resolveTenantTools()` directly, which
 * deliberately runs in SYSTEM db scope (see services/toolSources/resolver.ts
 * module doc) — RLS is bypassed there BY DESIGN, so that case instead proves
 * the resolver's own hand-built owner predicate (`ownerPredicate()` in
 * resolver.ts) is correct. It is an app-layer contract, not a DB one.
 */
import './setup';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
import { db, withDbAccessContext, type DbAccessContext } from '../../db';
import { toolSources, toolSourceTools } from '../../db/schema';
import { pgErrorCode } from '../../utils/pgErrors';
import { createOrganization, createPartner } from './db-utils';
import { loadTenantToolBindingState, resolveTenantTools } from '../../services/toolSources/resolver';
import type { AuthContext } from '../../middleware/auth';

const SYSTEM_CTX: DbAccessContext = {
  scope: 'system',
  orgId: null,
  accessibleOrgIds: null,
  accessiblePartnerIds: null,
  userId: null,
};

/** A partner-scoped session: passes breeze_has_partner_access for its own partner. */
function partnerContext(partnerId: string, orgIds: string[]): DbAccessContext {
  return {
    scope: 'partner',
    orgId: null,
    accessibleOrgIds: orgIds,
    accessiblePartnerIds: [partnerId],
    userId: null,
    currentPartnerId: partnerId,
  };
}

/**
 * An org-scoped session still carries its partner id (buildDbAccessContext
 * sets currentPartnerId from auth.partnerId for every scope) — that is what
 * the SELECT-widening policy keys off. accessiblePartnerIds stays empty, so
 * breeze_has_partner_access() is false, exactly as in production.
 */
function orgContext(orgId: string, partnerId: string): DbAccessContext {
  return {
    scope: 'organization',
    orgId,
    accessibleOrgIds: [orgId],
    accessiblePartnerIds: [],
    userId: null,
    currentPartnerId: partnerId,
  };
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

const createdSourceIds: string[] = [];

afterEach(async () => {
  const sourceIds = [...new Set(createdSourceIds)];
  createdSourceIds.length = 0;
  if (sourceIds.length === 0) return;
  await withDbAccessContext(SYSTEM_CTX, async () => {
    // tool_source_tools is ON DELETE CASCADE from tool_sources, but delete it
    // explicitly first anyway — cheap and keeps this suite independent of
    // that cascade if it ever changes.
    await db.delete(toolSourceTools).where(inArray(toolSourceTools.sourceId, sourceIds));
    await db.delete(toolSources).where(inArray(toolSources.id, sourceIds));
  });
});

/** Seed a tool_sources row under SYSTEM scope, bypassing the policy under test. */
async function seedSource(owner: { orgId?: string | null; partnerId?: string | null }): Promise<string> {
  const rand = Math.random().toString(36).slice(2, 8);
  const rows = await withDbAccessContext(SYSTEM_CTX, () =>
    db
      .insert(toolSources)
      .values({
        orgId: owner.orgId ?? null,
        partnerId: owner.partnerId ?? null,
        slug: `src${rand}`,
        name: `Test Source ${rand}`,
        kind: 'mcp',
        endpointUrl: 'https://tool-source.example.test/mcp',
        credentialOrigin: 'https://tool-source.example.test',
      })
      .returning({ id: toolSources.id }),
  );
  const id = rows[0]!.id;
  createdSourceIds.push(id);
  return id;
}

/** Seed a tool_source_tools row under SYSTEM scope, bypassing RLS and the owner-guard trigger's normal callers. */
async function seedTool(
  sourceId: string,
  owner: { orgId?: string | null; partnerId?: string | null },
  overrides: Partial<{ enabled: boolean; tier: 1 | 2 | 3; proposedTier: 1 | 3; name: string; qualifiedName: string }> = {},
): Promise<string> {
  const rand = Math.random().toString(36).slice(2, 8);
  const rows = await withDbAccessContext(SYSTEM_CTX, () =>
    db
      .insert(toolSourceTools)
      .values({
        sourceId,
        orgId: owner.orgId ?? null,
        partnerId: owner.partnerId ?? null,
        name: overrides.name ?? `tool_${rand}`,
        qualifiedName: overrides.qualifiedName ?? `src${rand}__tool_${rand}`,
        proposedTier: overrides.proposedTier ?? 1,
        tier: overrides.tier ?? 1,
        enabled: overrides.enabled ?? false,
        revision: 'rev-1',
      })
      .returning({ id: toolSourceTools.id }),
  );
  return rows[0]!.id;
}

const countSources = async (ctx: DbAccessContext, sourceId: string): Promise<number> =>
  withDbAccessContext(ctx, async () => {
    const rows = await db.select({ id: toolSources.id }).from(toolSources).where(eq(toolSources.id, sourceId));
    return rows.length;
  });

const countTools = async (ctx: DbAccessContext, toolId: string): Promise<number> =>
  withDbAccessContext(ctx, async () => {
    const rows = await db.select({ id: toolSourceTools.id }).from(toolSourceTools).where(eq(toolSourceTools.id, toolId));
    return rows.length;
  });

describe('tool_sources / tool_source_tools partner RLS (#5216 W01 Task A11)', () => {
  beforeEach(() => {
    // The resolver (case 6) is dark-shipped behind this flag; the DB-layer
    // cases (1-5) don't consult it, so setting it unconditionally is harmless.
    process.env.TOOL_SOURCES_ENABLED = 'true';
  });

  describe('DB-enforced: RLS + CHECK constraints + owner-guard trigger', () => {
    it('partner B forging partner A\'s partner_id on tool_sources is rejected (42501)', async () => {
      const partnerA = await createPartner();
      const partnerB = await createPartner();

      await expectSqlState(
        () =>
          withDbAccessContext(partnerContext(partnerB.id, []), () =>
            db
              .insert(toolSources)
              .values({
                orgId: null,
                partnerId: partnerA.id,
                slug: 'forged1',
                name: 'Forged',
                kind: 'mcp',
                endpointUrl: 'https://tool-source.example.test/mcp',
                credentialOrigin: 'https://tool-source.example.test',
              })
              .returning(),
          ),
        '42501',
      );
    });

    it('org B forging org A\'s org_id on tool_sources is rejected (42501)', async () => {
      const partner = await createPartner();
      const orgA = await createOrganization({ partnerId: partner.id });
      const orgB = await createOrganization({ partnerId: partner.id });

      await expectSqlState(
        () =>
          withDbAccessContext(orgContext(orgB.id, partner.id), () =>
            db
              .insert(toolSources)
              .values({
                orgId: orgA.id,
                partnerId: null,
                slug: 'forged2',
                name: 'Forged',
                kind: 'mcp',
                endpointUrl: 'https://tool-source.example.test/mcp',
                credentialOrigin: 'https://tool-source.example.test',
              })
              .returning(),
          ),
        '42501',
      );
    });

    // The two forge cases above only exercise the PARENT table
    // (`tool_sources`) — every `tool_source_tools` write in this file runs
    // under SYSTEM_CTX (`seedTool`), so the CHILD table's own
    // `tool_source_tools_isolation` policy was never forged under a real
    // tenant session. The forged row's owner is set to MATCH its parent's
    // actual owner (not the attacking tenant) so the owner-guard trigger
    // (23514, tested separately above) passes and the failure this test
    // asserts is unambiguously the RLS WITH CHECK (42501), not the trigger.
    it('partner B forging partner A\'s partner_id on tool_source_tools (child) is rejected (42501)', async () => {
      const partnerA = await createPartner();
      const partnerB = await createPartner();
      const sourceId = await seedSource({ partnerId: partnerA.id });

      await expectSqlState(
        () =>
          withDbAccessContext(partnerContext(partnerB.id, []), () =>
            db
              .insert(toolSourceTools)
              .values({
                sourceId,
                orgId: null,
                partnerId: partnerA.id,
                name: 'forged_child_1',
                qualifiedName: 'x__forged_child_1',
                proposedTier: 1,
                tier: 1,
                revision: 'rev-1',
              })
              .returning(),
          ),
        '42501',
      );
    });

    it('org B forging org A\'s org_id on tool_source_tools (child) is rejected (42501)', async () => {
      const partner = await createPartner();
      const orgA = await createOrganization({ partnerId: partner.id });
      const orgB = await createOrganization({ partnerId: partner.id });
      const sourceId = await seedSource({ orgId: orgA.id });

      await expectSqlState(
        () =>
          withDbAccessContext(orgContext(orgB.id, partner.id), () =>
            db
              .insert(toolSourceTools)
              .values({
                sourceId,
                orgId: orgA.id,
                partnerId: null,
                name: 'forged_child_2',
                qualifiedName: 'x__forged_child_2',
                proposedTier: 1,
                tier: 1,
                revision: 'rev-1',
              })
              .returning(),
          ),
        '42501',
      );
    });

    it('tool_sources: both owners set, and neither owner set, both violate the XOR CHECK (23514)', async () => {
      const partner = await createPartner();
      const org = await createOrganization({ partnerId: partner.id });

      await expectSqlState(
        () =>
          withDbAccessContext(SYSTEM_CTX, () =>
            db
              .insert(toolSources)
              .values({
                orgId: org.id,
                partnerId: partner.id,
                slug: 'bothown',
                name: 'Both owners',
                kind: 'mcp',
                endpointUrl: 'https://tool-source.example.test/mcp',
                credentialOrigin: 'https://tool-source.example.test',
              })
              .returning(),
          ),
        '23514',
      );

      await expectSqlState(
        () =>
          withDbAccessContext(SYSTEM_CTX, () =>
            db
              .insert(toolSources)
              .values({
                orgId: null,
                partnerId: null,
                slug: 'noowner',
                name: 'No owner',
                kind: 'mcp',
                endpointUrl: 'https://tool-source.example.test/mcp',
                credentialOrigin: 'https://tool-source.example.test',
              })
              .returning(),
          ),
        '23514',
      );
    });

    it('tool_source_tools: both owners set, and neither owner set, both violate the XOR CHECK (23514)', async () => {
      const partner = await createPartner();
      const org = await createOrganization({ partnerId: partner.id });
      const sourceId = await seedSource({ orgId: org.id });

      await expectSqlState(
        () =>
          withDbAccessContext(SYSTEM_CTX, () =>
            db
              .insert(toolSourceTools)
              .values({
                sourceId,
                orgId: org.id,
                partnerId: partner.id,
                name: 'both_owners',
                qualifiedName: 'x__both_owners',
                proposedTier: 1,
                tier: 1,
                revision: 'rev-1',
              })
              .returning(),
          ),
        '23514',
      );

      await expectSqlState(
        () =>
          withDbAccessContext(SYSTEM_CTX, () =>
            db
              .insert(toolSourceTools)
              .values({
                sourceId,
                orgId: null,
                partnerId: null,
                name: 'no_owner',
                qualifiedName: 'x__no_owner',
                proposedTier: 1,
                tier: 1,
                revision: 'rev-1',
              })
              .returning(),
          ),
        '23514',
      );
    });

    it('a tool_source_tools row whose owner differs from its parent tool_sources row is rejected by the owner-guard trigger (23514)', async () => {
      // The XOR CHECK alone would pass this (exactly one owner is set on the
      // child) — it is the constraint TRIGGER, not a branch FK, that catches
      // a child claiming a DIFFERENT owner than its parent.
      const partner = await createPartner();
      const orgA = await createOrganization({ partnerId: partner.id });
      const orgB = await createOrganization({ partnerId: partner.id });
      const sourceId = await seedSource({ orgId: orgA.id });

      await expectSqlState(
        () =>
          withDbAccessContext(SYSTEM_CTX, () =>
            db
              .insert(toolSourceTools)
              .values({
                sourceId,
                orgId: orgB.id,
                partnerId: null,
                name: 'cross_owner',
                qualifiedName: 'x__cross_owner',
                proposedTier: 1,
                tier: 1,
                revision: 'rev-1',
              })
              .returning(),
          ),
        '23514',
      );
    });

    it('a tool_source_tools row whose owner axis differs from a partner-wide parent is also rejected by the trigger (23514)', async () => {
      const partner = await createPartner();
      const org = await createOrganization({ partnerId: partner.id });
      const sourceId = await seedSource({ partnerId: partner.id });

      await expectSqlState(
        () =>
          withDbAccessContext(SYSTEM_CTX, () =>
            db
              .insert(toolSourceTools)
              .values({
                sourceId,
                orgId: org.id,
                partnerId: null,
                name: 'cross_axis',
                qualifiedName: 'x__cross_axis',
                proposedTier: 1,
                tier: 1,
                revision: 'rev-1',
              })
              .returning(),
          ),
        '23514',
      );
    });

    it('a same-owner tool_source_tools row under a partner-wide parent is accepted (positive control)', async () => {
      const partner = await createPartner();
      const sourceId = await seedSource({ partnerId: partner.id });

      const rows = await withDbAccessContext(SYSTEM_CTX, () =>
        db
          .insert(toolSourceTools)
          .values({
            sourceId,
            orgId: null,
            partnerId: partner.id,
            name: 'same_owner',
            qualifiedName: 'x__same_owner',
            proposedTier: 1,
            tier: 1,
            revision: 'rev-1',
          })
          .returning(),
      );
      expect(rows).toHaveLength(1);
    });

    it('an ORG context cannot SELECT another partner\'s tool_sources row through the dual-axis policy, but DOES read its OWN partner\'s partner-wide row through the additive SELECT branch', async () => {
      // The load-bearing case. `breeze_has_partner_access` is always false for
      // an org token, so WITHOUT the separate tool_sources_partner_wide_select
      // policy an org context would be silently blind to every partner-wide
      // tool source — no error, just nothing — and #4673's whole point (an
      // org token seeing partner-wide config) would be dead code.
      const partner = await createPartner();
      const otherPartner = await createPartner();
      const org = await createOrganization({ partnerId: partner.id });

      const mine = await seedSource({ partnerId: partner.id });
      const theirs = await seedSource({ partnerId: otherPartner.id });

      // Blind through the dual-axis FOR ALL policy alone: breeze_has_org_access
      // is false for someone else's partner-wide row, and breeze_has_partner_access
      // is false for an org token altogether.
      expect(await countSources(orgContext(org.id, partner.id), theirs)).toBe(0);

      // Visible through the additive partner-wide SELECT branch for the org's
      // OWN partner.
      expect(await countSources(orgContext(org.id, partner.id), mine)).toBe(1);

      // A DIFFERENT partner's org context still reads zero rows of `mine`.
      const orgOfOtherPartner = await createOrganization({ partnerId: otherPartner.id });
      expect(await countSources(orgContext(orgOfOtherPartner.id, otherPartner.id), mine)).toBe(0);
    });

    it('same load-bearing branch on tool_source_tools: an org reads its own partner\'s partner-wide tool, never another partner\'s', async () => {
      const partner = await createPartner();
      const otherPartner = await createPartner();
      const org = await createOrganization({ partnerId: partner.id });

      const mineSourceId = await seedSource({ partnerId: partner.id });
      const mineToolId = await seedTool(mineSourceId, { partnerId: partner.id });
      const theirsSourceId = await seedSource({ partnerId: otherPartner.id });
      const theirsToolId = await seedTool(theirsSourceId, { partnerId: otherPartner.id });

      expect(await countTools(orgContext(org.id, partner.id), theirsToolId)).toBe(0);
      expect(await countTools(orgContext(org.id, partner.id), mineToolId)).toBe(1);

      const orgOfOtherPartner = await createOrganization({ partnerId: otherPartner.id });
      expect(await countTools(orgContext(orgOfOtherPartner.id, otherPartner.id), mineToolId)).toBe(0);
    });

    it('the partner-wide SELECT branch is SELECT-only: an org context cannot UPDATE or DELETE an inherited partner-wide row', async () => {
      const partner = await createPartner();
      const org = await createOrganization({ partnerId: partner.id });
      const shared = await seedSource({ partnerId: partner.id });

      const deleted = await withDbAccessContext(orgContext(org.id, partner.id), () =>
        db.delete(toolSources).where(eq(toolSources.id, shared)).returning({ id: toolSources.id }),
      );
      expect(deleted).toEqual([]);

      const updated = await withDbAccessContext(orgContext(org.id, partner.id), () =>
        db.update(toolSources).set({ name: 'hijacked' }).where(eq(toolSources.id, shared)).returning({ id: toolSources.id }),
      );
      expect(updated).toEqual([]);

      // Still there, untouched, when read back under system scope.
      const stillThere = await countSources(SYSTEM_CTX, shared);
      expect(stillThere).toBe(1);
    });
  });

  describe('App-layer: resolveTenantTools() owner predicate (system db scope, RLS bypassed by design)', () => {
    it('resolves the partner\'s enabled partner-wide tool for an org-scoped AuthContext, and never another partner\'s', async () => {
      const partner = await createPartner();
      const otherPartner = await createPartner();
      const org = await createOrganization({ partnerId: partner.id });

      const mineSourceId = await seedSource({ partnerId: partner.id });
      await seedTool(mineSourceId, { partnerId: partner.id }, {
        enabled: true,
        name: 'get_asset',
        qualifiedName: 'mine__get_asset',
      });

      const theirsSourceId = await seedSource({ partnerId: otherPartner.id });
      await seedTool(theirsSourceId, { partnerId: otherPartner.id }, {
        enabled: true,
        name: 'get_asset',
        qualifiedName: 'theirs__get_asset',
      });

      const orgAuth = { scope: 'organization', orgId: org.id, partnerId: partner.id, user: { id: 'test-user' } } as unknown as AuthContext;

      const resolved = await resolveTenantTools(orgAuth);
      const qualifiedNames = resolved.map((d) => d.qualifiedName);

      expect(qualifiedNames).toContain('mine__get_asset');
      expect(qualifiedNames).not.toContain('theirs__get_asset');

      // Cross-partner: the OTHER partner's org never sees the first partner's tool either.
      const otherOrg = await createOrganization({ partnerId: otherPartner.id });
      const otherOrgAuth = {
        scope: 'organization',
        orgId: otherOrg.id,
        partnerId: otherPartner.id,
        user: { id: 'test-user' },
      } as unknown as AuthContext;
      const resolvedForOther = await resolveTenantTools(otherOrgAuth);
      expect(resolvedForOther.map((d) => d.qualifiedName)).not.toContain('mine__get_asset');
    });

    // #6023: a partner-scoped session (auth.orgId unset — nothing on the real
    // request path ever sets it) was unable to reach an ORG-OWNED tool source
    // even when the request targeted that org explicitly (the web Test drawer's
    // `?orgId=`, or a chat session's pinned org). The fix threads an explicit
    // `targetOrgId` argument through the resolver instead of relying on
    // `auth.orgId`.
    it('partner scope + targeted org: includes that org\'s own tool, on top of the partner-wide ones', async () => {
      const partner = await createPartner();
      const org = await createOrganization({ partnerId: partner.id });

      const orgOwnedSourceId = await seedSource({ orgId: org.id });
      await seedTool(orgOwnedSourceId, { orgId: org.id }, {
        enabled: true,
        name: 'get_asset',
        qualifiedName: 'orgowned__get_asset',
      });

      const partnerWideSourceId = await seedSource({ partnerId: partner.id });
      await seedTool(partnerWideSourceId, { partnerId: partner.id }, {
        enabled: true,
        name: 'get_ticket',
        qualifiedName: 'partnerwide__get_ticket',
      });

      const partnerAuth = { scope: 'partner', orgId: null, partnerId: partner.id, user: { id: 'test-user' } } as unknown as AuthContext;

      // No target org: the org-owned tool is unreachable — exactly the bug.
      const withoutTarget = await resolveTenantTools(partnerAuth);
      expect(withoutTarget.map((d) => d.qualifiedName)).not.toContain('orgowned__get_asset');
      expect(withoutTarget.map((d) => d.qualifiedName)).toContain('partnerwide__get_ticket');

      // With the validated request org passed as targetOrgId: both are visible.
      const withTarget = await resolveTenantTools(partnerAuth, org.id);
      const qualifiedNames = withTarget.map((d) => d.qualifiedName);
      expect(qualifiedNames).toContain('orgowned__get_asset');
      expect(qualifiedNames).toContain('partnerwide__get_ticket');
    });

    it('partner scope + targeted org belonging to ANOTHER partner: excluded — targetOrgId is never trusted without a live partner-match re-derivation', async () => {
      const partner = await createPartner();
      const otherPartner = await createPartner();
      const otherPartnersOrg = await createOrganization({ partnerId: otherPartner.id });

      const sourceId = await seedSource({ orgId: otherPartnersOrg.id });
      await seedTool(sourceId, { orgId: otherPartnersOrg.id }, {
        enabled: true,
        name: 'get_asset',
        qualifiedName: 'notmine__get_asset',
      });

      const partnerAuth = { scope: 'partner', orgId: null, partnerId: partner.id, user: { id: 'test-user' } } as unknown as AuthContext;

      // partner forges/passes the OTHER partner's org id as the target — must
      // not surface that org's tool, even though the org_id equality alone
      // would match.
      const resolved = await resolveTenantTools(partnerAuth, otherPartnersOrg.id);
      expect(resolved.map((d) => d.qualifiedName)).not.toContain('notmine__get_asset');
    });
  });
});

/**
 * Tool catalog W01 PR B (#5216): `loadTenantToolBindingState` is what release
 * revalidation classifies an approved external intent against, and its whole
 * job is to report WHY a tool can no longer run. Every unit-level caller mocks
 * it, so the row -> `{ tool, source }` mapping is only ever proven here: a
 * swapped field (source status read off the tool row, say) would turn
 * `external_tool_source_unavailable` into a silent release with every mocked
 * test still green.
 */
describe('loadTenantToolBindingState — live row mapping (#5216 PR B)', () => {
  it('returns the live tool AND source facts unfiltered, whatever their state', async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    const sourceId = await seedSource({ orgId: org.id });
    const toolId = await seedTool(sourceId, { orgId: org.id }, { enabled: false, tier: 3 });

    const state = await loadTenantToolBindingState(toolId);

    // A disabled tool must still COME BACK (with enabled:false) — this loader
    // deliberately has none of the dispatch loader's filters.
    expect(state).not.toBeNull();
    expect(state!.tool).toMatchObject({ id: toolId, enabled: false, removedAt: null, revision: 'rev-1', tier: 3 });
    expect(state!.source).toMatchObject({ id: sourceId, status: 'active' });
  });

  it('returns null for an id that names no row (a stale binding on an immutable intent)', async () => {
    expect(await loadTenantToolBindingState('11111111-1111-4111-8111-111111111111')).toBeNull();
  });
});
