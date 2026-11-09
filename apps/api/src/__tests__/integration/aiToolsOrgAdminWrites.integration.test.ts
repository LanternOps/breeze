/**
 * Integration test — W18 PR B (#6789): the two org-admin writers against real Postgres as the unprivileged
 * `breeze_app` role, through `executeTool` (the production dispatch).
 *
 * Proven:
 *   - manage_org_portal_settings update: refused (nothing written) when enabling a parent would activate a sensitive
 *     child that is already on, including when the child is switched on by a concurrent transaction that holds the
 *     row lock while the tool waits (a plain read would have seen the old value); CONTROL: with the child off it writes;
 *   - set_sensitive_access: the effect digest is computed from the real row, a flag changed after approval gives
 *     another digest (the release refuses: the generic path is effectDigestToctou.integration.test.ts), and the
 *     unchanged row recomputes the same one; the four-eyes execution writes only the named flags;
 *   - manage_report_recipients add in org A with org B's contact is not found, and no row is written;
 *   - remove of a series exclusion ('remove' row) without reports:export is refused and the row stays; CONTROL: a
 *     caller with the export grant removes it;
 *   - convert refuses an address that is not in the report's email list (config unchanged) and converts one that is.
 */
import './setup';
import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import { db, withDbAccessContext, withSystemDbAccessContext } from '../../db';
import { portalBranding, reportScheduleRecipients, reportSeries, reports } from '../../db/schema';
import { buildDbAccessContext, type AuthContext } from '../../middleware/auth';
import { executeTool } from '../../services/aiTools';
import { computeEffectDigestForRelease, computeEffectDigestOutcome } from '../../services/actionIntents/effectDigest';
import { clearPermissionCache } from '../../services/permissions';
import { assignUserToOrganization, assignUserToPartner, createOrganization, createPartner, createRole, createUser, grantRolePermissions } from './db-utils';
import { getTestDb } from './setup';

function partnerAuth(userId: string, partnerId: string, orgIds: string[]): AuthContext {
  return {
    principal: { kind: 'user_session' },
    user: { id: userId, email: 'fixture-operator@example.com', name: 'Fixture Operator', isPlatformAdmin: false },
    token: { mfa: true } as AuthContext['token'],
    scope: 'partner', orgId: null, partnerId, partnerOrgAccess: 'all', accessibleOrgIds: orgIds,
    orgCondition: (column: Parameters<typeof eq>[0]) => sql`${column} = ANY(${orgIds})`,
    canAccessOrg: (id: string) => orgIds.includes(id), canAccessSite: () => true,
    aiOrigin: { kind: 'ai_assistant', sessionId: randomUUID() },
  } as unknown as AuthContext;
}

function orgAuth(userId: string, partnerId: string, orgId: string): AuthContext {
  return {
    principal: { kind: 'user_session' },
    user: { id: userId, email: 'fixture-org-admin@example.com', name: 'Fixture Org Admin', isPlatformAdmin: false },
    token: { mfa: true } as AuthContext['token'],
    scope: 'organization', orgId, partnerId, accessibleOrgIds: [orgId],
    orgCondition: (column: Parameters<typeof eq>[0]) => eq(column, orgId),
    canAccessOrg: (id: string) => id === orgId, canAccessSite: () => true,
    aiOrigin: { kind: 'ai_assistant', sessionId: randomUUID() },
  } as unknown as AuthContext;
}

function contextOf(auth: AuthContext) {
  return buildDbAccessContext({
    scope: auth.scope, orgId: auth.orgId, accessibleOrgIds: auth.accessibleOrgIds ?? [], partnerId: auth.partnerId, userId: auth.user.id,
  });
}

async function run(tool: string, input: Record<string, unknown>, auth: AuthContext) {
  const raw = await withDbAccessContext(contextOf(auth), () => executeTool(tool, input, auth));
  return JSON.parse(raw) as Record<string, any>;
}

