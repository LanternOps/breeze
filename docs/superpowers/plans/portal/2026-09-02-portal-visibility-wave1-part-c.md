# Customer Portal Visibility — Wave 1 Plan, Part C (W09–W10: report self-service)

> Part of `docs/superpowers/plans/portal/2026-09-02-portal-visibility-wave1.md` — read that file's **Global Constraints** and **File Structure** first; every task below inherits them. Spec: `docs/superpowers/specs/portal/2026-09-02-portal-visibility-wave1-design.md`.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

---

## Wave W09 — Reports foundation

### Task 9.1: Add the portal report schema and migration

**Files:**

- Create: `apps/api/migrations/2026-09-28-c-portal-report-self-service.sql`
- Modify: `apps/api/src/db/schema/reports.ts:1-90`
- Test: `apps/api/src/db/schema/reports.test.ts`
- Test: `apps/api/src/__tests__/integration/portalReportRecipientsRls.integration.test.ts`

**Interfaces:**

- Consumes: `reports`, `reportRuns`, `contacts`, `portalUsers`
- Produces: `reports.portalSelfService`, `reportRuns.requestedByKind`, `reportRuns.requestedByUserId`, `reportRuns.requestedByPortalUserId`, `reportScheduleRecipients`

- [ ] **Step 1: Write the failing schema and RLS tests.**

```ts
// apps/api/src/db/schema/reports.test.ts
import { describe, expect, it } from 'vitest';
import { getTableColumns } from 'drizzle-orm';
import {
  reportRuns,
  reports,
  reportScheduleRecipients,
  reportTypeEnum,
} from './reports';

const executionScopeColumns = [
  'executionScopeVersion',
  'executionScopeKind',
  'executionScopeSiteIds',
  'executionScopeUserId',
  'executionScopeFingerprint',
  'executionScopeCapturedAt',
  'executionScopePrincipalKind',
] as const;

describe('report execution scope provenance', () => {
  it.each([
    ['reports', reports],
    ['report_runs', reportRuns],
  ])('exposes all execution-scope columns on %s', (_name, table) => {
    const columns = getTableColumns(table);
    for (const name of executionScopeColumns) {
      expect(columns).toHaveProperty(name);
      expect(columns[name].notNull).toBe(false);
    }
  });

  it('models portal report visibility and requester provenance', () => {
    const reportColumns = getTableColumns(reports);
    const runColumns = getTableColumns(reportRuns);

    expect(reportColumns.portalSelfService.notNull).toBe(true);
    expect(reportColumns.portalSelfService.hasDefault).toBe(true);
    expect(runColumns).toHaveProperty('requestedByKind');
    expect(runColumns).toHaveProperty('requestedByUserId');
    expect(runColumns).toHaveProperty('requestedByPortalUserId');
  });

  it('models contact-bound report schedule recipients', () => {
    const columns = getTableColumns(reportScheduleRecipients);
    expect(Object.keys(columns)).toEqual([
      'id',
      'reportId',
      'orgId',
      'contactId',
      'createdAt',
    ]);
    expect(columns.reportId.notNull).toBe(true);
    expect(columns.orgId.notNull).toBe(true);
    expect(columns.contactId.notNull).toBe(true);
  });
});

describe('reportTypeEnum', () => {
  it('includes both portal-safe report types', () => {
    expect(reportTypeEnum.enumValues).toContain('executive_summary');
    expect(reportTypeEnum.enumValues).toContain(
      'security_compliance_posture',
    );
  });
});
```

```ts
// apps/api/src/__tests__/integration/portalReportRecipientsRls.integration.test.ts
import './setup';
import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import {
  db,
  withDbAccessContext,
  withSystemDbAccessContext,
  type DbAccessContext,
} from '../../db';
import {
  contacts,
  reportScheduleRecipients,
  reports,
} from '../../db/schema';
import {
  createOrganization,
  createPartner,
} from './db-utils';

const runDb = it.runIf(Boolean(process.env.DATABASE_URL));

function orgContext(orgId: string): DbAccessContext {
  return {
    scope: 'organization',
    orgId,
    accessibleOrgIds: [orgId],
    accessiblePartnerIds: [],
    currentPartnerId: null,
  };
}

describe('report_schedule_recipients RLS', () => {
  runDb('allows its org and rejects a cross-org insert', async () => {
    const fixture = await withSystemDbAccessContext(async () => {
      const partner = await createPartner();
      const orgA = await createOrganization({ partnerId: partner.id });
      const orgB = await createOrganization({ partnerId: partner.id });

      const [report] = await db.insert(reports).values({
        orgId: orgA.id,
        name: 'Customer portal — Executive summary',
        type: 'executive_summary',
        schedule: 'one_time',
        format: 'pdf',
        portalSelfService: true,
      }).returning({ id: reports.id });

      const [contact] = await db.insert(contacts).values({
        orgId: orgA.id,
        name: 'Customer',
        email: 'customer@example.test',
      }).returning({ id: contacts.id });

      return { orgA, orgB, report: report!, contact: contact! };
    });

    const [created] = await withDbAccessContext(
      orgContext(fixture.orgA.id),
      () => db.insert(reportScheduleRecipients).values({
        reportId: fixture.report.id,
        orgId: fixture.orgA.id,
        contactId: fixture.contact.id,
      }).returning(),
    );
    expect(created?.orgId).toBe(fixture.orgA.id);

    await expect(
      withDbAccessContext(orgContext(fixture.orgB.id), () =>
        db.insert(reportScheduleRecipients).values({
          reportId: fixture.report.id,
          orgId: fixture.orgA.id,
          contactId: fixture.contact.id,
        }),
      ),
    ).rejects.toMatchObject({
      cause: expect.objectContaining({ code: '42501' }),
    });

    const rows = await withDbAccessContext(
      orgContext(fixture.orgB.id),
      () => db.select().from(reportScheduleRecipients)
        .where(eq(reportScheduleRecipients.reportId, fixture.report.id)),
    );
    expect(rows).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the tests and confirm the missing columns/table fail.**

```bash
cd apps/api && npx vitest run src/db/schema/reports.test.ts
cd apps/api && npx vitest run -c vitest.integration.config.ts src/__tests__/integration/portalReportRecipientsRls.integration.test.ts
```

Expected: the unit test fails because `reportScheduleRecipients` and the new columns are absent. The integration test needs a live migrated database and initially fails because `report_schedule_recipients` does not exist.

- [ ] **Step 3: Add the complete idempotent migration and Drizzle definitions.**

```sql
-- apps/api/migrations/2026-09-28-c-portal-report-self-service.sql
-- Portal report self-service (Wave W09).
--
-- report_schedule_recipients is deliberately organization-owned only (RLS
-- Shape 1). Recipient selection is per-customer delivery data, not reusable
-- partner-wide policy, so this is the Partner-Wide First exception approved by
-- the portal-visibility design.
--
-- public.breeze_has_org_access(org_id) contains the system-scope branch. The
-- policies below therefore admit the owning organization and trusted system
-- jobs without a separate, broader predicate.
--
-- Registration in this change:
--   * CORE_ORG_CASCADE_DELETE_ORDER
--   * CORE_TENANT_EXPORT_POLICY
--   * no RLS allowlist: Shape 1 is auto-discovered
--   * no device cascade registration: there is no device_id
--
-- Idempotency: columns and indexes use IF NOT EXISTS, foreign keys are guarded
-- through pg_constraint, and policies are dropped before being recreated.

ALTER TABLE reports
  ADD COLUMN IF NOT EXISTS portal_self_service boolean NOT NULL DEFAULT false;

CREATE UNIQUE INDEX IF NOT EXISTS reports_portal_self_service_org_type_uniq
  ON reports (org_id, type)
  WHERE portal_self_service = true;

-- Composite target required by report_schedule_recipients.
CREATE UNIQUE INDEX IF NOT EXISTS reports_id_org_id_uniq
  ON reports (id, org_id);

ALTER TABLE report_runs
  ADD COLUMN IF NOT EXISTS requested_by_kind text;

ALTER TABLE report_runs
  ADD COLUMN IF NOT EXISTS requested_by_user_id uuid;

ALTER TABLE report_runs
  ADD COLUMN IF NOT EXISTS requested_by_portal_user_id uuid;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'report_runs_requested_by_user_id_users_id_fk'
  ) THEN
    ALTER TABLE report_runs
      ADD CONSTRAINT report_runs_requested_by_user_id_users_id_fk
      FOREIGN KEY (requested_by_user_id)
      REFERENCES users (id)
      ON DELETE SET NULL;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname =
      'report_runs_requested_by_portal_user_id_portal_users_id_fk'
  ) THEN
    ALTER TABLE report_runs
      ADD CONSTRAINT
        report_runs_requested_by_portal_user_id_portal_users_id_fk
      FOREIGN KEY (requested_by_portal_user_id)
      REFERENCES portal_users (id)
      ON DELETE SET NULL;
  END IF;
END $$;

ALTER TABLE report_runs
  DROP CONSTRAINT IF EXISTS report_runs_requested_by_shape_chk;

ALTER TABLE report_runs
  ADD CONSTRAINT report_runs_requested_by_shape_chk CHECK ((
    (
      requested_by_kind IS NULL
      AND requested_by_user_id IS NULL
      AND requested_by_portal_user_id IS NULL
    )
    OR (
      requested_by_kind = 'user'
      AND requested_by_user_id IS NOT NULL
      AND requested_by_portal_user_id IS NULL
    )
    OR (
      requested_by_kind = 'portal_user'
      AND requested_by_user_id IS NULL
      AND requested_by_portal_user_id IS NOT NULL
    )
    OR (
      requested_by_kind = 'system'
      AND requested_by_user_id IS NULL
      AND requested_by_portal_user_id IS NULL
    )
  ) IS TRUE);

-- Fix forward from 2026-09-24-b-ai-agents-org-narrative.sql.
ALTER TABLE reports
  DROP CONSTRAINT IF EXISTS reports_execution_scope_principal_chk;

ALTER TABLE reports
  ADD CONSTRAINT reports_execution_scope_principal_chk CHECK (
    execution_scope_principal_kind IS NULL
    OR execution_scope_principal_kind IN (
      'user',
      'system',
      'portal_user'
    )
  );

ALTER TABLE report_runs
  DROP CONSTRAINT IF EXISTS report_runs_execution_scope_principal_chk;

ALTER TABLE report_runs
  ADD CONSTRAINT report_runs_execution_scope_principal_chk CHECK (
    execution_scope_principal_kind IS NULL
    OR execution_scope_principal_kind IN (
      'user',
      'system',
      'portal_user'
    )
  );

ALTER TABLE reports
  DROP CONSTRAINT IF EXISTS reports_execution_scope_shape_chk;

ALTER TABLE reports
  ADD CONSTRAINT reports_execution_scope_shape_chk CHECK ((
    (
      execution_scope_version IS NULL
      AND execution_scope_kind IS NULL
      AND execution_scope_site_ids IS NULL
      AND execution_scope_user_id IS NULL
      AND execution_scope_fingerprint IS NULL
      AND execution_scope_captured_at IS NULL
      AND execution_scope_principal_kind IS NULL
    )
    OR (
      execution_scope_version = 1
      AND execution_scope_fingerprint IS NOT NULL
      AND execution_scope_captured_at IS NOT NULL
      AND (
        (
          execution_scope_kind = 'restricted'
          AND execution_scope_site_ids IS NOT NULL
          AND execution_scope_user_id IS NOT NULL
          AND execution_scope_principal_kind IS DISTINCT FROM 'system'
          AND execution_scope_principal_kind IS DISTINCT FROM 'portal_user'
        )
        OR (
          execution_scope_kind = 'unrestricted'
          AND execution_scope_site_ids IS NULL
          AND (
            (
              execution_scope_principal_kind IN ('system', 'portal_user')
              AND execution_scope_user_id IS NULL
            )
            OR (
              execution_scope_principal_kind IS DISTINCT FROM 'system'
              AND execution_scope_principal_kind IS DISTINCT FROM 'portal_user'
              AND execution_scope_user_id IS NOT NULL
            )
          )
        )
        OR (
          execution_scope_kind = 'legacy_unscoped'
          AND execution_scope_site_ids IS NULL
          AND execution_scope_principal_kind IS DISTINCT FROM 'system'
          AND execution_scope_principal_kind IS DISTINCT FROM 'portal_user'
        )
      )
    )
  ) IS TRUE);

ALTER TABLE report_runs
  DROP CONSTRAINT IF EXISTS report_runs_execution_scope_shape_chk;

ALTER TABLE report_runs
  ADD CONSTRAINT report_runs_execution_scope_shape_chk CHECK ((
    (
      execution_scope_version IS NULL
      AND execution_scope_kind IS NULL
      AND execution_scope_site_ids IS NULL
      AND execution_scope_user_id IS NULL
      AND execution_scope_fingerprint IS NULL
      AND execution_scope_captured_at IS NULL
      AND execution_scope_principal_kind IS NULL
    )
    OR (
      execution_scope_version = 1
      AND execution_scope_fingerprint IS NOT NULL
      AND execution_scope_captured_at IS NOT NULL
      AND (
        (
          execution_scope_kind = 'restricted'
          AND execution_scope_site_ids IS NOT NULL
          AND execution_scope_user_id IS NOT NULL
          AND execution_scope_principal_kind IS DISTINCT FROM 'system'
          AND execution_scope_principal_kind IS DISTINCT FROM 'portal_user'
        )
        OR (
          execution_scope_kind = 'unrestricted'
          AND execution_scope_site_ids IS NULL
          AND (
            (
              execution_scope_principal_kind IN ('system', 'portal_user')
              AND execution_scope_user_id IS NULL
            )
            OR (
              execution_scope_principal_kind IS DISTINCT FROM 'system'
              AND execution_scope_principal_kind IS DISTINCT FROM 'portal_user'
              AND execution_scope_user_id IS NOT NULL
            )
          )
        )
        OR (
          execution_scope_kind = 'legacy_unscoped'
          AND execution_scope_site_ids IS NULL
          AND execution_scope_principal_kind IS DISTINCT FROM 'system'
          AND execution_scope_principal_kind IS DISTINCT FROM 'portal_user'
        )
      )
    )
  ) IS TRUE);

CREATE TABLE IF NOT EXISTS report_schedule_recipients (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  report_id uuid NOT NULL,
  org_id uuid NOT NULL,
  contact_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'report_schedule_recipients_report_org_fk'
  ) THEN
    ALTER TABLE report_schedule_recipients
      ADD CONSTRAINT report_schedule_recipients_report_org_fk
      FOREIGN KEY (report_id, org_id)
      REFERENCES reports (id, org_id)
      ON DELETE CASCADE;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'report_schedule_recipients_contact_org_fk'
  ) THEN
    ALTER TABLE report_schedule_recipients
      ADD CONSTRAINT report_schedule_recipients_contact_org_fk
      FOREIGN KEY (contact_id, org_id)
      REFERENCES contacts (id, org_id)
      ON DELETE CASCADE;
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS
  report_schedule_recipients_report_contact_uniq
  ON report_schedule_recipients (report_id, contact_id);

ALTER TABLE report_schedule_recipients ENABLE ROW LEVEL SECURITY;
ALTER TABLE report_schedule_recipients FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS breeze_org_isolation_select
  ON report_schedule_recipients;
DROP POLICY IF EXISTS breeze_org_isolation_insert
  ON report_schedule_recipients;
DROP POLICY IF EXISTS breeze_org_isolation_update
  ON report_schedule_recipients;
DROP POLICY IF EXISTS breeze_org_isolation_delete
  ON report_schedule_recipients;

CREATE POLICY breeze_org_isolation_select
  ON report_schedule_recipients
  FOR SELECT
  USING (public.breeze_has_org_access(org_id));

CREATE POLICY breeze_org_isolation_insert
  ON report_schedule_recipients
  FOR INSERT
  WITH CHECK (public.breeze_has_org_access(org_id));

CREATE POLICY breeze_org_isolation_update
  ON report_schedule_recipients
  FOR UPDATE
  USING (public.breeze_has_org_access(org_id))
  WITH CHECK (public.breeze_has_org_access(org_id));

CREATE POLICY breeze_org_isolation_delete
  ON report_schedule_recipients
  FOR DELETE
  USING (public.breeze_has_org_access(org_id));

GRANT SELECT, INSERT, UPDATE, DELETE
  ON report_schedule_recipients
  TO breeze_app;
```

```ts
// apps/api/src/db/schema/reports.ts
import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import { contacts } from './contacts';
import { organizations } from './orgs';
import { portalUsers } from './portal';
import { users } from './users';

// Keep the existing enums unchanged.

