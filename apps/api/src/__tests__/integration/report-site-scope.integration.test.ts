/**
 * Wave 2 release gate — tenant, site, and mixed-version isolation for reports.
 *
 * Everything here runs against REAL PostgreSQL under
 * `vitest.integration.config.ts`. Route traffic goes through the production
 * middleware chain (authMiddleware -> requireScope -> requirePermission) on the
 * unprivileged `breeze_app` pool, so forced RLS is live for every assertion.
 * Fixtures are seeded through the BYPASSRLS superuser pool, which means every
 * hidden row physically exists and is reachable by a pre-wave (org-only) query
 * — a vacuous "nothing was there anyway" pass is impossible.
 *
 * Non-vacuity is asserted explicitly rather than assumed:
 *
 *  - Cross-tenant forge: the SAME insert is proven to succeed as the superuser
 *    and from its own organization's context, so the RLS rejection cannot be a
 *    typo or a missing column.
 *  - Hidden rows: each visibility test also asserts the tenant-only (pre-wave)
 *    count, so the gap between "org can reach it" and "the route returns it" is
 *    measured, not asserted in the abstract.
 *  - "Selects no payload" / "issues no query": proven by REVOKEing the relevant
 *    SELECT privilege from `breeze_app` for the duration of the request. A denied
 *    path must still answer 404/403/zero-safe; the positive control proves the
 *    revoke actually bites by making the authorized path fail.
 *
 * Fixture topology (rebuilt per test — setup.ts TRUNCATEs on beforeEach):
 *
 *   Partner P1
 *     Org A  sites A1, A2   — partner user has NO organization_users row (partner fallback)
 *     Org B  sites B1, B2   — partner user HAS an organization_users row restricted to B1
 *     Org D  site  D1       — partner user's membership role lacks reports:read (denied)
 *     Org E  site  E1       — partner user's membership has site_ids = '{}' (restricted-empty)
 *   Partner P2
 *     Org F  site  F1       — wholly inaccessible to every P1 principal
 */
import './setup';

import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { and, eq, sql } from 'drizzle-orm';

import { getAppDb, getTestDb } from './setup';
import {
  createOrganization,
  createPartner,
  createRole,
  createSite,
  createUser,
  grantRolePermissions,
} from './db-utils';
import { createAccessToken, type TokenPayload } from '../../services/jwt';
import { clearPermissionCache } from '../../services/permissions';
import { withSystemDbAccessContext } from '../../db';
import {
  alertRules,
  alertTemplates,
  alerts,
  devices,
  organizationUsers,
  partnerUsers,
  reportRuns,
  reports,
  users,
} from '../../db/schema';
import { reportRoutes } from '../../routes/reports';
import type { AuthContext } from '../../middleware/auth';
import {
  decodeSiteScope,
  resolveLiveReportAuthority,
  resolveRequestReportAuthority,
  resolveRequestReportAuthorityMap,
  siteScopeFingerprint,
  type PersistedSiteScopeColumns,
} from '../../services/siteScope';
import { previousBaselineFor } from '../../services/reportGenerationService';

// The scheduled-report worker's email hop must be observable: a denied run has
// to reach ZERO delivery attempts, and the positive control has to reach one.
// Only `getEmailService` is replaced; every other export stays real.
const emailProbe = vi.hoisted(() => ({ calls: 0 }));
vi.mock('../../services/email', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/email')>();
  return {
    ...actual,
    getEmailService: () => {
      emailProbe.calls += 1;
      return null;
    },
  };
});

// Imported AFTER the mock declaration for readability; vitest hoists vi.mock
// above every import, so the worker still sees the probed email service.
import { findDueReports, processRunScheduledReport } from '../../jobs/reportScheduleWorker';

const runDb = it.runIf(!!process.env.DATABASE_URL);
const JSON_HEADERS = { 'Content-Type': 'application/json' } as const;
const REPORT_PERMS = [
  { resource: 'reports', action: 'read' },
  { resource: 'reports', action: 'write' },
  { resource: 'reports', action: 'export' },
  { resource: 'reports', action: 'delete' },
];
const MIGRATION_FILE = '2026-08-06-a-report-site-scope.sql';

function buildApp(): Hono {
  const app = new Hono();
  app.route('/reports', reportRoutes);
  return app;
}

function authed(token: string, init: RequestInit = {}): RequestInit {
  return {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      ...JSON_HEADERS,
      ...(init.headers as Record<string, string> | undefined),
    },
  };
}

// ───────────────────────────── raw SQL helpers ─────────────────────────────

/**
 * postgres.js refuses a JS `Date` bound through a raw `sql` template (drizzle
 * tags it with the timestamp OID and the driver then expects a string), so raw
 * inserts pass the naive-UTC literal drizzle itself writes for `timestamp`
 * columns.
 */
function naiveUtc(value: Date): string {
  return value.toISOString().slice(0, 23).replace('T', ' ');
}

async function rawRows<T = Record<string, unknown>>(
  query: ReturnType<typeof sql>,
): Promise<T[]> {
  const result = await getTestDb().execute(query);
  return result as unknown as T[];
}

async function scalar<T>(query: ReturnType<typeof sql>): Promise<T> {
  const rows = await rawRows<Record<string, T>>(query);
  const first = rows[0];
  if (!first) throw new Error('scalar(): query returned no rows');
  return Object.values(first)[0] as T;
}

/**
 * Run `fn` with `breeze_app`'s SELECT privilege on `table` removed (optionally
 * keeping every column except `exceptColumn`). Used to prove a code path never
 * touches a table/column: if it did, the request would fail with
 * `permission denied` instead of the expected not-found/zero-safe answer.
 */
async function withoutSelectPrivilege<T>(
  table: string,
  fn: () => Promise<T>,
  exceptColumn?: string,
): Promise<T> {
  const db = getTestDb();
  await db.execute(sql.raw(`REVOKE SELECT ON ${table} FROM breeze_app`));
  if (exceptColumn) {
    await db.execute(
      sql.raw(`DO $$
        DECLARE cols text;
        BEGIN
          SELECT string_agg(quote_ident(column_name), ', ')
            INTO cols
            FROM information_schema.columns
           WHERE table_schema = 'public'
             AND table_name = '${table}'
             AND column_name <> '${exceptColumn}';
          EXECUTE format('GRANT SELECT (%s) ON ${table} TO breeze_app', cols);
        END $$;`),
    );
  }
  try {
    return await fn();
  } finally {
    await db.execute(sql.raw(`REVOKE ALL ON ${table} FROM breeze_app`));
    await db.execute(
      sql.raw(
        `GRANT SELECT, INSERT, UPDATE, DELETE, REFERENCES ON ${table} TO breeze_app`,
      ),
    );
  }
}

const SCOPE_SHAPE_CHECK = () => `((
  (
    execution_scope_version IS NULL
    AND execution_scope_kind IS NULL
    AND execution_scope_site_ids IS NULL
    AND execution_scope_user_id IS NULL
    AND execution_scope_fingerprint IS NULL
    AND execution_scope_captured_at IS NULL
  )
  OR
  (
    execution_scope_version = 1
    AND execution_scope_fingerprint IS NOT NULL
    AND execution_scope_captured_at IS NOT NULL
    AND (
      (execution_scope_kind = 'restricted' AND execution_scope_site_ids IS NOT NULL AND execution_scope_user_id IS NOT NULL)
      OR (execution_scope_kind = 'unrestricted' AND execution_scope_site_ids IS NULL AND execution_scope_user_id IS NOT NULL)
      OR (execution_scope_kind = 'legacy_unscoped' AND execution_scope_site_ids IS NULL)
    )
  )
) IS TRUE)`.replace(/\s+/g, ' ');

/** Re-create the migration's shape CHECK constraints if a previous test dropped them. */
async function ensureScopeShapeConstraints(): Promise<void> {
  for (const table of ['reports', 'report_runs'] as const) {
    const constraint = `${table}_execution_scope_shape_chk`;
    const present = await scalar<number>(sql`
      SELECT count(*)::int FROM pg_constraint WHERE conname = ${constraint}
    `);
    if (present === 0) {
      await getTestDb().execute(
        sql.raw(
          `ALTER TABLE ${table} ADD CONSTRAINT ${constraint} CHECK ${SCOPE_SHAPE_CHECK()}`,
        ),
      );
    }
  }
}

/** Drop both shape CHECKs, run `fn`, then delete the rows it created and restore them. */
async function withoutScopeShapeConstraints<T>(
  fn: () => Promise<T>,
): Promise<T> {
  const db = getTestDb();
  for (const table of ['reports', 'report_runs'] as const) {
    await db.execute(
      sql.raw(
        `ALTER TABLE ${table} DROP CONSTRAINT IF EXISTS ${table}_execution_scope_shape_chk`,
      ),
    );
  }
  try {
    return await fn();
  } finally {
    // Malformed rows would fail re-validation; they have served their purpose.
    await db.execute(sql`
      DELETE FROM report_runs
       WHERE execution_scope_version IS NOT NULL AND execution_scope_version <> 1
    `);
    await db.execute(sql`
      DELETE FROM report_runs
       WHERE execution_scope_version = 1
         AND (execution_scope_kind IS NULL
              OR (execution_scope_kind = 'restricted' AND execution_scope_site_ids IS NULL))
    `);
    await db.execute(sql`
      DELETE FROM reports
       WHERE execution_scope_version IS NOT NULL AND execution_scope_version <> 1
    `);
    await db.execute(sql`
      DELETE FROM reports
       WHERE execution_scope_version = 1
         AND (execution_scope_kind IS NULL
              OR (execution_scope_kind = 'restricted' AND execution_scope_site_ids IS NULL))
    `);
    await ensureScopeShapeConstraints();
  }
}

// ───────────────────────────── scope fixtures ─────────────────────────────

type ScopeShape =
  | { kind: 'unrestricted'; userId: string }
  | { kind: 'restricted'; userId: string; siteIds: string[] }
  | { kind: 'legacy'; userId?: string | null }
  | { kind: 'null' };

function provenanceValues(orgId: string, shape: ScopeShape) {
  const capturedAt = new Date('2026-07-01T00:00:00.000Z');
  switch (shape.kind) {
    case 'unrestricted':
      return {
        executionScopeVersion: 1,
        executionScopeKind: 'unrestricted' as const,
        executionScopeSiteIds: null,
        executionScopeUserId: shape.userId,
        executionScopeFingerprint: siteScopeFingerprint({
          version: 1,
          kind: 'unrestricted',
          orgId,
        }),
        executionScopeCapturedAt: capturedAt,
      };
    case 'restricted': {
      const siteIds = [...new Set(shape.siteIds)].sort((a, b) => a.localeCompare(b));
      return {
        executionScopeVersion: 1,
        executionScopeKind: 'restricted' as const,
        executionScopeSiteIds: siteIds,
        executionScopeUserId: shape.userId,
        executionScopeFingerprint: siteScopeFingerprint({
          version: 1,
          kind: 'restricted',
          orgId,
          siteIds,
        }),
        executionScopeCapturedAt: capturedAt,
      };
    }
    case 'legacy':
      return {
        executionScopeVersion: 1,
        executionScopeKind: 'legacy_unscoped' as const,
        executionScopeSiteIds: null,
        executionScopeUserId: shape.userId ?? null,
        executionScopeFingerprint: siteScopeFingerprint({
          version: 1,
          kind: 'legacy_unscoped',
          orgId,
        }),
        executionScopeCapturedAt: capturedAt,
      };
    case 'null':
      return {
        executionScopeVersion: null,
        executionScopeKind: null,
        executionScopeSiteIds: null,
        executionScopeUserId: null,
        executionScopeFingerprint: null,
        executionScopeCapturedAt: null,
      };
  }
}

interface SeedReportOptions {
  orgId: string;
  name: string;
  scope: ScopeShape;
  createdBy?: string | null;
  schedule?: 'one_time' | 'daily' | 'weekly' | 'monthly';
  config?: Record<string, unknown>;
  updatedAt?: Date;
  type?: 'device_inventory' | 'alert_summary' | 'compliance';
}

async function seedReport(options: SeedReportOptions): Promise<string> {
  const at = options.updatedAt ?? new Date();
  const [row] = await getTestDb()
    .insert(reports)
    .values({
      orgId: options.orgId,
      name: options.name,
      type: options.type ?? 'device_inventory',
      config: options.config ?? {},
      schedule: options.schedule ?? 'one_time',
      format: 'csv',
      createdBy: options.createdBy ?? null,
      createdAt: at,
      updatedAt: at,
      ...provenanceValues(options.orgId, options.scope),
    })
    .returning({ id: reports.id });
  if (!row) throw new Error('seedReport: no row returned');
  return row.id;
}

interface SeedRunOptions {
  reportId: string;
  orgId: string;
  scope: ScopeShape;
  createdAt?: Date;
  status?: 'pending' | 'running' | 'completed' | 'failed';
  result?: Record<string, unknown> | null;
}

