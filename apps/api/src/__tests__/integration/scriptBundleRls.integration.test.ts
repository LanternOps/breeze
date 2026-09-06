/**
 * Script bundle import under REAL RLS on script_versions / script_to_tags
 * (RMM-QA-220, migration apps/api/migrations/2026-10-01-100000-script-children-rls.sql).
 *
 * importBundle authorises the parent script through resolveScriptCreateScope
 * and then INSERTs script_to_tags (linkTags) and, in `new-version` mode,
 * script_versions — as `breeze_app` inside the caller's DB access context.
 * With the child policies forced, those INSERTs must still pass for every
 * caller scope the route supports:
 *   (a) organization scope  -> org-owned script (org_id + partner_id set)
 *   (b) partner scope, availability 'partner' -> partner-wide script (org_id NULL)
 *   (c) system scope with an explicit orgId -> org-owned script
 * If any of these regress, the policy is wrong — not the importer (spec §non-goals).
 */
import './setup';
import { describe, expect, it } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
import { db, withDbAccessContext, withSystemDbAccessContext } from '../../db';
import { scripts, scriptTags, scriptToTags, scriptVersions } from '../../db/schema';
import { buildDbAccessContext } from '../../middleware/auth';
import { importBundle, type BundleAuth } from '../../services/scriptBundle';
import { SCRIPT_BUNDLE_VERSION, type ScriptBundleEnvelope } from '../../services/scriptBundle/schema';
import { createOrganization, createPartner, createUser } from './db-utils';

function bundleAuth(args: {
  scope: 'organization' | 'partner' | 'system';
  orgId: string | null;
  partnerId: string | null;
  accessibleOrgIds: string[] | null;
  partnerOrgAccess?: 'all' | 'selected' | 'none' | null;
  userId: string;
}): BundleAuth {
  return {
    scope: args.scope,
    orgId: args.orgId,
    partnerId: args.partnerId,
    partnerOrgAccess: args.partnerOrgAccess ?? null,
    accessibleOrgIds: args.accessibleOrgIds,
    canAccessOrg: (id: string) => args.accessibleOrgIds === null || args.accessibleOrgIds.includes(id),
    user: { id: args.userId, email: 'bundle-rls@example.com', name: 'Bundle RLS', isPlatformAdmin: false },
  };
}

function bundle(content: string, suffix: string): ScriptBundleEnvelope {
  return {
    bundleVersion: SCRIPT_BUNDLE_VERSION,
    scripts: [
      { name: `Bundle One ${suffix}`, osTypes: ['windows'], language: 'powershell', content, tags: ['alpha', 'beta'], timeoutSeconds: 300, runAs: 'system' },
      { name: `Bundle Two ${suffix}`, osTypes: ['linux'], language: 'bash', content, tags: ['alpha'], timeoutSeconds: 300, runAs: 'system' },
    ],
  };
}

async function readBack(names: string[]) {
  return withSystemDbAccessContext(async () => {
    const rows = await db.select().from(scripts).where(inArray(scripts.name, names));
    const byName = new Map(rows.map((r) => [r.name, r]));
    const ids = rows.map((r) => r.id);
    const versions = ids.length ? await db.select().from(scriptVersions).where(inArray(scriptVersions.scriptId, ids)) : [];
    const links = ids.length
      ? await db
          .select({ scriptId: scriptToTags.scriptId, tagName: scriptTags.name, tagOrgId: scriptTags.orgId, tagPartnerId: scriptTags.partnerId })
          .from(scriptToTags)
          .innerJoin(scriptTags, eq(scriptToTags.tagId, scriptTags.id))
          .where(inArray(scriptToTags.scriptId, ids))
      : [];
    return { byName, versions, links };
  });
}

async function importTwice(auth: BundleAuth, ctx: ReturnType<typeof buildDbAccessContext>, availability: 'org' | 'partner', orgId: string | null, suffix: string) {
  const first = await withDbAccessContext(ctx, () => importBundle(auth, bundle('echo v1', suffix), { availability, orgId, mode: 'skip' }));
  const second = await withDbAccessContext(ctx, () => importBundle(auth, bundle('echo v2', suffix), { availability, orgId, mode: 'new-version' }));
  return { first, second };
}

function expectImported(result: Awaited<ReturnType<typeof importBundle>>, expected: { imported?: number; versioned?: number }) {
  if ('error' in result) throw new Error(`importBundle returned a scope error: ${result.error}`);
  expect(result.errors).toEqual([]);
  if (expected.imported !== undefined) expect(result.imported).toBe(expected.imported);
  if (expected.versioned !== undefined) expect(result.versioned).toBe(expected.versioned);
}