export const reports = pgTable('reports', {
  // Keep the existing columns.
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').notNull().references(() => organizations.id),
  name: varchar('name', { length: 255 }).notNull(),
  type: reportTypeEnum('type').notNull(),
  config: jsonb('config').notNull().default({}),
  schedule: reportScheduleEnum('schedule').notNull().default('one_time'),
  format: reportFormatEnum('format').notNull().default('csv'),
  lastGeneratedAt: timestamp('last_generated_at'),
  createdBy: uuid('created_by').references(() => users.id),
  executionScopeVersion: integer('execution_scope_version'),
  executionScopeKind: varchar('execution_scope_kind', { length: 32 }),
  executionScopeSiteIds: uuid('execution_scope_site_ids').array(),
  executionScopeUserId: uuid('execution_scope_user_id'),
  executionScopeFingerprint: varchar('execution_scope_fingerprint', { length: 64 }),
  executionScopeCapturedAt: timestamp('execution_scope_captured_at', {
    withTimezone: true,
  }),
  executionScopePrincipalKind: text('execution_scope_principal_kind')
    .$type<'user' | 'system' | 'portal_user'>(),
  sourceAiAgentScheduleId: uuid('source_ai_agent_schedule_id'),
  portalSelfService: boolean('portal_self_service').notNull().default(false),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
}, (table) => ({
  reportsIdOrgIdUniq: uniqueIndex('reports_id_org_id_uniq')
    .on(table.id, table.orgId),
  reportsPortalSelfServiceOrgTypeUniq: uniqueIndex(
    'reports_portal_self_service_org_type_uniq',
  ).on(table.orgId, table.type)
    .where(sql`${table.portalSelfService} = true`),
}));

export const reportRuns = pgTable('report_runs', {
  // Keep the existing columns.
  id: uuid('id').primaryKey().defaultRandom(),
  reportId: uuid('report_id').notNull().references(() => reports.id),
  status: reportRunStatusEnum('status').notNull().default('pending'),
  startedAt: timestamp('started_at'),
  completedAt: timestamp('completed_at'),
  outputUrl: text('output_url'),
  errorMessage: text('error_message'),
  rowCount: integer('row_count'),
  result: jsonb('result'),
  executionScopeVersion: integer('execution_scope_version'),
  executionScopeKind: varchar('execution_scope_kind', { length: 32 }),
  executionScopeSiteIds: uuid('execution_scope_site_ids').array(),
  executionScopeUserId: uuid('execution_scope_user_id'),
  executionScopeFingerprint: varchar('execution_scope_fingerprint', { length: 64 }),
  executionScopeCapturedAt: timestamp('execution_scope_captured_at', {
    withTimezone: true,
  }),
  executionScopePrincipalKind: text('execution_scope_principal_kind')
    .$type<'user' | 'system' | 'portal_user'>(),
  requestedByKind: text('requested_by_kind')
    .$type<'user' | 'system' | 'portal_user'>(),
  requestedByUserId: uuid('requested_by_user_id').references(
    () => users.id,
    { onDelete: 'set null' },
  ),
  requestedByPortalUserId: uuid('requested_by_portal_user_id').references(
    () => portalUsers.id,
    { onDelete: 'set null' },
  ),
  createdAt: timestamp('created_at').defaultNow().notNull(),
}, (table) => ({
  requestedByShape: check(
    'report_runs_requested_by_shape_chk',
    sql`(
      (
        ${table.requestedByKind} IS NULL
        AND ${table.requestedByUserId} IS NULL
        AND ${table.requestedByPortalUserId} IS NULL
      )
      OR (
        ${table.requestedByKind} = 'user'
        AND ${table.requestedByUserId} IS NOT NULL
        AND ${table.requestedByPortalUserId} IS NULL
      )
      OR (
        ${table.requestedByKind} = 'portal_user'
        AND ${table.requestedByUserId} IS NULL
        AND ${table.requestedByPortalUserId} IS NOT NULL
      )
      OR (
        ${table.requestedByKind} = 'system'
        AND ${table.requestedByUserId} IS NULL
        AND ${table.requestedByPortalUserId} IS NULL
      )
    ) IS TRUE`,
  ),
}));

export const reportScheduleRecipients = pgTable(
  'report_schedule_recipients',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    reportId: uuid('report_id').notNull(),
    orgId: uuid('org_id').notNull(),
    contactId: uuid('contact_id').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    reportOrgFk: foreignKey({
      name: 'report_schedule_recipients_report_org_fk',
      columns: [table.reportId, table.orgId],
      foreignColumns: [reports.id, reports.orgId],
    }).onDelete('cascade'),
    contactOrgFk: foreignKey({
      name: 'report_schedule_recipients_contact_org_fk',
      columns: [table.contactId, table.orgId],
      foreignColumns: [contacts.id, contacts.orgId],
    }).onDelete('cascade'),
    reportContactUniq: uniqueIndex(
      'report_schedule_recipients_report_contact_uniq',
    ).on(table.reportId, table.contactId),
    orgIdx: index('report_schedule_recipients_org_idx').on(table.orgId),
  }),
);
```

- [ ] **Step 4: Apply the migration and run the focused and RLS tests green.**

```bash
pnpm db:migrate
cd apps/api && npx vitest run src/db/schema/reports.test.ts
cd apps/api && npx vitest run -c vitest.integration.config.ts src/__tests__/integration/portalReportRecipientsRls.integration.test.ts
cd apps/api && npx vitest run -c vitest.integration.config.ts src/__tests__/integration/rls-coverage.integration.test.ts
pnpm db:check-drift
```

The three integration commands need a live database.

- [ ] **Step 5: Commit the migration and schema.**

```bash
git add apps/api/migrations/2026-09-28-c-portal-report-self-service.sql apps/api/src/db/schema/reports.ts apps/api/src/db/schema/reports.test.ts apps/api/src/__tests__/integration/portalReportRecipientsRls.integration.test.ts && git commit -m "feat(portal): add report self-service schema"
```

### Task 9.2: Register report recipients in cascade and export contracts

**Files:**

- Modify: `apps/api/src/services/tenantCascade.ts:67-467`
- Modify: `apps/api/src/services/tenantExportPolicyRegistry.ts:41-413`
- Test: `apps/api/src/services/tenantCascade.test.ts`
- Test: `apps/api/src/services/tenantExportPolicy.test.ts`
- Test: `apps/api/src/__tests__/integration/tenantCascade.integration.test.ts`
- Test: `apps/api/src/__tests__/integration/tenant-export-policy.integration.test.ts`
- Test: `apps/api/src/__tests__/integration/tenantExportErasureRoundtrip.integration.test.ts`

**Interfaces:**

- Consumes: `CORE_ORG_CASCADE_DELETE_ORDER`, `CORE_TENANT_EXPORT_POLICY`
- Produces: cascade/export registration for `report_schedule_recipients` and `reports.portal_self_service`

- [ ] **Step 1: Write the failing registration assertions.**

```ts
// apps/api/src/services/tenantCascade.test.ts
it('registers report_schedule_recipients in localeCompare order', () => {
  const order = getOrgCascadeDeleteOrder();
  const recipients = order.indexOf('report_schedule_recipients');
  const reports = order.indexOf('reports');

  expect(recipients).toBeGreaterThan(-1);
  expect(reports).toBeGreaterThan(recipients);
  expect(
    order.filter((name) => name !== 'organizations'),
  ).toEqual(
    order
      .filter((name) => name !== 'organizations')
      .toSorted((a, b) => a.localeCompare(b)),
  );
});
```

```ts
// apps/api/src/services/tenantExportPolicy.test.ts
import { CORE_TENANT_EXPORT_POLICY } from './tenantExportPolicyRegistry';

it('exports portal report definitions and contact-bound recipients', () => {
  expect(
    CORE_TENANT_EXPORT_POLICY.reports.columns.portal_self_service.decision,
  ).toBe('include');

  expect(
    Object.fromEntries(
      Object.entries(
        CORE_TENANT_EXPORT_POLICY.report_schedule_recipients.columns,
      ).map(([name, value]) => [name, value.decision]),
    ),
  ).toEqual({
    id: 'include',
    report_id: 'include',
    org_id: 'include',
    contact_id: 'include',
    created_at: 'include',
  });

  expect(CORE_TENANT_EXPORT_POLICY).not.toHaveProperty('report_runs');
});
```

- [ ] **Step 2: Run the focused tests and confirm the registrations are absent.**

```bash
cd apps/api && npx vitest run src/services/tenantCascade.test.ts
cd apps/api && npx vitest run src/services/tenantExportPolicy.test.ts
```

Expected: `report_schedule_recipients` and `portal_self_service` are missing.

- [ ] **Step 3: Add the exact cascade and export entries.**

```ts
// apps/api/src/services/tenantCascade.ts
const CORE_ORG_CASCADE_DELETE_ORDER: ReadonlyArray<string> = Object.freeze([
  // Existing alphabetized entries remain unchanged.
  'recovery_tokens',
  'remediation_suggestions',
  'remote_sessions',
  'report_schedule_recipients',
  'reports',
  'restore_jobs',
  // Remaining entries remain unchanged.
]);
```

`report_runs` stays out of `CORE_ORG_CASCADE_DELETE_ORDER`: it has no `org_id` and is already handled by the explicit pre-clear at `apps/api/src/services/tenantCascade.ts:572-597`. The verified `localeCompare` relationship is `report_runs < report_schedule_recipients < reports`, but only the latter two belong in the core array.

```ts
// apps/api/src/services/tenantExportPolicyRegistry.ts
export const CORE_TENANT_EXPORT_POLICY: TenantExportPolicyRegistry = {
  // Existing entries remain unchanged.
  report_schedule_recipients: tablePolicy('org_id', {
    included: [
      'id',
      'report_id',
      'org_id',
      'contact_id',
      'created_at',
    ],
    reviewedIncluded: [],
    excludedSensitive: [],
    excludedOpen: [],
  }),
  reports: tablePolicy('org_id', {
    included: [
      'id',
      'org_id',
      'name',
      'type',
      'schedule',
      'format',
      'last_generated_at',
      'execution_scope_version',
      'execution_scope_kind',
      'execution_scope_site_ids',
      'execution_scope_user_id',
      'execution_scope_fingerprint',
      'execution_scope_captured_at',
      'execution_scope_principal_kind',
      'source_ai_agent_schedule_id',
      'portal_self_service',
      'created_by',
      'created_at',
      'updated_at',
    ],
    reviewedIncluded: [],
    excludedSensitive: [],
    excludedOpen: ['config'],
  }),
  // Remaining entries remain unchanged.
};
```

Do not add `report_runs` to `CORE_TENANT_EXPORT_POLICY`. As documented at `apps/api/src/services/tenantExportPolicyRegistry.ts:297-303`, it lacks `org_id` and is not a core org-cascade table, so its requester columns do not receive a registry row. Shape 1 is auto-discovered by `rls-coverage.integration.test.ts`; no RLS allowlist changes apply.

- [ ] **Step 4: Run the unit and live-database contracts green.**

```bash
cd apps/api && npx vitest run src/services/tenantCascade.test.ts
cd apps/api && npx vitest run src/services/tenantExportPolicy.test.ts
cd apps/api && npx vitest run -c vitest.integration.config.ts src/__tests__/integration/tenantCascade.integration.test.ts
cd apps/api && npx vitest run -c vitest.integration.config.ts src/__tests__/integration/tenant-export-policy.integration.test.ts
cd apps/api && npx vitest run -c vitest.integration.config.ts src/__tests__/integration/tenantExportErasureRoundtrip.integration.test.ts
```

The integration tests need a live database.

- [ ] **Step 5: Commit the tenancy registrations.**

```bash
git add apps/api/src/services/tenantCascade.ts apps/api/src/services/tenantCascade.test.ts apps/api/src/services/tenantExportPolicyRegistry.ts apps/api/src/services/tenantExportPolicy.test.ts apps/api/src/__tests__/integration/tenantCascade.integration.test.ts apps/api/src/__tests__/integration/tenant-export-policy.integration.test.ts apps/api/src/__tests__/integration/tenantExportErasureRoundtrip.integration.test.ts && git commit -m "feat(portal): register report recipient tenancy"
```

### Task 9.3: Add portal-user report execution authority and provenance

**Files:**

- Modify: `apps/api/src/services/siteScope.ts:39-84,305-526,553-620,744-758`
- Reference: `apps/api/src/routes/reports/core.ts:337-373`
- Modify: `apps/api/src/routes/reports/runs.ts:62-190`
- Modify: `apps/api/src/jobs/reportScheduleWorker.ts:447-675`
- Modify: `apps/api/src/services/aiToolsFleet.ts:2157-2234`
- Modify: `apps/api/src/services/aiAgents/narrativeReport.ts:205-338`
- Test: `apps/api/src/services/siteScope.test.ts`
- Test: `apps/api/src/services/siteScope.projections.test.ts`
- Test: `apps/api/src/routes/reports.test.ts`
- Test: `apps/api/src/routes/reports/runs.systemPrincipal.test.ts`
- Test: `apps/api/src/routes/reports/systemManaged.test.ts`
- Test: `apps/api/src/jobs/reportScheduleWorker.test.ts`
- Test: `apps/api/src/services/aiToolsFleet.siteScope.test.ts`
- Test: `apps/api/src/services/aiAgents/narrativeReport.test.ts`
- Test: `apps/api/src/services/reportGenerationService.test.ts`
- Test: `apps/api/src/services/reportGenerationService.execSummary.test.ts`
- Test: `apps/api/src/services/securityComplianceReport.test.ts`
- Test: `apps/api/src/__tests__/integration/securityComplianceReport.integration.test.ts`

**Interfaces:**

- Consumes: `SiteScopeV1`, `siteScopeFingerprint(scope)`, `reportRuns`
- Produces: `ReportPrincipalKind = 'user' | 'system' | 'portal_user'`
- Produces: `portalUserReportAuthority(orgId: string, capturedAt?: Date): PortalUserReportExecutionAuthority`
- Produces: `persistedSiteScopeValues(authority: ReportExecutionAuthority): PersistedSiteScopeColumns`

- [ ] **Step 1: Write the failing authority and provenance tests.**

```ts
// apps/api/src/services/siteScope.test.ts
describe('portal-user report execution principal', () => {
  it('builds and persists an unrestricted authority without a staff user id', () => {
    const authority = portalUserReportAuthority(ORG_A, CAPTURED_AT);

    expect(authority).toEqual({
      principalKind: 'portal_user',
      scope: {
        version: 1,
        kind: 'unrestricted',
        orgId: ORG_A,
      },
      capturedAt: CAPTURED_AT,
      fingerprint: siteScopeFingerprint(unrestricted()),
    });
    expect(authority).not.toHaveProperty('principalUserId');

    expect(persistedSiteScopeValues(authority)).toEqual({
      executionScopeVersion: 1,
      executionScopeKind: 'unrestricted',
      executionScopeSiteIds: null,
      executionScopeUserId: null,
      executionScopeFingerprint: siteScopeFingerprint(unrestricted()),
      executionScopeCapturedAt: CAPTURED_AT,
      executionScopePrincipalKind: 'portal_user',
    });
  });

  it('decodes a persisted portal-user run as unrestricted', () => {
    expect(decodeSiteScope({
      executionScopeVersion: 1,
      executionScopeKind: 'unrestricted',
      executionScopeSiteIds: null,
      executionScopeUserId: null,
      executionScopeFingerprint: siteScopeFingerprint(unrestricted()),
      executionScopeCapturedAt: CAPTURED_AT,
      executionScopePrincipalKind: 'portal_user',
    }, ORG_A)).toEqual(unrestricted());
  });

  it('rejects a restricted portal-user principal', () => {
    expect(() => decodeSiteScope({
      executionScopeVersion: 1,
      executionScopeKind: 'restricted',
      executionScopeSiteIds: [SITE_A],
      executionScopeUserId: null,
      executionScopeFingerprint: siteScopeFingerprint(restricted([SITE_A])),
      executionScopeCapturedAt: CAPTURED_AT,
      executionScopePrincipalKind: 'portal_user',
    }, ORG_A)).toThrow(/invalid/i);
  });
});
```

```ts
// apps/api/src/services/siteScope.projections.test.ts
import { PgDialect } from 'drizzle-orm/pg-core';
import { reportRuns } from '../db/schema';
import { unrestrictedReportRunScopeSqlPredicate } from './siteScope';