async function seedRun(options: SeedRunOptions): Promise<string> {
  const at = options.createdAt ?? new Date();
  const [row] = await getTestDb()
    .insert(reportRuns)
    .values({
      reportId: options.reportId,
      status: options.status ?? 'completed',
      startedAt: at,
      completedAt: at,
      createdAt: at,
      rowCount: 1,
      result: options.result ?? { rows: [{ hostname: 'seeded' }], rowCount: 1 },
      ...provenanceValues(options.orgId, options.scope),
    })
    .returning({ id: reportRuns.id });
  if (!row) throw new Error('seedRun: no row returned');
  return row.id;
}

// ───────────────────────────── core fixture ─────────────────────────────

interface Principal {
  id: string;
  email: string;
  token: string;
}

interface Fixture {
  partner1: string;
  partner2: string;
  orgA: string;
  orgB: string;
  orgD: string;
  orgE: string;
  orgF: string;
  siteA1: string;
  siteA2: string;
  siteB1: string;
  siteB2: string;
  siteD1: string;
  siteE1: string;
  siteF1: string;
  roleOrgA: string;
  roleOrgB: string;
  roleOrgD: string;
  roleOrgE: string;
  roleOrgF: string;
  rolePartner: string;
  siteAUser: Principal;
  unrestrictedUser: Principal;
  emptyScopeUser: Principal;
  partnerUser: Principal;
  systemUser: Principal;
  foreignUser: Principal;
  deviceA1: string;
  deviceA2: string;
  deviceB1: string;
  deviceB2: string;
  deviceD1: string;
  deviceE1: string;
}

let deviceSeq = 0;

async function seedDevice(orgId: string, siteId: string, hostname: string): Promise<string> {
  deviceSeq += 1;
  const [row] = await getTestDb()
    .insert(devices)
    .values({
      orgId,
      siteId,
      agentId: `agent-w2-${deviceSeq}-${Date.now()}`,
      hostname,
      displayName: hostname,
      osType: 'windows',
      osVersion: '11',
      osBuild: '22631',
      architecture: 'x86_64',
      agentVersion: '0.0.0-test',
      status: 'online',
      enrolledAt: new Date(),
      lastSeenAt: new Date(),
    })
    .returning({ id: devices.id });
  if (!row) throw new Error('seedDevice: no row returned');
  return row.id;
}

async function addOrgMembership(
  userId: string,
  orgId: string,
  roleId: string,
  siteIds: string[] | null,
): Promise<void> {
  await getTestDb().insert(organizationUsers).values({ userId, orgId, roleId, siteIds });
}

async function mintToken(args: {
  userId: string;
  email: string;
  roleId: string | null;
  orgId: string | null;
  partnerId: string | null;
  scope: 'organization' | 'partner' | 'system';
}): Promise<string> {
  const payload: Omit<TokenPayload, 'type'> = {
    sub: args.userId,
    email: args.email,
    roleId: args.roleId,
    orgId: args.orgId,
    partnerId: args.partnerId,
    scope: args.scope,
    mfa: false,
    aep: 1,
    mep: 1,
    sid: randomUUID(),
  };
  return createAccessToken(payload);
}

async function buildFixture(): Promise<Fixture> {
  const partner1 = (await createPartner())!;
  const partner2 = (await createPartner())!;

  const orgA = (await createOrganization({ partnerId: partner1.id }))!;
  const orgB = (await createOrganization({ partnerId: partner1.id }))!;
  const orgD = (await createOrganization({ partnerId: partner1.id }))!;
  const orgE = (await createOrganization({ partnerId: partner1.id }))!;
  const orgF = (await createOrganization({ partnerId: partner2.id }))!;

  const siteA1 = (await createSite({ orgId: orgA.id, name: 'Site A1' }))!;
  const siteA2 = (await createSite({ orgId: orgA.id, name: 'Site A2' }))!;
  const siteB1 = (await createSite({ orgId: orgB.id, name: 'Site B1' }))!;
  const siteB2 = (await createSite({ orgId: orgB.id, name: 'Site B2' }))!;
  const siteD1 = (await createSite({ orgId: orgD.id, name: 'Site D1' }))!;
  const siteE1 = (await createSite({ orgId: orgE.id, name: 'Site E1' }))!;
  const siteF1 = (await createSite({ orgId: orgF.id, name: 'Site F1' }))!;

  const roleOrgA = (await createRole({ scope: 'organization', orgId: orgA.id, partnerId: partner1.id }))!;
  const roleOrgB = (await createRole({ scope: 'organization', orgId: orgB.id, partnerId: partner1.id }))!;
  const roleOrgD = (await createRole({ scope: 'organization', orgId: orgD.id, partnerId: partner1.id }))!;
  const roleOrgE = (await createRole({ scope: 'organization', orgId: orgE.id, partnerId: partner1.id }))!;
  const roleOrgF = (await createRole({ scope: 'organization', orgId: orgF.id, partnerId: partner2.id }))!;
  const rolePartner = (await createRole({ scope: 'partner', partnerId: partner1.id }))!;

  await grantRolePermissions(roleOrgA.id, REPORT_PERMS);
  await grantRolePermissions(roleOrgB.id, REPORT_PERMS);
  // Org D's membership role deliberately carries NO reports permission.
  await grantRolePermissions(roleOrgD.id, [{ resource: 'devices', action: 'read' }]);
  await grantRolePermissions(roleOrgE.id, REPORT_PERMS);
  await grantRolePermissions(roleOrgF.id, REPORT_PERMS);
  await grantRolePermissions(rolePartner.id, REPORT_PERMS);

  const siteAUserRow = (await createUser({ partnerId: partner1.id, orgId: orgA.id, email: `site-a-${randomUUID()}@example.com` }))!;
  const unrestrictedRow = (await createUser({ partnerId: partner1.id, orgId: orgA.id, email: `unres-${randomUUID()}@example.com` }))!;
  const emptyRow = (await createUser({ partnerId: partner1.id, orgId: orgA.id, email: `empty-${randomUUID()}@example.com` }))!;
  const partnerRow = (await createUser({ partnerId: partner1.id, orgId: null, email: `partner-${randomUUID()}@example.com` }))!;
  const systemRow = (await createUser({ partnerId: partner1.id, orgId: null, email: `system-${randomUUID()}@example.com` }))!;
  const foreignRow = (await createUser({ partnerId: partner2.id, orgId: orgF.id, email: `foreign-${randomUUID()}@example.com` }))!;

  await getTestDb()
    .update(users)
    .set({ isPlatformAdmin: true })
    .where(eq(users.id, systemRow.id));

  await addOrgMembership(siteAUserRow.id, orgA.id, roleOrgA.id, [siteA1.id]);
  await addOrgMembership(unrestrictedRow.id, orgA.id, roleOrgA.id, null);
  await addOrgMembership(emptyRow.id, orgA.id, roleOrgA.id, []);
  await addOrgMembership(foreignRow.id, orgF.id, roleOrgF.id, null);

  // Partner principal: NO membership in Org A (fallback), a Site-B1 membership
  // in Org B, a permissionless membership in Org D, an empty set in Org E.
  await getTestDb().insert(partnerUsers).values({
    userId: partnerRow.id,
    partnerId: partner1.id,
    roleId: rolePartner.id,
    orgAccess: 'all',
  });
  await addOrgMembership(partnerRow.id, orgB.id, roleOrgB.id, [siteB1.id]);
  await addOrgMembership(partnerRow.id, orgD.id, roleOrgD.id, null);
  await addOrgMembership(partnerRow.id, orgE.id, roleOrgE.id, []);

  // A system-scope token still resolves RBAC through a real membership
  // (requirePermission reads partner/org axis); `accessibleOrgIds` stays null
  // and `is_platform_admin` is what makes the site axis unrestricted.
  await getTestDb().insert(partnerUsers).values({
    userId: systemRow.id,
    partnerId: partner1.id,
    roleId: rolePartner.id,
    orgAccess: 'all',
  });

  const deviceA1 = await seedDevice(orgA.id, siteA1.id, 'host-a1');
  const deviceA2 = await seedDevice(orgA.id, siteA2.id, 'host-a2');
  const deviceB1 = await seedDevice(orgB.id, siteB1.id, 'host-b1');
  const deviceB2 = await seedDevice(orgB.id, siteB2.id, 'host-b2');
  const deviceD1 = await seedDevice(orgD.id, siteD1.id, 'host-d1');
  const deviceE1 = await seedDevice(orgE.id, siteE1.id, 'host-e1');

  return {
    partner1: partner1.id,
    partner2: partner2.id,
    orgA: orgA.id,
    orgB: orgB.id,
    orgD: orgD.id,
    orgE: orgE.id,
    orgF: orgF.id,
    siteA1: siteA1.id,
    siteA2: siteA2.id,
    siteB1: siteB1.id,
    siteB2: siteB2.id,
    siteD1: siteD1.id,
    siteE1: siteE1.id,
    siteF1: siteF1.id,
    roleOrgA: roleOrgA.id,
    roleOrgB: roleOrgB.id,
    roleOrgD: roleOrgD.id,
    roleOrgE: roleOrgE.id,
    roleOrgF: roleOrgF.id,
    rolePartner: rolePartner.id,
    siteAUser: {
      id: siteAUserRow.id,
      email: siteAUserRow.email,
      token: await mintToken({
        userId: siteAUserRow.id,
        email: siteAUserRow.email,
        roleId: roleOrgA.id,
        orgId: orgA.id,
        partnerId: partner1.id,
        scope: 'organization',
      }),
    },
    unrestrictedUser: {
      id: unrestrictedRow.id,
      email: unrestrictedRow.email,
      token: await mintToken({
        userId: unrestrictedRow.id,
        email: unrestrictedRow.email,
        roleId: roleOrgA.id,
        orgId: orgA.id,
        partnerId: partner1.id,
        scope: 'organization',
      }),
    },
    emptyScopeUser: {
      id: emptyRow.id,
      email: emptyRow.email,
      token: await mintToken({
        userId: emptyRow.id,
        email: emptyRow.email,
        roleId: roleOrgA.id,
        orgId: orgA.id,
        partnerId: partner1.id,
        scope: 'organization',
      }),
    },
    partnerUser: {
      id: partnerRow.id,
      email: partnerRow.email,
      token: await mintToken({
        userId: partnerRow.id,
        email: partnerRow.email,
        roleId: rolePartner.id,
        orgId: null,
        partnerId: partner1.id,
        scope: 'partner',
      }),
    },
    systemUser: {
      id: systemRow.id,
      email: systemRow.email,
      token: await mintToken({
        userId: systemRow.id,
        email: systemRow.email,
        roleId: rolePartner.id,
        orgId: null,
        partnerId: partner1.id,
        scope: 'system',
      }),
    },
    foreignUser: {
      id: foreignRow.id,
      email: foreignRow.email,
      token: await mintToken({
        userId: foreignRow.id,
        email: foreignRow.email,
        roleId: roleOrgF.id,
        orgId: orgF.id,
        partnerId: partner2.id,
        scope: 'organization',
      }),
    },
    deviceA1,
    deviceA2,
    deviceB1,
    deviceB2,
    deviceD1,
    deviceE1,
  };
}

/** Minimal AuthContext for direct resolver assertions (only these fields are read). */
function fakeAuth(args: {
  userId: string;
  scope: 'organization' | 'partner' | 'system';
  orgId?: string | null;
  accessibleOrgIds: string[] | null;
}): AuthContext {
  return {
    user: { id: args.userId },
    scope: args.scope,
    orgId: args.orgId ?? null,
    accessibleOrgIds: args.accessibleOrgIds,
    canAccessOrg: (orgId: string) =>
      args.accessibleOrgIds === null || args.accessibleOrgIds.includes(orgId),
  } as unknown as AuthContext;
}

beforeEach(async () => {
  await clearPermissionCache();
  await ensureScopeShapeConstraints();
  emailProbe.calls = 0;
});

// ═══════════════════════════════════════════════════════════════════════════
// 1. Database-level tenant isolation
// ═══════════════════════════════════════════════════════════════════════════

