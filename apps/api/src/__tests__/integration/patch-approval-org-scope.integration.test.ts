/**
 * Integration test: partner-axis patch_approvals readable by org-scoped callers.
 *
 * patch_approvals is partner-axis RLS (breeze_has_partner_access). An org-scoped
 * caller's DB context has accessiblePartnerIds=[] → the table returns 0 rows in
 * request context. The fix wraps approval reads in runOutsideDbContext +
 * withSystemDbAccessContext so the partner's approvals are always visible,
 * regardless of the caller's scope.
 *
 * This test MUST FAIL before the fix (org context → empty approval set → approved
 * patch shows as "pending") and PASS after (approved patch reflected correctly).
 *
 * Harness mirrors: update-rings-partner-scope.integration.test.ts
 */
import './setup';
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { eq, and } from 'drizzle-orm';
import { Hono } from 'hono';
import { db, withSystemDbAccessContext, withDbAccessContext, runOutsideDbContext, type DbAccessContext } from '../../db';
import {
  patches,
  patchApprovals,
  devices,
  devicePatches,
} from '../../db/schema';
import {
  createPartner,
  createOrganization,
  setupTestEnvironment,
} from './db-utils';
import { getTestDb } from './setup';
import { authMiddleware } from '../../middleware/auth';
import { patchRoutes } from '../../routes/patches';

const runDb = it.runIf(!!process.env.DATABASE_URL);

function buildPatchesApp(): Hono {
  const app = new Hono();
  app.use('*', authMiddleware);
  app.route('/patches', patchRoutes);
  return app;
}

/** Seed a patches catalog row (global table, no tenant FK). Uses superuser pool. */
async function seedPatch(): Promise<string> {
  const [row] = await getTestDb()
    .insert(patches)
    .values({
      source: 'microsoft',
      externalId: `microsoft:${randomUUID()}`,
      title: 'Org-scope-test patch',
      severity: 'important',
    })
    .returning({ id: patches.id });
  if (!row) throw new Error('seedPatch: no row returned');
  return row.id;
}