it('keeps a complete portal-authored run visible to an unrestricted reader', () => {
  const portalAuthoredRun = {
    executionScopeUserId: null,
    executionScopePrincipalKind: 'portal_user' as const,
  };
  const query = new PgDialect().sqlToQuery(
    unrestrictedReportRunScopeSqlPredicate(reportRuns),
  );

  expect(portalAuthoredRun.executionScopeUserId).toBeNull();
  const portalUserParameter =
    query.params.indexOf(portalAuthoredRun.executionScopePrincipalKind) + 1;
  expect(portalUserParameter).toBeGreaterThan(0);
  expect(query.sql).toMatch(
    new RegExp(
      `"report_runs"\\."execution_scope_user_id" is null\\s+and\\s+`
        + `"report_runs"\\."execution_scope_principal_kind" = \\$${portalUserParameter}`,
    ),
  );
});
```

```ts
// apps/api/src/routes/reports.test.ts
it('stores human requester provenance for an MSP-generated run', async () => {
  const response = await app.request(`/reports/${REPORT_ID}/generate`, {
    method: 'POST',
  });
  expect(response.status).toBe(200);
  expect(insertValuesMock).toHaveBeenCalledWith(
    expect.objectContaining({
      requestedByKind: 'user',
      requestedByUserId: 'user-123',
      requestedByPortalUserId: null,
    }),
  );
});
```

- [ ] **Step 2: Run the focused tests and confirm `portal_user` and requester fields fail.**

```bash
cd apps/api && npx vitest run src/services/siteScope.test.ts
cd apps/api && npx vitest run src/services/siteScope.projections.test.ts
cd apps/api && npx vitest run src/routes/reports.test.ts
```

Expected: `portalUserReportAuthority` and the portal-user predicate arm are missing, and generated runs do not store requester provenance.

- [ ] **Step 3: Implement the discriminated authority, portal-user SQL visibility, and update every run writer and authority literal.**

```ts
// apps/api/src/services/siteScope.ts
export type ReportPrincipalKind = 'user' | 'system' | 'portal_user';

export interface UserReportExecutionAuthority {
  principalKind: 'user';
  scope: SiteScopeV1;
  principalUserId: string;
  capturedAt: Date;
  fingerprint: string;
}

export interface PortalUserReportExecutionAuthority {
  principalKind: 'portal_user';
  scope: {
    version: 1;
    kind: 'unrestricted';
    orgId: string;
  };
  capturedAt: Date;
  fingerprint: string;
}

export type ReportExecutionAuthority =
  | UserReportExecutionAuthority
  | PortalUserReportExecutionAuthority;

export type LiveReportAuthorityResult =
  | { ok: true; authority: UserReportExecutionAuthority }
  | {
      ok: false;
      reason:
        | 'user_inactive'
        | 'membership_removed'
        | 'permission_removed'
        | 'organization_inaccessible'
        | 'empty_scope'
        | 'unverifiable_scope';
    };

function persistedPrincipalKind(
  row: PersistedSiteScopeColumns,
): ReportPrincipalKind | null {
  const value = row.executionScopePrincipalKind ?? null;
  if (
    value !== null
    && value !== 'user'
    && value !== 'system'
    && value !== 'portal_user'
  ) {
    throw new Error('invalid persisted site scope principal kind');
  }
  return value;
}

export function portalUserReportAuthority(
  orgId: string,
  capturedAt = new Date(),
): PortalUserReportExecutionAuthority {
  assertNonEmptyString(orgId, 'organization ID');
  assertValidDate(capturedAt);
  const scope = {
    version: 1,
    kind: 'unrestricted',
    orgId,
  } as const;
  return {
    principalKind: 'portal_user',
    scope,
    capturedAt,
    fingerprint: siteScopeFingerprint(scope),
  };
}

export function persistedSiteScopeValues(
  authority: ReportExecutionAuthority,
): PersistedSiteScopeColumns {
  assertValidDate(authority.capturedAt);
  const scope = normalizeScope(authority.scope);

  if (authority.fingerprint !== siteScopeFingerprint(scope)) {
    throw new Error('invalid execution scope fingerprint');
  }

  if (authority.principalKind === 'portal_user') {
    if (scope.kind !== 'unrestricted') {
      throw new Error('invalid portal-user execution scope kind');
    }
    return {
      executionScopeVersion: 1,
      executionScopeKind: 'unrestricted',
      executionScopeSiteIds: null,
      executionScopeUserId: null,
      executionScopeFingerprint: authority.fingerprint,
      executionScopeCapturedAt: authority.capturedAt,
      executionScopePrincipalKind: 'portal_user',
    };
  }

  assertNonEmptyString(authority.principalUserId, 'principal user ID');
  return {
    executionScopeVersion: 1,
    executionScopeKind: scope.kind,
    executionScopeSiteIds:
      scope.kind === 'restricted' ? scope.siteIds : null,
    executionScopeUserId: authority.principalUserId,
    executionScopeFingerprint: authority.fingerprint,
    executionScopeCapturedAt: authority.capturedAt,
    executionScopePrincipalKind: 'user',
  };
}
```

Update the unrestricted branch of `decodeSiteScope` so both non-human principals require a null staff ID, while restricted and legacy scopes reject both:

```ts
const hasNoStaffPrincipal =
  principalKind === 'system' || principalKind === 'portal_user';

if (row.executionScopeKind === 'unrestricted') {
  if (row.executionScopeSiteIds !== null) {
    throw new Error('partial or invalid persisted unrestricted site scope');
  }
  if (hasNoStaffPrincipal) {
    if (row.executionScopeUserId !== null) {
      throw new Error('invalid persisted non-user site scope principal');
    }
  } else if (row.executionScopeUserId === null) {
    throw new Error('partial or invalid persisted unrestricted site scope');
  }
}

if (
  (row.executionScopeKind === 'restricted'
    || row.executionScopeKind === 'legacy_unscoped')
  && hasNoStaffPrincipal
) {
  throw new Error('invalid persisted non-user site scope kind');
}
```

Mirror the existing system-principal completeness branch at
`apps/api/src/services/siteScope.ts:553-620`, then include the portal-user twin
in `unrestrictedDefinitionPredicate`. This is the predicate consumed by the MSP
recent-runs query at `apps/api/src/routes/reports/core.ts:337-373`:

```ts
function completeVersionOnePortalUserBase(
  columns: ReportScopeColumns,
): SQL<unknown> {
  return and(
    eq(columns.executionScopeVersion, 1),
    isNull(columns.executionScopeUserId),
    eq(columns.executionScopePrincipalKind, 'portal_user'),
    isNotNull(columns.executionScopeFingerprint),
    isNotNull(columns.executionScopeCapturedAt),
  )!;
}

function unrestrictedDefinitionPredicate(
  columns: ReportScopeColumns,
): SQL<unknown> {
  const completeBase = completeVersionOneBase(columns);
  return or(
    and(
      completeBase,
      eq(columns.executionScopeKind, 'unrestricted'),
      isNull(columns.executionScopeSiteIds),
    ),
    // Platform-authored: unrestricted, no acting user, principal 'system'.
    and(
      completeVersionOneSystemBase(columns),
      eq(columns.executionScopeKind, 'unrestricted'),
      isNull(columns.executionScopeSiteIds),
    ),
    // Portal-authored: unrestricted, no MSP acting user, principal 'portal_user'.
    and(
      completeVersionOnePortalUserBase(columns),
      eq(columns.executionScopeKind, 'unrestricted'),
      isNull(columns.executionScopeSiteIds),
    ),
    and(
      completeBase,
      eq(columns.executionScopeKind, 'restricted'),
      isNotNull(columns.executionScopeSiteIds),
    ),
    and(
      eq(columns.executionScopeVersion, 1),
      eq(columns.executionScopeKind, 'legacy_unscoped'),
      isNull(columns.executionScopeSiteIds),
      isNotNull(columns.executionScopeFingerprint),
      isNotNull(columns.executionScopeCapturedAt),
    ),
    and(
      isNull(columns.executionScopeVersion),
      isNull(columns.executionScopeKind),
      isNull(columns.executionScopeSiteIds),
      isNull(columns.executionScopeUserId),
      isNull(columns.executionScopeFingerprint),
      isNull(columns.executionScopeCapturedAt),
      isNull(columns.executionScopePrincipalKind),
    ),
  )!;
}
```

Add `principalKind: 'user'` in `liveAuthority` and the three production staff-authority literals at `reportScheduleWorker.ts:555-560`, `routes/reports/runs.ts:112-117`, and `aiToolsFleet.ts:2187-2192`.

Update **every** `ReportExecutionAuthority` literal in the seven additional test
files. The following is one real before/after example per file; where a file has
more than one literal, apply the same discriminator to all of them.

`apps/api/src/routes/reports/runs.systemPrincipal.test.ts:122-130`:

```ts
// Before
return {
  ok: true,
  authority: {
    scope,
    principalUserId: USER_ID,
    capturedAt: CAPTURED_AT,
    fingerprint: siteScopeFingerprint(scope),
  },
};

// After
return {
  ok: true,
  authority: {
    principalKind: 'user',
    scope,
    principalUserId: USER_ID,
    capturedAt: CAPTURED_AT,
    fingerprint: siteScopeFingerprint(scope),
  },
};
```

`apps/api/src/routes/reports/systemManaged.test.ts:151-159`:

```ts
// Before
return {
  ok: true,
  authority: {
    scope,
    principalUserId: USER_ID,
    capturedAt: CAPTURED_AT,
    fingerprint: siteScopeFingerprint(scope),
  },
};

// After
return {
  ok: true,
  authority: {
    principalKind: 'user',
    scope,
    principalUserId: USER_ID,
    capturedAt: CAPTURED_AT,
    fingerprint: siteScopeFingerprint(scope),
  },
};
```

`apps/api/src/services/aiToolsFleet.siteScope.test.ts:83-95` (also update the
literals whose `principalUserId` is at real lines 373, 464, and 503):

```ts
// Before
authority: {
  scope: auth.allowedSiteIds === undefined
    ? { version: 1, kind: 'unrestricted', orgId }
    : { version: 1, kind: 'restricted', orgId, siteIds: auth.allowedSiteIds },
  principalUserId: auth.user.id,
  capturedAt: new Date('2026-07-25T12:00:00.000Z'),
  fingerprint: auth.allowedSiteIds === undefined ? 'f'.repeat(64) : 'a'.repeat(64),
},

// After
authority: {
  principalKind: 'user',
  scope: auth.allowedSiteIds === undefined
    ? { version: 1, kind: 'unrestricted', orgId }
    : { version: 1, kind: 'restricted', orgId, siteIds: auth.allowedSiteIds },
  principalUserId: auth.user.id,
  capturedAt: new Date('2026-07-25T12:00:00.000Z'),
  fingerprint: auth.allowedSiteIds === undefined ? 'f'.repeat(64) : 'a'.repeat(64),
},
```

`apps/api/src/services/reportGenerationService.test.ts:64-72`:

```ts
// Before
return {
  scope: kind === 'restricted'
    ? { version: 1, kind, orgId, siteIds }
    : { version: 1, kind, orgId },
  principalUserId: USER_ID,
  capturedAt: new Date('2026-07-25T12:00:00.000Z'),
  fingerprint: kind === 'restricted' ? 'a'.repeat(64) : 'f'.repeat(64),
};

// After
return {
  principalKind: 'user',
  scope: kind === 'restricted'
    ? { version: 1, kind, orgId, siteIds }
    : { version: 1, kind, orgId },
  principalUserId: USER_ID,
  capturedAt: new Date('2026-07-25T12:00:00.000Z'),
  fingerprint: kind === 'restricted' ? 'a'.repeat(64) : 'f'.repeat(64),
};
```

`apps/api/src/services/reportGenerationService.execSummary.test.ts:19-24`:

```ts
// Before
const AUTHORITY: ReportExecutionAuthority = {
  scope: { version: 1, kind: 'unrestricted', orgId: ORG },
  principalUserId: '11111111-1111-4111-8111-111111111111',
  capturedAt: new Date('2026-07-25T12:00:00.000Z'),
  fingerprint: 'f'.repeat(64),
};

// After
const AUTHORITY: ReportExecutionAuthority = {
  principalKind: 'user',
  scope: { version: 1, kind: 'unrestricted', orgId: ORG },
  principalUserId: '11111111-1111-4111-8111-111111111111',
  capturedAt: new Date('2026-07-25T12:00:00.000Z'),
  fingerprint: 'f'.repeat(64),
};
```

`apps/api/src/services/securityComplianceReport.test.ts:30-38`:

```ts
// Before
return {
  scope: siteIds === undefined
    ? { version: 1, kind: 'unrestricted', orgId: ORG }
    : { version: 1, kind: 'restricted', orgId: ORG, siteIds },
  principalUserId: USER_ID,
  capturedAt: new Date('2026-07-25T12:00:00.000Z'),
  fingerprint: siteIds === undefined ? 'f'.repeat(64) : 'a'.repeat(64),
};

// After
return {
  principalKind: 'user',
  scope: siteIds === undefined
    ? { version: 1, kind: 'unrestricted', orgId: ORG }
    : { version: 1, kind: 'restricted', orgId: ORG, siteIds },
  principalUserId: USER_ID,
  capturedAt: new Date('2026-07-25T12:00:00.000Z'),
  fingerprint: siteIds === undefined ? 'f'.repeat(64) : 'a'.repeat(64),
};
```

`apps/api/src/__tests__/integration/securityComplianceReport.integration.test.ts:113-118`:

```ts
// Before
const authority: ReportExecutionAuthority = {
  scope,
  principalUserId: envA.user.id,
  capturedAt: new Date(),
  fingerprint: siteScopeFingerprint(scope),
};

// After
const authority: ReportExecutionAuthority = {
  principalKind: 'user',
  scope,
  principalUserId: envA.user.id,
  capturedAt: new Date(),
  fingerprint: siteScopeFingerprint(scope),
};
```

Add requester fields to all production `reportRuns` inserts:

```ts
// apps/api/src/routes/reports/runs.ts
.values({
  reportId: report.id,
  status: 'pending',
  startedAt: new Date(),
  requestedByKind: 'user',
  requestedByUserId: auth.user.id,
  requestedByPortalUserId: null,
  ...persistedSiteScopeValues(executionAuthority),
})
```

```ts
// apps/api/src/jobs/reportScheduleWorker.ts
.values({
  reportId: report.id,
  status: 'running',
  startedAt: new Date(),
  requestedByKind: 'user',
  requestedByUserId: executionAuthority.principalUserId,
  requestedByPortalUserId: null,
  ...persistedSiteScopeValues(executionAuthority),
})
```

```ts
// apps/api/src/services/aiToolsFleet.ts
.values({
  reportId,
  status: 'pending',
  requestedByKind: 'user',
  requestedByUserId: executionAuthority.principalUserId,
  requestedByPortalUserId: null,
  ...persistedSiteScopeValues(executionAuthority),
})
```

```ts
// apps/api/src/services/aiAgents/narrativeReport.ts
.values({
  reportId: definition.id,
  status: 'completed',
  startedAt: generatedAt,
  completedAt: generatedAt,
  rowCount: 0,
  result: { rows: [], rowCount: 0, summary },
  requestedByKind: 'system',
  requestedByUserId: null,
  requestedByPortalUserId: null,
  ...scopeValues,
})
```

Keep `isSystemManagedReportDefinition` at `routes/reports/helpers.ts:133-137` system-specific. A `portal_user` run is customer-initiated, not a system-managed definition.

- [ ] **Step 4: Run the authority, writer, and projection suites green.**

```bash
cd apps/api && npx vitest run src/services/siteScope.test.ts
cd apps/api && npx vitest run src/services/siteScope.projections.test.ts
cd apps/api && npx vitest run src/routes/reports.test.ts
cd apps/api && npx vitest run src/routes/reports/runs.systemPrincipal.test.ts
cd apps/api && npx vitest run src/routes/reports/systemManaged.test.ts
cd apps/api && npx vitest run src/jobs/reportScheduleWorker.test.ts
cd apps/api && npx vitest run src/services/aiToolsFleet.siteScope.test.ts
cd apps/api && npx vitest run src/services/aiAgents/narrativeReport.test.ts
cd apps/api && npx vitest run src/services/reportGenerationService.test.ts
cd apps/api && npx vitest run src/services/reportGenerationService.execSummary.test.ts
cd apps/api && npx vitest run src/services/securityComplianceReport.test.ts
cd apps/api && npx vitest run -c vitest.integration.config.ts src/__tests__/integration/securityComplianceReport.integration.test.ts
cd apps/api && npx tsc --noEmit
```

- [ ] **Step 5: Commit authority and provenance.**

```bash
git add apps/api/src/services/siteScope.ts apps/api/src/services/siteScope.test.ts apps/api/src/services/siteScope.projections.test.ts apps/api/src/routes/reports/runs.ts apps/api/src/routes/reports.test.ts apps/api/src/routes/reports/runs.systemPrincipal.test.ts apps/api/src/routes/reports/systemManaged.test.ts apps/api/src/jobs/reportScheduleWorker.ts apps/api/src/jobs/reportScheduleWorker.test.ts apps/api/src/services/aiToolsFleet.ts apps/api/src/services/aiToolsFleet.siteScope.test.ts apps/api/src/services/aiAgents/narrativeReport.ts apps/api/src/services/aiAgents/narrativeReport.test.ts apps/api/src/services/reportGenerationService.test.ts apps/api/src/services/reportGenerationService.execSummary.test.ts apps/api/src/services/securityComplianceReport.test.ts apps/api/src/__tests__/integration/securityComplianceReport.integration.test.ts && git commit -m "feat(portal): record report requester authority"
```

### Task 9.4: Provision canonical portal report definitions

**Files:**

- Create: `apps/api/src/services/portal/reportsSelfService.ts`
- Create: `apps/api/src/services/portal/reportsSelfService.test.ts`
- Modify: `apps/api/src/routes/orgPortalSettings.ts:18-147`
- Test: `apps/api/src/routes/orgPortalSettings.test.ts`

**Interfaces:**

- Consumes: `persistedSiteScopeValues(authority)`, `siteScopeFingerprint(scope)`
- Produces: `provisionPortalReportDefinitions(args: { orgId: string; createdBy: string }): Promise<void>`
- Produces: `onPortalFlagsChanged(args: { orgId: string; actingUserId: string; before: { enableReports: boolean }; after: { enableReports: boolean } }): Promise<void>`

- [ ] **Step 1: Write the failing provisioning and settings-seam tests.**

```ts
// apps/api/src/services/portal/reportsSelfService.test.ts
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { inserted, selected } = vi.hoisted(() => ({
  inserted: vi.fn(),
  selected: vi.fn(),
}));