describe('Wave 2 · forced RLS blocks cross-organization report forgery', () => {
  runDb('breeze_app cannot forge a report or run into another organization', async () => {
    const f = await buildFixture();
    const appDb = getAppDb();

    // Parent report in Org A, seeded as the superuser so it definitely exists.
    const reportA = await seedReport({
      orgId: f.orgA,
      name: 'A owned',
      scope: { kind: 'unrestricted', userId: f.unrestrictedUser.id },
    });

    // ── Positive control 1: the statement itself is valid (superuser insert). ──
    const okId = await scalar<string>(sql`
      INSERT INTO reports (org_id, name, type, config, schedule, format)
      VALUES (${f.orgA}::uuid, 'superuser control', 'device_inventory', '{}'::jsonb, 'one_time', 'csv')
      RETURNING id
    `);
    expect(okId).toBeTruthy();

    // ── Positive control 2: breeze_app CAN insert into its OWN organization. ──
    const selfInsert = await appDb.transaction(async (tx) => {
      await tx.execute(sql`select set_config('breeze.scope', 'organization', true)`);
      await tx.execute(sql`select set_config('breeze.org_id', ${f.orgB}, true)`);
      await tx.execute(sql`select set_config('breeze.accessible_org_ids', ${f.orgB}, true)`);
      const rows = await tx.execute(sql`
        INSERT INTO reports (org_id, name, type, config, schedule, format)
        VALUES (${f.orgB}::uuid, 'own org', 'device_inventory', '{}'::jsonb, 'one_time', 'csv')
        RETURNING id
      `);
      return rows as unknown as Array<{ id: string }>;
    });
    expect(selfInsert).toHaveLength(1);

    // ── The forge: Org B's context inserting an Org A row. ──
    let forgeError: unknown;
    try {
      await appDb.transaction(async (tx) => {
        await tx.execute(sql`select set_config('breeze.scope', 'organization', true)`);
        await tx.execute(sql`select set_config('breeze.org_id', ${f.orgB}, true)`);
        await tx.execute(sql`select set_config('breeze.accessible_org_ids', ${f.orgB}, true)`);
        await tx.execute(sql`
          INSERT INTO reports (org_id, name, type, config, schedule, format)
          VALUES (${f.orgA}::uuid, 'forged', 'device_inventory', '{}'::jsonb, 'one_time', 'csv')
        `);
      });
    } catch (err) {
      forgeError = err;
    }
    const forgeMessage =
      (forgeError as { cause?: { message?: string }; message?: string })?.cause?.message ??
      (forgeError as { message?: string })?.message ??
      '';
    expect(forgeMessage).toContain('new row violates row-level security policy');

    // ── Same for report_runs, whose policy joins through its parent report. ──
    let runForgeError: unknown;
    try {
      await appDb.transaction(async (tx) => {
        await tx.execute(sql`select set_config('breeze.scope', 'organization', true)`);
        await tx.execute(sql`select set_config('breeze.org_id', ${f.orgB}, true)`);
        await tx.execute(sql`select set_config('breeze.accessible_org_ids', ${f.orgB}, true)`);
        await tx.execute(sql`
          INSERT INTO report_runs (report_id, status)
          VALUES (${reportA}::uuid, 'pending')
        `);
      });
    } catch (err) {
      runForgeError = err;
    }
    const runForgeMessage =
      (runForgeError as { cause?: { message?: string }; message?: string })?.cause?.message ??
      (runForgeError as { message?: string })?.message ??
      '';
    expect(runForgeMessage).toContain('new row violates row-level security policy');

    // Positive control 3: the SAME run insert succeeds from Org A's context,
    // proving the rejection above was the policy and not a bad statement.
    const runOk = await appDb.transaction(async (tx) => {
      await tx.execute(sql`select set_config('breeze.scope', 'organization', true)`);
      await tx.execute(sql`select set_config('breeze.org_id', ${f.orgA}, true)`);
      await tx.execute(sql`select set_config('breeze.accessible_org_ids', ${f.orgA}, true)`);
      const rows = await tx.execute(sql`
        INSERT INTO report_runs (report_id, status)
        VALUES (${reportA}::uuid, 'pending')
        RETURNING id
      `);
      return rows as unknown as Array<{ id: string }>;
    });
    expect(runOk).toHaveLength(1);

    // Nothing forged actually landed.
    const forgedCount = await scalar<number>(sql`
      SELECT count(*)::int FROM reports WHERE name = 'forged'
    `);
    expect(forgedCount).toBe(0);
  });

  runDb('report_runs keeps its parent-join policy and both tables force RLS', async () => {
    const rows = await rawRows<{ relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean }>(sql`
      SELECT relname, relrowsecurity, relforcerowsecurity
        FROM pg_class WHERE relname IN ('reports', 'report_runs')
    `);
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.relrowsecurity).toBe(true);
      expect(row.relforcerowsecurity).toBe(true);
    }
    const runPolicies = await rawRows<{ policyname: string; qual: string | null; with_check: string | null }>(sql`
      SELECT policyname, qual, with_check FROM pg_policies WHERE tablename = 'report_runs'
    `);
    expect(runPolicies.length).toBeGreaterThanOrEqual(4);
    for (const policy of runPolicies) {
      const predicate = `${policy.qual ?? ''}${policy.with_check ?? ''}`;
      expect(predicate).toContain('FROM reports');
      expect(predicate).toContain('breeze_has_org_access');
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 2. Live authority resolution
// ═══════════════════════════════════════════════════════════════════════════

describe('Wave 2 · exact live report authority comes only from current state', () => {
  runDb('organization membership site_ids alone decides the site axis', async () => {
    const f = await buildFixture();

    const restricted = await resolveLiveReportAuthority(f.siteAUser.id, f.orgA, 'read');
    expect(restricted.ok).toBe(true);
    expect(restricted.ok && restricted.authority.scope).toEqual({
      version: 1,
      kind: 'restricted',
      orgId: f.orgA,
      siteIds: [f.siteA1],
    });

    const unrestricted = await resolveLiveReportAuthority(f.unrestrictedUser.id, f.orgA, 'read');
    expect(unrestricted.ok && unrestricted.authority.scope).toEqual({
      version: 1,
      kind: 'unrestricted',
      orgId: f.orgA,
    });

    const empty = await resolveLiveReportAuthority(f.emptyScopeUser.id, f.orgA, 'read');
    expect(empty).toEqual({ ok: false, reason: 'empty_scope' });

    // NULL and '{}' must stay distinguishable end to end.
    expect(unrestricted.ok && unrestricted.authority.fingerprint).not.toEqual(
      restricted.ok && restricted.authority.fingerprint,
    );
  });

  runDb('organization membership overrides broader partner authority', async () => {
    const f = await buildFixture();

    // Org A: no organization_users row -> partner fallback, unrestricted.
    const fallback = await resolveLiveReportAuthority(f.partnerUser.id, f.orgA, 'read');
    expect(fallback.ok && fallback.authority.scope).toEqual({
      version: 1,
      kind: 'unrestricted',
      orgId: f.orgA,
    });

    // Org B: organization_users row restricted to B1 wins over org_access='all'.
    const orgAxis = await resolveLiveReportAuthority(f.partnerUser.id, f.orgB, 'read');
    expect(orgAxis.ok && orgAxis.authority.scope).toEqual({
      version: 1,
      kind: 'restricted',
      orgId: f.orgB,
      siteIds: [f.siteB1],
    });

    // Org D: the membership role lacks reports:read; the partner role must NOT rescue it.
    const denied = await resolveLiveReportAuthority(f.partnerUser.id, f.orgD, 'read');
    expect(denied).toEqual({ ok: false, reason: 'permission_removed' });

    // Org E: membership with an empty site set.
    const emptySet = await resolveLiveReportAuthority(f.partnerUser.id, f.orgE, 'read');
    expect(emptySet).toEqual({ ok: false, reason: 'empty_scope' });

    // Org F belongs to another partner entirely.
    const foreign = await resolveLiveReportAuthority(f.partnerUser.id, f.orgF, 'read');
    expect(foreign.ok).toBe(false);
  });

  runDb('system (platform-admin) authority is unrestricted; a removed user is denied', async () => {
    const f = await buildFixture();

    const system = await resolveLiveReportAuthority(f.systemUser.id, f.orgB, 'read');
    expect(system.ok && system.authority.scope).toEqual({
      version: 1,
      kind: 'unrestricted',
      orgId: f.orgB,
    });

    await getTestDb()
      .update(users)
      .set({ status: 'disabled' })
      .where(eq(users.id, f.siteAUser.id));
    expect(await resolveLiveReportAuthority(f.siteAUser.id, f.orgA, 'read')).toEqual({
      ok: false,
      reason: 'user_inactive',
    });
  });

  runDb('roles are a permission source only — no role table carries site IDs', async () => {
    const f = await buildFixture();

    const roleSiteColumns = await rawRows<{ table_name: string; column_name: string }>(sql`
      SELECT table_name, column_name FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name IN ('roles', 'role_permissions', 'permissions')
         AND column_name ILIKE '%site%'
    `);
    expect(roleSiteColumns).toEqual([]);

    // The role IS the permission source: revoking reports:read denies outright…
    await getTestDb().execute(sql`
      DELETE FROM role_permissions rp
       USING permissions p
       WHERE rp.permission_id = p.id
         AND rp.role_id = ${f.roleOrgA}::uuid
         AND p.resource = 'reports' AND p.action = 'read'
    `);
    expect(await resolveLiveReportAuthority(f.siteAUser.id, f.orgA, 'read')).toEqual({
      ok: false,
      reason: 'permission_removed',
    });

    // …but it never supplies site IDs: restoring it returns the SAME site set.
    await grantRolePermissions(f.roleOrgA, [{ resource: 'reports', action: 'read' }]);
    await grantRolePermissions(f.roleOrgA, [{ resource: 'devices', action: 'write' }]);
    const afterRoleChange = await resolveLiveReportAuthority(f.siteAUser.id, f.orgA, 'read');
    expect(afterRoleChange.ok && afterRoleChange.authority.scope).toEqual({
      version: 1,
      kind: 'restricted',
      orgId: f.orgA,
      siteIds: [f.siteA1],
    });

    // …only organization_users.site_ids can.
    await getTestDb()
      .update(organizationUsers)
      .set({ siteIds: null })
      .where(and(eq(organizationUsers.userId, f.siteAUser.id), eq(organizationUsers.orgId, f.orgA)));
    const afterSiteChange = await resolveLiveReportAuthority(f.siteAUser.id, f.orgA, 'read');
    expect(afterSiteChange.ok && afterSiteChange.authority.scope).toEqual({
      version: 1,
      kind: 'unrestricted',
      orgId: f.orgA,
    });
  });

  runDb('resolveRequestReportAuthorityMap answers per organization, never reusing one decision', async () => {
    const f = await buildFixture();
    const auth = fakeAuth({
      userId: f.partnerUser.id,
      scope: 'partner',
      accessibleOrgIds: [f.orgA, f.orgB, f.orgD, f.orgE],
    });

    const map = await resolveRequestReportAuthorityMap(
      auth,
      [f.orgA, f.orgB, f.orgD, f.orgE, f.orgF],
      'read',
    );

    expect(map.get(f.orgA)).toMatchObject({ ok: true });
    expect((map.get(f.orgA) as { authority: { scope: unknown } }).authority.scope).toEqual({
      version: 1,
      kind: 'unrestricted',
      orgId: f.orgA,
    });
    expect((map.get(f.orgB) as { authority: { scope: unknown } }).authority.scope).toEqual({
      version: 1,
      kind: 'restricted',
      orgId: f.orgB,
      siteIds: [f.siteB1],
    });
    expect(map.get(f.orgD)).toEqual({ ok: false, reason: 'permission_removed' });
    expect(map.get(f.orgE)).toEqual({ ok: false, reason: 'empty_scope' });
    expect(map.get(f.orgF)).toEqual({ ok: false, reason: 'organization_inaccessible' });

    // An org token can never widen to another organization.
    const orgAuth = fakeAuth({
      userId: f.siteAUser.id,
      scope: 'organization',
      orgId: f.orgA,
      accessibleOrgIds: [f.orgA],
    });
    expect(await resolveRequestReportAuthority(orgAuth, f.orgB, 'read')).toEqual({
      ok: false,
      reason: 'organization_inaccessible',
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 3. Definition lists / templates / known-ID parity (exact organization)
// ═══════════════════════════════════════════════════════════════════════════

async function seedDefinitionMatrix(f: Fixture) {
  const base = Date.parse('2026-07-20T12:00:00.000Z');
  const at = (minutes: number) => new Date(base - minutes * 60_000);

  const visible: string[] = [];
  for (let i = 0; i < 5; i += 1) {
    visible.push(
      await seedReport({
        orgId: f.orgA,
        name: `visible-a1-${i}`,
        scope: { kind: 'restricted', userId: f.siteAUser.id, siteIds: [f.siteA1] },
        createdBy: f.siteAUser.id,
        updatedAt: at(i),
      }),
    );
  }

  const hidden = {
    otherSite: await seedReport({
      orgId: f.orgA,
      name: 'hidden-a2',
      scope: { kind: 'restricted', userId: f.unrestrictedUser.id, siteIds: [f.siteA2] },
      createdBy: f.unrestrictedUser.id,
      updatedAt: at(10),
    }),
    unrestricted: await seedReport({
      orgId: f.orgA,
      name: 'hidden-unrestricted',
      scope: { kind: 'unrestricted', userId: f.unrestrictedUser.id },
      createdBy: f.unrestrictedUser.id,
      updatedAt: at(11),
    }),
    legacy: await seedReport({
      orgId: f.orgA,
      name: 'hidden-legacy',
      scope: { kind: 'legacy', userId: f.unrestrictedUser.id },
      createdBy: f.unrestrictedUser.id,
      updatedAt: at(12),
    }),
    oldWriter: await seedReport({
      orgId: f.orgA,
      name: 'hidden-old-writer',
      scope: { kind: 'null' },
      createdBy: f.unrestrictedUser.id,
      updatedAt: at(13),
    }),
    superset: await seedReport({
      orgId: f.orgA,
      name: 'hidden-superset',
      scope: {
        kind: 'restricted',
        userId: f.unrestrictedUser.id,
        siteIds: [f.siteA1, f.siteA2],
      },
      createdBy: f.unrestrictedUser.id,
      updatedAt: at(14),
    }),
    otherOrg: await seedReport({
      orgId: f.orgB,
      name: 'hidden-org-b',
      scope: { kind: 'restricted', userId: f.partnerUser.id, siteIds: [f.siteB1] },
      createdBy: f.partnerUser.id,
      updatedAt: at(15),
    }),
  };

  return { visible, hidden };
}

describe('Wave 2 · definition + template pages report exact visible totals', () => {
  runDb('restricted caller sees 2/2/1 pages with total=5 on main and template lists', async () => {
    const f = await buildFixture();
    const { visible, hidden } = await seedDefinitionMatrix(f);
    const app = buildApp();

    // Non-vacuity: a pre-wave, org-only predicate reaches every Org A row.
    const orgOnlyCount = await scalar<number>(
      sql`SELECT count(*)::int FROM reports WHERE org_id = ${f.orgA}::uuid`,
    );
    expect(orgOnlyCount).toBe(10);

    for (const listPath of ['/reports', '/reports/templates']) {
      const seen: string[] = [];
      for (const [page, expected] of [[1, 2], [2, 2], [3, 1]] as const) {
        const res = await app.request(
          `${listPath}?limit=2&page=${page}`,
          authed(f.siteAUser.token),
        );
        expect(res.status).toBe(200);
        const body = (await res.json()) as {
          data: Array<{ id: string }>;
          pagination: { total: number };
        };
        expect(body.data).toHaveLength(expected);
        expect(body.pagination.total).toBe(5);
        seen.push(...body.data.map((row) => row.id));
      }
      expect(new Set(seen)).toEqual(new Set(visible));
      for (const hiddenId of Object.values(hidden)) {
        expect(seen).not.toContain(hiddenId);
      }
      // Page 4 is empty but still reports the same total — no scope oracle.
      const page4 = await app.request(`${listPath}?limit=2&page=4`, authed(f.siteAUser.token));
      const page4Body = (await page4.json()) as {
        data: unknown[];
        pagination: { total: number };
      };
      expect(page4Body.data).toHaveLength(0);
      expect(page4Body.pagination.total).toBe(5);
    }
  });

  runDb('hidden definition UUIDs are indistinguishable from nonexistent ones', async () => {
    const f = await buildFixture();
    const { hidden } = await seedDefinitionMatrix(f);
    const app = buildApp();
    const token = f.siteAUser.token;
    const ghost = randomUUID();

    const probes: Array<[string, () => Response | Promise<Response>]> = [];
    for (const [label, id] of [
      ['hidden-other-site', hidden.otherSite],
      ['hidden-unrestricted', hidden.unrestricted],
      ['hidden-legacy', hidden.legacy],
      ['hidden-old-writer', hidden.oldWriter],
      ['hidden-superset', hidden.superset],
      ['hidden-other-org', hidden.otherOrg],
      ['nonexistent', ghost],
    ] as const) {
      probes.push([`GET ${label}`, () => app.request(`/reports/${id}`, authed(token))]);
      probes.push([
        `PUT ${label}`,
        () =>
          app.request(
            `/reports/${id}`,
            authed(token, { method: 'PUT', body: JSON.stringify({ name: 'pwn' }) }),
          ),
      ]);
      probes.push([
        `POST reauthorize ${label}`,
        () => app.request(`/reports/${id}/reauthorize`, authed(token, { method: 'POST' })),
      ]);
      probes.push([
        `DELETE ${label}`,
        () => app.request(`/reports/${id}`, authed(token, { method: 'DELETE' })),
      ]);
    }

    const observed: Array<[string, number, string]> = [];
    for (const [label, run] of probes) {
      const res = await run();
      observed.push([label, res.status, await res.text()]);
    }

    const distinct = new Set(observed.map(([, status, body]) => `${status}|${body}`));
    expect([...distinct]).toEqual(['404|{"error":"Report not found"}']);
  });

  runDb('deleting a hidden definition mutates neither reports nor report_runs', async () => {
    const f = await buildFixture();
    const { hidden } = await seedDefinitionMatrix(f);
    const app = buildApp();

    const hiddenRunA = await seedRun({
      reportId: hidden.otherSite,
      orgId: f.orgA,
      scope: { kind: 'restricted', userId: f.unrestrictedUser.id, siteIds: [f.siteA2] },
    });
    const hiddenRunB = await seedRun({
      reportId: hidden.unrestricted,
      orgId: f.orgA,
      scope: { kind: 'unrestricted', userId: f.unrestrictedUser.id },
    });

    const beforeReports = await scalar<number>(sql`SELECT count(*)::int FROM reports`);
    const beforeRuns = await scalar<number>(sql`SELECT count(*)::int FROM report_runs`);
    const beforeUpdatedAt = await rawRows<{ id: string; updated_at: Date }>(
      sql`SELECT id, updated_at FROM reports ORDER BY id`,
    );

    for (const id of Object.values(hidden)) {
      const res = await app.request(`/reports/${id}`, authed(f.siteAUser.token, { method: 'DELETE' }));
      expect(res.status).toBe(404);
    }

    expect(await scalar<number>(sql`SELECT count(*)::int FROM reports`)).toBe(beforeReports);
    expect(await scalar<number>(sql`SELECT count(*)::int FROM report_runs`)).toBe(beforeRuns);
    const afterUpdatedAt = await rawRows<{ id: string; updated_at: Date }>(
      sql`SELECT id, updated_at FROM reports ORDER BY id`,
    );
    expect(JSON.stringify(afterUpdatedAt)).toEqual(JSON.stringify(beforeUpdatedAt));
    expect(
      await scalar<number>(
        sql`SELECT count(*)::int FROM report_runs WHERE id IN (${hiddenRunA}::uuid, ${hiddenRunB}::uuid)`,
      ),
    ).toBe(2);
  });

  runDb('a denied known-ID read never selects the definition config payload', async () => {
    const f = await buildFixture();
    const { visible, hidden } = await seedDefinitionMatrix(f);
    const app = buildApp();

    await withoutSelectPrivilege(
      'reports',
      async () => {
        // Denied path: must still be a clean 404 — it never reads `config`.
        const denied = await app.request(
          `/reports/${hidden.otherSite}`,
          authed(f.siteAUser.token),
        );
        expect(denied.status).toBe(404);
        expect(await denied.json()).toEqual({ error: 'Report not found' });

        // Positive control: the AUTHORIZED path does read `config`, so with the
        // column revoked it fails loudly. This proves the revoke actually bites.
        const authorized = await app.request(`/reports/${visible[0]}`, authed(f.siteAUser.token));
        expect(authorized.status).toBeGreaterThanOrEqual(500);
      },
      'config',
    );
  });

  runDb('an unrestricted caller still sees legacy and old-writer definitions', async () => {
    const f = await buildFixture();
    const { visible, hidden } = await seedDefinitionMatrix(f);
    const app = buildApp();

    const res = await app.request('/reports?limit=100', authed(f.unrestrictedUser.token));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: Array<{ id: string }>; pagination: { total: number } };
    const ids = body.data.map((row) => row.id);
    expect(body.pagination.total).toBe(10);
    for (const id of visible) expect(ids).toContain(id);
    expect(ids).toContain(hidden.legacy);
    expect(ids).toContain(hidden.oldWriter);
    expect(ids).toContain(hidden.unrestricted);
    expect(ids).toContain(hidden.superset);
    expect(ids).not.toContain(hidden.otherOrg);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 4. Partner / system multi-organization definition + template lists
// ═══════════════════════════════════════════════════════════════════════════

describe('Wave 2 · partner and system multi-organization definition lists', () => {
  runDb('partner list without orgId applies one per-organization composite predicate', async () => {
    const f = await buildFixture();
    const base = Date.parse('2026-07-20T12:00:00.000Z');
    const at = (m: number) => new Date(base - m * 60_000);

    // Three Org A definitions — visible through unrestricted partner fallback.
    const a1 = await seedReport({ orgId: f.orgA, name: 'a-unres', scope: { kind: 'unrestricted', userId: f.unrestrictedUser.id }, updatedAt: at(0) });
    const a2 = await seedReport({ orgId: f.orgA, name: 'a-restricted', scope: { kind: 'restricted', userId: f.siteAUser.id, siteIds: [f.siteA1] }, updatedAt: at(1) });
    const a3 = await seedReport({ orgId: f.orgA, name: 'a-legacy', scope: { kind: 'legacy', userId: f.unrestrictedUser.id }, updatedAt: at(2) });
    // Two Org B definitions restricted to B1 — visible through the B1 membership.
    const b1 = await seedReport({ orgId: f.orgB, name: 'b1-one', scope: { kind: 'restricted', userId: f.partnerUser.id, siteIds: [f.siteB1] }, updatedAt: at(3) });
    const b2 = await seedReport({ orgId: f.orgB, name: 'b1-two', scope: { kind: 'restricted', userId: f.partnerUser.id, siteIds: [f.siteB1] }, updatedAt: at(4) });

    // Everything below must be absent.
    const excluded = {
      bSiteB2: await seedReport({ orgId: f.orgB, name: 'b2', scope: { kind: 'restricted', userId: f.partnerUser.id, siteIds: [f.siteB2] }, updatedAt: at(5) }),
      bUnrestricted: await seedReport({ orgId: f.orgB, name: 'b-unres', scope: { kind: 'unrestricted', userId: f.partnerUser.id }, updatedAt: at(6) }),
      bLegacy: await seedReport({ orgId: f.orgB, name: 'b-legacy', scope: { kind: 'legacy', userId: f.partnerUser.id }, updatedAt: at(7) }),
      bOldWriter: await seedReport({ orgId: f.orgB, name: 'b-null', scope: { kind: 'null' }, updatedAt: at(8) }),
      dDenied: await seedReport({ orgId: f.orgD, name: 'd-denied', scope: { kind: 'unrestricted', userId: f.partnerUser.id }, updatedAt: at(9) }),
      eEmpty: await seedReport({ orgId: f.orgE, name: 'e-empty', scope: { kind: 'unrestricted', userId: f.partnerUser.id }, updatedAt: at(10) }),
      fForeign: await seedReport({ orgId: f.orgF, name: 'f-foreign', scope: { kind: 'unrestricted', userId: f.foreignUser.id }, updatedAt: at(11) }),
    };

    const app = buildApp();
    const expectedVisible = new Set([a1, a2, a3, b1, b2]);

    for (const listPath of ['/reports', '/reports/templates']) {
      const seen: string[] = [];
      for (const [page, count] of [[1, 2], [2, 2], [3, 1]] as const) {
        const res = await app.request(
          `${listPath}?limit=2&page=${page}`,
          authed(f.partnerUser.token),
        );
        expect(res.status).toBe(200);
        const body = (await res.json()) as {
          data: Array<{ id: string }>;
          pagination: { total: number };
        };
        expect(body.data).toHaveLength(count);
        expect(body.pagination.total).toBe(5);
        seen.push(...body.data.map((row) => row.id));
      }
      expect(new Set(seen)).toEqual(expectedVisible);
      for (const id of Object.values(excluded)) expect(seen).not.toContain(id);
    }

    // An explicit orgId derives ONE membership-first scope: Org B's B1 membership
    // beats the partner fallback even though the caller is a partner principal.
    const explicitB = await app.request(
      `/reports?limit=100&orgId=${f.orgB}`,
      authed(f.partnerUser.token),
    );
    const explicitBody = (await explicitB.json()) as {
      data: Array<{ id: string }>;
      pagination: { total: number };
    };
    expect(explicitBody.pagination.total).toBe(2);
    expect(new Set(explicitBody.data.map((r) => r.id))).toEqual(new Set([b1, b2]));

    // Denied and inaccessible organizations 403 rather than silently widening.
    expect((await app.request(`/reports?orgId=${f.orgD}`, authed(f.partnerUser.token))).status).toBe(403);
    expect((await app.request(`/reports?orgId=${f.orgE}`, authed(f.partnerUser.token))).status).toBe(403);
    expect((await app.request(`/reports?orgId=${f.orgF}`, authed(f.partnerUser.token))).status).toBe(403);
  });

  runDb('system list without orgId uses the unrestricted predicate and excludes malformed rows', async () => {
    const f = await buildFixture();
    const base = Date.parse('2026-07-20T12:00:00.000Z');
    const at = (m: number) => new Date(base - m * 60_000);

    const visible = [
      await seedReport({ orgId: f.orgA, name: 's-a-unres', scope: { kind: 'unrestricted', userId: f.unrestrictedUser.id }, updatedAt: at(0) }),
      await seedReport({ orgId: f.orgA, name: 's-a-restricted', scope: { kind: 'restricted', userId: f.siteAUser.id, siteIds: [f.siteA1] }, updatedAt: at(1) }),
      await seedReport({ orgId: f.orgB, name: 's-b-legacy', scope: { kind: 'legacy', userId: f.partnerUser.id }, updatedAt: at(2) }),
      await seedReport({ orgId: f.orgB, name: 's-b-null', scope: { kind: 'null' }, updatedAt: at(3) }),
      await seedReport({ orgId: f.orgF, name: 's-f-unres', scope: { kind: 'unrestricted', userId: f.foreignUser.id }, updatedAt: at(4) }),
    ];

    const app = buildApp();

    // The migration's CHECK constraint is the first line of defence: a malformed
    // provenance row cannot even be written while it is in place.
    await expect(
      getTestDb().execute(sql`
        INSERT INTO reports (org_id, name, type, execution_scope_version, execution_scope_kind,
                             execution_scope_fingerprint, execution_scope_captured_at, execution_scope_user_id)
        VALUES (${f.orgA}::uuid, 'bad-version', 'device_inventory', 2, 'unrestricted',
                repeat('a', 64), now(), ${f.siteAUser.id}::uuid)
      `),
    ).rejects.toThrow();

    // Drop it to exercise the SQL predicate's own rejection of malformed rows
    // (defence in depth for a database restored without the constraint).
    await withoutScopeShapeConstraints(async () => {
      const malformed = [
        await scalar<string>(sql`
          INSERT INTO reports (org_id, name, type, execution_scope_version, execution_scope_kind,
                               execution_scope_fingerprint, execution_scope_captured_at, execution_scope_user_id, updated_at)
          VALUES (${f.orgA}::uuid, 'malformed-v2', 'device_inventory', 2, 'unrestricted',
                  repeat('a', 64), now(), ${f.siteAUser.id}::uuid, ${naiveUtc(at(5))}::timestamp)
          RETURNING id
        `),
        await scalar<string>(sql`
          INSERT INTO reports (org_id, name, type, execution_scope_version, execution_scope_kind,
                               execution_scope_site_ids, execution_scope_fingerprint,
                               execution_scope_captured_at, execution_scope_user_id, updated_at)
          VALUES (${f.orgB}::uuid, 'malformed-partial', 'device_inventory', 1, 'restricted',
                  NULL, repeat('b', 64), now(), ${f.partnerUser.id}::uuid, ${naiveUtc(at(6))}::timestamp)
          RETURNING id
        `),
      ];

      const totalRows = await scalar<number>(sql`SELECT count(*)::int FROM reports`);
      expect(totalRows).toBe(7);

      const seen: string[] = [];
      for (const [page, count] of [[1, 2], [2, 2], [3, 1]] as const) {
        const res = await app.request(
          `/reports?limit=2&page=${page}`,
          authed(f.systemUser.token),
        );
        expect(res.status).toBe(200);
        const body = (await res.json()) as {
          data: Array<{ id: string }>;
          pagination: { total: number };
        };
        expect(body.data).toHaveLength(count);
        expect(body.pagination.total).toBe(5);
        seen.push(...body.data.map((r) => r.id));
      }
      expect(new Set(seen)).toEqual(new Set(visible));
      for (const id of malformed) expect(seen).not.toContain(id);

      // Same shape on the template list.
      const templates = await app.request('/reports/templates?limit=2&page=1', authed(f.systemUser.token));
      const templateBody = (await templates.json()) as { pagination: { total: number } };
      expect(templateBody.pagination.total).toBe(5);
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 5. Run visibility, pagination, download, baselines
// ═══════════════════════════════════════════════════════════════════════════

async function seedRunMatrix(f: Fixture) {
  const parent = await seedReport({
    orgId: f.orgA,
    name: 'run-parent',
    scope: { kind: 'restricted', userId: f.siteAUser.id, siteIds: [f.siteA1] },
    createdBy: f.siteAUser.id,
  });
  const base = Date.parse('2026-07-20T12:00:00.000Z');
  const at = (m: number) => new Date(base - m * 60_000);

  const visible: string[] = [];
  const hidden: string[] = [];
  // Interleave visible A1 runs with hidden ones so a naive limit/offset over an
  // unfiltered set would slice the wrong rows.
  for (let i = 0; i < 5; i += 1) {
    visible.push(
      await seedRun({
        reportId: parent,
        orgId: f.orgA,
        scope: { kind: 'restricted', userId: f.siteAUser.id, siteIds: [f.siteA1] },
        createdAt: at(i * 2),
        result: { rows: [{ hostname: 'host-a1' }], rowCount: 1, summary: { marker: `v${i}` } },
      }),
    );
    hidden.push(
      await seedRun({
        reportId: parent,
        orgId: f.orgA,
        scope: { kind: 'restricted', userId: f.unrestrictedUser.id, siteIds: [f.siteA2] },
        createdAt: at(i * 2 + 1),
        result: { rows: [{ hostname: 'host-a2-SECRET' }], rowCount: 1 },
      }),
    );
  }
  hidden.push(
    await seedRun({
      reportId: parent,
      orgId: f.orgA,
      scope: { kind: 'unrestricted', userId: f.unrestrictedUser.id },
      createdAt: at(20),
      result: { rows: [{ hostname: 'ORG-WIDE-SECRET' }], rowCount: 1 },
    }),
    await seedRun({
      reportId: parent,
      orgId: f.orgA,
      scope: { kind: 'legacy', userId: f.unrestrictedUser.id },
      createdAt: at(21),
      result: { rows: [{ hostname: 'LEGACY-SECRET' }], rowCount: 1 },
    }),
    await seedRun({
      reportId: parent,
      orgId: f.orgA,
      scope: { kind: 'null' },
      createdAt: at(22),
      result: { rows: [{ hostname: 'OLD-WRITER-SECRET' }], rowCount: 1 },
    }),
  );

  return { parent, visible, hidden };
}

describe('Wave 2 · run lists, known-ID access, downloads, and baselines', () => {
  runDb('five visible runs interleaved with hidden runs page 2/2/1 with total=5', async () => {
    const f = await buildFixture();
    const { visible, hidden } = await seedRunMatrix(f);
    const app = buildApp();

    // Non-vacuity: the pre-wave, org-only join reaches all 13 rows.
    const orgOnly = await scalar<number>(sql`
      SELECT count(*)::int FROM report_runs r
        JOIN reports p ON p.id = r.report_id
       WHERE p.org_id = ${f.orgA}::uuid
    `);
    expect(orgOnly).toBe(13);

    const seen: string[] = [];
    for (const [page, count] of [[1, 2], [2, 2], [3, 1]] as const) {
      const res = await app.request(`/reports/runs?limit=2&page=${page}`, authed(f.siteAUser.token));
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        data: Array<{ id: string }>;
        pagination: { total: number };
      };
      expect(body.data).toHaveLength(count);
      expect(body.pagination.total).toBe(5);
      seen.push(...body.data.map((r) => r.id));
    }
    expect(new Set(seen)).toEqual(new Set(visible));
    for (const id of hidden) expect(seen).not.toContain(id);
  });

  runDb('a Site A caller cannot fetch or download a Site B / hidden run by UUID', async () => {
    const f = await buildFixture();
    const { visible, hidden } = await seedRunMatrix(f);

    // A run in a different organization entirely.
    const orgBReport = await seedReport({
      orgId: f.orgB,
      name: 'b-parent',
      scope: { kind: 'restricted', userId: f.partnerUser.id, siteIds: [f.siteB1] },
    });
    const orgBRun = await seedRun({
      reportId: orgBReport,
      orgId: f.orgB,
      scope: { kind: 'restricted', userId: f.partnerUser.id, siteIds: [f.siteB1] },
      result: { rows: [{ hostname: 'host-b1-SECRET' }], rowCount: 1 },
    });

    const app = buildApp();
    const ghost = randomUUID();
    const bodies = new Set<string>();
    for (const id of [...hidden, orgBRun, ghost]) {
      const detail = await app.request(`/reports/runs/${id}`, authed(f.siteAUser.token));
      expect(detail.status).toBe(404);
      bodies.add(`${detail.status}|${await detail.text()}`);
      const download = await app.request(
        `/reports/runs/${id}/download`,
        authed(f.siteAUser.token),
      );
      expect(download.status).toBe(404);
      bodies.add(`${download.status}|${await download.text()}`);
    }
    expect([...bodies]).toEqual(['404|{"error":"Report run not found"}']);

    // Positive control: an authorized run downloads fine and never contains
    // another site's row content.
    const ok = await app.request(`/reports/runs/${visible[0]}/download`, authed(f.siteAUser.token));
    expect(ok.status).toBe(200);
    const csv = await ok.text();
    expect(csv).toContain('host-a1');
    expect(csv).not.toContain('SECRET');
  });

  runDb('a denied run fetch/download never selects the stored result payload', async () => {
    const f = await buildFixture();
    const { visible, hidden } = await seedRunMatrix(f);
    const app = buildApp();

    await withoutSelectPrivilege(
      'report_runs',
      async () => {
        for (const id of hidden) {
          const detail = await app.request(`/reports/runs/${id}`, authed(f.siteAUser.token));
          expect(detail.status).toBe(404);
          const download = await app.request(
            `/reports/runs/${id}/download`,
            authed(f.siteAUser.token),
          );
          expect(download.status).toBe(404);
        }
        // Positive control: the authorized download DOES read `result`, so with
        // the column revoked it must fail — proving the revoke is effective.
        const authorized = await app.request(
          `/reports/runs/${visible[0]}/download`,
          authed(f.siteAUser.token),
        );
        expect(authorized.status).toBeGreaterThanOrEqual(500);
      },
      'result',
    );
  });

  runDb('baseline lookup never crosses scope fingerprints', async () => {
    const f = await buildFixture();
    const parent = await seedReport({
      orgId: f.orgA,
      name: 'baseline-parent',
      scope: { kind: 'restricted', userId: f.siteAUser.id, siteIds: [f.siteA1] },
      createdBy: f.siteAUser.id,
    });

    // Older run with the CALLER's fingerprint; newer run with a foreign one.
    await seedRun({
      reportId: parent,
      orgId: f.orgA,
      scope: { kind: 'restricted', userId: f.siteAUser.id, siteIds: [f.siteA1] },
      createdAt: new Date('2026-07-01T00:00:00.000Z'),
      result: { rows: [], rowCount: 0, summary: { marker: 'A1-BASELINE' }, generatedAt: '2026-07-01T00:00:00.000Z' },
    });
    await seedRun({
      reportId: parent,
      orgId: f.orgA,
      scope: { kind: 'restricted', userId: f.unrestrictedUser.id, siteIds: [f.siteA2] },
      createdAt: new Date('2026-07-10T00:00:00.000Z'),
      result: { rows: [], rowCount: 0, summary: { marker: 'A2-BASELINE' }, generatedAt: '2026-07-10T00:00:00.000Z' },
    });

    // The newest completed run overall is the A2 one — a fingerprint-blind
    // lookup would return it.
    const newestOverall = await scalar<string>(sql`
      SELECT (result->'summary'->>'marker') FROM report_runs
       WHERE report_id = ${parent}::uuid AND status = 'completed'
       ORDER BY completed_at DESC LIMIT 1
    `);
    expect(newestOverall).toBe('A2-BASELINE');

    const app = buildApp();
    const res = await app.request(
      `/reports/${parent}/generate`,
      authed(f.siteAUser.token, { method: 'POST' }),
    );
    expect(res.status).toBe(200);
    const { runId } = (await res.json()) as { runId: string };

    const marker = await scalar<string | null>(sql`
      SELECT (result->'previous'->'summary'->>'marker') FROM report_runs WHERE id = ${runId}::uuid
    `);
    expect(marker).toBe('A1-BASELINE');

    // And direct service-level proof for the same invariant.
    const a2Fingerprint = siteScopeFingerprint({
      version: 1,
      kind: 'restricted',
      orgId: f.orgA,
      siteIds: [f.siteA2],
    });
    await withSystemDbAccessContext(async () => {
      const a2Baseline = await previousBaselineFor(parent, a2Fingerprint);
      expect(a2Baseline?.summary?.marker).toBe('A2-BASELINE');
    });
  });

  runDb('generated run output and download contain only the caller\'s site', async () => {
    const f = await buildFixture();
    const parent = await seedReport({
      orgId: f.orgA,
      name: 'gen-parent',
      scope: { kind: 'restricted', userId: f.siteAUser.id, siteIds: [f.siteA1] },
      createdBy: f.siteAUser.id,
    });
    const app = buildApp();

    const res = await app.request(
      `/reports/${parent}/generate`,
      authed(f.siteAUser.token, { method: 'POST' }),
    );
    expect(res.status).toBe(200);
    const { runId } = (await res.json()) as { runId: string };

    const stored = await rawRows<{ kind: string; site_ids: string[]; result: { rows: Array<{ hostname: string }> } }>(sql`
      SELECT execution_scope_kind AS kind, execution_scope_site_ids AS site_ids, result
        FROM report_runs WHERE id = ${runId}::uuid
    `);
    expect(stored[0]!.kind).toBe('restricted');
    expect(stored[0]!.site_ids).toEqual([f.siteA1]);
    const hostnames = stored[0]!.result.rows.map((r) => r.hostname);
    expect(hostnames).toEqual(['host-a1']);

    const download = await app.request(`/reports/runs/${runId}/download`, authed(f.siteAUser.token));
    expect(download.status).toBe(200);
    const csv = await download.text();
    expect(csv).toContain('host-a1');
    expect(csv).not.toContain('host-a2');
  });

  runDb('unrestricted creation, execution, and download remain unchanged', async () => {
    const f = await buildFixture();
    const app = buildApp();

    const created = await app.request(
      '/reports',
      authed(f.unrestrictedUser.token, {
        method: 'POST',
        body: JSON.stringify({ name: 'unrestricted report', type: 'device_inventory' }),
      }),
    );
    expect(created.status).toBe(201);
    const definition = (await created.json()) as {
      id: string;
      executionScopeKind: string;
      executionScopeSiteIds: string[] | null;
      executionScopeUserId: string;
    };
    expect(definition.executionScopeKind).toBe('unrestricted');
    expect(definition.executionScopeSiteIds).toBeNull();
    expect(definition.executionScopeUserId).toBe(f.unrestrictedUser.id);

    const generated = await app.request(
      `/reports/${definition.id}/generate`,
      authed(f.unrestrictedUser.token, { method: 'POST' }),
    );
    expect(generated.status).toBe(200);
    const { runId } = (await generated.json()) as { runId: string };

    const download = await app.request(
      `/reports/runs/${runId}/download`,
      authed(f.unrestrictedUser.token),
    );
    expect(download.status).toBe(200);
    const csv = await download.text();
    expect(csv).toContain('host-a1');
    expect(csv).toContain('host-a2');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 6. Partner / system multi-organization run lists
// ═══════════════════════════════════════════════════════════════════════════

describe('Wave 2 · partner and system multi-organization run lists', () => {
  runDb('partner run list without orgId uses the per-organization composite', async () => {
    const f = await buildFixture();
    const base = Date.parse('2026-07-20T12:00:00.000Z');
    const at = (m: number) => new Date(base - m * 60_000);

    const parentA = await seedReport({ orgId: f.orgA, name: 'pa', scope: { kind: 'unrestricted', userId: f.unrestrictedUser.id } });
    const parentB = await seedReport({ orgId: f.orgB, name: 'pb', scope: { kind: 'restricted', userId: f.partnerUser.id, siteIds: [f.siteB1] } });
    const parentD = await seedReport({ orgId: f.orgD, name: 'pd', scope: { kind: 'unrestricted', userId: f.partnerUser.id } });
    const parentE = await seedReport({ orgId: f.orgE, name: 'pe', scope: { kind: 'unrestricted', userId: f.partnerUser.id } });
    const parentF = await seedReport({ orgId: f.orgF, name: 'pf', scope: { kind: 'unrestricted', userId: f.foreignUser.id } });

    const visible = [
      await seedRun({ reportId: parentA, orgId: f.orgA, scope: { kind: 'unrestricted', userId: f.unrestrictedUser.id }, createdAt: at(0) }),
      await seedRun({ reportId: parentA, orgId: f.orgA, scope: { kind: 'restricted', userId: f.siteAUser.id, siteIds: [f.siteA1] }, createdAt: at(1) }),
      await seedRun({ reportId: parentA, orgId: f.orgA, scope: { kind: 'legacy', userId: f.unrestrictedUser.id }, createdAt: at(2) }),
      await seedRun({ reportId: parentB, orgId: f.orgB, scope: { kind: 'restricted', userId: f.partnerUser.id, siteIds: [f.siteB1] }, createdAt: at(3) }),
      await seedRun({ reportId: parentB, orgId: f.orgB, scope: { kind: 'restricted', userId: f.partnerUser.id, siteIds: [f.siteB1] }, createdAt: at(4) }),
    ];
    const excluded = [
      await seedRun({ reportId: parentB, orgId: f.orgB, scope: { kind: 'restricted', userId: f.partnerUser.id, siteIds: [f.siteB2] }, createdAt: at(5) }),
      await seedRun({ reportId: parentB, orgId: f.orgB, scope: { kind: 'unrestricted', userId: f.partnerUser.id }, createdAt: at(6) }),
      await seedRun({ reportId: parentB, orgId: f.orgB, scope: { kind: 'legacy', userId: f.partnerUser.id }, createdAt: at(7) }),
      await seedRun({ reportId: parentB, orgId: f.orgB, scope: { kind: 'null' }, createdAt: at(8) }),
      await seedRun({ reportId: parentD, orgId: f.orgD, scope: { kind: 'unrestricted', userId: f.partnerUser.id }, createdAt: at(9) }),
      await seedRun({ reportId: parentE, orgId: f.orgE, scope: { kind: 'unrestricted', userId: f.partnerUser.id }, createdAt: at(10) }),
      await seedRun({ reportId: parentF, orgId: f.orgF, scope: { kind: 'unrestricted', userId: f.foreignUser.id }, createdAt: at(11) }),
    ];

    const app = buildApp();
    const seen: string[] = [];
    for (const [page, count] of [[1, 2], [2, 2], [3, 1]] as const) {
      const res = await app.request(
        `/reports/runs?limit=2&page=${page}`,
        authed(f.partnerUser.token),
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        data: Array<{ id: string }>;
        pagination: { total: number };
      };
      expect(body.data).toHaveLength(count);
      expect(body.pagination.total).toBe(5);
      seen.push(...body.data.map((r) => r.id));
    }
    expect(new Set(seen)).toEqual(new Set(visible));
    for (const id of excluded) expect(seen).not.toContain(id);
  });

  runDb('system run list without orgId applies the unrestricted predicate across organizations', async () => {
    const f = await buildFixture();
    const base = Date.parse('2026-07-20T12:00:00.000Z');
    const at = (m: number) => new Date(base - m * 60_000);

    const parentA = await seedReport({ orgId: f.orgA, name: 'sa', scope: { kind: 'unrestricted', userId: f.unrestrictedUser.id } });
    const parentF = await seedReport({ orgId: f.orgF, name: 'sf', scope: { kind: 'unrestricted', userId: f.foreignUser.id } });

    const visible = [
      await seedRun({ reportId: parentA, orgId: f.orgA, scope: { kind: 'unrestricted', userId: f.unrestrictedUser.id }, createdAt: at(0) }),
      await seedRun({ reportId: parentA, orgId: f.orgA, scope: { kind: 'restricted', userId: f.siteAUser.id, siteIds: [f.siteA1] }, createdAt: at(1) }),
      await seedRun({ reportId: parentA, orgId: f.orgA, scope: { kind: 'legacy', userId: f.unrestrictedUser.id }, createdAt: at(2) }),
      await seedRun({ reportId: parentA, orgId: f.orgA, scope: { kind: 'null' }, createdAt: at(3) }),
      await seedRun({ reportId: parentF, orgId: f.orgF, scope: { kind: 'unrestricted', userId: f.foreignUser.id }, createdAt: at(4) }),
    ];

    const app = buildApp();
    await withoutScopeShapeConstraints(async () => {
      const malformed = await scalar<string>(sql`
        INSERT INTO report_runs (report_id, status, execution_scope_version, execution_scope_kind,
                                 execution_scope_fingerprint, execution_scope_captured_at,
                                 execution_scope_user_id, created_at)
        VALUES (${parentA}::uuid, 'completed', 3, 'unrestricted', repeat('c', 64), now(),
                ${f.unrestrictedUser.id}::uuid, ${naiveUtc(at(5))}::timestamp)
        RETURNING id
      `);

      const seen: string[] = [];
      for (const [page, count] of [[1, 2], [2, 2], [3, 1]] as const) {
        const res = await app.request(
          `/reports/runs?limit=2&page=${page}`,
          authed(f.systemUser.token),
        );
        expect(res.status).toBe(200);
        const body = (await res.json()) as {
          data: Array<{ id: string }>;
          pagination: { total: number };
        };
        expect(body.data).toHaveLength(count);
        expect(body.pagination.total).toBe(5);
        seen.push(...body.data.map((r) => r.id));
      }
      expect(new Set(seen)).toEqual(new Set(visible));
      expect(seen).not.toContain(malformed);
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 7. Cross-organization known-ID rebinding
// ═══════════════════════════════════════════════════════════════════════════

describe('Wave 2 · cross-organization known-ID fetch and download rebind authority', () => {
  runDb('an Org B Site-B1 membership overrides partner fallback for exact rows', async () => {
    const f = await buildFixture();

    const bParent = await seedReport({ orgId: f.orgB, name: 'b-parent', scope: { kind: 'unrestricted', userId: f.partnerUser.id } });
    const b1Definition = await seedReport({ orgId: f.orgB, name: 'b1-def', scope: { kind: 'restricted', userId: f.partnerUser.id, siteIds: [f.siteB1] } });
    const b2Definition = await seedReport({ orgId: f.orgB, name: 'b2-def', scope: { kind: 'restricted', userId: f.partnerUser.id, siteIds: [f.siteB2] } });
    const b1Run = await seedRun({ reportId: b1Definition, orgId: f.orgB, scope: { kind: 'restricted', userId: f.partnerUser.id, siteIds: [f.siteB1] } });
    const b2Run = await seedRun({ reportId: b2Definition, orgId: f.orgB, scope: { kind: 'restricted', userId: f.partnerUser.id, siteIds: [f.siteB2] } });

    const aDefinition = await seedReport({ orgId: f.orgA, name: 'a-def', scope: { kind: 'unrestricted', userId: f.unrestrictedUser.id } });
    const aRun = await seedRun({ reportId: aDefinition, orgId: f.orgA, scope: { kind: 'unrestricted', userId: f.unrestrictedUser.id } });

    const fDefinition = await seedReport({ orgId: f.orgF, name: 'f-def', scope: { kind: 'unrestricted', userId: f.foreignUser.id } });
    const fRun = await seedRun({ reportId: fDefinition, orgId: f.orgF, scope: { kind: 'unrestricted', userId: f.foreignUser.id } });

    const app = buildApp();
    const token = f.partnerUser.token;

    // Allowed: Org A via unrestricted partner fallback (no membership there).
    expect((await app.request(`/reports/${aDefinition}`, authed(token))).status).toBe(200);
    expect((await app.request(`/reports/runs/${aRun}`, authed(token))).status).toBe(200);
    expect((await app.request(`/reports/runs/${aRun}/download`, authed(token))).status).toBe(200);

    // Allowed: Org B rows inside Site B1.
    expect((await app.request(`/reports/${b1Definition}`, authed(token))).status).toBe(200);
    expect((await app.request(`/reports/runs/${b1Run}`, authed(token))).status).toBe(200);

    // Denied: Org B rows outside Site B1, the Org B unrestricted definition,
    // the other partner's rows, and a nonexistent UUID — all identical.
    const ghost = randomUUID();
    const definitionBodies = new Set<string>();
    for (const id of [b2Definition, bParent, fDefinition, ghost]) {
      const res = await app.request(`/reports/${id}`, authed(token));
      definitionBodies.add(`${res.status}|${await res.text()}`);
    }
    expect([...definitionBodies]).toEqual(['404|{"error":"Report not found"}']);

    const runBodies = new Set<string>();
    for (const id of [b2Run, fRun, ghost]) {
      const detail = await app.request(`/reports/runs/${id}`, authed(token));
      runBodies.add(`${detail.status}|${await detail.text()}`);
      const download = await app.request(`/reports/runs/${id}/download`, authed(token));
      runBodies.add(`${download.status}|${await download.text()}`);
    }
    expect([...runBodies]).toEqual(['404|{"error":"Report run not found"}']);

    // System authority is unrestricted everywhere, including the other partner.
    for (const id of [b2Definition, bParent, fDefinition, aDefinition]) {
      expect((await app.request(`/reports/${id}`, authed(f.systemUser.token))).status).toBe(200);
    }
    for (const id of [b2Run, fRun, aRun]) {
      expect((await app.request(`/reports/runs/${id}`, authed(f.systemUser.token))).status).toBe(200);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 8. GET /reports/:id recentRuns
// ═══════════════════════════════════════════════════════════════════════════

describe('Wave 2 · report detail embeds only authorized recent runs', () => {
  runDb('returns the five newest authorized runs and never embeds a result', async () => {
    const f = await buildFixture();
    const parent = await seedReport({
      orgId: f.orgA,
      name: 'detail-parent',
      scope: { kind: 'restricted', userId: f.siteAUser.id, siteIds: [f.siteA1] },
      createdBy: f.siteAUser.id,
    });
    const base = Date.parse('2026-07-20T12:00:00.000Z');
    const at = (m: number) => new Date(base - m * 60_000);

    const authorized: string[] = [];
    for (let i = 0; i < 7; i += 1) {
      authorized.push(
        await seedRun({
          reportId: parent,
          orgId: f.orgA,
          scope: { kind: 'restricted', userId: f.siteAUser.id, siteIds: [f.siteA1] },
          createdAt: at(i * 2),
        }),
      );
      await seedRun({
        reportId: parent,
        orgId: f.orgA,
        scope: { kind: 'restricted', userId: f.unrestrictedUser.id, siteIds: [f.siteA2] },
        createdAt: at(i * 2 + 1),
        result: { rows: [{ hostname: 'host-a2-SECRET' }], rowCount: 1 },
      });
    }

    const app = buildApp();
    const res = await app.request(`/reports/${parent}`, authed(f.siteAUser.token));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { recentRuns: Array<Record<string, unknown>> };
    expect(body.recentRuns).toHaveLength(5);
    expect(body.recentRuns.map((r) => r.id)).toEqual(authorized.slice(0, 5));
    for (const run of body.recentRuns) {
      expect(run).not.toHaveProperty('result');
    }
    expect(JSON.stringify(body)).not.toContain('SECRET');
  });

  runDb('partner Org B detail excludes B2/unrestricted/legacy despite Org A fallback', async () => {
    const f = await buildFixture();
    const parent = await seedReport({
      orgId: f.orgB,
      name: 'b-detail',
      scope: { kind: 'restricted', userId: f.partnerUser.id, siteIds: [f.siteB1] },
    });
    const base = Date.parse('2026-07-20T12:00:00.000Z');
    const at = (m: number) => new Date(base - m * 60_000);

    const allowed = await seedRun({
      reportId: parent,
      orgId: f.orgB,
      scope: { kind: 'restricted', userId: f.partnerUser.id, siteIds: [f.siteB1] },
      createdAt: at(0),
    });
    const excluded = [
      await seedRun({ reportId: parent, orgId: f.orgB, scope: { kind: 'restricted', userId: f.partnerUser.id, siteIds: [f.siteB2] }, createdAt: at(1) }),
      await seedRun({ reportId: parent, orgId: f.orgB, scope: { kind: 'unrestricted', userId: f.partnerUser.id }, createdAt: at(2) }),
      await seedRun({ reportId: parent, orgId: f.orgB, scope: { kind: 'legacy', userId: f.partnerUser.id }, createdAt: at(3) }),
      await seedRun({ reportId: parent, orgId: f.orgB, scope: { kind: 'null' }, createdAt: at(4) }),
    ];

    const app = buildApp();
    const res = await app.request(`/reports/${parent}`, authed(f.partnerUser.token));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { recentRuns: Array<{ id: string }> };
    expect(body.recentRuns.map((r) => r.id)).toEqual([allowed]);
    for (const id of excluded) {
      expect(body.recentRuns.map((r) => r.id)).not.toContain(id);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 9. Ad-hoc generation
// ═══════════════════════════════════════════════════════════════════════════

describe('Wave 2 · ad-hoc generation carries an explicit immutable authority', () => {
  runDb('restricted ad-hoc output excludes other sites and rejects out-of-scope filters', async () => {
    const f = await buildFixture();
    const app = buildApp();

    const res = await app.request(
      '/reports/generate',
      authed(f.siteAUser.token, {
        method: 'POST',
        body: JSON.stringify({ type: 'device_inventory' }),
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { rows: Array<{ hostname: string }> } };
    expect(body.data.rows.map((r) => r.hostname)).toEqual(['host-a1']);

    // An explicitly requested foreign site is refused, not silently intersected.
    const outOfScope = await app.request(
      '/reports/generate',
      authed(f.siteAUser.token, {
        method: 'POST',
        body: JSON.stringify({
          type: 'device_inventory',
          config: { filters: { siteIds: [f.siteA2] } },
        }),
      }),
    );
    expect(outOfScope.status).toBe(403);

    // Non-vacuity: the unrestricted caller in the same org sees both hosts.
    const wide = await app.request(
      '/reports/generate',
      authed(f.unrestrictedUser.token, {
        method: 'POST',
        body: JSON.stringify({ type: 'device_inventory' }),
      }),
    );
    const wideBody = (await wide.json()) as { data: { rows: Array<{ hostname: string }> } };
    expect(wideBody.data.rows.map((r) => r.hostname).sort()).toEqual(['host-a1', 'host-a2']);
  });

  runDb('restricted-empty ad-hoc generation issues no device query at all', async () => {
    const f = await buildFixture();
    const app = buildApp();

    await withoutSelectPrivilege('devices', async () => {
      const denied = await app.request(
        '/reports/generate',
        authed(f.emptyScopeUser.token, {
          method: 'POST',
          body: JSON.stringify({ type: 'device_inventory' }),
        }),
      );
      expect(denied.status).toBe(403);

      // Positive control: the unrestricted caller DOES query devices, so with
      // SELECT revoked the same request fails.
      const control = await app.request(
        '/reports/generate',
        authed(f.unrestrictedUser.token, {
          method: 'POST',
          body: JSON.stringify({ type: 'device_inventory' }),
        }),
      );
      expect(control.status).toBeGreaterThanOrEqual(500);
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 10. /reports/data/alerts-summary aggregates
// ═══════════════════════════════════════════════════════════════════════════

async function seedAlerts(f: Fixture) {
  const db = getTestDb();
  const [template] = await db
    .insert(alertTemplates)
    .values({
      name: 'w2-template',
      conditions: {},
      severity: 'critical',
      titleTemplate: 't',
      messageTemplate: 'm',
    })
    .returning({ id: alertTemplates.id });

  const ruleFor = async (orgId: string, name: string) => {
    const [rule] = await db
      .insert(alertRules)
      .values({
        orgId,
        templateId: template!.id,
        name,
        targetType: 'all',
        targetId: orgId,
      })
      .returning({ id: alertRules.id });
    return rule!.id;
  };

  const ruleA = await ruleFor(f.orgA, 'rule-a');
  const ruleB = await ruleFor(f.orgB, 'rule-b');
  const ruleD = await ruleFor(f.orgD, 'rule-d');
  const ruleE = await ruleFor(f.orgE, 'rule-e');

  const now = new Date();
  await db.insert(alerts).values([
    { ruleId: ruleA, deviceId: f.deviceA1, orgId: f.orgA, severity: 'critical', status: 'active', title: 'a1', triggeredAt: now },
    { ruleId: ruleA, deviceId: f.deviceA2, orgId: f.orgA, severity: 'high', status: 'active', title: 'a2', triggeredAt: now },
    { ruleId: ruleB, deviceId: f.deviceB1, orgId: f.orgB, severity: 'medium', status: 'acknowledged', title: 'b1', triggeredAt: now },
    { ruleId: ruleB, deviceId: f.deviceB2, orgId: f.orgB, severity: 'low', status: 'resolved', title: 'b2', triggeredAt: now },
    { ruleId: ruleD, deviceId: f.deviceD1, orgId: f.orgD, severity: 'info', status: 'active', title: 'd1', triggeredAt: now },
    { ruleId: ruleE, deviceId: f.deviceE1, orgId: f.orgE, severity: 'critical', status: 'active', title: 'e1', triggeredAt: now },
  ]);
}

interface AlertsSummaryBody {
  data: {
    bySeverity: Record<string, number>;
    byStatus: Record<string, number>;
    byDay: Array<{ date: string; count: number }>;
    topRules: Array<{ ruleName: string; count: number }>;
  };
  total: number;
}

describe('Wave 2 · alerts-summary aggregates respect the exact per-organization scope', () => {
  runDb('exact restricted organization returns Site A-only values in every aggregate', async () => {
    const f = await buildFixture();
    await seedAlerts(f);
    const app = buildApp();

    const res = await app.request('/reports/data/alerts-summary', authed(f.siteAUser.token));
    expect(res.status).toBe(200);
    const body = (await res.json()) as AlertsSummaryBody;
    expect(body.total).toBe(1);
    expect(body.data.bySeverity).toEqual({ critical: 1 });
    expect(body.data.byStatus).toEqual({ active: 1 });
    expect(body.data.byDay.reduce((sum, d) => sum + d.count, 0)).toBe(1);
    expect(body.data.topRules.map((r) => r.ruleName)).toEqual(['rule-a']);
    expect(body.data.topRules[0]!.count).toBe(1);

    // Non-vacuity: the same org, unrestricted, sees both A alerts.
    const wide = await app.request('/reports/data/alerts-summary', authed(f.unrestrictedUser.token));
    const wideBody = (await wide.json()) as AlertsSummaryBody;
    expect(wideBody.total).toBe(2);
    expect(wideBody.data.bySeverity).toEqual({ critical: 1, high: 1 });
  });

  runDb('partner no-orgId aggregates cover Org A wholly and Org B only at Site B1', async () => {
    const f = await buildFixture();
    await seedAlerts(f);
    const app = buildApp();

    const res = await app.request('/reports/data/alerts-summary', authed(f.partnerUser.token));
    expect(res.status).toBe(200);
    const body = (await res.json()) as AlertsSummaryBody;

    expect(body.total).toBe(3);
    expect(body.data.bySeverity).toEqual({ critical: 1, high: 1, medium: 1 });
    expect(body.data.byStatus).toEqual({ active: 2, acknowledged: 1 });
    expect(body.data.byDay.reduce((sum, d) => sum + d.count, 0)).toBe(3);
    expect(new Set(body.data.topRules.map((r) => r.ruleName))).toEqual(new Set(['rule-a', 'rule-b']));
    // Org D (denied) and Org E (restricted-empty) contribute nothing; if Org E's
    // critical alert leaked, critical would be 2 and rule-e would appear.
    expect(body.data.topRules.map((r) => r.ruleName)).not.toContain('rule-d');
    expect(body.data.topRules.map((r) => r.ruleName)).not.toContain('rule-e');

    // Non-vacuity: the system caller sees every alert in the fixture.
    const system = await app.request('/reports/data/alerts-summary', authed(f.systemUser.token));
    const systemBody = (await system.json()) as AlertsSummaryBody;
    expect(systemBody.total).toBe(6);

    // An explicit organization derives ONE membership-first scope.
    const explicitB = await app.request(
      `/reports/data/alerts-summary?orgId=${f.orgB}`,
      authed(f.partnerUser.token),
    );
    const explicitBody = (await explicitB.json()) as AlertsSummaryBody;
    expect(explicitBody.total).toBe(1);
    expect(explicitBody.data.bySeverity).toEqual({ medium: 1 });
  });

  runDb('restricted-empty authority answers zero-safe without touching alerts', async () => {
    const f = await buildFixture();
    await seedAlerts(f);
    const app = buildApp();

    await withoutSelectPrivilege('alerts', async () => {
      const empty = await app.request(
        '/reports/data/alerts-summary',
        authed(f.emptyScopeUser.token),
      );
      expect(empty.status).toBe(200);
      expect(await empty.json()).toEqual({
        data: { bySeverity: {}, byStatus: {}, byDay: [], topRules: [] },
        total: 0,
      });

      // Positive control: an authorized caller DOES query alerts.
      const control = await app.request(
        '/reports/data/alerts-summary',
        authed(f.unrestrictedUser.token),
      );
      expect(control.status).toBeGreaterThanOrEqual(500);
    });
  });

  runDb('devices.site_id is NOT NULL — a "null-site" device row is unrepresentable', async () => {
    const nullable = await scalar<string>(sql`
      SELECT is_nullable FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'devices' AND column_name = 'site_id'
    `);
    expect(nullable).toBe('NO');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 11. Scheduled execution gates
// ═══════════════════════════════════════════════════════════════════════════

async function runScheduled(reportId: string): Promise<void> {
  await withSystemDbAccessContext(() =>
    processRunScheduledReport({
      type: 'run-scheduled-report',
      reportId,
      occurrenceKey: 1,
    }),
  );
}

describe('Wave 2 · scheduled execution fails closed before any side effect', () => {
  runDb('a scheduled run completes and delivers while the creator keeps a common site', async () => {
    const f = await buildFixture();
    const reportId = await seedReport({
      orgId: f.orgA,
      name: 'scheduled-ok',
      schedule: 'daily',
      scope: { kind: 'restricted', userId: f.siteAUser.id, siteIds: [f.siteA1] },
      createdBy: f.siteAUser.id,
      config: { emailRecipients: ['ops@example.com'] },
    });

    await runScheduled(reportId);

    const runs = await rawRows<{ status: string; kind: string; site_ids: string[]; result: { rows: Array<{ hostname: string }> } | null }>(sql`
      SELECT status, execution_scope_kind AS kind, execution_scope_site_ids AS site_ids, result
        FROM report_runs WHERE report_id = ${reportId}::uuid
    `);
    expect(runs).toHaveLength(1);
    expect(runs[0]!.status).toBe('completed');
    expect(runs[0]!.kind).toBe('restricted');
    expect(runs[0]!.site_ids).toEqual([f.siteA1]);
    expect(runs[0]!.result!.rows.map((r) => r.hostname)).toEqual(['host-a1']);
    expect(emailProbe.calls).toBe(1);
  });

  runDb('narrowing the creator to no common site blocks the run before output or email', async () => {
    const f = await buildFixture();
    const reportId = await seedReport({
      orgId: f.orgA,
      name: 'scheduled-narrowed',
      schedule: 'daily',
      scope: { kind: 'restricted', userId: f.siteAUser.id, siteIds: [f.siteA1] },
      createdBy: f.siteAUser.id,
      config: { emailRecipients: ['ops@example.com'] },
    });

    await getTestDb()
      .update(organizationUsers)
      .set({ siteIds: [f.siteA2] })
      .where(and(eq(organizationUsers.userId, f.siteAUser.id), eq(organizationUsers.orgId, f.orgA)));

    await runScheduled(reportId);

    const runs = await rawRows<{ status: string; error_message: string | null; result: unknown; output_url: string | null }>(sql`
      SELECT status, error_message, result, output_url FROM report_runs WHERE report_id = ${reportId}::uuid
    `);
    expect(runs).toHaveLength(1);
    expect(runs[0]!.status).toBe('failed');
    expect(runs[0]!.error_message).toBe('scope_no_intersection');
    expect(runs[0]!.result).toBeNull();
    expect(runs[0]!.output_url).toBeNull();
    expect(emailProbe.calls).toBe(0);

    const lastGenerated = await scalar<Date | null>(
      sql`SELECT last_generated_at FROM reports WHERE id = ${reportId}::uuid`,
    );
    expect(lastGenerated).toBeNull();
  });

  runDb('removing the creator membership blocks execution', async () => {
    const f = await buildFixture();
    const reportId = await seedReport({
      orgId: f.orgA,
      name: 'scheduled-removed',
      schedule: 'daily',
      scope: { kind: 'restricted', userId: f.siteAUser.id, siteIds: [f.siteA1] },
      createdBy: f.siteAUser.id,
      config: { emailRecipients: ['ops@example.com'] },
    });

    await getTestDb()
      .delete(organizationUsers)
      .where(and(eq(organizationUsers.userId, f.siteAUser.id), eq(organizationUsers.orgId, f.orgA)));

    await runScheduled(reportId);

    const runs = await rawRows<{ status: string; error_message: string | null }>(sql`
      SELECT status, error_message FROM report_runs WHERE report_id = ${reportId}::uuid
    `);
    expect(runs).toHaveLength(1);
    expect(runs[0]!.status).toBe('failed');
    expect(runs[0]!.error_message).toBe('scope_membership_removed');
    expect(emailProbe.calls).toBe(0);
  });

  runDb('a disabled creator blocks execution', async () => {
    const f = await buildFixture();
    const reportId = await seedReport({
      orgId: f.orgA,
      name: 'scheduled-disabled',
      schedule: 'daily',
      scope: { kind: 'restricted', userId: f.siteAUser.id, siteIds: [f.siteA1] },
      createdBy: f.siteAUser.id,
    });

    await getTestDb()
      .update(users)
      .set({ status: 'disabled' })
      .where(eq(users.id, f.siteAUser.id));

    await runScheduled(reportId);

    const runs = await rawRows<{ status: string; error_message: string | null }>(sql`
      SELECT status, error_message FROM report_runs WHERE report_id = ${reportId}::uuid
    `);
    expect(runs[0]!.status).toBe('failed');
    expect(runs[0]!.error_message).toBe('scope_user_inactive');
  });

  runDb('legacy and old-writer schedules never execute and are never marked due', async () => {
    const f = await buildFixture();
    const legacyId = await seedReport({
      orgId: f.orgA,
      name: 'scheduled-legacy',
      schedule: 'daily',
      scope: { kind: 'legacy', userId: f.unrestrictedUser.id },
      createdBy: f.unrestrictedUser.id,
    });
    const oldWriterId = await seedReport({
      orgId: f.orgA,
      name: 'scheduled-old-writer',
      schedule: 'daily',
      scope: { kind: 'null' },
      createdBy: f.unrestrictedUser.id,
    });
    const executableId = await seedReport({
      orgId: f.orgA,
      name: 'scheduled-executable',
      schedule: 'daily',
      scope: { kind: 'unrestricted', userId: f.unrestrictedUser.id },
      createdBy: f.unrestrictedUser.id,
    });

    // The all-null row decodes as legacy_unscoped rather than throwing.
    const oldWriterRow = await rawRows<PersistedSiteScopeColumns & { org_id: string }>(sql`
      SELECT org_id,
             execution_scope_version AS "executionScopeVersion",
             execution_scope_kind AS "executionScopeKind",
             execution_scope_site_ids AS "executionScopeSiteIds",
             execution_scope_user_id AS "executionScopeUserId",
             execution_scope_fingerprint AS "executionScopeFingerprint",
             execution_scope_captured_at AS "executionScopeCapturedAt"
        FROM reports WHERE id = ${oldWriterId}::uuid
    `);
    expect(decodeSiteScope(oldWriterRow[0]!, f.orgA)).toEqual({
      version: 1,
      kind: 'legacy_unscoped',
      orgId: f.orgA,
    });

    const due = await withSystemDbAccessContext(() =>
      findDueReports(new Date('2026-07-21T12:00:00.000Z')),
    );
    const dueIds = due.map((d) => d.id);
    expect(dueIds).not.toContain(legacyId);
    expect(dueIds).not.toContain(oldWriterId);
    expect(dueIds).toContain(executableId);

    // Even if forced, neither produces output.
    for (const [id, reason] of [
      [legacyId, 'scope_legacy_unscoped'],
      [oldWriterId, 'scope_legacy_unscoped'],
    ] as const) {
      await runScheduled(id);
      const runs = await rawRows<{ status: string; error_message: string | null; result: unknown }>(sql`
        SELECT status, error_message, result FROM report_runs WHERE report_id = ${id}::uuid
      `);
      expect(runs).toHaveLength(1);
      expect(runs[0]!.status).toBe('failed');
      expect(runs[0]!.error_message).toBe(reason);
      expect(runs[0]!.result).toBeNull();
    }
    expect(emailProbe.calls).toBe(0);
  });

  runDb('reauthorization is the only way a legacy schedule becomes executable', async () => {
    const f = await buildFixture();
    const legacyId = await seedReport({
      orgId: f.orgA,
      name: 'scheduled-legacy-reauth',
      schedule: 'daily',
      scope: { kind: 'legacy', userId: f.unrestrictedUser.id },
      createdBy: f.unrestrictedUser.id,
    });
    const app = buildApp();

    // A restricted caller may not reauthorize a legacy definition.
    expect(
      (await app.request(`/reports/${legacyId}/reauthorize`, authed(f.siteAUser.token, { method: 'POST' }))).status,
    ).toBe(404);

    const res = await app.request(
      `/reports/${legacyId}/reauthorize`,
      authed(f.unrestrictedUser.token, { method: 'POST' }),
    );
    expect(res.status).toBe(200);
    const updated = (await res.json()) as {
      executionScopeKind: string;
      executionScopeUserId: string;
    };
    expect(updated.executionScopeKind).toBe('unrestricted');
    expect(updated.executionScopeUserId).toBe(f.unrestrictedUser.id);

    const due = await withSystemDbAccessContext(() =>
      findDueReports(new Date('2026-07-21T12:00:00.000Z')),
    );
    expect(due.map((d) => d.id)).toContain(legacyId);

    await runScheduled(legacyId);
    const runs = await rawRows<{ status: string }>(
      sql`SELECT status FROM report_runs WHERE report_id = ${legacyId}::uuid`,
    );
    expect(runs.map((r) => r.status)).toEqual(['completed']);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 12. Migration + mixed-version invariants
// ═══════════════════════════════════════════════════════════════════════════

describe('Wave 2 · migration is idempotent and the shape CHECK holds', () => {
  runDb('reapplying the expansion migration changes neither schema nor rows', async () => {
    const f = await buildFixture();
    await seedReport({
      orgId: f.orgA,
      name: 'idempotency-restricted',
      scope: { kind: 'restricted', userId: f.siteAUser.id, siteIds: [f.siteA1] },
      createdBy: f.siteAUser.id,
    });
    const oldWriter = await seedReport({
      orgId: f.orgA,
      name: 'idempotency-old-writer',
      scope: { kind: 'null' },
      createdBy: f.unrestrictedUser.id,
    });
    await seedRun({ reportId: oldWriter, orgId: f.orgA, scope: { kind: 'null' } });

    const here = path.dirname(fileURLToPath(import.meta.url));
    const migrationPath = path.resolve(here, '../../../migrations', MIGRATION_FILE);
    const migrationSql = await readFile(migrationPath, 'utf8');

    const snapshotSchema = () => rawRows(sql`
      SELECT table_name, column_name, data_type, is_nullable
        FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name IN ('reports', 'report_runs')
       ORDER BY table_name, column_name
    `);
    const snapshotConstraints = () => rawRows(sql`
      SELECT conname, pg_get_constraintdef(oid) AS definition
        FROM pg_constraint
       WHERE conrelid IN ('reports'::regclass, 'report_runs'::regclass)
       ORDER BY conname
    `);
    const snapshotRows = async () => ({
      reports: await rawRows(sql`
        SELECT id, execution_scope_version, execution_scope_kind, execution_scope_site_ids,
               execution_scope_user_id, execution_scope_fingerprint, execution_scope_captured_at
          FROM reports ORDER BY id
      `),
      runs: await rawRows(sql`
        SELECT id, execution_scope_version, execution_scope_kind, execution_scope_site_ids,
               execution_scope_user_id, execution_scope_fingerprint, execution_scope_captured_at
          FROM report_runs ORDER BY id
      `),
    });

    // First (re)application backfills the all-null rows to legacy_unscoped.
    await getTestDb().execute(sql.raw(migrationSql));
    const schemaBefore = await snapshotSchema();
    const constraintsBefore = await snapshotConstraints();
    const rowsBefore = await snapshotRows();

    expect(
      (rowsBefore.reports as Array<{ id: string; execution_scope_kind: string }>).find(
        (r) => r.id === oldWriter,
      )?.execution_scope_kind,
    ).toBe('legacy_unscoped');

    // Second application must be a strict no-op.
    await getTestDb().execute(sql.raw(migrationSql));

    expect(await snapshotSchema()).toEqual(schemaBefore);
    expect(await snapshotConstraints()).toEqual(constraintsBefore);
    expect(await snapshotRows()).toEqual(rowsBefore);

    const backfilled = await scalar<number>(sql`
      SELECT count(*)::int FROM reports
       WHERE execution_scope_kind = 'legacy_unscoped'
         AND execution_scope_fingerprint = encode(
           sha256(convert_to('{"version":1,"kind":"legacy_unscoped","orgId":"' || org_id::text || '"}', 'UTF8')), 'hex')
    `);
    expect(backfilled).toBeGreaterThan(0);
  });

  runDb('the shape CHECK rejects every partial provenance combination', async () => {
    const f = await buildFixture();
    const forbidden = [
      sql`INSERT INTO reports (org_id, name, type, execution_scope_version) VALUES (${f.orgA}::uuid, 'p1', 'device_inventory', 1)`,
      sql`INSERT INTO reports (org_id, name, type, execution_scope_kind) VALUES (${f.orgA}::uuid, 'p2', 'device_inventory', 'unrestricted')`,
      sql`INSERT INTO reports (org_id, name, type, execution_scope_version, execution_scope_kind, execution_scope_fingerprint, execution_scope_captured_at) VALUES (${f.orgA}::uuid, 'p3', 'device_inventory', 1, 'unrestricted', repeat('a', 64), now())`,
      sql`INSERT INTO reports (org_id, name, type, execution_scope_version, execution_scope_kind, execution_scope_site_ids, execution_scope_user_id, execution_scope_fingerprint, execution_scope_captured_at) VALUES (${f.orgA}::uuid, 'p4', 'device_inventory', 1, 'unrestricted', ARRAY[${f.siteA1}::uuid], ${f.siteAUser.id}::uuid, repeat('a', 64), now())`,
      sql`INSERT INTO reports (org_id, name, type, execution_scope_version, execution_scope_kind, execution_scope_user_id, execution_scope_fingerprint, execution_scope_captured_at) VALUES (${f.orgA}::uuid, 'p5', 'device_inventory', 1, 'restricted', ${f.siteAUser.id}::uuid, repeat('a', 64), now())`,
      sql`INSERT INTO reports (org_id, name, type, execution_scope_version, execution_scope_kind, execution_scope_user_id, execution_scope_fingerprint, execution_scope_captured_at) VALUES (${f.orgA}::uuid, 'p6', 'device_inventory', 2, 'unrestricted', ${f.siteAUser.id}::uuid, repeat('a', 64), now())`,
      sql`INSERT INTO reports (org_id, name, type, execution_scope_version, execution_scope_kind, execution_scope_user_id, execution_scope_fingerprint, execution_scope_captured_at) VALUES (${f.orgA}::uuid, 'p7', 'device_inventory', 1, 'bogus', ${f.siteAUser.id}::uuid, repeat('a', 64), now())`,
    ];

    for (const statement of forbidden) {
      await expect(getTestDb().execute(statement)).rejects.toThrow();
    }
    expect(
      await scalar<number>(sql`SELECT count(*)::int FROM reports WHERE name LIKE 'p_'`),
    ).toBe(0);
  });
});