async function assertChildren(suffix: string, owner: { orgId: string | null; partnerId: string | null }) {
  const names = [`Bundle One ${suffix}`, `Bundle Two ${suffix}`];
  const { byName, versions, links } = await readBack(names);
  const one = byName.get(names[0]!);
  const two = byName.get(names[1]!);
  expect(one?.orgId ?? null).toBe(owner.orgId);
  expect(one?.partnerId ?? null).toBe(owner.partnerId);
  expect(one?.content).toBe('echo v2');
  expect(one?.version).toBe(2);
  // One snapshot per script, holding the v1 content, created by the caller.
  const oneVersions = versions.filter((v) => v.scriptId === one!.id);
  const twoVersions = versions.filter((v) => v.scriptId === two!.id);
  expect(oneVersions.map((v) => [v.version, v.content])).toEqual([[1, 'echo v1']]);
  expect(twoVersions.map((v) => [v.version, v.content])).toEqual([[1, 'echo v1']]);
  // Tags: two links on One, one on Two, all owned by the same scope as the script.
  expect(links.filter((l) => l.scriptId === one!.id).map((l) => l.tagName).sort()).toEqual(['alpha', 'beta']);
  expect(links.filter((l) => l.scriptId === two!.id).map((l) => l.tagName)).toEqual(['alpha']);
  for (const l of links) {
    expect(l.tagOrgId ?? null).toBe(owner.orgId);
    expect(l.tagPartnerId ?? null).toBe(owner.partnerId);
  }
}

describe('script bundle import under forced RLS on script_versions / script_to_tags (RMM-QA-220)', () => {
  it('(a) organization-scope caller: versions and tag links land on the org-owned script', async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    const user = await createUser({ partnerId: partner.id, orgId: org.id });
    const suffix = `org-${Date.now()}`;
    const auth = bundleAuth({ scope: 'organization', orgId: org.id, partnerId: partner.id, accessibleOrgIds: [org.id], userId: user.id });
    const ctx = buildDbAccessContext({ scope: 'organization', orgId: org.id, accessibleOrgIds: [org.id], partnerId: partner.id, userId: user.id });

    const { first, second } = await importTwice(auth, ctx, 'org', null, suffix);
    expectImported(first, { imported: 2 });
    expectImported(second, { versioned: 2 });
    await assertChildren(suffix, { orgId: org.id, partnerId: partner.id });
  });

  it('(b) partner-scope caller with partner-wide capability: versions and tag links land on the partner-wide script', async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    const user = await createUser({ partnerId: partner.id });
    const suffix = `pw-${Date.now()}`;
    const auth = bundleAuth({ scope: 'partner', orgId: null, partnerId: partner.id, accessibleOrgIds: [org.id], partnerOrgAccess: 'all', userId: user.id });
    const ctx = buildDbAccessContext({ scope: 'partner', orgId: null, accessibleOrgIds: [org.id], partnerId: partner.id, userId: user.id });

    const { first, second } = await importTwice(auth, ctx, 'partner', null, suffix);
    expectImported(first, { imported: 2 });
    expectImported(second, { versioned: 2 });
    await assertChildren(suffix, { orgId: null, partnerId: partner.id });
  });

  it('(c) system-scope caller with an explicit orgId: versions and tag links land on the org-owned script', async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    const user = await createUser({ partnerId: partner.id });
    const suffix = `sys-${Date.now()}`;
    const auth = bundleAuth({ scope: 'system', orgId: null, partnerId: null, accessibleOrgIds: null, userId: user.id });
    const ctx = buildDbAccessContext({ scope: 'system', orgId: null, accessibleOrgIds: null, partnerId: null, userId: user.id });

    const { first, second } = await importTwice(auth, ctx, 'org', org.id, suffix);
    expectImported(first, { imported: 2 });
    expectImported(second, { versioned: 2 });
    // resolveScriptCreateScope: system scope -> { orgId: requested, partnerId: null }.
    await assertChildren(suffix, { orgId: org.id, partnerId: null });
  });

  it('cross-check: the org-owned links are invisible to a different org under breeze_app', async () => {
    const partner = await createPartner();
    const orgA = await createOrganization({ partnerId: partner.id });
    const orgB = await createOrganization({ partnerId: partner.id });
    const user = await createUser({ partnerId: partner.id, orgId: orgA.id });
    const suffix = `xo-${Date.now()}`;
    const auth = bundleAuth({ scope: 'organization', orgId: orgA.id, partnerId: partner.id, accessibleOrgIds: [orgA.id], userId: user.id });
    const ctxA = buildDbAccessContext({ scope: 'organization', orgId: orgA.id, accessibleOrgIds: [orgA.id], partnerId: partner.id, userId: user.id });
    const ctxB = buildDbAccessContext({ scope: 'organization', orgId: orgB.id, accessibleOrgIds: [orgB.id], partnerId: partner.id, userId: null });

    expectImported(await withDbAccessContext(ctxA, () => importBundle(auth, bundle('echo v1', suffix), { availability: 'org', orgId: null, mode: 'skip' })), { imported: 2 });
    const [row] = await withSystemDbAccessContext(() => db.select({ id: scripts.id }).from(scripts).where(eq(scripts.name, `Bundle One ${suffix}`)));
    const asB = await withDbAccessContext(ctxB, () =>
      db.select({ tagId: scriptToTags.tagId }).from(scriptToTags).where(eq(scriptToTags.scriptId, row!.id))
    );
    expect(asB).toEqual([]);
    const asA = await withDbAccessContext(ctxA, () => db.select({ tagId: scriptToTags.tagId }).from(scriptToTags).where(eq(scriptToTags.scriptId, row!.id)));
    expect(asA).toHaveLength(2);
  });
});