vi.mock('../../db', () => ({
  db: {
    insert: vi.fn(() => ({
      values: vi.fn((values) => {
        inserted(values);
        return {
          onConflictDoNothing: vi.fn(() => Promise.resolve()),
        };
      }),
    })),
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => selected()),
      })),
    })),
  },
}));

import { provisionPortalReportDefinitions } from './reportsSelfService';

describe('provisionPortalReportDefinitions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    selected.mockResolvedValue([
      { type: 'executive_summary' },
      { type: 'security_compliance_posture' },
    ]);
  });

  it('inserts the two fixed customer-safe definitions idempotently', async () => {
    await provisionPortalReportDefinitions({
      orgId: '11111111-1111-4111-8111-111111111111',
      createdBy: '22222222-2222-4222-8222-222222222222',
    });

    expect(inserted).toHaveBeenCalledWith([
      expect.objectContaining({
        name: 'Customer portal — Executive summary',
        type: 'executive_summary',
        schedule: 'one_time',
        format: 'pdf',
        portalSelfService: true,
      }),
      expect.objectContaining({
        name: 'Customer portal — Security & compliance posture',
        type: 'security_compliance_posture',
        schedule: 'one_time',
        format: 'pdf',
        portalSelfService: true,
      }),
    ]);
  });
});
```

```ts
// apps/api/src/routes/orgPortalSettings.test.ts
it('provisions definitions only when enableReports flips on', async () => {
  dbSelectResult
    .mockResolvedValueOnce([{ id: ORG_ID }])
    .mockResolvedValueOnce([{ enableReports: false }]);
  dbUpsertReturning.mockResolvedValue([
    { ...FULL_ROW, enableReports: true },
  ]);

  const response = await patch({ enableReports: true });

  expect(response.status).toBe(200);
  expect(onPortalFlagsChangedMock).toHaveBeenCalledWith({
    orgId: ORG_ID,
    actingUserId: 'u-1',
    before: { enableReports: false },
    after: { enableReports: true },
  });
});
```

- [ ] **Step 2: Run both tests and confirm the service and seam are missing.**

```bash
cd apps/api && npx vitest run src/services/portal/reportsSelfService.test.ts
cd apps/api && npx vitest run src/routes/orgPortalSettings.test.ts
```

Expected: the service import fails and the PATCH does not invoke the seam.

- [ ] **Step 3: Implement idempotent definitions and await the flag seam.**

```ts
// apps/api/src/services/portal/reportsSelfService.ts
import { and, eq } from 'drizzle-orm';
import { db } from '../../db';
import { reports } from '../../db/schema';
import {
  persistedSiteScopeValues,
  siteScopeFingerprint,
  type UserReportExecutionAuthority,
} from '../siteScope';

const PORTAL_DEFINITIONS = [
  {
    type: 'executive_summary',
    name: 'Customer portal — Executive summary',
    config: {
      dateRange: { preset: 'last_30_days' },
      filters: { siteIds: [] },
    },
  },
  {
    type: 'security_compliance_posture',
    name: 'Customer portal — Security & compliance posture',
    config: {
      dateRange: { preset: 'last_30_days' },
      sites: [],
      windowDays: 30,
      minPasswordLength: 8,
      maxLocalAdmins: 2,
      maxAvDefinitionsAgeDays: 7,
      maxSecurityStatusAgeDays: 30,
      includeCis: true,
      backupRequired: true,
    },
  },
] as const;

export async function provisionPortalReportDefinitions(args: {
  orgId: string;
  createdBy: string;
}): Promise<void> {
  const scope = {
    version: 1,
    kind: 'unrestricted',
    orgId: args.orgId,
  } as const;
  const authority: UserReportExecutionAuthority = {
    principalKind: 'user',
    principalUserId: args.createdBy,
    scope,
    capturedAt: new Date(),
    fingerprint: siteScopeFingerprint(scope),
  };
  const scopeValues = persistedSiteScopeValues(authority);

  await db.insert(reports).values(
    PORTAL_DEFINITIONS.map((definition) => ({
      orgId: args.orgId,
      name: definition.name,
      type: definition.type,
      config: definition.config,
      schedule: 'one_time' as const,
      format: 'pdf' as const,
      portalSelfService: true,
      createdBy: args.createdBy,
      ...scopeValues,
    })),
  ).onConflictDoNothing({
    target: [reports.orgId, reports.type],
    where: eq(reports.portalSelfService, true),
  });

  const rows = await db.select({ type: reports.type })
    .from(reports)
    .where(and(
      eq(reports.orgId, args.orgId),
      eq(reports.portalSelfService, true),
    ));

  const found = new Set(rows.map((row) => row.type));
  for (const definition of PORTAL_DEFINITIONS) {
    if (!found.has(definition.type)) {
      throw new Error(
        `Failed to provision portal report definition ${definition.type}`,
      );
    }
  }
}
```

```ts
// apps/api/src/routes/orgPortalSettings.ts
import {
  provisionPortalReportDefinitions,
} from '../services/portal/reportsSelfService';

export async function onPortalFlagsChanged(args: {
  orgId: string;
  actingUserId: string;
  before: { enableReports: boolean };
  after: { enableReports: boolean };
}): Promise<void> {
  if (!args.before.enableReports && args.after.enableReports) {
    await provisionPortalReportDefinitions({
      orgId: args.orgId,
      createdBy: args.actingUserId,
    });
  }
}
```

Before the upsert, select the current flag; after the upsert and before the audit/response, invoke the seam:

```ts
const auth = c.get('auth') as AuthContext;
const [before] = await db
  .select({ enableReports: portalBranding.enableReports })
  .from(portalBranding)
  .where(eq(portalBranding.orgId, org.id))
  .limit(1);

const [row] = await db
  .insert(portalBranding)
  .values({ orgId: org.id, ...body })
  .onConflictDoUpdate({
    target: portalBranding.orgId,
    set: { ...body, updatedAt: new Date() },
  })
  .returning(portalSettingsColumns());

await onPortalFlagsChanged({
  orgId: org.id,
  actingUserId: auth.user.id,
  before: { enableReports: before?.enableReports ?? false },
  after: { enableReports: row.enableReports },
});
```

- [ ] **Step 4: Run the provisioning and settings tests green.**

```bash
cd apps/api && npx vitest run src/services/portal/reportsSelfService.test.ts
cd apps/api && npx vitest run src/routes/orgPortalSettings.test.ts
```

- [ ] **Step 5: Commit canonical provisioning.**

```bash
git add apps/api/src/services/portal/reportsSelfService.ts apps/api/src/services/portal/reportsSelfService.test.ts apps/api/src/routes/orgPortalSettings.ts apps/api/src/routes/orgPortalSettings.test.ts && git commit -m "feat(portal): provision customer report definitions"
```

### Task 9.5: Add contact and scheduled-recipient APIs

**Files:**

- Create: `apps/api/src/routes/orgContacts.ts`
- Create: `apps/api/src/routes/orgContacts.test.ts`
- Create: `apps/api/src/routes/reports/recipients.ts`
- Create: `apps/api/src/routes/reports/recipients.test.ts`
- Modify: `apps/api/src/routes/orgs.ts:42-82,2282-2290`
- Modify: `apps/api/src/routes/reports/index.ts:1-14`
- Modify: `apps/api/src/routes/reports/schemas.ts:77-180`

**Interfaces:**

- Consumes: `GET /orgs/organizations/:id/contacts`, `POST /orgs/organizations/:id/contacts`
- Produces: `GET /reports/:id/recipients`
- Produces: `POST /reports/:id/recipients { contactId: string }`
- Produces: `DELETE /reports/:id/recipients/:contactId`
- Produces: `POST /reports/:id/recipients/convert { email: string; name?: string }`

- [ ] **Step 1: Write failing route tests using the neighbouring Drizzle chain pattern.**

```ts
// apps/api/src/routes/reports/recipients.test.ts
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

const { results, inserted, deleted } = vi.hoisted(() => ({
  results: [] as unknown[][],
  inserted: vi.fn(),
  deleted: vi.fn(),
}));

vi.mock('../../db', () => {
  const chain: Record<string, any> = {};
  for (const method of [
    'select',
    'from',
    'innerJoin',
    'where',
    'orderBy',
    'limit',
  ]) {
    chain[method] = vi.fn(() => chain);
  }
  chain.then = (resolve: (value: unknown) => unknown) =>
    Promise.resolve(results.shift() ?? []).then(resolve);

  return {
    db: {
      ...chain,
      insert: vi.fn(() => ({
        values: vi.fn((value) => {
          inserted(value);
          return {
            onConflictDoNothing: vi.fn(() => ({
              returning: vi.fn(() => Promise.resolve([{ id: 'recipient-1' }])),
            })),
          };
        }),
      })),
      delete: vi.fn(() => ({
        where: vi.fn((condition) => {
          deleted(condition);
          return { returning: vi.fn(() => Promise.resolve([{ id: 'recipient-1' }])) };
        }),
      })),
    },
  };
});

vi.mock('./helpers', () => ({
  getReportWithOrgCheck: vi.fn(async () => ({
    id: 'report-1',
    orgId: '11111111-1111-4111-8111-111111111111',
  })),
}));

import { recipientsRoutes } from './recipients';

function app() {
  const hono = new Hono();
  hono.use('*', async (c, next) => {
    c.set('auth', {
      scope: 'organization',
      orgId: '11111111-1111-4111-8111-111111111111',
      user: { id: 'user-1' },
    });
    await next();
  });
  hono.route('/', recipientsRoutes);
  return hono;
}

describe('report recipient routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    results.length = 0;
  });

  it('lists contact-bound recipients', async () => {
    results.push([{
      id: 'recipient-1',
      contactId: 'contact-1',
      name: 'Alex',
      email: 'alex@example.test',
    }]);

    const response = await app().request('/report-1/recipients');
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      data: [{
        id: 'recipient-1',
        contactId: 'contact-1',
        name: 'Alex',
        email: 'alex@example.test',
      }],
    });
  });

  it('rejects a contact from another organization', async () => {
    results.push([]);
    const response = await app().request('/report-1/recipients', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        contactId: '22222222-2222-4222-8222-222222222222',
      }),
    });
    expect(response.status).toBe(404);
    expect(inserted).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run the tests and confirm the routers and schemas are missing.**

```bash
cd apps/api && npx vitest run src/routes/reports/recipients.test.ts
cd apps/api && npx vitest run src/routes/orgContacts.test.ts
```

Expected: imports fail because neither route exists.

- [ ] **Step 3: Implement contact listing/creation and recipient CRUD.**

```ts
// apps/api/src/routes/reports/schemas.ts
export const reportRecipientParamSchema = z.object({
  id: z.string().guid(),
  contactId: z.string().guid().optional(),
});

export const addReportRecipientSchema = z.object({
  contactId: z.string().guid(),
});

export const convertReportRecipientSchema = z.object({
  email: z.string().email().max(320),
  name: z.string().trim().min(1).max(255).optional(),
});
```

```ts
// apps/api/src/routes/orgContacts.ts
import type { Hono } from 'hono';
import { and, asc, eq, isNull } from 'drizzle-orm';
import { z } from 'zod';
import { zValidator } from '../lib/validation';
import { db } from '../db';
import { contacts, organizations } from '../db/schema';
import {
  requireMfa,
  requirePermission,
  requireScope,
  type AuthContext,
} from '../middleware/auth';
import { PERMISSIONS } from '../services/permissions';

const createContactSchema = z.object({
  name: z.string().trim().min(1).max(255).optional(),
  email: z.string().email().max(320),
});

async function resolveOrg(c: any) {
  const auth = c.get('auth') as AuthContext;
  const orgId = c.req.param('id')!;
  if (auth.scope === 'partner' && !auth.canAccessOrg(orgId)) return null;
  const [org] = await db.select({ id: organizations.id })
    .from(organizations)
    .where(and(
      eq(organizations.id, orgId),
      isNull(organizations.deletedAt),
    ))
    .limit(1);
  return org ?? null;
}

export function registerOrgContactsRoutes(orgRoutes: Hono): void {
  const read = requirePermission(
    PERMISSIONS.ORGS_READ.resource,
    PERMISSIONS.ORGS_READ.action,
  );
  const write = requirePermission(
    PERMISSIONS.ORGS_WRITE.resource,
    PERMISSIONS.ORGS_WRITE.action,
  );

  orgRoutes.get(
    '/organizations/:id/contacts',
    requireScope('partner', 'system'),
    read,
    async (c) => {
      const org = await resolveOrg(c);
      if (!org) return c.json({ error: 'Organization not found' }, 404);

      const rows = await db.select({
        id: contacts.id,
        name: contacts.name,
        email: contacts.email,
      }).from(contacts)
        .where(eq(contacts.orgId, org.id))
        .orderBy(asc(contacts.name), asc(contacts.email));

      return c.json({ data: rows });
    },
  );

  orgRoutes.post(
    '/organizations/:id/contacts',
    requireScope('partner', 'system'),
    write,
    requireMfa(),
    zValidator('json', createContactSchema),
    async (c) => {
      const org = await resolveOrg(c);
      if (!org) return c.json({ error: 'Organization not found' }, 404);
      const input = c.req.valid('json');
      const [created] = await db.insert(contacts).values({
        orgId: org.id,
        name: input.name ?? null,
        email: input.email.trim().toLowerCase(),
        createdBy: c.get('auth').user.id,
      }).returning({
        id: contacts.id,
        name: contacts.name,
        email: contacts.email,
      });
      return c.json({ data: created }, 201);
    },
  );
}
```