async function portalRow(orgId: string) {
  const [row] = await getTestDb().select().from(portalBranding).where(eq(portalBranding.orgId, orgId)).limit(1);
  return row;
}

async function contact(orgId: string, email: string) {
  const id = randomUUID();
  await getTestDb().execute(sql`INSERT INTO contacts (id, org_id, name, email) VALUES (${id}, ${orgId}, ${email}, ${email})`);
  return id;
}

async function seed() {
  const partner = await createPartner();
  const orgA = await createOrganization({ partnerId: partner.id });
  const orgB = await createOrganization({ partnerId: partner.id });

  const partnerRole = await createRole({ scope: 'partner', partnerId: partner.id, name: `W18B partner ${randomUUID()}` });
  await grantRolePermissions(partnerRole.id, [{ resource: 'organizations', action: 'read' }, { resource: 'organizations', action: 'write' }]);
  const tech = await createUser({ partnerId: partner.id, email: `w18b-tech-${randomUUID()}@example.com` });
  await assignUserToPartner(tech.id, partner.id, partnerRole.id, 'all');

  // Org A report writers: one without reports:export (the gate's subject), one with it (the CONTROL).
  const writeRole = await createRole({ scope: 'organization', orgId: orgA.id, partnerId: partner.id, name: `W18B write ${randomUUID()}` });
  await grantRolePermissions(writeRole.id, [{ resource: 'reports', action: 'read' }, { resource: 'reports', action: 'write' }]);
  const exportRole = await createRole({ scope: 'organization', orgId: orgA.id, partnerId: partner.id, name: `W18B export ${randomUUID()}` });
  await grantRolePermissions(exportRole.id, [
    { resource: 'reports', action: 'read' }, { resource: 'reports', action: 'write' }, { resource: 'reports', action: 'export' },
  ]);
  const writer = await createUser({ partnerId: partner.id, orgId: orgA.id, email: `w18b-writer-${randomUUID()}@example.com` });
  const exporter = await createUser({ partnerId: partner.id, orgId: orgA.id, email: `w18b-exporter-${randomUUID()}@example.com` });
  await assignUserToOrganization(writer.id, orgA.id, writeRole.id);
  await assignUserToOrganization(exporter.id, orgA.id, exportRole.id);

  return {
    partner, orgA, orgB,
    auth: {
      tech: partnerAuth(tech.id, partner.id, [orgA.id, orgB.id]),
      writer: orgAuth(writer.id, partner.id, orgA.id),
      exporter: orgAuth(exporter.id, partner.id, orgA.id),
    },
  };
}

let f: Awaited<ReturnType<typeof seed>>;
beforeEach(async () => {
  clearPermissionCache();
  f = await seed();
});