describe('patch_approvals: org-scoped callers see partner approvals', () => {
  /**
   * Core regression test: org-scoped context must NOT get 0 rows when reading
   * a partner's patch_approvals row via system-context escape.
   *
   * Directly exercises the pattern used by the fixed code: runOutsideDbContext +
   * withSystemDbAccessContext inside an org-scoped withDbAccessContext.
   */
  runDb('system-context escape inside org-scoped context reads partner patch_approvals', async () => {
    const partner = await createPartner();
    const org = await createOrganization({ partnerId: partner.id });
    const patchId = await seedPatch();

    // Seed an approved patch_approvals row for this partner (system context).
    await withSystemDbAccessContext(() =>
      db.insert(patchApprovals).values({
        partnerId: partner.id,
        patchId,
        ringId: null,
        status: 'approved',
      })
    );

    // Read patchApprovals inside an ORG-scoped context (accessiblePartnerIds=[]).
    // The fix: runOutsideDbContext + withSystemDbAccessContext escapes the org context.
    // BEFORE fix: would return 0 rows (RLS denies partner-axis read for org context).
    // AFTER fix: returns the row via system context.
    const orgCtx: DbAccessContext = {
      scope: 'organization',
      orgId: org.id,
      accessibleOrgIds: [org.id],
      accessiblePartnerIds: [],
      currentPartnerId: partner.id,
      userId: null,
    };

    const rows = await withDbAccessContext(orgCtx, async () =>
      runOutsideDbContext(() =>
        withSystemDbAccessContext(() =>
          db
            .select({ patchId: patchApprovals.patchId, status: patchApprovals.status })
            .from(patchApprovals)
            .where(
              and(
                eq(patchApprovals.partnerId, partner.id),
                eq(patchApprovals.patchId, patchId)
              )
            )
        )
      )
    );

    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe('approved');
  });

  /**
   * Route-level test: GET /patches?orgId=<id> returns approvalStatus='approved'
   * for an org-scoped user whose partner has an approved patch.
   */
  runDb('GET /patches?orgId returns approvalStatus=approved for org-scoped user', async () => {
    const env = await setupTestEnvironment({ scope: 'organization' });
    const patchId = await seedPatch();

    // Seed a device so the patch shows up in the org scope (EXISTS join in list.ts).
    const [device] = await getTestDb()
      .insert(devices)
      .values({
        orgId: env.organization.id,
        siteId: env.site.id,
        agentId: `agent-patchapproval-list-${Date.now()}`,
        hostname: `test-device-${Date.now()}`,
        osType: 'windows',
        osVersion: '10.0.19045',
        architecture: 'x86_64',
        agentVersion: '0.0.0-test',
        status: 'online',
      })
      .returning();
    if (!device) throw new Error('failed to seed device');

    await getTestDb()
      .insert(devicePatches)
      .values({
        deviceId: device.id,
        orgId: env.organization.id,
        patchId,
        status: 'pending',
      });

    // Seed an approved patch_approvals row for this org's partner.
    await withSystemDbAccessContext(() =>
      db.insert(patchApprovals).values({
        partnerId: env.partner.id,
        patchId,
        ringId: null,
        status: 'approved',
      })
    );

    const app = buildPatchesApp();
    const res = await app.request(`/patches?orgId=${env.organization.id}`, {
      headers: { Authorization: `Bearer ${env.token}` },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    const patch = (body.data as Array<{ id: string; approvalStatus: string }>).find(p => p.id === patchId);
    expect(patch).toBeDefined();
    // BEFORE fix: 'pending' (0 rows from patchApprovals in org context).
    // AFTER fix: 'approved'.
    expect(patch!.approvalStatus).toBe('approved');
  });

  /**
   * Route-level test: GET /patches/compliance returns approvedMissing > 0
   * when org-scoped user has a device with an approved pending patch.
   */
  runDb('GET /patches/compliance shows approvedMissing for org-scoped user', async () => {
    const env = await setupTestEnvironment({ scope: 'organization' });
    const patchId = await seedPatch();

    const [device] = await getTestDb()
      .insert(devices)
      .values({
        orgId: env.organization.id,
        siteId: env.site.id,
        agentId: `agent-patchapproval-compliance-${Date.now()}`,
        hostname: `test-compliance-device-${Date.now()}`,
        osType: 'windows',
        osVersion: '10.0.19045',
        architecture: 'x86_64',
        agentVersion: '0.0.0-test',
        status: 'online',
      })
      .returning();
    if (!device) throw new Error('failed to seed device');

    await getTestDb()
      .insert(devicePatches)
      .values({
        deviceId: device.id,
        orgId: env.organization.id,
        patchId,
        status: 'pending',
      });

    // Seed approved patch_approvals for the partner.
    await withSystemDbAccessContext(() =>
      db.insert(patchApprovals).values({
        partnerId: env.partner.id,
        patchId,
        ringId: null,
        status: 'approved',
      })
    );

    const app = buildPatchesApp();
    const res = await app.request(`/patches/compliance?orgId=${env.organization.id}`, {
      headers: { Authorization: `Bearer ${env.token}` },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    const needsPatches = body.data.devicesNeedingPatches as Array<{
      id: string;
      approvedMissing: number;
      unapprovedMissing: number;
    }>;
    expect(needsPatches).toHaveLength(1);
    // BEFORE fix: approvedMissing=0 (RLS hides patchApprovals in org context).
    // AFTER fix: approvedMissing=1.
    expect(needsPatches[0]!.approvedMissing).toBe(1);
    expect(needsPatches[0]!.unapprovedMissing).toBe(0);
  });

  /**
   * All-orgs view (issue #2597): a partner-scoped caller sends GET /patches with
   * NO orgId. The approval read must resolve the caller's OWN token partner and
   * surface partner-wide (ring_id NULL) approvals. Before the fix this path
   * skipped patch_approvals entirely (the read was gated on query.orgId), so
   * every patch showed 'pending' on reload even though the approval row existed.
   */
  runDb('GET /patches (no orgId) surfaces partner-wide approval for a partner-scoped caller', async () => {
    const env = await setupTestEnvironment({ scope: 'partner' });
    const patchId = await seedPatch();

    await withSystemDbAccessContext(() =>
      db.insert(patchApprovals).values({
        partnerId: env.partner.id,
        patchId,
        ringId: null,
        status: 'approved',
      })
    );

    const app = buildPatchesApp();
    // No orgId — the "All orgs" view. limit=200 matches the web client and keeps
    // the freshly-seeded (newest, desc createdAt) patch on the first page.
    const res = await app.request('/patches?limit=200', {
      headers: { Authorization: `Bearer ${env.token}` },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    const patch = (body.data as Array<{ id: string; approvalStatus: string }>).find(p => p.id === patchId);
    expect(patch).toBeDefined();
    // BEFORE fix: 'pending' (no orgId → approval read skipped).
    // AFTER fix: 'approved' (resolved from the caller's token partner).
    expect(patch!.approvalStatus).toBe('approved');
  });

  /**
   * Cross-partner isolation for the no-orgId all-orgs view. The read uses a
   * system-context (RLS-bypassing) escape, so the app-layer
   * `eq(patchApprovals.partnerId, ...)` filter is the ONLY thing enforcing
   * tenant isolation on this path — this proves partner A's approval never
   * leaks into partner B's all-orgs view.
   */
  runDb("GET /patches (no orgId) does not leak one partner's approval to another partner", async () => {
    const partnerA = await setupTestEnvironment({ scope: 'partner' });
    const partnerB = await setupTestEnvironment({ scope: 'partner' });
    const patchId = await seedPatch();

    // Only partner A approves the (global-catalog) patch, partner-wide.
    await withSystemDbAccessContext(() =>
      db.insert(patchApprovals).values({
        partnerId: partnerA.partner.id,
        patchId,
        ringId: null,
        status: 'approved',
      })
    );

    const app = buildPatchesApp();
    // Partner B sees the same catalog patch, but with NO approval of their own.
    const res = await app.request('/patches?limit=200', {
      headers: { Authorization: `Bearer ${partnerB.token}` },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    const patch = (body.data as Array<{ id: string; approvalStatus: string }>).find(p => p.id === patchId);
    expect(patch).toBeDefined();
    expect(patch!.approvalStatus).toBe('pending');
  });
});