```ts
// apps/api/src/routes/reports/recipients.ts
import { Hono } from 'hono';
import { and, asc, eq, sql } from 'drizzle-orm';
import { zValidator } from '../../lib/validation';
import { db } from '../../db';
import {
  contacts,
  reportScheduleRecipients,
  reports,
} from '../../db/schema';
import {
  authMiddleware,
  requirePermission,
  requireScope,
} from '../../middleware/auth';
import { PERMISSIONS } from '../../services/permissions';
import { getReportWithOrgCheck } from './helpers';
import {
  addReportRecipientSchema,
  convertReportRecipientSchema,
} from './schemas';

export const recipientsRoutes = new Hono();
recipientsRoutes.use('*', authMiddleware);

const read = requirePermission(
  PERMISSIONS.REPORTS_READ.resource,
  PERMISSIONS.REPORTS_READ.action,
);
const write = requirePermission(
  PERMISSIONS.REPORTS_WRITE.resource,
  PERMISSIONS.REPORTS_WRITE.action,
);

recipientsRoutes.get(
  '/:id/recipients',
  requireScope('organization', 'partner', 'system'),
  read,
  async (c) => {
    const report = await getReportWithOrgCheck(
      c.req.param('id')!,
      c.get('auth'),
    );
    if (!report) return c.json({ error: 'Report not found' }, 404);

    const rows = await db.select({
      id: reportScheduleRecipients.id,
      contactId: contacts.id,
      name: contacts.name,
      email: contacts.email,
    }).from(reportScheduleRecipients)
      .innerJoin(
        contacts,
        and(
          eq(contacts.id, reportScheduleRecipients.contactId),
          eq(contacts.orgId, reportScheduleRecipients.orgId),
        ),
      )
      .where(and(
        eq(reportScheduleRecipients.reportId, report.id),
        eq(reportScheduleRecipients.orgId, report.orgId),
      ))
      .orderBy(asc(contacts.name), asc(contacts.email));

    return c.json({ data: rows });
  },
);

recipientsRoutes.post(
  '/:id/recipients',
  requireScope('organization', 'partner', 'system'),
  write,
  zValidator('json', addReportRecipientSchema),
  async (c) => {
    const report = await getReportWithOrgCheck(
      c.req.param('id')!,
      c.get('auth'),
    );
    if (!report) return c.json({ error: 'Report not found' }, 404);

    const { contactId } = c.req.valid('json');
    const [contact] = await db.select({ id: contacts.id })
      .from(contacts)
      .where(and(
        eq(contacts.id, contactId),
        eq(contacts.orgId, report.orgId),
      ))
      .limit(1);
    if (!contact) return c.json({ error: 'Contact not found' }, 404);

    const [recipient] = await db.insert(reportScheduleRecipients).values({
      reportId: report.id,
      orgId: report.orgId,
      contactId,
    }).onConflictDoNothing().returning();

    return c.json({ data: recipient ?? null }, recipient ? 201 : 200);
  },
);

recipientsRoutes.delete(
  '/:id/recipients/:contactId',
  requireScope('organization', 'partner', 'system'),
  write,
  async (c) => {
    const report = await getReportWithOrgCheck(
      c.req.param('id')!,
      c.get('auth'),
    );
    if (!report) return c.json({ error: 'Report not found' }, 404);

    const rows = await db.delete(reportScheduleRecipients)
      .where(and(
        eq(reportScheduleRecipients.reportId, report.id),
        eq(reportScheduleRecipients.orgId, report.orgId),
        eq(
          reportScheduleRecipients.contactId,
          c.req.param('contactId')!,
        ),
      ))
      .returning({ id: reportScheduleRecipients.id });

    if (rows.length === 0) {
      return c.json({ error: 'Recipient not found' }, 404);
    }
    return c.json({ data: { deleted: true } });
  },
);

recipientsRoutes.post(
  '/:id/recipients/convert',
  requireScope('organization', 'partner', 'system'),
  write,
  zValidator('json', convertReportRecipientSchema),
  async (c) => {
    const report = await getReportWithOrgCheck(
      c.req.param('id')!,
      c.get('auth'),
    );
    if (!report) return c.json({ error: 'Report not found' }, 404);

    const input = c.req.valid('json');
    const email = input.email.trim().toLowerCase();

    const result = await db.transaction(async (tx) => {
      let [contact] = await tx.select({
        id: contacts.id,
        name: contacts.name,
        email: contacts.email,
      }).from(contacts)
        .where(and(
          eq(contacts.orgId, report.orgId),
          sql`lower(${contacts.email}) = ${email}`,
        ))
        .limit(1);

      if (!contact) {
        [contact] = await tx.insert(contacts).values({
          orgId: report.orgId,
          name: input.name ?? null,
          email,
          createdBy: c.get('auth').user.id,
        }).returning({
          id: contacts.id,
          name: contacts.name,
          email: contacts.email,
        });
      }

      await tx.insert(reportScheduleRecipients).values({
        reportId: report.id,
        orgId: report.orgId,
        contactId: contact!.id,
      }).onConflictDoNothing();

      const legacy = Array.isArray(report.config?.emailRecipients)
        ? report.config.emailRecipients.filter(
            (value: unknown) =>
              typeof value !== 'string'
              || value.trim().toLowerCase() !== email,
          )
        : [];

      await tx.update(reports).set({
        config: {
          ...(report.config as Record<string, unknown>),
          emailRecipients: legacy,
        },
        updatedAt: new Date(),
      }).where(and(
        eq(reports.id, report.id),
        eq(reports.orgId, report.orgId),
      ));

      return contact!;
    });

    return c.json({ data: result }, 201);
  },
);
```

Mount `registerOrgContactsRoutes(orgRoutes)` beside the existing portal settings/users registrations in `apps/api/src/routes/orgs.ts:2282-2290`, and mount `recipientsRoutes` before `coreRoutes`:

```ts
// apps/api/src/routes/reports/index.ts
import { recipientsRoutes } from './recipients';

reportRoutes.route('/', dataRoutes);
reportRoutes.route('/', generateRoutes);
reportRoutes.route('/', runsRoutes);
reportRoutes.route('/', recipientsRoutes);
reportRoutes.route('/', coreRoutes);
```

- [ ] **Step 4: Run both route suites green.**

```bash
cd apps/api && npx vitest run src/routes/reports/recipients.test.ts
cd apps/api && npx vitest run src/routes/orgContacts.test.ts
```

- [ ] **Step 5: Commit the recipient APIs.**

```bash
git add apps/api/src/routes/orgContacts.ts apps/api/src/routes/orgContacts.test.ts apps/api/src/routes/orgs.ts apps/api/src/routes/reports/recipients.ts apps/api/src/routes/reports/recipients.test.ts apps/api/src/routes/reports/index.ts apps/api/src/routes/reports/schemas.ts && git commit -m "feat(portal): add report recipient APIs"
```

### Task 9.6: Resolve scheduled recipients from contacts and legacy addresses

**Files:**

- Modify: `apps/api/src/jobs/reportScheduleWorker.ts:23-83,278-285,447-675`
- Test: `apps/api/src/jobs/reportScheduleWorker.test.ts`

**Interfaces:**

- Consumes: `report_schedule_recipients`, `contacts.email`, `config.emailRecipients`
- Produces: `resolveScheduledReportRecipients(args: { reportId: string; orgId: string; config: Record<string, unknown> }): Promise<string[]>`

- [ ] **Step 1: Write the failing worker union test.**

```ts
// apps/api/src/jobs/reportScheduleWorker.test.ts
it('unions contact and legacy recipients, logs null emails, dedupes, and caps at 50', async () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  selectResults.push([
    { contactId: 'contact-a', email: 'Ops@Example.test' },
    { contactId: 'contact-b', email: null },
    ...Array.from({ length: 55 }, (_, index) => ({
      contactId: `contact-${index}`,
      email: `user${index}@example.test`,
    })),
  ]);

  const recipients = await resolveScheduledReportRecipients({
    reportId: 'report-1',
    orgId: '11111111-1111-4111-8111-111111111111',
    config: {
      emailRecipients: [
        'ops@example.test',
        'legacy@example.test',
        'invalid',
      ],
    },
  });

  expect(recipients).toHaveLength(50);
  expect(
    recipients.filter((email) => email.toLowerCase() === 'ops@example.test'),
  ).toHaveLength(1);
  expect(recipients).toContain('legacy@example.test');
  expect(warn).toHaveBeenCalledWith(
    '[ReportScheduleWorker] Recipient contact has no email; skipping',
    expect.objectContaining({
      reportId: 'report-1',
      contactId: 'contact-b',
    }),
  );
});
```

- [ ] **Step 2: Run the worker test and confirm only legacy addresses are returned.**

```bash
cd apps/api && npx vitest run src/jobs/reportScheduleWorker.test.ts
```

Expected: `resolveScheduledReportRecipients` is missing.

- [ ] **Step 3: Implement the org-pinned union and use it for success and failure mail.**

```ts
// apps/api/src/jobs/reportScheduleWorker.ts
import {
  contacts,
  organizations,
  partners,
  reportRuns,
  reportScheduleRecipients,
  reports,
} from '../db/schema';

function validEmail(value: unknown): value is string {
  return typeof value === 'string'
    && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim());
}

export async function resolveScheduledReportRecipients(args: {
  reportId: string;
  orgId: string;
  config: Record<string, unknown>;
}): Promise<string[]> {
  const contactRows = await db.select({
    contactId: contacts.id,
    email: contacts.email,
  }).from(reportScheduleRecipients)
    .innerJoin(
      contacts,
      and(
        eq(contacts.id, reportScheduleRecipients.contactId),
        eq(contacts.orgId, reportScheduleRecipients.orgId),
      ),
    )
    .where(and(
      eq(reportScheduleRecipients.reportId, args.reportId),
      eq(reportScheduleRecipients.orgId, args.orgId),
      eq(contacts.orgId, args.orgId),
    ));

  const candidates: string[] = [];
  for (const row of contactRows) {
    if (!row.email) {
      console.warn(
        '[ReportScheduleWorker] Recipient contact has no email; skipping',
        {
          reportId: args.reportId,
          contactId: row.contactId,
        },
      );
      continue;
    }
    if (validEmail(row.email)) candidates.push(row.email.trim());
  }

  const legacy = args.config.emailRecipients;
  if (Array.isArray(legacy)) {
    candidates.push(
      ...legacy.filter(validEmail).map((email) => email.trim()),
    );
  }

  const deduped = new Map<string, string>();
  for (const email of candidates) {
    const key = email.toLowerCase();
    if (!deduped.has(key)) deduped.set(key, email);
  }

  const resolved = [...deduped.values()];
  if (resolved.length > 50) {
    console.warn(
      '[ReportScheduleWorker] Recipient union exceeds 50; truncating',
      {
        reportId: args.reportId,
        requested: resolved.length,
      },
    );
  }
  return resolved.slice(0, 50);
}
```

Replace both calls at `reportScheduleWorker.ts:617` and `:667`:

```ts
const recipients = await resolveScheduledReportRecipients({
  reportId: report.id,
  orgId: report.orgId,
  config,
});
```

- [ ] **Step 4: Run the worker suite green.**

```bash
cd apps/api && npx vitest run src/jobs/reportScheduleWorker.test.ts
```

- [ ] **Step 5: Commit worker recipient resolution.**

```bash
git add apps/api/src/jobs/reportScheduleWorker.ts apps/api/src/jobs/reportScheduleWorker.test.ts && git commit -m "feat(portal): bind scheduled reports to contacts"
```

### Task 9.7: Add contact recipients to the MSP report builder

**Files:**

- Modify: `apps/web/src/components/reports/ReportBuilder.tsx:70-108,696-810,1174-1345,1965-2105`
- Test: `apps/web/src/components/reports/ReportBuilder.test.tsx`
- Test: `apps/web/src/lib/__tests__/no-silent-mutations.test.ts`
- Modify: `apps/web/src/locales/en/reports.json:287-379,745-777`
- Modify: `apps/web/src/locales/de-DE/reports.json:287-379,745-777`
- Modify: `apps/web/src/locales/es-419/reports.json:287-379,745-777`
- Modify: `apps/web/src/locales/fr-CA/reports.json:287-379,745-777`
- Modify: `apps/web/src/locales/fr-FR/reports.json:287-379,745-777`
- Modify: `apps/web/src/locales/it-IT/reports.json:287-379,745-777`
- Modify: `apps/web/src/locales/pt-BR/reports.json:287-379,745-777`
- Modify: `apps/web/src/locales/tr-TR/reports.json:287-379,745-777`

**Interfaces:**

- Consumes: contact and recipient endpoints from Task 9.5
- Consumes: `runAction<T>(options): Promise<T>` from `apps/web/src/lib/runAction.ts`
- Produces: contact multi-select and explicit legacy-address conversion controls

- [ ] **Step 1: Write the failing builder interaction test.**

```tsx
// apps/web/src/components/reports/ReportBuilder.test.tsx
it('adds a contact and explicitly converts a legacy address', async () => {
  fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
    if (url.includes('/orgs/organizations/org-1/contacts')) {
      return json({
        data: [{
          id: 'contact-1',
          name: 'Alex Customer',
          email: 'alex@example.test',
        }],
      });
    }
    if (url.endsWith('/reports/report-1/recipients')) {
      if (init?.method === 'POST') {
        return json({ data: { id: 'recipient-1' } }, 201);
      }
      return json({ data: [] });
    }
    if (url.endsWith('/reports/report-1/recipients/convert')) {
      return json({
        data: {
          id: 'contact-2',
          name: null,
          email: 'legacy@example.test',
        },
      }, 201);
    }
    return json({});
  });

  render(
    <ReportBuilder
      mode="edit"
      reportId="report-1"
      defaultValues={{
        type: 'executive_summary',
        schedule: 'monthly',
        emailRecipients: ['legacy@example.test'],
      }}
    />,
  );

  await userEvent.click(
    await screen.findByTestId('report-recipient-contact-contact-1'),
  );
  expect(fetchMock).toHaveBeenCalledWith(
    expect.stringContaining('/reports/report-1/recipients'),
    expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ contactId: 'contact-1' }),
    }),
  );

  await userEvent.click(
    screen.getByTestId('report-recipient-convert-legacy@example.test'),
  );
  expect(fetchMock).toHaveBeenCalledWith(
    expect.stringContaining('/reports/report-1/recipients/convert'),
    expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ email: 'legacy@example.test' }),
    }),
  );
});
```

- [ ] **Step 2: Run the component test and confirm the controls are missing.**

```bash
cd apps/web && npx vitest run src/components/reports/ReportBuilder.test.tsx
```

Expected: neither recipient test ID exists.

- [ ] **Step 3: Add the state, `runAction` mutations, controls, and locale keys.**

```tsx
type ContactOption = {
  id: string;
  name: string | null;
  email: string;
};

const [contacts, setContacts] = useState<ContactOption[]>([]);
const [selectedContactIds, setSelectedContactIds] = useState<Set<string>>(
  new Set(),
);

useEffect(() => {
  if (!currentOrgId || !reportId || schedule === 'one_time') return;

  void Promise.all([
    fetchWithAuth(`/orgs/organizations/${currentOrgId}/contacts`),
    fetchWithAuth(`/reports/${reportId}/recipients`),
  ]).then(async ([contactsResponse, recipientsResponse]) => {
    if (contactsResponse.ok) {
      const payload = await contactsResponse.json();
      setContacts(
        (payload.data ?? []).filter(
          (contact: ContactOption) => Boolean(contact.email),
        ),
      );
    }
    if (recipientsResponse.ok) {
      const payload = await recipientsResponse.json();
      setSelectedContactIds(
        new Set(
          (payload.data ?? []).map(
            (recipient: { contactId: string }) => recipient.contactId,
          ),
        ),
      );
    }
  });
}, [currentOrgId, reportId, schedule]);

async function toggleContact(contactId: string): Promise<void> {
  if (!reportId) return;
  const selected = selectedContactIds.has(contactId);
  try {
    await runAction({
      action: () => fetchWithAuth(
        selected
          ? `/reports/${reportId}/recipients/${contactId}`
          : `/reports/${reportId}/recipients`,
        {
          method: selected ? 'DELETE' : 'POST',
          body: selected
            ? undefined
            : JSON.stringify({ contactId }),
        },
      ),
      successMessage: selected
        ? t('reports.reportBuilder.recipients.removed')
        : t('reports.reportBuilder.recipients.added'),
      errorMessage: t('reports.reportBuilder.recipients.updateFailed'),
    });
    setSelectedContactIds((current) => {
      const next = new Set(current);
      if (selected) next.delete(contactId);
      else next.add(contactId);
      return next;
    });
  } catch (error) {
    if (error instanceof ActionError && error.status === 401) return;
    if (!(error instanceof ActionError)) {
      setError(t('reports.reportBuilder.recipients.updateFailed'));
    }
  }
}

async function convertLegacyRecipient(email: string): Promise<void> {
  if (!reportId) return;
  try {
    const data = await runAction<{ data: ContactOption }>({
      action: () => fetchWithAuth(
        `/reports/${reportId}/recipients/convert`,
        {
          method: 'POST',
          body: JSON.stringify({ email }),
        },
      ),
      successMessage: t('reports.reportBuilder.recipients.converted'),
      errorMessage: t('reports.reportBuilder.recipients.convertFailed'),
    });
    setEmailRecipients((current) =>
      current.filter(
        (value) => value.toLowerCase() !== email.toLowerCase(),
      ),
    );
    setContacts((current) => [
      ...current.filter((contact) => contact.id !== data.data.id),
      data.data,
    ]);
    setSelectedContactIds((current) =>
      new Set([...current, data.data.id]),
    );
  } catch (error) {
    if (error instanceof ActionError && error.status === 401) return;
    if (!(error instanceof ActionError)) {
      setError(t('reports.reportBuilder.recipients.convertFailed'));
    }
  }
}
```