describe('manage_org_portal_settings (W18 PR B, #6789)', () => {
  it('update refuses a parent enable that would show a dormant sensitive child, and writes nothing', async () => {
    await getTestDb().insert(portalBranding).values({ orgId: f.orgA.id, enablePhysicalPlacement: true });
    const out = await run('manage_org_portal_settings', { action: 'update', orgId: f.orgA.id, settings: { enableNetworkVisibility: true } }, f.auth.tech);
    expect(out.code).toBe('SENSITIVE_ACTIVATION');
    expect(out.error).toContain('enablePhysicalPlacement');
    expect((await portalRow(f.orgA.id))?.enableNetworkVisibility).toBe(false);

    // CONTROL: org B has no child on (and no row yet), so the same update writes.
    const ok = await run('manage_org_portal_settings', { action: 'update', orgId: f.orgB.id, settings: { enableNetworkVisibility: true } }, f.auth.tech);
    expect(ok.updated).toBe(true);
    expect((await portalRow(f.orgB.id))?.enableNetworkVisibility).toBe(true);
  });

  it('the check runs under the row lock: a child switched on by a concurrent transaction is seen, and the update refuses', async () => {
    await getTestDb().insert(portalBranding).values({ orgId: f.orgA.id });
    let pending: Promise<Record<string, any>> | null = null;
    await getTestDb().transaction(async (tx) => {
      await tx.select({ id: portalBranding.id }).from(portalBranding).where(eq(portalBranding.orgId, f.orgA.id)).for('update');
      // The tool starts while the row is locked and the child is still off.
      pending = run('manage_org_portal_settings', { action: 'update', orgId: f.orgA.id, settings: { enableNetworkVisibility: true } }, f.auth.tech);
      // Wait until the tool's backend is really blocked on a lock, so the case cannot pass on a slow start.
      for (let i = 0; i < 100; i += 1) {
        const waiting = await getTestDb().execute(sql`SELECT count(*)::int AS n FROM pg_locks WHERE NOT granted`);
        if (Number((waiting as unknown as Array<{ n: number }>)[0]?.n ?? (waiting as unknown as { rows: Array<{ n: number }> }).rows?.[0]?.n) > 0) break;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      await tx.update(portalBranding).set({ enableNetworkAlerts: true }).where(eq(portalBranding.orgId, f.orgA.id));
    });
    const out = await pending!;
    expect(out.code).toBe('SENSITIVE_ACTIVATION');
    expect(out.error).toContain('enableNetworkAlerts');
    const row = await portalRow(f.orgA.id);
    expect(row?.enableNetworkVisibility).toBe(false);
    expect(row?.enableNetworkAlerts).toBe(true);
  });

  it('set_sensitive_access: the digest is pinned from the real row and drifts when a flag changes; execution writes only the named flags', async () => {
    await getTestDb().insert(portalBranding).values({ orgId: f.orgA.id, enableReports: true });
    const args = { action: 'set_sensitive_access', orgId: f.orgA.id, flags: { enableVulnerabilityDetail: true } };
    const pinned = await withSystemDbAccessContext(() => computeEffectDigestOutcome('manage_org_portal_settings', args, db));
    expect(pinned.kind).toBe('pinned');
    const digest = pinned.kind === 'pinned' ? pinned.digest : '';

    // CONTROL: nothing changed, the release recompute matches.
    expect((await withSystemDbAccessContext(() => computeEffectDigestForRelease('manage_org_portal_settings', args, db))).digest).toBe(digest);
    // Drift: someone turns patch detail on after approval; the release recompute no longer matches.
    await getTestDb().update(portalBranding).set({ enablePatchDetail: true }).where(eq(portalBranding.orgId, f.orgA.id));
    expect((await withSystemDbAccessContext(() => computeEffectDigestForRelease('manage_org_portal_settings', args, db))).digest).not.toBe(digest);
    // A non-sensitive column is outside the pin.
    await getTestDb().update(portalBranding).set({ enablePatchDetail: false, welcomeMessage: 'Hello' }).where(eq(portalBranding.orgId, f.orgA.id));
    expect((await withSystemDbAccessContext(() => computeEffectDigestForRelease('manage_org_portal_settings', args, db))).digest).toBe(digest);

    const out = await run('manage_org_portal_settings', args, f.auth.tech);
    expect(out.updated).toBe(true);
    const row = await portalRow(f.orgA.id);
    expect(row?.enableVulnerabilityDetail).toBe(true);
    expect(row?.enablePatchDetail).toBe(false);
    expect(row?.enableReports).toBe(true);
  });

  it('an org scope caller is refused before anything is read', async () => {
    const out = await run('manage_org_portal_settings', { action: 'get', orgId: f.orgA.id }, f.auth.writer);
    expect(out.code).toBe('PARTNER_SCOPE_REQUIRED');
  });
});

describe('manage_report_recipients (W18 PR B, #6789)', () => {
  async function plainReport(config: Record<string, unknown> = {}) {
    const id = randomUUID();
    await getTestDb().insert(reports).values({ id, orgId: f.orgA.id, name: 'Monthly', type: 'executive_summary', schedule: 'monthly', config } as never);
    return id;
  }

  it('add in org A with org B\'s contact is not found, and no row is written', async () => {
    const reportId = await plainReport();
    const foreign = await contact(f.orgB.id, `w18b-${randomUUID()}@example.com`);
    const out = await run('manage_report_recipients', { action: 'add', reportId, contactId: foreign }, f.auth.exporter);
    expect(out.code).toBe('NOT_FOUND');
    const rows = await getTestDb().select().from(reportScheduleRecipients).where(eq(reportScheduleRecipients.reportId, reportId));
    expect(rows).toEqual([]);
    // CONTROL: org A's own contact is added.
    const own = await contact(f.orgA.id, `w18b-${randomUUID()}@example.com`);
    expect((await run('manage_report_recipients', { action: 'add', reportId, contactId: own }, f.auth.exporter)).added).toBe(true);
  });

  it('add without reports:export is refused even on a plain definition (Decision 5)', async () => {
    const reportId = await plainReport();
    const own = await contact(f.orgA.id, `w18b-${randomUUID()}@example.com`);
    expect((await run('manage_report_recipients', { action: 'add', reportId, contactId: own }, f.auth.writer)).code).toBe('EXPORT_AND_MFA_REQUIRED');
  });

  it("remove of a series exclusion without reports:export is refused and the row stays; CONTROL: the export grant removes it", async () => {
    const [series] = await getTestDb().insert(reportSeries).values({
      partnerId: f.partner.id, name: 'Series', type: 'executive_summary', schedule: 'monthly', targetMode: 'all',
    }).returning();
    const reportId = randomUUID();
    await getTestDb().execute(sql`
      INSERT INTO reports (id, org_id, name, type, schedule, series_id, series_revision)
      VALUES (${reportId}, ${f.orgA.id}, 'Monthly', 'executive_summary', 'monthly', ${series!.id}, 1)`);
    const excluded = await contact(f.orgA.id, `w18b-${randomUUID()}@example.com`);
    await getTestDb().insert(reportScheduleRecipients).values({ reportId, orgId: f.orgA.id, contactId: excluded, mode: 'remove' });

    const out = await run('manage_report_recipients', { action: 'remove', reportId, contactId: excluded }, f.auth.writer);
    expect(out.code).toBe('EXPORT_AND_MFA_REQUIRED');
    const still = await getTestDb().select().from(reportScheduleRecipients)
      .where(and(eq(reportScheduleRecipients.reportId, reportId), eq(reportScheduleRecipients.contactId, excluded)));
    expect(still).toHaveLength(1);

    expect((await run('manage_report_recipients', { action: 'remove', reportId, contactId: excluded }, f.auth.exporter)).deleted).toBe(true);
  });

  it('convert refuses an address not in the email list (config unchanged) and converts one that is', async () => {
    const listed = `w18b-listed-${randomUUID()}@example.com`;
    const reportId = await plainReport({ emailRecipients: [listed] });
    const refused = await run('manage_report_recipients', { action: 'convert', reportId, email: `w18b-other-${randomUUID()}@example.com` }, f.auth.exporter);
    expect(refused.code).toBe('recipient_not_in_report_email_recipients');
    const [before] = await getTestDb().select({ config: reports.config }).from(reports).where(eq(reports.id, reportId));
    expect((before!.config as { emailRecipients: string[] }).emailRecipients).toEqual([listed]);

    const ok = await run('manage_report_recipients', { action: 'convert', reportId, email: listed }, f.auth.exporter);
    expect(ok.converted).toBe(true);
    const [after] = await getTestDb().select({ config: reports.config }).from(reports).where(eq(reports.id, reportId));
    expect((after!.config as { emailRecipients: string[] }).emailRecipients).toEqual([]);
    const rows = await getTestDb().select().from(reportScheduleRecipients).where(eq(reportScheduleRecipients.reportId, reportId));
    expect(rows).toHaveLength(1);
  });
});