```tsx
<div className="space-y-3">
  <p className="text-xs font-medium text-muted-foreground">
    {t('reports.reportBuilder.recipients.contacts')}
  </p>
  <div className="grid gap-2 sm:grid-cols-2">
    {contacts.map((contact) => (
      <label
        key={contact.id}
        data-testid={`report-recipient-contact-${contact.id}`}
        className="flex items-center gap-2 rounded-md border p-3 text-sm"
      >
        <input
          type="checkbox"
          checked={selectedContactIds.has(contact.id)}
          onChange={() => void toggleContact(contact.id)}
        />
        <span>
          {contact.name || contact.email}
          {contact.name && (
            <span className="block text-xs text-muted-foreground">
              {contact.email}
            </span>
          )}
        </span>
      </label>
    ))}
  </div>

  {emailRecipients.length > 0 && (
    <div>
      <p className="text-xs font-medium text-muted-foreground">
        {t('reports.reportBuilder.recipients.legacy')}
      </p>
      {emailRecipients.map((email) => (
        <div key={email} className="flex items-center justify-between py-2">
          <span className="text-sm">{email}</span>
          <button
            type="button"
            data-testid={`report-recipient-convert-${email}`}
            onClick={() => void convertLegacyRecipient(email)}
            className="text-xs font-medium text-primary"
          >
            {t('reports.reportBuilder.recipients.convert')}
          </button>
        </div>
      ))}
    </div>
  )}
</div>
```

Add this identical key structure to all eight `reports.json` files, with translated values:

```json
{
  "recipients": {
    "contacts": "Organization contacts",
    "legacy": "Legacy email addresses",
    "convert": "Convert to contact",
    "added": "Report recipient added",
    "removed": "Report recipient removed",
    "converted": "Email address converted to a contact",
    "updateFailed": "Could not update the report recipients",
    "convertFailed": "Could not convert this email address"
  },
  "visibleInPortal": "Visible in customer portal"
}
```

- [ ] **Step 4: Run the builder and mutation-visibility tests green.**

```bash
cd apps/web && npx vitest run src/components/reports/ReportBuilder.test.tsx
cd apps/web && npx vitest run src/lib/__tests__/no-silent-mutations.test.ts
cd apps/web && npx vitest run src/lib/i18n/localeParity.test.ts
```

- [ ] **Step 5: Commit the report-builder recipient UI.**

```bash
git add apps/web/src/components/reports/ReportBuilder.tsx apps/web/src/components/reports/ReportBuilder.test.tsx apps/web/src/lib/__tests__/no-silent-mutations.test.ts apps/web/src/locales/*/reports.json && git commit -m "feat(portal): select report recipients from contacts"
```

## Wave W10 — Portal report self-service

### Task 10.1: Implement portal report listing, generation, and rendering

**Files:**

- Modify: `apps/api/src/services/portal/reportsSelfService.ts`
- Modify: `apps/api/src/services/reportBranding.ts:21-47`
- Test: `apps/api/src/services/portal/reportsSelfService.test.ts`

**Interfaces:**

- Consumes: `generateReport(type, orgId, config, authority): Promise<ReportResult>` from `apps/api/src/services/reportGenerationService.ts:600-637`
- Consumes: `buildReportPdf(rows, options)` from `@breeze/shared/reportPdf`
- Consumes: `rowsToCsv(rows)` from `@breeze/shared`, already used at `apps/api/src/routes/reports/runs.ts:408`
- Produces: `listPortalRuns(orgId: string, opts: { page: number; limit: number }): Promise<{ data: PortalRunDto[]; pagination: { page: number; limit: number; total: number } }>`
- Produces: `generatePortalReport(args: { orgId: string; portalUserId: string; type: 'security_compliance_posture' | 'executive_summary' }): Promise<PortalRunDto>`
- Produces: `renderRunPdf(runId: string, orgId: string, timezone: string): Promise<Buffer>`
- Produces: `renderRunCsv(runId: string, orgId: string): Promise<string>`
- Produces: `getReportBranding(orgId: string): Promise<ReportBranding>`

- [ ] **Step 1: Write failing service tests, including compiled org predicates.**

```ts
// apps/api/src/services/portal/reportsSelfService.test.ts
import { PgDialect } from 'drizzle-orm/pg-core';
import { describe, expect, it, vi } from 'vitest';
import {
  portalDefinitionPredicate,
  portalRunPredicate,
} from './reportsSelfService';

const dialect = new PgDialect();
const ORG_ID = '11111111-1111-4111-8111-111111111111';
const RUN_ID = '22222222-2222-4222-8222-222222222222';

describe('portal report SQL scope', () => {
  it('pins canonical definitions to the session org and portal flag', () => {
    const query = dialect.sqlToQuery(
      portalDefinitionPredicate(ORG_ID, 'executive_summary'),
    );
    expect(query.sql).toContain('"reports"."org_id" = $');
    expect(query.sql).toContain('"reports"."portal_self_service" = $');
    expect(query.params).toContain(ORG_ID);
    expect(query.params).toContain(true);
  });

  it('pins run rendering to run id, org id, and portal flag', () => {
    const query = dialect.sqlToQuery(portalRunPredicate(RUN_ID, ORG_ID));
    expect(query.sql).toContain('"report_runs"."id" = $');
    expect(query.sql).toContain('"reports"."org_id" = $');
    expect(query.sql).toContain('"reports"."portal_self_service" = $');
    expect(query.params).toEqual(expect.arrayContaining([
      RUN_ID,
      ORG_ID,
      true,
    ]));
  });
});

describe('generatePortalReport', () => {
  it('stores portal-user provenance and waits for generation', async () => {
    definitionRows.push([{
      id: 'report-1',
      orgId: ORG_ID,
      type: 'executive_summary',
      name: 'Customer portal — Executive summary',
      config: {},
    }]);
    generateReportMock.mockResolvedValue({
      rows: [{ name: 'Device 1' }],
      rowCount: 1,
      generatedAt: '2026-09-02T12:00:00.000Z',
    });

    const result = await generatePortalReport({
      orgId: ORG_ID,
      portalUserId: '33333333-3333-4333-8333-333333333333',
      type: 'executive_summary',
    });

    expect(insertValuesMock).toHaveBeenCalledWith(
      expect.objectContaining({
        requestedByKind: 'portal_user',
        requestedByUserId: null,
        requestedByPortalUserId:
          '33333333-3333-4333-8333-333333333333',
        executionScopePrincipalKind: 'portal_user',
        executionScopeUserId: null,
      }),
    );
    expect(generateReportMock).toHaveBeenCalledTimes(1);
    expect(result.status).toBe('completed');
  });
});
```

- [ ] **Step 2: Run the service test and confirm query builders and generation are missing.**

```bash
cd apps/api && npx vitest run src/services/portal/reportsSelfService.test.ts
```

Expected: the four W10 functions and both predicate builders are absent.

- [ ] **Step 3: Implement the service, state-backend limiter, and renderers.**

```ts
// apps/api/src/services/portal/reportsSelfService.ts
import {
  and,
  count,
  desc,
  eq,
} from 'drizzle-orm';
import { buildReportPdf } from '@breeze/shared/reportPdf';
import {
  rowsToCsv,
  type PortalRunDto,
} from '@breeze/shared';
import { db } from '../../db';
import { reportRuns, reports } from '../../db/schema';
import { getRedis } from '../redis';
import {
  generateReport,
  previousBaselineFor,
  type ReportResult,
} from '../reportGenerationService';
import {
  persistedSiteScopeValues,
  portalUserReportAuthority,
} from '../siteScope';
import {
  checkRateLimit,
} from '../../routes/portal/helpers';
import {
  PORTAL_USE_REDIS,
} from '../../routes/portal/schemas';
import {
  getReportBranding,
} from '../reportBranding';

// Keep PORTAL_DEFINITIONS and provisionPortalReportDefinitions from W09.

export const PORTAL_REPORT_TYPES = [
  'security_compliance_posture',
  'executive_summary',
] as const;

export type PortalReportType = typeof PORTAL_REPORT_TYPES[number];

export class PortalReportNotFoundError extends Error {
  constructor() {
    super('Portal report not found');
    this.name = 'PortalReportNotFoundError';
  }
}

export class PortalReportRateLimitError extends Error {
  constructor(readonly retryAfterSeconds: number) {
    super('Portal report generation is rate limited');
    this.name = 'PortalReportRateLimitError';
  }
}

const inFlightUntil = new Map<string, number>();
const IN_FLIGHT_TTL_SECONDS = 15 * 60;

export function portalDefinitionPredicate(
  orgId: string,
  type: PortalReportType,
) {
  return and(
    eq(reports.orgId, orgId),
    eq(reports.type, type),
    eq(reports.portalSelfService, true),
  )!;
}

export function portalRunPredicate(runId: string, orgId: string) {
  return and(
    eq(reportRuns.id, runId),
    eq(reports.orgId, orgId),
    eq(reports.portalSelfService, true),
  )!;
}

function toDto(row: {
  id: string;
  reportId: string;
  name: string;
  type: PortalReportType;
  status: 'pending' | 'running' | 'completed' | 'failed';
  startedAt: Date | null;
  completedAt: Date | null;
  rowCount: number | null;
  createdAt: Date;
}): PortalRunDto {
  return {
    id: row.id,
    reportId: row.reportId,
    name: row.name,
    type: row.type,
    status: row.status,
    startedAt: row.startedAt?.toISOString() ?? null,
    completedAt: row.completedAt?.toISOString() ?? null,
    rowCount: row.rowCount,
    createdAt: row.createdAt.toISOString(),
  };
}

async function acquireInFlight(key: string): Promise<() => Promise<void>> {
  const redis = PORTAL_USE_REDIS ? getRedis() : null;
  const token = crypto.randomUUID();

  if (redis) {
    const acquired = await redis.set(
      key,
      token,
      'EX',
      IN_FLIGHT_TTL_SECONDS,
      'NX',
    );
    if (acquired !== 'OK') throw new PortalReportRateLimitError(30);
    return async () => {
      await redis.eval(
        'if redis.call("get", KEYS[1]) == ARGV[1] then '
          + 'return redis.call("del", KEYS[1]) else return 0 end',
        1,
        key,
        token,
      );
    };
  }

  const now = Date.now();
  const expiresAt = inFlightUntil.get(key) ?? 0;
  if (expiresAt > now) throw new PortalReportRateLimitError(30);
  inFlightUntil.set(key, now + IN_FLIGHT_TTL_SECONDS * 1000);
  return async () => {
    inFlightUntil.delete(key);
  };
}

export async function listPortalRuns(
  orgId: string,
  opts: { page: number; limit: number },
): Promise<{
  data: PortalRunDto[];
  pagination: { page: number; limit: number; total: number };
}> {
  const page = Math.max(1, opts.page);
  const limit = Math.min(100, Math.max(1, opts.limit));
  const offset = (page - 1) * limit;
  const where = and(
    eq(reports.orgId, orgId),
    eq(reports.portalSelfService, true),
    eq(reportRuns.status, 'completed'),
  );

  const [totalRow] = await db.select({ total: count() })
    .from(reportRuns)
    .innerJoin(reports, eq(reportRuns.reportId, reports.id))
    .where(where);

  const rows = await db.select({
    id: reportRuns.id,
    reportId: reportRuns.reportId,
    name: reports.name,
    type: reports.type,
    status: reportRuns.status,
    startedAt: reportRuns.startedAt,
    completedAt: reportRuns.completedAt,
    rowCount: reportRuns.rowCount,
    createdAt: reportRuns.createdAt,
  }).from(reportRuns)
    .innerJoin(reports, eq(reportRuns.reportId, reports.id))
    .where(where)
    .orderBy(desc(reportRuns.completedAt), desc(reportRuns.id))
    .limit(limit)
    .offset(offset);

  return {
    data: rows.map((row) => toDto(row as Parameters<typeof toDto>[0])),
    pagination: {
      page,
      limit,
      total: Number(totalRow?.total ?? 0),
    },
  };
}

export async function generatePortalReport(args: {
  orgId: string;
  portalUserId: string;
  type: PortalReportType;
}): Promise<PortalRunDto> {
  const [definition] = await db.select({
    id: reports.id,
    orgId: reports.orgId,
    name: reports.name,
    type: reports.type,
    config: reports.config,
  }).from(reports)
    .where(portalDefinitionPredicate(args.orgId, args.type))
    .limit(1);

  if (!definition) throw new PortalReportNotFoundError();

  const inFlightKey =
    `portal:report:in-flight:${args.orgId}:${args.type}`;
  const release = await acquireInFlight(inFlightKey);

  try {
    const rate = await checkRateLimit(
      `report-generation:org:${args.orgId}`,
      {
        windowMs: 60 * 60 * 1000,
        maxAttempts: 5,
        blockMs: 60 * 60 * 1000,
      },
    );
    if (!rate.allowed) {
      throw new PortalReportRateLimitError(rate.retryAfterSeconds);
    }

    const startedAt = new Date();
    const authority = portalUserReportAuthority(args.orgId, startedAt);
    const [run] = await db.insert(reportRuns).values({
      reportId: definition.id,
      status: 'running',
      startedAt,
      requestedByKind: 'portal_user',
      requestedByUserId: null,
      requestedByPortalUserId: args.portalUserId,
      ...persistedSiteScopeValues(authority),
    }).returning();

    if (!run) throw new Error('Failed to create portal report run');

    try {
      const result = await generateReport(
        definition.type,
        args.orgId,
        (definition.config ?? {}) as Record<string, unknown>,
        authority,
      );
      const previous = await previousBaselineFor(
        definition.id,
        authority.fingerprint,
      );
      if (previous) result.previous = previous;

      const completedAt = new Date();
      const rowCount = result.rowCount
        ?? (Array.isArray(result.rows) ? result.rows.length : 0);
      const [completed] = await db.update(reportRuns).set({
        status: 'completed',
        completedAt,
        rowCount,
        result,
        outputUrl: `/api/v1/portal/reports/runs/${run.id}/pdf`,
      }).where(eq(reportRuns.id, run.id)).returning();

      return toDto({
        ...completed!,
        name: definition.name,
        type: definition.type as PortalReportType,
      });
    } catch (error) {
      const [failed] = await db.update(reportRuns).set({
        status: 'failed',
        completedAt: new Date(),
        errorMessage:
          error instanceof Error ? error.message : 'Report generation failed',
      }).where(eq(reportRuns.id, run.id)).returning();

      return toDto({
        ...failed!,
        name: definition.name,
        type: definition.type as PortalReportType,
      });
    }
  } finally {
    await release();
  }
}

async function completedRun(runId: string, orgId: string) {
  const [row] = await db.select({
    id: reportRuns.id,
    type: reports.type,
    result: reportRuns.result,
    completedAt: reportRuns.completedAt,
  }).from(reportRuns)
    .innerJoin(reports, eq(reportRuns.reportId, reports.id))
    .where(and(
      portalRunPredicate(runId, orgId),
      eq(reportRuns.status, 'completed'),
    ))
    .limit(1);

  if (!row) throw new PortalReportNotFoundError();
  return row;
}

export async function renderRunPdf(
  runId: string,
  orgId: string,
  timezone: string,
): Promise<Buffer> {
  const row = await completedRun(runId, orgId);
  const result = row.result as ReportResult | null;
  if (!result) throw new Error('Report result is unavailable');

  const branding = await getReportBranding(orgId);
  const generatedAt = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(row.completedAt ?? new Date());

  const document = buildReportPdf(result.rows ?? [], {
    reportType: row.type,
    generatedAt,
    timezone,
    summary: result.summary,
    previous: result.previous,
    branding,
  });
  return Buffer.from(document.output('arraybuffer'));
}

export async function renderRunCsv(
  runId: string,
  orgId: string,
): Promise<string> {
  const row = await completedRun(runId, orgId);
  const result = row.result as ReportResult | null;
  if (!result || !Array.isArray(result.rows)) {
    throw new Error('Report has no tabular result');
  }
  return rowsToCsv(result.rows);
}
```

```ts
// apps/api/src/services/reportBranding.ts
export async function getReportBranding(
  orgId: string,
): Promise<ReportBranding> {
  return loadReportBrandingForOrg(orgId);
}
```

- [ ] **Step 4: Run the complete self-service service test green.**

```bash
cd apps/api && npx vitest run src/services/portal/reportsSelfService.test.ts
```

- [ ] **Step 5: Commit the report service.**

```bash
git add apps/api/src/services/portal/reportsSelfService.ts apps/api/src/services/portal/reportsSelfService.test.ts apps/api/src/services/reportBranding.ts && git commit -m "feat(portal): generate and render customer reports"
```

### Task 10.2: Expose the portal reports API

**Files:**

- Modify: `apps/api/src/routes/portal/reports.ts` (created and mounted by Part A Task 3.3)
- Create: `apps/api/src/routes/portal/reports.test.ts`
- Modify: `apps/api/src/routes/portal/schemas.ts:88-170`

**Interfaces:**

- Consumes: W10 report service methods from Task 10.1
- Consumes: W03 `portalReportRoutes`, already mounted at `/reports` behind `portalAuthMiddleware` and `createPortalFeatureGateStrict('enableReports')`
- Produces: `GET /api/v1/portal/reports/runs?page&limit`
- Produces: `POST /api/v1/portal/reports/generate`
- Produces: `GET /api/v1/portal/reports/runs/:id/pdf`
- Produces: `GET /api/v1/portal/reports/runs/:id/csv`

- [ ] **Step 1: Write failing route tests for list, generation, 404, 429, and artifacts.**

```ts
// apps/api/src/routes/portal/reports.test.ts
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

const {
  listMock,
  generateMock,
  pdfMock,
  csvMock,
} = vi.hoisted(() => ({
  listMock: vi.fn(),
  generateMock: vi.fn(),
  pdfMock: vi.fn(),
  csvMock: vi.fn(),
}));

vi.mock('../../services/portal/reportsSelfService', async (load) => {
  const actual = await load<
    typeof import('../../services/portal/reportsSelfService)
  >();
  return {
    ...actual,
    listPortalRuns: listMock,
    generatePortalReport: generateMock,
    renderRunPdf: pdfMock,
    renderRunCsv: csvMock,
  };
});

vi.mock('./helpers', async (load) => {
  const actual = await load<typeof import('./helpers')>();
  return {
    ...actual,
    validatePortalCookieCsrfRequest: vi.fn(() => null),
  };
});

import {
  PortalReportNotFoundError,
  PortalReportRateLimitError,
} from '../../services/portal/reportsSelfService';
import { portalReportRoutes } from './reports';

const ORG_ID = '11111111-1111-4111-8111-111111111111';
const PORTAL_USER_ID = '22222222-2222-4222-8222-222222222222';
const RUN_ID = '33333333-3333-4333-8333-333333333333';

function app() {
  const hono = new Hono();
  hono.use('*', async (c, next) => {
    c.set('portalAuth', {
      user: {
        id: PORTAL_USER_ID,
        orgId: ORG_ID,
        email: 'customer@example.test',
        name: 'Customer',
        receiveNotifications: true,
        status: 'active',
      },
      token: 'token',
      authMethod: 'bearer',
      timezone: 'UTC',
    });
    await next();
  });
  hono.route('/reports', portalReportRoutes);
  return hono;
}

describe('portal report routes', () => {
  beforeEach(() => vi.clearAllMocks());

  it('lists only the service result for the session org', async () => {
    listMock.mockResolvedValue({
      data: [{ id: 'run-1', status: 'completed' }],
      pagination: { page: 1, limit: 20, total: 1 },
    });

    const response = await app().request('/reports/runs?page=1&limit=20');
    expect(response.status).toBe(200);
    expect(listMock).toHaveBeenCalledWith(ORG_ID, {
      page: 1,
      limit: 20,
    });
  });

  it('generates synchronously for the portal user', async () => {
    generateMock.mockResolvedValue({
      id: 'run-1',
      status: 'completed',
    });

    const response = await app().request('/reports/generate', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'executive_summary' }),
    });

    expect(response.status).toBe(201);
    expect(generateMock).toHaveBeenCalledWith({
      orgId: ORG_ID,
      portalUserId: PORTAL_USER_ID,
      type: 'executive_summary',
    });
  });

  it('returns 404 when the canonical definition or run is absent', async () => {
    generateMock.mockRejectedValue(new PortalReportNotFoundError());
    const response = await app().request('/reports/generate', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'executive_summary' }),
    });
    expect(response.status).toBe(404);
  });

  it('returns 429 with Retry-After for either limiter', async () => {
    generateMock.mockRejectedValue(new PortalReportRateLimitError(47));
    const response = await app().request('/reports/generate', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'security_compliance_posture' }),
    });
    expect(response.status).toBe(429);
    expect(response.headers.get('Retry-After')).toBe('47');
  });

  it('returns PDF bytes as an attachment', async () => {
    pdfMock.mockResolvedValue(Buffer.from('%PDF-test'));
    const response = await app().request(`/reports/runs/${RUN_ID}/pdf`);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('application/pdf');
    expect(response.headers.get('content-disposition')).toContain(
      'attachment',
    );
    expect(pdfMock).toHaveBeenCalledWith(RUN_ID, ORG_ID, 'UTC');
  });
});
```

- [ ] **Step 2: Run the route test and confirm the W03 router has no handlers yet.**

```bash
cd apps/api && npx vitest run src/routes/portal/reports.test.ts
```

Expected: the W03 `portalReportRoutes` import succeeds, but its empty router returns 404 because the report handlers do not exist yet.

- [ ] **Step 3: Implement schemas, route handlers, error mapping, and caching.**

```ts
// apps/api/src/routes/portal/schemas.ts
export const portalReportListSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

export const portalReportGenerateSchema = z.object({
  type: z.enum([
    'security_compliance_posture',
    'executive_summary',
  ]),
});

export const portalReportRunParamSchema = z.object({
  id: z.string().guid(),
});
```

```ts
// apps/api/src/routes/portal/reports.ts
// Keep the W03 import and `export const portalReportRoutes = new Hono();`.
import { zValidator } from '../../lib/validation';
import {
  generatePortalReport,
  listPortalRuns,
  PortalReportNotFoundError,
  PortalReportRateLimitError,
  renderRunCsv,
  renderRunPdf,
} from '../../services/portal/reportsSelfService';
import {
  applyPortalCacheHeaders,
  buildWeakEtag,
  isEtagFresh,
  validatePortalCookieCsrfRequest,
} from './helpers';
import {
  portalReportGenerateSchema,
  portalReportListSchema,
  portalReportRunParamSchema,
} from './schemas';

portalReportRoutes.get(
  '/runs',
  zValidator('query', portalReportListSchema),
  async (c) => {
    const auth = c.get('portalAuth');
    const query = c.req.valid('query');
    const payload = await listPortalRuns(auth.user.orgId, query);

    applyPortalCacheHeaders(c, {
      scope: 'private',
      browserMaxAgeSeconds: 30,
      staleWhileRevalidateSeconds: 30,
      vary: ['Authorization', 'Cookie'],
    });
    const etag = buildWeakEtag(payload);
    c.header('ETag', etag);
    if (isEtagFresh(c.req.header('if-none-match'), etag)) {
      return new Response(null, {
        status: 304,
        headers: c.res.headers,
      });
    }
    return c.json(payload);
  },
);

portalReportRoutes.post(
  '/generate',
  zValidator('json', portalReportGenerateSchema),
  async (c) => {
    const csrfError = validatePortalCookieCsrfRequest(c);
    if (csrfError) return c.json({ error: csrfError }, 403);

    const auth = c.get('portalAuth');
    try {
      const run = await generatePortalReport({
        orgId: auth.user.orgId,
        portalUserId: auth.user.id,
        type: c.req.valid('json').type,
      });
      return c.json({ data: run }, 201);
    } catch (error) {
      if (error instanceof PortalReportNotFoundError) {
        return c.json({ error: 'Portal report definition not found' }, 404);
      }
      if (error instanceof PortalReportRateLimitError) {
        c.header('Retry-After', String(error.retryAfterSeconds));
        return c.json({
          error: 'Report generation is temporarily limited',
        }, 429);
      }
      throw error;
    }
  },
);

portalReportRoutes.get(
  '/runs/:id/pdf',
  zValidator('param', portalReportRunParamSchema),
  async (c) => {
    const auth = c.get('portalAuth');
    const runId = c.req.valid('param').id;
    try {
      const body = await renderRunPdf(
        runId,
        auth.user.orgId,
        auth.timezone,
      );
      c.header('Content-Type', 'application/pdf');
      c.header(
        'Content-Disposition',
        `attachment; filename="portal-report-${runId}.pdf"`,
      );
      return c.body(body);
    } catch (error) {
      if (error instanceof PortalReportNotFoundError) {
        return c.json({ error: 'Report run not found' }, 404);
      }
      console.error('[portal] PDF report render failed', { runId });
      return c.json({ error: 'Could not render report' }, 500);
    }
  },
);

portalReportRoutes.get(
  '/runs/:id/csv',
  zValidator('param', portalReportRunParamSchema),
  async (c) => {
    const auth = c.get('portalAuth');
    const runId = c.req.valid('param').id;
    try {
      const body = await renderRunCsv(runId, auth.user.orgId);
      c.header('Content-Type', 'text/csv; charset=utf-8');
      c.header(
        'Content-Disposition',
        `attachment; filename="portal-report-${runId}.csv"`,
      );
      return c.body(body);
    } catch (error) {
      if (error instanceof PortalReportNotFoundError) {
        return c.json({ error: 'Report run not found' }, 404);
      }
      console.error('[portal] CSV report render failed', { runId });
      return c.json({ error: 'Could not render report' }, 500);
    }
  },
);
```

Do not edit `apps/api/src/routes/portal/index.ts` here. Part A Task 3.3 already
owns the `/reports/*` authentication and strict feature-gate middleware and the
`portalRoutes.route('/reports', portalReportRoutes)` mount.

- [ ] **Step 4: Run the portal route test green.**

```bash
cd apps/api && npx vitest run src/routes/portal/reports.test.ts
```

- [ ] **Step 5: Commit the reports API.**

```bash
git add apps/api/src/routes/portal/reports.ts apps/api/src/routes/portal/reports.test.ts apps/api/src/routes/portal/schemas.ts && git commit -m "feat(portal): expose customer report endpoints"
```

### Task 10.3: Add the portal Reports page and API client

**Files:**

- Create: `apps/portal/src/pages/reports/index.astro`
- Create: `apps/portal/src/components/portal/ReportRunList.tsx`
- Create: `apps/portal/src/components/portal/ReportRunList.test.tsx`
- Modify: `apps/portal/src/components/portal/index.ts`
- Modify: `apps/portal/src/lib/api.ts:6-10,102-132,291-299,677-723`
- Test: `apps/portal/src/lib/api.test.ts`

**Interfaces:**

- Consumes: `PortalRunDto` from `packages/shared/src/types/portalVisibility.ts`
- Produces: `portalApi.getReportRuns(params?, config?)`
- Produces: `portalApi.generateReport(type, config?)`
- Produces: `portalApi.reportArtifactUrl(runId, format)`
- Produces: data test IDs `portal-reports-generate-posture`, `portal-reports-generate-executive`, `portal-report-run-row-${runId}`

- [ ] **Step 1: Write the failing page component test.**

```tsx
// apps/portal/src/components/portal/ReportRunList.test.tsx
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ReportRunList } from './ReportRunList';

const { generateMock, listMock } = vi.hoisted(() => ({
  generateMock: vi.fn(),
  listMock: vi.fn(),
}));

vi.mock('@/lib/api', () => ({
  portalApi: {
    generateReport: generateMock,
    getReportRuns: listMock,
    reportArtifactUrl: (id: string, format: string) =>
      `/api/v1/portal/reports/runs/${id}/${format}`,
  },
}));

const run = {
  id: 'run-1',
  reportId: 'report-1',
  name: 'Customer portal — Executive summary',
  type: 'executive_summary',
  status: 'completed',
  startedAt: '2026-09-02T12:00:00.000Z',
  completedAt: '2026-09-02T12:01:00.000Z',
  rowCount: 4,
  createdAt: '2026-09-02T12:00:00.000Z',
};

describe('ReportRunList', () => {
  beforeEach(() => vi.clearAllMocks());

  it('generates a report and renders PDF/CSV download links', async () => {
    generateMock.mockResolvedValue({ data: run });
    listMock.mockResolvedValue({ data: [run] });

    render(<ReportRunList initialRuns={[]} />);

    fireEvent.click(
      screen.getByTestId('portal-reports-generate-executive'),
    );

    await waitFor(() => {
      expect(generateMock).toHaveBeenCalledWith('executive_summary');
    });
    expect(
      await screen.findByTestId('portal-report-run-row-run-1'),
    ).toBeInTheDocument();

    expect(
      screen.getByTestId('portal-report-run-pdf-run-1'),
    ).toHaveAttribute(
      'href',
      '/api/v1/portal/reports/runs/run-1/pdf',
    );
    expect(
      screen.getByTestId('portal-report-run-csv-run-1'),
    ).toHaveAttribute(
      'href',
      '/api/v1/portal/reports/runs/run-1/csv',
    );
  });
});
```

- [ ] **Step 2: Run the test and confirm the component and client methods are missing.**

```bash
cd apps/portal && npx vitest run src/components/portal/ReportRunList.test.tsx
```

Expected: `ReportRunList` and the portal API methods cannot be imported.

- [ ] **Step 3: Add the client, SSR page, and interactive run list.**

```ts
// apps/portal/src/lib/api.ts
import type {
  InvoiceStatus,
  PortalRunDto,
  PublicQuoteHeader,
  QuotePresentation,
  TicketFormField,
} from '@breeze/shared';

// Add inside portalApi:
getReportRuns: async (
  params: ListParams = {},
  config: ApiRequestConfig = {},
): Promise<PaginatedResult<PortalRunDto>> => {
  const query = buildQueryString({
    page: params.page ?? 1,
    limit: params.limit ?? 20,
  });
  const response = await apiGet<{
    data: PortalRunDto[];
    pagination: Pagination;
  }>(`/portal/reports/runs${query}`, config);
  return mapPaginatedData(response);
},

generateReport: async (
  type: 'security_compliance_posture' | 'executive_summary',
  config: ApiRequestConfig = {},
): Promise<ApiResponse<PortalRunDto>> => {
  const response = await apiPost<{ data: PortalRunDto }>(
    '/portal/reports/generate',
    { type },
    config,
  );
  if (!response.data) return response;
  return {
    data: response.data.data,
    statusCode: response.statusCode,
    headers: response.headers,
  };
},

reportArtifactUrl: (
  runId: string,
  format: 'pdf' | 'csv',
): PublicApiPath =>
  publicApiPath(`/portal/reports/runs/${runId}/${format}`),
```

```astro
---
// apps/portal/src/pages/reports/index.astro
import PortalLayout from '../../layouts/PortalLayout.astro';
import ReportRunList from '../../components/portal/ReportRunList';
import { portalApi } from '../../lib/api';
import { buildServerApiConfig } from '../../lib/server';
import { redirectToLoginAfter401 } from '../../lib/session';

const response = await portalApi.getReportRuns(
  { page: 1, limit: 20 },
  buildServerApiConfig(Astro.request),
);

if (response.statusCode === 401) {
  return redirectToLoginAfter401(Astro);
}
---

<PortalLayout title="Reports">
  <ReportRunList
    client:load
    initialRuns={response.data ?? []}
    error={response.error}
  />
</PortalLayout>
```

```tsx
// apps/portal/src/components/portal/ReportRunList.tsx
import { useState } from 'react';
import type { PortalRunDto } from '@breeze/shared';
import { portalApi } from '@/lib/api';
import {
  EmptyState,
  ErrorNotice,
  PageHeader,
} from './ui';

export function ReportRunList({
  initialRuns,
  error,
}: {
  initialRuns: PortalRunDto[];
  error?: string | null;
}) {
  const [runs, setRuns] = useState(initialRuns);
  const [busyType, setBusyType] = useState<string | null>(null);
  const [message, setMessage] = useState(error ?? null);

  async function generate(
    type: 'security_compliance_posture' | 'executive_summary',
  ) {
    setBusyType(type);
    setMessage(null);
    const response = await portalApi.generateReport(type);
    if (!response.data) {
      setMessage(response.error ?? 'Could not generate the report.');
      setBusyType(null);
      return;
    }

    const refreshed = await portalApi.getReportRuns({
      page: 1,
      limit: 20,
    });
    setRuns(
      refreshed.data
        ?? (response.data.status === 'completed'
          ? [response.data, ...runs]
          : runs),
    );
    if (response.data.status === 'failed') {
      setMessage('The report could not be generated.');
    }
    setBusyType(null);
  }

  return (
    <div>
      <PageHeader
        title="Reports"
        lede="Generate and download a current summary of your environment."
      />

      <div className="mb-8 flex flex-wrap gap-3">
        <button
          type="button"
          data-testid="portal-reports-generate-posture"
          disabled={busyType !== null}
          onClick={() => void generate('security_compliance_posture')}
          className="rounded-md bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground disabled:opacity-50"
        >
          {busyType === 'security_compliance_posture'
            ? 'Generating…'
            : 'Generate security posture'}
        </button>
        <button
          type="button"
          data-testid="portal-reports-generate-executive"
          disabled={busyType !== null}
          onClick={() => void generate('executive_summary')}
          className="rounded-md border px-4 py-2 text-sm font-semibold disabled:opacity-50"
        >
          {busyType === 'executive_summary'
            ? 'Generating…'
            : 'Generate executive summary'}
        </button>
      </div>

      {message && <ErrorNotice>{message}</ErrorNotice>}

      {runs.length === 0 ? (
        <EmptyState title="No reports yet">
          Generate a report to create the first downloadable snapshot.
        </EmptyState>
      ) : (
        <table
          className="w-full"
          data-testid="portal-report-runs-table"
        >
          <thead>
            <tr>
              <th>Report</th>
              <th>Generated</th>
              <th>Downloads</th>
            </tr>
          </thead>
          <tbody>
            {runs.map((run) => (
              <tr
                key={run.id}
                data-testid={`portal-report-run-row-${run.id}`}
              >
                <td>{run.name}</td>
                <td>
                  {run.completedAt
                    ? new Date(run.completedAt).toLocaleString()
                    : 'Not completed'}
                </td>
                <td>
                  <a
                    data-testid={`portal-report-run-pdf-${run.id}`}
                    href={portalApi.reportArtifactUrl(run.id, 'pdf')}
                    download
                  >
                    PDF
                  </a>
                  <a
                    data-testid={`portal-report-run-csv-${run.id}`}
                    href={portalApi.reportArtifactUrl(run.id, 'csv')}
                    download
                    className="ml-3"
                  >
                    CSV
                  </a>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

export default ReportRunList;
```

- [ ] **Step 4: Run the component and API client tests green.**

```bash
cd apps/portal && npx vitest run src/components/portal/ReportRunList.test.tsx
cd apps/portal && npx vitest run src/lib/api.test.ts
```

- [ ] **Step 5: Commit the portal Reports page.**

```bash
git add apps/portal/src/pages/reports/index.astro apps/portal/src/components/portal/ReportRunList.tsx apps/portal/src/components/portal/ReportRunList.test.tsx apps/portal/src/components/portal/index.ts apps/portal/src/lib/api.ts apps/portal/src/lib/api.test.ts && git commit -m "feat(portal): add customer reports page"
```

### Task 10.4: Mark canonical definitions in the MSP reports list

**Files:**

- Modify: `apps/api/src/routes/reports/core.ts:214-266,611-673`
- Modify: `apps/web/src/components/reports/ReportsList.tsx:31-69,430-568`
- Test: `apps/api/src/routes/reports.test.ts`
- Test: `apps/web/src/components/reports/ReportsList.schedule.test.tsx`
- Modify: `apps/web/src/locales/en/reports.json:287-379`
- Modify: `apps/web/src/locales/de-DE/reports.json:287-379`
- Modify: `apps/web/src/locales/es-419/reports.json:287-379`
- Modify: `apps/web/src/locales/fr-CA/reports.json:287-379`
- Modify: `apps/web/src/locales/fr-FR/reports.json:287-379`
- Modify: `apps/web/src/locales/it-IT/reports.json:287-379`
- Modify: `apps/web/src/locales/pt-BR/reports.json:287-379`
- Modify: `apps/web/src/locales/tr-TR/reports.json:287-379`

**Interfaces:**

- Consumes: `reports.portalSelfService`
- Produces: `Report.portalSelfService: boolean`
- Produces: “Visible in customer portal” badge and read-only actions while enabled

- [ ] **Step 1: Write failing API and component tests.**

```ts
// apps/api/src/routes/reports.test.ts
it('returns portalSelfService and refuses deletion while portal reports are enabled', async () => {
  selectResults.push([{
    id: REPORT_ID,
    orgId: ORG_ID,
    portalSelfService: true,
    enableReports: true,
  }]);

  const response = await app.request(`/reports/${REPORT_ID}`, {
    method: 'DELETE',
  });

  expect(response.status).toBe(409);
  expect(await response.json()).toEqual({
    error: 'portal_self_service_report',
  });
});
```

```tsx
// apps/web/src/components/reports/ReportsList.schedule.test.tsx
it('shows the portal badge and hides mutation actions', async () => {
  fetchMock.mockImplementation(async (url: string) => {
    if (url.endsWith('/reports')) {
      return json({
        data: [{
          ...REPORT,
          portalSelfService: true,
        }],
      });
    }
    return json({ data: [] });
  });

  render(<ReportsList />);

  expect(
    await screen.findByTestId(`report-portal-badge-${REPORT.id}`),
  ).toHaveTextContent('Visible in customer portal');
  expect(
    screen.queryByTestId(`report-delete-${REPORT.id}`),
  ).not.toBeInTheDocument();
  expect(
    screen.queryByTestId(`report-edit-${REPORT.id}`),
  ).not.toBeInTheDocument();
});
```

- [ ] **Step 2: Run both tests and confirm the field and badge are missing.**

```bash
cd apps/api && npx vitest run src/routes/reports.test.ts
cd apps/web && npx vitest run src/components/reports/ReportsList.schedule.test.tsx
```

Expected: the DELETE succeeds and the badge cannot be found.

- [ ] **Step 3: Project the flag, guard deletion, and render the badge.**

Include `portalSelfService: reports.portalSelfService` in report-list/detail projections. Before deletion, load `portalBranding.enableReports` under the same org predicate and reject only when both values are true:

```ts
if (locked.locked.portalSelfService) {
  const [branding] = await tx.select({
    enableReports: portalBranding.enableReports,
  }).from(portalBranding)
    .where(eq(portalBranding.orgId, locked.locked.orgId))
    .limit(1);

  if (branding?.enableReports === true) {
    return { kind: 'portal_self_service' as const };
  }
}
```

Map the result before the delete:

```ts
if (deleted?.kind === 'portal_self_service') {
  return c.json({ error: 'portal_self_service_report' }, 409);
}
```

```tsx
// apps/web/src/components/reports/ReportsList.tsx
export type Report = {
  id: string;
  name: string;
  type: ReportType;
  schedule: ReportSchedule;
  format: ReportFormat;
  config: Record<string, unknown>;
  portalSelfService: boolean;
  lastGeneratedAt: string | null;
  createdAt: string;
  updatedAt: string;
};
```

```tsx
<div className="flex items-center gap-2">
  <FileText className="h-4 w-4 text-muted-foreground" />
  <span className="font-medium">{report.name}</span>
  {report.portalSelfService && (
    <span
      data-testid={`report-portal-badge-${report.id}`}
      className="rounded-full bg-primary/10 px-2 py-0.5 text-xs font-medium text-primary"
    >
      {t('reports.reportsList.visibleInPortal')}
    </span>
  )}
</div>
```

Gate existing Generate/Edit/Delete actions with `!report.portalSelfService`. Add `visibleInPortal` to all eight locale files using the translated equivalent of “Visible in customer portal.”

- [ ] **Step 4: Run API, component, and locale tests green.**

```bash
cd apps/api && npx vitest run src/routes/reports.test.ts
cd apps/web && npx vitest run src/components/reports/ReportsList.schedule.test.tsx
cd apps/web && npx vitest run src/lib/i18n/localeParity.test.ts
```

- [ ] **Step 5: Commit the MSP visibility badge and mutation guard.**

```bash
git add apps/api/src/routes/reports/core.ts apps/api/src/routes/reports.test.ts apps/web/src/components/reports/ReportsList.tsx apps/web/src/components/reports/ReportsList.schedule.test.tsx apps/web/src/locales/*/reports.json && git commit -m "feat(portal): mark customer-visible reports"
```

### Task 10.5: Prove portal report tenancy and the end-to-end customer flow

**Files:**

- Create: `apps/api/src/__tests__/integration/portalReportSelfService.integration.test.ts`
- Create: `e2e-tests/pages/PortalVisibilityPage.ts`
- Create: `e2e-tests/tests/portal-visibility.spec.ts`
- Modify: `e2e-tests/seed-fixtures.sql`
- Modify: `apps/portal/src/components/portal/LoginForm.tsx:61-135`
- Modify: `apps/portal/src/layouts/PortalLayout.astro:76-99`

**Interfaces:**

- Consumes: W03 feature flags and portal navigation
- Consumes: W10 portal reports API/page
- Produces: real-Postgres proof of `requested_by_kind = 'portal_user'`
- Produces: real-Postgres proof that org B cannot render org A’s run
- Produces: Playwright report-generation/download and Devices-nav gating coverage

- [ ] **Step 1: Write the failing integration and Playwright tests.**

```ts
// apps/api/src/__tests__/integration/portalReportSelfService.integration.test.ts
import './setup';
import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import {
  db,
  withDbAccessContext,
  withSystemDbAccessContext,
  type DbAccessContext,
} from '../../db';
import {
  portalUsers,
  reportRuns,
  reports,
} from '../../db/schema';
import {
  createOrganization,
  createPartner,
} from './db-utils';
import {
  generatePortalReport,
  PortalReportNotFoundError,
  renderRunPdf,
} from '../../services/portal/reportsSelfService';
import {
  persistedSiteScopeValues,
  siteScopeFingerprint,
  type UserReportExecutionAuthority,
} from '../../services/siteScope';

const runDb = it.runIf(Boolean(process.env.DATABASE_URL));

function orgContext(orgId: string): DbAccessContext {
  return {
    scope: 'organization',
    orgId,
    accessibleOrgIds: [orgId],
    accessiblePartnerIds: [],
    currentPartnerId: null,
    userId: null,
  };
}

describe('portal report self-service tenancy', () => {
  runDb('stores portal provenance and hides org A PDF from org B', async () => {
    const fixture = await withSystemDbAccessContext(async () => {
      const partner = await createPartner();
      const orgA = await createOrganization({ partnerId: partner.id });
      const orgB = await createOrganization({ partnerId: partner.id });

      const [portalUser] = await db.insert(portalUsers).values({
        orgId: orgA.id,
        email: `portal-${crypto.randomUUID()}@example.test`,
        status: 'active',
      }).returning({ id: portalUsers.id });

      const scope = {
        version: 1,
        kind: 'unrestricted',
        orgId: orgA.id,
      } as const;
      const authority: UserReportExecutionAuthority = {
        principalKind: 'user',
        principalUserId: crypto.randomUUID(),
        scope,
        capturedAt: new Date(),
        fingerprint: siteScopeFingerprint(scope),
      };

      await db.insert(reports).values({
        orgId: orgA.id,
        name: 'Customer portal — Executive summary',
        type: 'executive_summary',
        schedule: 'one_time',
        format: 'pdf',
        config: { dateRange: { preset: 'last_30_days' } },
        portalSelfService: true,
        ...persistedSiteScopeValues(authority),
      });

      return { orgA, orgB, portalUser: portalUser! };
    });

    const generated = await withDbAccessContext(
      orgContext(fixture.orgA.id),
      () => generatePortalReport({
        orgId: fixture.orgA.id,
        portalUserId: fixture.portalUser.id,
        type: 'executive_summary',
      }),
    );

    const [stored] = await withSystemDbAccessContext(() =>
      db.select({
        requestedByKind: reportRuns.requestedByKind,
        requestedByUserId: reportRuns.requestedByUserId,
        requestedByPortalUserId: reportRuns.requestedByPortalUserId,
      }).from(reportRuns).where(eq(reportRuns.id, generated.id)),
    );

    expect(stored).toEqual({
      requestedByKind: 'portal_user',
      requestedByUserId: null,
      requestedByPortalUserId: fixture.portalUser.id,
    });

    await expect(
      withDbAccessContext(orgContext(fixture.orgB.id), () =>
        renderRunPdf(generated.id, fixture.orgB.id, 'UTC'),
      ),
    ).rejects.toBeInstanceOf(PortalReportNotFoundError);
  });
});
```

```ts
// e2e-tests/pages/PortalVisibilityPage.ts
import type { Page } from '@playwright/test';

export class PortalVisibilityPage {
  constructor(private page: Page) {}

  email = () => this.page.getByTestId('portal-login-email');
  password = () => this.page.getByTestId('portal-login-password');
  submit = () => this.page.getByTestId('portal-login-submit');
  dashboardSecurity = () =>
    this.page.getByTestId('portal-dashboard-tile-security');
  generatePosture = () =>
    this.page.getByTestId('portal-reports-generate-posture');
  reportRows = () =>
    this.page.getByTestId(/^portal-report-run-row-/);
  reportsNav = () => this.page.getByTestId('portal-nav-reports');
  devicesNav = () => this.page.getByTestId('portal-nav-devices');

  async login(email: string, password: string): Promise<void> {
    await this.page.goto('/portal/login');
    await this.email().fill(email);
    await this.password().fill(password);
    await this.submit().click();
    await this.page.waitForURL('**/portal/dashboard');
  }
}
```

```ts
// e2e-tests/tests/portal-visibility.spec.ts
import { expect, test } from '../fixtures';
import { PortalVisibilityPage } from '../pages/PortalVisibilityPage';

const email = process.env.E2E_PORTAL_EMAIL ?? 'portal@breeze.local';
const password = process.env.E2E_PORTAL_PASSWORD ?? 'PortalTest123!';

test.describe.serial('portal visibility', () => {
  test('shows seeded dashboard values and downloads a posture PDF', async ({
    cleanPage,
  }) => {
    const portal = new PortalVisibilityPage(cleanPage);
    await portal.login(email, password);

    await expect(portal.dashboardSecurity()).toBeVisible();
    await portal.reportsNav().click();
    await portal.generatePosture().click();

    const row = portal.reportRows().first();
    await expect(row).toBeVisible();

    const downloadPromise = cleanPage.waitForEvent('download');
    await row
      .getByTestId(/^portal-report-run-pdf-/)
      .click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toMatch(/\.pdf$/);
  });

  test('hides Devices when self-service is disabled', async ({
    cleanPage,
  }) => {
    const portal = new PortalVisibilityPage(cleanPage);
    await portal.login(email, password);
    await expect(portal.devicesNav()).toHaveCount(0);
  });
});
```

- [ ] **Step 2: Run the integration and E2E tests and confirm the flow is absent.**

```bash
cd apps/api && npx vitest run -c vitest.integration.config.ts src/__tests__/integration/portalReportSelfService.integration.test.ts
cd e2e-tests && pnpm test tests/portal-visibility.spec.ts
```

The integration test needs a live database. The Playwright test needs the full local stack.

Expected: the integration test fails before the W10 service is complete; the E2E test fails on missing portal selectors/page behavior.

- [ ] **Step 3: Add deterministic fixtures and the required test IDs.**

Add a seeded portal user, branding flags, canonical report definitions, dashboard data, and `enable_self_service = false` to `e2e-tests/seed-fixtures.sql`. Use the repository’s existing password-hash function/fixture value rather than storing plaintext in the database.

```tsx
// apps/portal/src/components/portal/LoginForm.tsx
<input
  id="email"
  data-testid="portal-login-email"
  type="email"
  autoComplete="email"
  {...register('email')}
/>

<input
  id="password"
  data-testid="portal-login-password"
  type="password"
  autoComplete="current-password"
  {...register('password')}
/>

<button
  type="submit"
  data-testid="portal-login-submit"
  disabled={isLoading}
>
  {isLoading ? 'Signing in' : 'Sign in'}
</button>
```

```astro
<!-- apps/portal/src/layouts/PortalLayout.astro -->
<a
  href={withBase(item.href)}
  data-testid={`portal-nav-${item.href.slice(1) || 'home'}`}
  aria-current={isActive(item.href) ? 'page' : undefined}
>
  {item.label}
</a>
```

Ensure the W04 dashboard tile already uses `portal-dashboard-tile-security`, and keep every Playwright selector on `getByTestId`.

- [ ] **Step 4: Run the integration, E2E, and RLS contracts green.**

```bash
cd apps/api && npx vitest run -c vitest.integration.config.ts src/__tests__/integration/portalReportSelfService.integration.test.ts
cd apps/api && npx vitest run -c vitest.integration.config.ts src/__tests__/integration/rls-coverage.integration.test.ts
cd e2e-tests && pnpm test tests/portal-visibility.spec.ts
```

The API integration commands need a live database; Playwright needs the full stack.

- [ ] **Step 5: Commit the tenancy and browser proof.**

```bash
git add apps/api/src/__tests__/integration/portalReportSelfService.integration.test.ts e2e-tests/pages/PortalVisibilityPage.ts e2e-tests/tests/portal-visibility.spec.ts e2e-tests/seed-fixtures.sql apps/portal/src/components/portal/LoginForm.tsx apps/portal/src/layouts/PortalLayout.astro && git commit -m "test(portal): prove report self-service isolation"
```
