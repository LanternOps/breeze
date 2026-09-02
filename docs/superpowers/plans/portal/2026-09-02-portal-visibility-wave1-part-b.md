# Customer Portal Visibility — Wave 1 Plan, Part B (W04–W08: dashboard, security, backups, devices, support usage)

> Part of `docs/superpowers/plans/portal/2026-09-02-portal-visibility-wave1.md` — read that file's **Global Constraints** and **File Structure** first; every task below inherits them. Spec: `docs/superpowers/specs/portal/2026-09-02-portal-visibility-wave1-design.md`.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

---

## Wave W04 — Dashboard API + page

### Task 4.1: Implement dashboard tile read models

**Files:**
- Create `apps/api/src/services/portal/securityReadModel.test.ts`
- Create `apps/api/src/services/portal/patchReadModel.test.ts`
- Create `apps/api/src/services/portal/backupReadModel.test.ts`
- Create `apps/api/src/services/portal/ticketReadModel.test.ts`
- Create `apps/api/src/services/portal/actionItemsReadModel.test.ts`
- Modify `apps/api/src/services/portal/securityReadModel.ts:1-end` (W02 scaffold)
- Modify `apps/api/src/services/portal/patchReadModel.ts:1-end` (W02 scaffold)
- Modify `apps/api/src/services/portal/backupReadModel.ts:1-end` (W02 scaffold)
- Modify `apps/api/src/services/portal/ticketReadModel.ts:1-end` (W02 scaffold)
- Modify `apps/api/src/services/portal/actionItemsReadModel.ts:1-end` (W02 scaffold)
- Test `apps/api/src/services/portal/securityReadModel.test.ts`
- Test `apps/api/src/services/portal/patchReadModel.test.ts`
- Test `apps/api/src/services/portal/backupReadModel.test.ts`
- Test `apps/api/src/services/portal/ticketReadModel.test.ts`
- Test `apps/api/src/services/portal/actionItemsReadModel.test.ts`

**Interfaces:**
- Consumes `classifyDeviceProtection(input: { securityStatus: { provider: string; realTimeProtection: boolean | null; updatedAt: Date } | null; hasS1Agent: boolean; hasHuntressAgent: boolean; now: Date; maxSecurityStatusAgeDays: number }): ProtectionState`
- Consumes `securityCompliancePostureConfigSchema` from `apps/api/src/routes/reports/schemas.ts:38-56` so the portal uses the report's real `maxSecurityStatusAgeDays` default instead of duplicating `30`
- Produces one shared `portalMonthWindow(now, timezone)` SQL boundary for patch and support month-to-date queries
- Consumes `getSecurityPostureTrend(params: { orgId?: string; orgIds?: string[]; days: number })` from `apps/api/src/services/securityPosture.ts:1077-1121`
- Consumes `OUTSTANDING_DEVICE_PATCH_STATUSES` from `apps/api/src/db/schema/patches.ts:53-68`
- Consumes `security_status.provider`, `real_time_protection`, and `updated_at` from `apps/api/src/db/schema/security.ts:53-79`
- Consumes `security_posture_org_snapshots.overall_score`, `captured_at`, and `top_issues` from `apps/api/src/db/schema/security.ts:161-184`
- Consumes S1 and Huntress device evidence from `apps/api/src/db/schema/sentinelOne.ts:41-58` and `apps/api/src/db/schema/huntress.ts:79-95`
- Consumes installed patch evidence from `apps/api/src/db/schema/patches.ts:111-141,193-219`
- Consumes backup configuration/job/verification evidence from `apps/api/src/db/schema/backup.ts:109-145,207-278` and `apps/api/src/db/schema/backupVerification.ts:16-35`
- Consumes ticket timestamps and soft-delete state from `apps/api/src/db/schema/portal.ts:76-133`
- Consumes action-item states from `apps/api/src/db/schema/fleetFindings.ts:16-47` and `apps/api/src/db/schema/remediationSuggestions.ts:25-63`
- Produces `securityScoreTile(orgId: string, now: Date)`
- Produces `devicesProtectedTile(orgId: string, now: Date)`
- Produces `patchesAppliedTile(orgId: string, args: { timezone: string; now: Date })`
- Produces `backupTile(orgId: string, now: Date)`
- Produces `supportTile(orgId: string, args: { timezone: string; now: Date })`
- Produces `actionItemsTile(orgId: string, now: Date)`

- [ ] **Step 1: Write failing compiled-SQL and DTO tests for all dashboard tiles.**

```ts
// apps/api/src/services/portal/securityReadModel.test.ts
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';

const state = vi.hoisted(() => ({
  rows: [] as unknown[][],
  wheres: [] as unknown[],
}));

const posture = vi.hoisted(() => ({
  trend: vi.fn(),
}));

vi.mock('../securityPosture', () => ({
  getSecurityPostureTrend: posture.trend,
}));

vi.mock('../../db', () => ({
  db: {
    select: vi.fn(() => {
      const chain: Record<string, unknown> = {};
      for (const method of ['from', 'leftJoin', 'innerJoin', 'where', 'groupBy', 'orderBy', 'limit']) {
        chain[method] = vi.fn((arg: unknown) => {
          if (method === 'where') state.wheres.push(arg);
          return chain;
        });
      }
      chain.then = (resolve: (rows: unknown[]) => unknown) =>
        Promise.resolve(state.rows.shift() ?? []).then(resolve);
      return chain;
    }),
  },
}));

import { devicesProtectedTile, securityScoreTile } from './securityReadModel';

const ORG_ID = '11111111-1111-4111-8111-111111111111';
const NOW = new Date('2026-09-02T12:00:00Z');
const dialect = new PgDialect();

function compiledWheres() {
  return state.wheres.map((where) => dialect.sqlToQuery(where as SQL));
}

describe('dashboard security tiles', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.rows.length = 0;
    state.wheres.length = 0;
    posture.trend.mockResolvedValue([]);
  });

  it('returns the latest score, PDF band, 30-day delta, and stale status', async () => {
    state.rows.push([
      { overallScore: 82, capturedAt: new Date('2026-09-02T11:00:00Z') },
    ]);
    posture.trend.mockResolvedValue([
      { timestamp: '2026-08-03', overall: 74 },
      { timestamp: '2026-09-02', overall: 82 },
    ]);

    await expect(securityScoreTile(ORG_ID, NOW)).resolves.toEqual({
      status: 'ok',
      score: 82,
      band: 'strong',
      delta30d: 8,
      capturedAt: '2026-09-02T11:00:00.000Z',
    });

    expect(
      compiledWheres().some(({ sql, params }) =>
        sql.includes('"security_posture_org_snapshots"."org_id" =') &&
        params.includes(ORG_ID)),
    ).toBe(true);
  });

  it('classifies protected, unprotected, and unknown devices', async () => {
    state.rows.push([
      {
        id: 'd-protected',
        realTimeProtection: true,
        provider: 'windows_defender',
        avProducts: [{
          displayName: 'Defender',
          provider: 'windows_defender',
        }],
        securityUpdatedAt: new Date('2026-09-02T10:00:00Z'),
        hasS1Agent: false,
        hasHuntressAgent: false,
      },
      {
        id: 'd-unknown',
        realTimeProtection: false,
        avProducts: [],
        securityUpdatedAt: new Date('2026-07-01T00:00:00Z'),
        hasS1Agent: false,
        hasHuntressAgent: false,
      },
    ]);

    await expect(devicesProtectedTile(ORG_ID, NOW)).resolves.toEqual({
      status: 'ok',
      protected: 1,
      unprotected: 0,
      unknown: 1,
      total: 2,
      asOf: NOW.toISOString(),
    });

    const compiled = compiledWheres();
    expect(compiled.some(({ params }) => params.includes(ORG_ID))).toBe(true);
    expect(compiled.some(({ sql }) => sql.includes('"devices"."org_id" ='))).toBe(true);
  });

  it('returns no_data instead of a fabricated score or count', async () => {
    state.rows.push([]);
    await expect(securityScoreTile(ORG_ID, NOW)).resolves.toEqual({
      status: 'no_data',
      score: null,
      band: null,
      delta30d: null,
      capturedAt: null,
    });
  });
});
```

```ts
// apps/api/src/services/portal/patchReadModel.test.ts
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';

const state = vi.hoisted(() => ({
  rows: [] as unknown[][],
  wheres: [] as unknown[],
}));

vi.mock('../../db', () => ({
  db: {
    select: vi.fn(() => {
      const chain: Record<string, unknown> = {};
      for (const method of ['from', 'innerJoin', 'where', 'groupBy']) {
        chain[method] = vi.fn((arg: unknown) => {
          if (method === 'where') state.wheres.push(arg);
          return chain;
        });
      }
      chain.then = (resolve: (rows: unknown[]) => unknown) =>
        Promise.resolve(state.rows.shift() ?? []).then(resolve);
      return chain;
    }),
  },
}));

import { patchesAppliedTile } from './patchReadModel';

const ORG_ID = '11111111-1111-4111-8111-111111111111';

describe('patchesAppliedTile', () => {
  beforeEach(() => {
    state.rows.length = 0;
    state.wheres.length = 0;
  });

  it('returns month-to-date installs and critical outstanding devices', async () => {
    state.rows.push([{ applied: 41 }], [{ devicesWithOutstandingCritical: 3 }]);

    await expect(
      patchesAppliedTile(ORG_ID, {
        timezone: 'America/Denver',
        now: new Date('2026-09-02T12:00:00Z'),
      }),
    ).resolves.toEqual({
      status: 'ok',
      applied: 41,
      devicesWithOutstandingCritical: 3,
      month: '2026-09',
      timezone: 'America/Denver',
      asOf: '2026-09-02T12:00:00.000Z',
    });

    const compiled = state.wheres.map((where) =>
      new PgDialect().sqlToQuery(where as SQL),
    );
    expect(compiled).toHaveLength(2);
    expect(compiled[0]!.sql).toContain('date_trunc');
    for (const query of compiled) {
      expect(query.sql).toContain('"device_patches"."org_id" =');
      expect(query.params).toContain(ORG_ID);
    }
  });
});
```

```ts
// apps/api/src/services/portal/backupReadModel.test.ts
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';

const state = vi.hoisted(() => ({
  rows: [] as unknown[][],
  wheres: [] as unknown[],
}));

vi.mock('../../db', () => ({
  db: {
    select: vi.fn(() => {
      const chain: Record<string, unknown> = {};
      for (const method of ['from', 'innerJoin', 'leftJoin', 'where', 'orderBy', 'limit']) {
        chain[method] = vi.fn((arg: unknown) => {
          if (method === 'where') state.wheres.push(arg);
          return chain;
        });
      }
      chain.then = (resolve: (rows: unknown[]) => unknown) =>
        Promise.resolve(state.rows.shift() ?? []).then(resolve);
      return chain;
    }),
  },
}));

import { backupTile } from './backupReadModel';

const ORG_ID = '11111111-1111-4111-8111-111111111111';

describe('backupTile', () => {
  beforeEach(() => {
    state.rows.length = 0;
    state.wheres.length = 0;
  });

  it('returns latest passed verification and configured-device counts', async () => {
    state.rows.push(
      [{ total: 10 }],
      [{ configured: 7 }],
      [{
        completedAt: new Date('2026-09-02T09:00:00Z'),
        verificationType: 'test_restore',
      }],
    );

    const now = new Date('2026-09-02T12:00:00Z');
    await expect(backupTile(ORG_ID, now)).resolves.toEqual({
      status: 'ok',
      completedAt: '2026-09-02T09:00:00.000Z',
      verificationType: 'test_restore',
      configured: 7,
      total: 10,
      asOf: now.toISOString(),
    });

    for (const where of state.wheres) {
      const query = new PgDialect().sqlToQuery(where as SQL);
      expect(query.params).toContain(ORG_ID);
    }
  });

  it('returns not_configured when no active config has device evidence', async () => {
    state.rows.push([{ total: 10 }], [{ configured: 0 }], []);
    const now = new Date('2026-09-02T12:00:00Z');
    await expect(backupTile(ORG_ID, now)).resolves.toMatchObject({
      status: 'not_configured',
      completedAt: null,
      configured: 0,
      total: 10,
      asOf: now.toISOString(),
    });
  });
});
```

```ts
// apps/api/src/services/portal/ticketReadModel.test.ts
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';

const state = vi.hoisted(() => ({
  rows: [] as unknown[][],
  wheres: [] as unknown[],
}));

vi.mock('../../db', () => ({
  db: {
    select: vi.fn(() => {
      const chain: Record<string, unknown> = {};
      for (const method of ['from', 'where']) {
        chain[method] = vi.fn((arg: unknown) => {
          if (method === 'where') state.wheres.push(arg);
          return chain;
        });
      }
      chain.then = (resolve: (rows: unknown[]) => unknown) =>
        Promise.resolve(state.rows.shift() ?? []).then(resolve);
      return chain;
    }),
  },
}));

import { supportTile } from './ticketReadModel';

const ORG_ID = '11111111-1111-4111-8111-111111111111';

describe('supportTile', () => {
  beforeEach(() => {
    state.rows.length = 0;
    state.wheres.length = 0;
  });

  it('returns org-wide open count and response sample', async () => {
    state.rows.push(
      [{ openTickets: 4 }],
      [{ averageFirstResponseMinutes: 35, sampleSize: 2 }],
    );

    await expect(
      supportTile(ORG_ID, {
        timezone: 'UTC',
        now: new Date('2026-09-02T12:00:00Z'),
      }),
    ).resolves.toEqual({
      status: 'ok',
      openTickets: 4,
      averageFirstResponseMinutes: 35,
      sampleSize: 2,
      month: '2026-09',
      timezone: 'UTC',
      asOf: '2026-09-02T12:00:00.000Z',
    });

    const [openQuery, responseQuery] = state.wheres.map((where) =>
      new PgDialect().sqlToQuery(where as SQL),
    );
    expect(openQuery.sql).toContain('"tickets"."org_id" =');
    expect(openQuery.sql).toContain('"tickets"."deleted_at" is null');
    expect(openQuery.sql).not.toContain('date_trunc');
    expect(responseQuery.sql).toContain('"tickets"."org_id" =');
    expect(responseQuery.sql).toContain('"tickets"."deleted_at" is null');
    expect(responseQuery.sql).toContain('date_trunc');
    expect(openQuery.params).toContain(ORG_ID);
    expect(responseQuery.params).toContain(ORG_ID);
  });
});
```

```ts
// apps/api/src/services/portal/actionItemsReadModel.test.ts
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';

const state = vi.hoisted(() => ({
  rows: [] as unknown[][],
  wheres: [] as unknown[],
}));

vi.mock('../../db', () => ({
  db: {
    select: vi.fn(() => {
      const chain: Record<string, unknown> = {};
      for (const method of ['from', 'where', 'orderBy', 'limit']) {
        chain[method] = vi.fn((arg: unknown) => {
          if (method === 'where') state.wheres.push(arg);
          return chain;
        });
      }
      chain.then = (resolve: (rows: unknown[]) => unknown) =>
        Promise.resolve(state.rows.shift() ?? []).then(resolve);
      return chain;
    }),
  },
}));

import { actionItemsTile } from './actionItemsReadModel';

const ORG_ID = '11111111-1111-4111-8111-111111111111';

describe('actionItemsTile', () => {
  beforeEach(() => {
    state.rows.length = 0;
    state.wheres.length = 0;
  });

  it('combines findings and suggestions and limits top issues to three', async () => {
    state.rows.push(
      [{ count: 2 }],
      [{ count: 3 }],
      [{ topIssues: ['one', 'two', 'three', 'four'] }],
    );

    const now = new Date('2026-09-02T12:00:00Z');
    await expect(actionItemsTile(ORG_ID, now)).resolves.toEqual({
      status: 'ok',
      count: 5,
      topIssues: ['one', 'two', 'three'],
      asOf: now.toISOString(),
    });

    for (const where of state.wheres) {
      expect(
        new PgDialect().sqlToQuery(where as SQL).params,
      ).toContain(ORG_ID);
    }
  });
});
```

- [ ] **Step 2: Run the tile tests and confirm they fail because the W02 scaffolds do not yet execute the queries or return the DTO shapes.**

```bash
cd apps/api && npx vitest run src/services/portal/securityReadModel.test.ts
cd apps/api && npx vitest run src/services/portal/patchReadModel.test.ts
cd apps/api && npx vitest run src/services/portal/backupReadModel.test.ts
cd apps/api && npx vitest run src/services/portal/ticketReadModel.test.ts
cd apps/api && npx vitest run src/services/portal/actionItemsReadModel.test.ts
```

Expected failures: missing exports or mismatched DTOs; the compiled-SQL assertions must also fail until every query binds `ORG_ID`.

- [ ] **Step 3: Implement the minimal org-scoped tile queries.**

```ts
// apps/api/src/services/portal/securityReadModel.ts
import { and, asc, desc, eq, sql } from 'drizzle-orm';
import { db } from '../../db';
import {
  devices,
  securityPostureOrgSnapshots,
  securityStatus,
} from '../../db/schema';
import { classifyDeviceProtection } from './protection';
import { securityCompliancePostureConfigSchema } from '../../routes/reports/schemas';
import { getSecurityPostureTrend } from '../securityPosture';

const SECURITY_STATUS_MAX_AGE_DAYS =
  securityCompliancePostureConfigSchema.parse({})
    .maxSecurityStatusAgeDays;

function scoreBand(
  score: number,
): 'strong' | 'good' | 'fair' | 'at_risk' {
  if (score >= 80) return 'strong';
  if (score >= 60) return 'good';
  if (score >= 40) return 'fair';
  return 'at_risk';
}

export async function securityScoreTile(orgId: string, now: Date) {
  const [rows, trend] = await Promise.all([
    db
      .select({
        overallScore: securityPostureOrgSnapshots.overallScore,
        capturedAt: securityPostureOrgSnapshots.capturedAt,
      })
      .from(securityPostureOrgSnapshots)
      .where(eq(securityPostureOrgSnapshots.orgId, orgId))
      .orderBy(desc(securityPostureOrgSnapshots.capturedAt))
      .limit(1),
    getSecurityPostureTrend({ orgId, days: 31 }),
  ]);

  const latest = rows[0];
  if (!latest) {
    return {
      status: 'no_data' as const,
      score: null,
      band: null,
      delta30d: null,
      capturedAt: null,
    };
  }

  const targetDay = new Date(
    now.getTime() - 30 * 86_400_000,
  ).toISOString().slice(0, 10);
  const prior = [...trend].sort((a, b) =>
    Math.abs(
      new Date(String(a.timestamp)).getTime() -
        new Date(targetDay).getTime(),
    ) -
    Math.abs(
      new Date(String(b.timestamp)).getTime() -
        new Date(targetDay).getTime(),
    ),
  )[0];

  return {
    status:
      now.getTime() - latest.capturedAt.getTime() > 86_400_000
        ? 'stale' as const
        : 'ok' as const,
    score: latest.overallScore,
    band: scoreBand(latest.overallScore),
    delta30d:
      typeof prior?.overall === 'number'
        ? latest.overallScore - prior.overall
        : null,
    capturedAt: latest.capturedAt.toISOString(),
  };
}

export async function devicesProtectedTile(orgId: string, now: Date) {
  const rows = await db
    .select({
      id: devices.id,
      realTimeProtection: securityStatus.realTimeProtection,
      provider: securityStatus.provider,
      securityUpdatedAt: securityStatus.updatedAt,
      hasS1Agent: sql<boolean>`exists (
        select 1 from s1_agents s1
        where s1.org_id = ${orgId}
          and s1.device_id = ${devices.id}
      )`,
      hasHuntressAgent: sql<boolean>`exists (
        select 1 from huntress_agents ha
        where ha.org_id = ${orgId}
          and ha.device_id = ${devices.id}
      )`,
    })
    .from(devices)
    .leftJoin(
      securityStatus,
      and(
        eq(securityStatus.deviceId, devices.id),
        eq(securityStatus.orgId, orgId),
      ),
    )
    .where(and(eq(devices.orgId, orgId), eq(devices.isEphemeral, false)))
    .orderBy(asc(devices.id));

  if (rows.length === 0) {
    return {
      status: 'no_data' as const,
      protected: null,
      unprotected: null,
      unknown: null,
      total: null,
      asOf: now.toISOString(),
    };
  }

  const counts = { protected: 0, unprotected: 0, unknown: 0 };
  for (const row of rows) {
    counts[classifyDeviceProtection({
      securityStatus: row.securityUpdatedAt
          ? {
            provider: row.provider!,
            realTimeProtection: row.realTimeProtection,
            updatedAt: row.securityUpdatedAt,
          }
        : null,
      hasS1Agent: row.hasS1Agent,
      hasHuntressAgent: row.hasHuntressAgent,
      now,
      maxSecurityStatusAgeDays: SECURITY_STATUS_MAX_AGE_DAYS,
    })] += 1;
  }

  return {
    status: 'ok' as const,
    ...counts,
    total: rows.length,
    asOf: now.toISOString(),
  };
}
```

```ts
// apps/api/src/services/portal/patchReadModel.ts
import { and, countDistinct, eq, gte, inArray, lt, sql } from 'drizzle-orm';
import { db } from '../../db';
import {
  devicePatches,
  OUTSTANDING_DEVICE_PATCH_STATUSES,
  patches,
} from '../../db/schema';

export function portalMonthWindow(now: Date, timezone: string) {
  const localStart = sql<Date>`
    date_trunc('month', ${now}::timestamptz at time zone ${timezone})
  `;
  const start = sql<Date>`${localStart} at time zone ${timezone}`;
  const end = sql<Date>`
    (${localStart} + interval '1 month') at time zone ${timezone}
  `;
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
  }).formatToParts(now);
  const value = (type: string) =>
    parts.find((part) => part.type === type)!.value;

  return { start, end, month: `${value('year')}-${value('month')}` };
}

export async function patchesAppliedTile(
  orgId: string,
  args: { timezone: string; now: Date },
) {
  const { start, end, month } = portalMonthWindow(
    args.now,
    args.timezone,
  );

  const [appliedRows, outstandingRows] = await Promise.all([
    db
      .select({ applied: sql<number>`count(*)::int` })
      .from(devicePatches)
      .where(and(
        eq(devicePatches.orgId, orgId),
        eq(devicePatches.status, 'installed'),
        gte(devicePatches.installedAt, start),
        lt(devicePatches.installedAt, end),
      )),
    db
      .select({
        devicesWithOutstandingCritical:
          countDistinct(devicePatches.deviceId),
      })
      .from(devicePatches)
      .innerJoin(patches, eq(devicePatches.patchId, patches.id))
      .where(and(
        eq(devicePatches.orgId, orgId),
        inArray(devicePatches.status, [...OUTSTANDING_DEVICE_PATCH_STATUSES]),
        eq(patches.severity, 'critical'),
      )),
  ]);

  const applied = Number(appliedRows[0]?.applied ?? 0);
  const devicesWithOutstandingCritical = Number(
    outstandingRows[0]?.devicesWithOutstandingCritical ?? 0,
  );

  return {
    status: 'ok' as const,
    applied,
    devicesWithOutstandingCritical,
    month,
    timezone: args.timezone,
    asOf: args.now.toISOString(),
  };
}
```

```ts
// apps/api/src/services/portal/backupReadModel.ts
import { and, countDistinct, desc, eq } from 'drizzle-orm';
import { db } from '../../db';
import {
  backupConfigs,
  backupJobs,
  backupVerifications,
  devices,
} from '../../db/schema';

export async function backupTile(orgId: string, now: Date) {
  const [totalRows, configuredRows, latestRows] = await Promise.all([
    db
      .select({ total: countDistinct(devices.id) })
      .from(devices)
      .where(and(eq(devices.orgId, orgId), eq(devices.isEphemeral, false))),
    db
      .select({ configured: countDistinct(backupJobs.deviceId) })
      .from(backupJobs)
      .innerJoin(
        backupConfigs,
        and(
          eq(backupJobs.configId, backupConfigs.id),
          eq(backupConfigs.orgId, orgId),
          eq(backupConfigs.isActive, true),
        ),
      )
      .where(eq(backupJobs.orgId, orgId)),
    db
      .select({
        completedAt: backupVerifications.completedAt,
        verificationType: backupVerifications.verificationType,
      })
      .from(backupVerifications)
      .where(and(
        eq(backupVerifications.orgId, orgId),
        eq(backupVerifications.status, 'passed'),
      ))
      .orderBy(desc(backupVerifications.completedAt))
      .limit(1),
  ]);

  const total = Number(totalRows[0]?.total ?? 0);
  const configured = Number(configuredRows[0]?.configured ?? 0);
  const latest = latestRows[0];

  return {
    status:
      configured === 0
        ? 'not_configured' as const
        : latest
          ? 'ok' as const
          : 'no_data' as const,
    completedAt: latest?.completedAt?.toISOString() ?? null,
    verificationType: latest?.verificationType ?? null,
    configured,
    total,
    asOf: now.toISOString(),
  };
}
```

```ts
// apps/api/src/services/portal/ticketReadModel.ts
import { and, eq, gte, inArray, isNull, lt, sql } from 'drizzle-orm';
import { db } from '../../db';
import { tickets } from '../../db/schema';
import { portalMonthWindow } from './patchReadModel';

const OPEN_TICKET_STATUSES = ['new', 'open', 'pending', 'on_hold'] as const;

export async function supportTile(
  orgId: string,
  args: { timezone: string; now: Date },
) {
  const { start, end, month } = portalMonthWindow(
    args.now,
    args.timezone,
  );
  const [openRows, responseRows] = await Promise.all([
    db
      .select({ openTickets: sql<number>`count(*)::int` })
      .from(tickets)
      .where(and(
        eq(tickets.orgId, orgId),
        isNull(tickets.deletedAt),
        inArray(tickets.status, [...OPEN_TICKET_STATUSES]),
      )),
    db
      .select({
      averageFirstResponseMinutes: sql<number | null>`
        avg(extract(epoch from (
          ${tickets.firstResponseAt} - ${tickets.createdAt}
        )) / 60)
      `,
        sampleSize: sql<number>`count(*)::int`,
      })
      .from(tickets)
      .where(and(
        eq(tickets.orgId, orgId),
        isNull(tickets.deletedAt),
        sql`${tickets.firstResponseAt} is not null`,
        gte(tickets.createdAt, start),
        lt(tickets.createdAt, end),
      )),
  ]);

  const open = openRows[0];
  const response = responseRows[0];

  return {
    status: 'ok' as const,
    openTickets: Number(open?.openTickets ?? 0),
    averageFirstResponseMinutes:
      response?.averageFirstResponseMinutes == null
        ? null
        : Math.round(Number(response.averageFirstResponseMinutes)),
    sampleSize: Number(response?.sampleSize ?? 0),
    month,
    timezone: args.timezone,
    asOf: args.now.toISOString(),
  };
}
```

```ts
// apps/api/src/services/portal/actionItemsReadModel.ts
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { db } from '../../db';
import {
  fleetFindings,
  remediationSuggestions,
  securityPostureOrgSnapshots,
} from '../../db/schema';

export async function actionItemsTile(orgId: string, now: Date) {
  const [findingRows, suggestionRows, snapshotRows] = await Promise.all([
    db
      .select({ count: sql<number>`count(*)::int` })
      .from(fleetFindings)
      .where(and(
        eq(fleetFindings.orgId, orgId),
        inArray(fleetFindings.status, ['open', 'acknowledged']),
      )),
    db
      .select({ count: sql<number>`count(*)::int` })
      .from(remediationSuggestions)
      .where(and(
        eq(remediationSuggestions.orgId, orgId),
        eq(remediationSuggestions.status, 'suggested'),
      )),
    db
      .select({ topIssues: securityPostureOrgSnapshots.topIssues })
      .from(securityPostureOrgSnapshots)
      .where(eq(securityPostureOrgSnapshots.orgId, orgId))
      .orderBy(desc(securityPostureOrgSnapshots.capturedAt))
      .limit(1),
  ]);

  const rawTopIssues = snapshotRows[0]?.topIssues;
  const topIssues: string[] = Array.isArray(rawTopIssues)
    ? rawTopIssues.flatMap((item) => {
        if (typeof item === 'string') return [item];
        if (!item || typeof item !== 'object') return [];
        const label = (item as Record<string, unknown>).label;
        return typeof label === 'string' ? [label] : [];
      }).slice(0, 3)
    : [];

  return {
    status: 'ok' as const,
    count:
      Number(findingRows[0]?.count ?? 0) +
      Number(suggestionRows[0]?.count ?? 0),
    topIssues,
    asOf: now.toISOString(),
  };
}
```

- [ ] **Step 4: Run the five service tests and confirm every DTO and compiled org predicate is green.**

```bash
cd apps/api && npx vitest run src/services/portal/securityReadModel.test.ts
cd apps/api && npx vitest run src/services/portal/patchReadModel.test.ts
cd apps/api && npx vitest run src/services/portal/backupReadModel.test.ts
cd apps/api && npx vitest run src/services/portal/ticketReadModel.test.ts
cd apps/api && npx vitest run src/services/portal/actionItemsReadModel.test.ts
```

- [ ] **Step 5: Commit the dashboard tile read models.**

```bash
git add apps/api/src/services/portal/securityReadModel.ts apps/api/src/services/portal/securityReadModel.test.ts apps/api/src/services/portal/patchReadModel.ts apps/api/src/services/portal/patchReadModel.test.ts apps/api/src/services/portal/backupReadModel.ts apps/api/src/services/portal/backupReadModel.test.ts apps/api/src/services/portal/ticketReadModel.ts apps/api/src/services/portal/ticketReadModel.test.ts apps/api/src/services/portal/actionItemsReadModel.ts apps/api/src/services/portal/actionItemsReadModel.test.ts && git commit -m "feat(portal): add dashboard tile read models"
```

### Task 4.2: Add the dashboard orchestrator and Hono route

**Files:**
- Create `apps/api/src/services/portal/dashboard.test.ts`
- Modify `apps/api/src/services/portal/dashboard.ts:1-end` (W02 scaffold)
- Modify `apps/api/src/routes/portal/dashboard.ts:1-end` (W03 creates and mounts `portalDashboardRoutes`)
- Create `apps/api/src/routes/portal/dashboard.test.ts`
- Test `apps/api/src/services/portal/dashboard.test.ts`
- Test `apps/api/src/routes/portal/dashboard.test.ts`

**Interfaces:**
- Consumes `securityScoreTile`, `devicesProtectedTile`, `patchesAppliedTile`, `backupTile`, `supportTile`, and `actionItemsTile`
- Consumes `DashboardDto`
- Consumes proposal review states from `apps/api/src/db/schema/quotes.ts:12-14,33-40` and invoice balances from `apps/api/src/db/schema/invoices.ts:29-50`
- Consumes `auth.timezone`, hydrated once by `portalAuthMiddleware`; the route never resolves timezone itself
- Produces `awaitingYouTile(orgId: string, now: Date)`
- Produces `dashboardForOrg(orgId: string, args: { timezone: string; now: Date }): Promise<DashboardDto>`
- Produces `GET /api/v1/portal/dashboard`

- [ ] **Step 1: Write failing orchestration and route tests.**

```ts
// apps/api/src/services/portal/dashboard.test.ts
import { describe, expect, it, vi } from 'vitest';

const tiles = vi.hoisted(() => ({
  securityScoreTile: vi.fn(),
  devicesProtectedTile: vi.fn(),
  patchesAppliedTile: vi.fn(),
  backupTile: vi.fn(),
  supportTile: vi.fn(),
  actionItemsTile: vi.fn(),
}));

const dbState = vi.hoisted(() => ({
  rows: [] as unknown[][],
  wheres: [] as unknown[],
}));

vi.mock('../../db', () => ({
  db: {
    select: vi.fn(() => {
      const chain: Record<string, unknown> = {};
      for (const method of ['from', 'where']) {
        chain[method] = vi.fn((arg: unknown) => {
          if (method === 'where') dbState.wheres.push(arg);
          return chain;
        });
      }
      chain.then = (resolve: (rows: unknown[]) => unknown) =>
        Promise.resolve(dbState.rows.shift() ?? []).then(resolve);
      return chain;
    }),
  },
}));

vi.mock('./securityReadModel', () => ({
  securityScoreTile: tiles.securityScoreTile,
  devicesProtectedTile: tiles.devicesProtectedTile,
}));
vi.mock('./patchReadModel', () => ({
  patchesAppliedTile: tiles.patchesAppliedTile,
}));
vi.mock('./backupReadModel', () => ({ backupTile: tiles.backupTile }));
vi.mock('./ticketReadModel', () => ({ supportTile: tiles.supportTile }));
vi.mock('./actionItemsReadModel', () => ({
  actionItemsTile: tiles.actionItemsTile,
}));

import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import {
  awaitingYouTile,
  dashboardForOrg,
} from './dashboard';

it('counts only reviewable proposals and invoices with balance due', async () => {
  dbState.rows.push([{ count: 2 }], [{ count: 3 }]);
  const now = new Date('2026-09-02T12:00:00Z');

  await expect(awaitingYouTile('org-1', now)).resolves.toEqual({
    status: 'ok',
    proposals: 2,
    invoices: 3,
    asOf: now.toISOString(),
  });

  for (const where of dbState.wheres) {
    const query = new PgDialect().sqlToQuery(where as SQL);
    expect(query.params).toContain('org-1');
  }
});

it('runs all dashboard tiles and preserves independent statuses', async () => {
  const now = new Date('2026-09-02T12:00:00Z');
  tiles.securityScoreTile.mockResolvedValue({
    status: 'stale', score: 77, band: 'good', delta30d: -2,
    capturedAt: '2026-08-31T12:00:00.000Z',
  });
  tiles.devicesProtectedTile.mockResolvedValue({
    status: 'ok', protected: 8, unprotected: 1, unknown: 1,
    total: 10, asOf: now.toISOString(),
  });
  tiles.patchesAppliedTile.mockResolvedValue({
    status: 'ok', applied: 14, devicesWithOutstandingCritical: 1,
    month: '2026-09', timezone: 'America/Denver', asOf: now.toISOString(),
  });
  tiles.backupTile.mockResolvedValue({
    status: 'not_configured', completedAt: null, verificationType: null,
    configured: 0, total: 10, asOf: now.toISOString(),
  });
  tiles.supportTile.mockResolvedValue({
    status: 'no_data', openTickets: 0, averageFirstResponseMinutes: null,
    sampleSize: 0, month: '2026-09', timezone: 'America/Denver',
    asOf: now.toISOString(),
  });
  tiles.actionItemsTile.mockResolvedValue({
    status: 'ok', count: 2, topIssues: [], asOf: now.toISOString(),
  });
  dbState.rows.push([{ count: 1 }], [{ count: 2 }]);

  const dto = await dashboardForOrg('org-1', {
    timezone: 'America/Denver',
    now,
  });

  expect(dto).toEqual({
    asOf: now.toISOString(),
    timezone: 'America/Denver',
    securityScore: {
      status: 'stale', score: 77, band: 'good', delta30d: -2,
      capturedAt: '2026-08-31T12:00:00.000Z',
    },
    devicesProtected: {
      status: 'ok', protected: 8, unprotected: 1, unknown: 1,
      total: 10, asOf: now.toISOString(),
    },
    patchesApplied: {
      status: 'ok', applied: 14, devicesWithOutstandingCritical: 1,
      month: '2026-09', timezone: 'America/Denver', asOf: now.toISOString(),
    },
    backup: {
      status: 'not_configured', completedAt: null, verificationType: null,
      configured: 0, total: 10, asOf: now.toISOString(),
    },
    support: {
      status: 'no_data', openTickets: 0,
      averageFirstResponseMinutes: null, sampleSize: 0,
      month: '2026-09', timezone: 'America/Denver', asOf: now.toISOString(),
    },
    actionItems: {
      status: 'ok', count: 2, topIssues: [], asOf: now.toISOString(),
    },
    awaitingYou: {
      status: 'ok', proposals: 1, invoices: 2, asOf: now.toISOString(),
    },
  });
  expect(tiles.securityScoreTile).toHaveBeenCalledWith('org-1', now);
  expect(tiles.patchesAppliedTile).toHaveBeenCalledWith('org-1', {
    timezone: 'America/Denver',
    now,
  });
  expect(tiles.backupTile).toHaveBeenCalledWith('org-1', now);
  expect(tiles.actionItemsTile).toHaveBeenCalledWith('org-1', now);
});
```

```ts
// apps/api/src/routes/portal/dashboard.test.ts
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

const mocks = vi.hoisted(() => ({
  dashboardForOrg: vi.fn(),
  buildWeakEtag: vi.fn(() => 'W/"dashboard"'),
}));

vi.mock('../../services/portal/dashboard', () => ({
  dashboardForOrg: mocks.dashboardForOrg,
}));
vi.mock('./helpers', async (importActual) => {
  const actual = await importActual<typeof import('./helpers')>();
  return { ...actual, buildWeakEtag: mocks.buildWeakEtag };
});

import { portalDashboardRoutes } from './dashboard';

function app() {
  const hono = new Hono();
  hono.use('*', async (c, next) => {
    c.set('portalAuth', {
      user: {
        id: 'portal-user-1',
        orgId: '11111111-1111-4111-8111-111111111111',
        email: 'customer@example.com',
        name: 'Customer',
        receiveNotifications: true,
        status: 'active',
      },
      token: 'token',
      authMethod: 'bearer',
      timezone: 'America/Denver',
    });
    await next();
  });
  hono.route('/dashboard', portalDashboardRoutes);
  return hono;
}

describe('GET /dashboard', () => {
  beforeEach(() => vi.clearAllMocks());

  it('uses the session org and hydrated timezone and sends private cache headers', async () => {
    mocks.dashboardForOrg.mockResolvedValue({
      asOf: '2026-09-02T12:00:00.000Z',
      timezone: 'America/Denver',
      securityScore: { status: 'no_data' },
    });

    const response = await app().request('/dashboard');
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toContain('private');
    expect(response.headers.get('cache-control')).toContain('max-age=30');
    expect(response.headers.get('etag')).toBe('W/"dashboard"');
    expect(mocks.dashboardForOrg).toHaveBeenCalledWith(
      '11111111-1111-4111-8111-111111111111',
      expect.objectContaining({ timezone: 'America/Denver' }),
    );
  });
});
```

- [ ] **Step 2: Run both tests and confirm they fail because the orchestrator and route do not exist.**

```bash
cd apps/api && npx vitest run src/services/portal/dashboard.test.ts
cd apps/api && npx vitest run src/routes/portal/dashboard.test.ts
```

Expected failure: `awaitingYouTile`, the complete `DashboardDto`, or the handlers on the W03 route hub are absent.

- [ ] **Step 3: Implement `Promise.all`, private ETag handling, and route registration.**

```ts
// apps/api/src/services/portal/dashboard.ts
import type { DashboardDto } from '@breeze/shared';
import { and, eq, gt, inArray, ne, sql } from 'drizzle-orm';
import { db } from '../../db';
import { invoices, quotes } from '../../db/schema';
import {
  devicesProtectedTile,
  securityScoreTile,
} from './securityReadModel';
import { patchesAppliedTile } from './patchReadModel';
import { backupTile } from './backupReadModel';
import { supportTile } from './ticketReadModel';
import { actionItemsTile } from './actionItemsReadModel';

export async function awaitingYouTile(orgId: string, now: Date) {
  const [proposalRows, invoiceRows] = await Promise.all([
    db
      .select({ count: sql<number>`count(*)::int` })
      .from(quotes)
      .where(and(
        eq(quotes.orgId, orgId),
        inArray(quotes.status, ['sent', 'viewed']),
      )),
    db
      .select({ count: sql<number>`count(*)::int` })
      .from(invoices)
      .where(and(
        eq(invoices.orgId, orgId),
        ne(invoices.status, 'draft'),
        gt(invoices.balance, '0'),
      )),
  ]);

  return {
    status: 'ok' as const,
    proposals: Number(proposalRows[0]?.count ?? 0),
    invoices: Number(invoiceRows[0]?.count ?? 0),
    asOf: now.toISOString(),
  };
}

export async function dashboardForOrg(
  orgId: string,
  args: { timezone: string; now: Date },
): Promise<DashboardDto> {
  const [
    securityScore,
    devicesProtected,
    patchesApplied,
    backup,
    support,
    actionItems,
    awaitingYou,
  ] = await Promise.all([
    securityScoreTile(orgId, args.now),
    devicesProtectedTile(orgId, args.now),
    patchesAppliedTile(orgId, args),
    backupTile(orgId, args.now),
    supportTile(orgId, args),
    actionItemsTile(orgId, args.now),
    awaitingYouTile(orgId, args.now),
  ]);

  return {
    asOf: args.now.toISOString(),
    timezone: args.timezone,
    securityScore,
    devicesProtected,
    patchesApplied,
    backup,
    support,
    actionItems,
    awaitingYou,
  };
}
```

```ts
// append to the W03-created apps/api/src/routes/portal/dashboard.ts
import { dashboardForOrg } from '../../services/portal/dashboard';
import {
  applyPortalCacheHeaders,
  buildWeakEtag,
  isEtagFresh,
} from './helpers';

portalDashboardRoutes.get('/', async (c) => {
  const auth = c.get('portalAuth');
  const payload = await dashboardForOrg(auth.user.orgId, {
    timezone: auth.timezone,
    now: new Date(),
  });

  applyPortalCacheHeaders(c, {
    scope: 'private',
    browserMaxAgeSeconds: 30,
    staleWhileRevalidateSeconds: 0,
    vary: ['Authorization', 'Cookie'],
  });
  const etag = buildWeakEtag(payload);
  c.header('ETag', etag);

  if (isEtagFresh(c.req.header('if-none-match'), etag)) {
    return new Response(null, { status: 304, headers: c.res.headers });
  }
  return c.json(payload);
});
```

- [ ] **Step 4: Run the orchestrator and route tests green.**

```bash
cd apps/api && npx vitest run src/services/portal/dashboard.test.ts
cd apps/api && npx vitest run src/routes/portal/dashboard.test.ts
```

- [ ] **Step 5: Commit the dashboard API.**

```bash
git add apps/api/src/services/portal/dashboard.ts apps/api/src/services/portal/dashboard.test.ts apps/api/src/routes/portal/dashboard.ts apps/api/src/routes/portal/dashboard.test.ts && git commit -m "feat(portal): add dashboard API"
```

### Task 4.3: Add the portal dashboard client and UI

**Files:**
- Modify `apps/portal/src/lib/api.ts:6-10,149-267,723-734`
- Modify `apps/portal/src/lib/api.test.ts:38-59`
- Create `apps/portal/src/pages/dashboard/index.astro`
- Create `apps/portal/src/components/portal/DashboardTiles.tsx`
- Create `apps/portal/src/components/portal/DashboardTiles.test.tsx`
- Create `apps/portal/src/components/portal/Sparkline.tsx`
- Create `apps/portal/src/components/portal/Sparkline.test.tsx`
- Test `apps/portal/src/lib/api.test.ts`
- Test `apps/portal/src/components/portal/DashboardTiles.test.tsx`
- Test `apps/portal/src/components/portal/Sparkline.test.tsx`

**Interfaces:**
- Consumes `DashboardDto`
- Consumes `apiGet<T>` from `apps/portal/src/lib/api.ts:251-256`
- Produces `portalApi.getDashboard(config?: ApiRequestConfig): Promise<ApiResponse<DashboardDto>>`
- Produces `DashboardTiles`
- Produces dependency-free `Sparkline`

- [ ] **Step 1: Write failing client and component tests.**

```ts
// append to apps/portal/src/lib/api.test.ts
describe('portalApi.getDashboard', () => {
  it('GETs the dashboard endpoint and preserves tile statuses', async () => {
    const dto = {
      asOf: '2026-09-02T12:00:00.000Z',
      timezone: 'America/Denver',
      securityScore: { status: 'stale', score: 76 },
    };
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(dto), { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await expect(portalApi.getDashboard()).resolves.toMatchObject({ data: dto });
    expect(String(fetchMock.mock.calls[0][0])).toContain('/portal/dashboard');
  });
});
```

```tsx
// apps/portal/src/components/portal/Sparkline.test.tsx
// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Sparkline } from './Sparkline';

it('renders a labelled inline SVG without a chart dependency', () => {
  render(<Sparkline values={[40, 55, 70, 82]} label="Security score trend" />);
  const svg = screen.getByTestId('portal-sparkline');
  expect(svg.tagName.toLowerCase()).toBe('svg');
  expect(svg.getAttribute('aria-label')).toBe('Security score trend');
  expect(svg.querySelector('polyline')).not.toBeNull();
});
```

```tsx
// apps/portal/src/components/portal/DashboardTiles.test.tsx
// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { DashboardTiles } from './DashboardTiles';
import type { DashboardDto } from '@breeze/shared';

const dashboard: DashboardDto = {
  asOf: '2026-09-02T12:00:00.000Z',
  timezone: 'America/Denver',
  securityScore: {
    status: 'ok',
    score: 82,
    band: 'strong',
    delta30d: 4,
    capturedAt: '2026-09-02T11:00:00.000Z',
  },
  devicesProtected: {
    status: 'ok',
    protected: 8,
    unprotected: 1,
    unknown: 1,
    total: 10,
    asOf: '2026-09-02T12:00:00.000Z',
  },
  patchesApplied: {
    status: 'ok',
    applied: 41,
    devicesWithOutstandingCritical: 2,
    month: '2026-09',
    timezone: 'America/Denver',
    asOf: '2026-09-02T12:00:00.000Z',
  },
  backup: {
    status: 'not_configured',
    completedAt: null,
    verificationType: null,
    configured: 0,
    total: 10,
    asOf: '2026-09-02T12:00:00.000Z',
  },
  support: {
    status: 'ok',
    openTickets: 3,
    averageFirstResponseMinutes: 25,
    sampleSize: 2,
    month: '2026-09',
    timezone: 'America/Denver',
    asOf: '2026-09-02T12:00:00.000Z',
  },
  actionItems: {
    status: 'ok',
    count: 2,
    topIssues: ['Disk encryption'],
    asOf: '2026-09-02T12:00:00.000Z',
  },
  awaitingYou: {
    status: 'ok',
    proposals: 1,
    invoices: 2,
    asOf: '2026-09-02T12:00:00.000Z',
  },
};

describe('DashboardTiles', () => {
  it('renders every tile with stable data-testids', () => {
    render(<DashboardTiles dashboard={dashboard} />);
    expect(screen.getByTestId('portal-dashboard-tile-security')).toHaveTextContent('82');
    expect(screen.getByTestId('portal-dashboard-tile-devices')).toHaveTextContent('8');
    expect(screen.getByTestId('portal-dashboard-tile-patches')).toHaveTextContent('41');
    expect(screen.getByTestId('portal-dashboard-tile-support')).toHaveTextContent('3');
    expect(screen.getByTestId('portal-dashboard-tile-action-items')).toHaveTextContent('2');
  });

  it('renders honest not-configured copy', () => {
    render(<DashboardTiles dashboard={dashboard} />);
    expect(screen.getByTestId('portal-dashboard-tile-backup')).toHaveTextContent(
      'Backups are not configured',
    );
  });
});
```

- [ ] **Step 2: Run the client and component tests and confirm missing methods/components fail.**

```bash
cd apps/portal && npx vitest run src/lib/api.test.ts
cd apps/portal && npx vitest run src/components/portal/Sparkline.test.tsx
cd apps/portal && npx vitest run src/components/portal/DashboardTiles.test.tsx
```

- [ ] **Step 3: Implement the API method, inline SVG, SSR page, and dashboard tiles.**

```diff
 // apps/portal/src/lib/api.ts — extend the existing shared type import and
 // insert this property inside the existing portalApi object before getDevices.
-import type { InvoiceStatus, PublicQuoteHeader, QuotePresentation, TicketFormField } from '@breeze/shared';
+import type { DashboardDto, InvoiceStatus, PublicQuoteHeader, QuotePresentation, TicketFormField } from '@breeze/shared';

 export const portalApi = {
+  getDashboard: (
+    config: ApiRequestConfig = {},
+  ): Promise<ApiResponse<DashboardDto>> =>
+    apiGet<DashboardDto>('/portal/dashboard', config),
+

   getDevices: async (
```

```tsx
// apps/portal/src/components/portal/Sparkline.tsx
export function Sparkline({
  values,
  label,
}: {
  values: number[];
  label: string;
}) {
  const width = 160;
  const height = 48;
  const min = Math.min(...values, 0);
  const max = Math.max(...values, 100);
  const range = Math.max(1, max - min);
  const points = values
    .map((value, index) => {
      const x = values.length === 1 ? width / 2 : index * width / (values.length - 1);
      const y = height - ((value - min) / range) * height;
      return `${x},${y}`;
    })
    .join(' ');

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      role="img"
      aria-label={label}
      data-testid="portal-sparkline"
      className="h-12 w-full"
    >
      <polyline
        points={points}
        fill="none"
        stroke="currentColor"
        strokeWidth="3"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}
```

```tsx
// apps/portal/src/components/portal/DashboardTiles.tsx
import type { DashboardDto } from '@breeze/shared';
import { PageHeader } from './ui';
import { Sparkline } from './Sparkline';

function Tile({
  testId,
  title,
  children,
}: {
  testId: string;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-lg border border-border p-5" data-testid={testId}>
      <h2 className="text-sm font-semibold text-muted-foreground">{title}</h2>
      <div className="mt-2">{children}</div>
    </section>
  );
}

export function DashboardTiles({ dashboard }: { dashboard: DashboardDto }) {
  return (
    <div>
      <PageHeader title="Dashboard" lede={`Current as of ${dashboard.timezone}.`} />
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        <Tile testId="portal-dashboard-tile-security" title="Security score">
          {dashboard.securityScore.score == null
            ? 'No security score is available'
            : <>
                <strong>{dashboard.securityScore.score}</strong>{' '}
                {dashboard.securityScore.band}
                <Sparkline
                  values={dashboard.securityScore.delta30d == null
                    ? [dashboard.securityScore.score]
                    : [
                        dashboard.securityScore.score -
                          dashboard.securityScore.delta30d,
                        dashboard.securityScore.score,
                      ]}
                  label="Security score, 30-day change"
                />
              </>}
        </Tile>

        <Tile testId="portal-dashboard-tile-devices" title="Devices protected">
          {dashboard.devicesProtected.protected == null
            ? 'No device protection data is available'
            : `${dashboard.devicesProtected.protected} of ${dashboard.devicesProtected.total}`}
        </Tile>

        <Tile testId="portal-dashboard-tile-patches" title="Patches applied this month">
          {dashboard.patchesApplied.applied ?? 'No patch data is available'}
        </Tile>

        <Tile testId="portal-dashboard-tile-backup" title="Last backup verified">
          {dashboard.backup.status === 'not_configured'
            ? 'Backups are not configured'
            : dashboard.backup.completedAt ?? 'No verification data is available'}
        </Tile>

        <Tile testId="portal-dashboard-tile-support" title="Support">
          {dashboard.support.openTickets ?? 'No support data is available'} open
        </Tile>

        <Tile testId="portal-dashboard-tile-action-items" title="Action items">
          {dashboard.actionItems.count ?? 'No action-item data is available'}
        </Tile>

        <Tile testId="portal-dashboard-tile-awaiting-you" title="Awaiting you">
          {dashboard.awaitingYou.proposals ?? 0} proposals ·{' '}
          {dashboard.awaitingYou.invoices ?? 0} invoices
        </Tile>
      </div>
    </div>
  );
}
```

```astro
---
// apps/portal/src/pages/dashboard/index.astro
import PortalLayout from '../../layouts/PortalLayout.astro';
import { DashboardTiles } from '../../components/portal/DashboardTiles';
import { portalApi } from '../../lib/api';
import { buildServerApiConfig } from '../../lib/server';
import { redirectToLoginAfter401 } from '../../lib/session';

const response = await portalApi.getDashboard(
  buildServerApiConfig(Astro.request),
);
if (response.statusCode === 401) {
  return redirectToLoginAfter401(Astro);
}
---

<PortalLayout title="Dashboard">
  {
    response.data
      ? <DashboardTiles dashboard={response.data} />
      : <p data-testid="portal-dashboard-error">{response.error}</p>
  }
</PortalLayout>
```

- [ ] **Step 4: Run the portal tests green.**

```bash
cd apps/portal && npx vitest run src/lib/api.test.ts
cd apps/portal && npx vitest run src/components/portal/Sparkline.test.tsx
cd apps/portal && npx vitest run src/components/portal/DashboardTiles.test.tsx
```

- [ ] **Step 5: Commit the dashboard client and page.**

```bash
git add apps/portal/src/lib/api.ts apps/portal/src/lib/api.test.ts apps/portal/src/pages/dashboard/index.astro apps/portal/src/components/portal/DashboardTiles.tsx apps/portal/src/components/portal/DashboardTiles.test.tsx apps/portal/src/components/portal/Sparkline.tsx apps/portal/src/components/portal/Sparkline.test.tsx && git commit -m "feat(portal): add dashboard page"
```

## Wave W05 — Security overview and devices

### Task 5.1: Implement the security overview and device read models

**Files:**
- Modify `apps/api/src/services/portal/securityReadModel.ts:1-end`
- Modify `apps/api/src/services/portal/securityReadModel.test.ts:1-end`
- Test `apps/api/src/services/portal/securityReadModel.test.ts`

**Interfaces:**
- Consumes `getSecurityPostureTrend(params: { orgId?: string; orgIds?: string[]; days: number })` from `apps/api/src/services/securityPosture.ts:1077-1121`
- Consumes `prettySecurityProvider(provider: string): string` from `apps/api/src/services/securityComplianceReportProducts.ts:13-43`
- Consumes `vulnerabilitySeverityForFindings(vulnIds: string[]): Promise<Map<string, { severity: string; isKev: boolean }>>`; absent catalog ids are returned as `{ severity: 'unknown', isKev: false }`
- Consumes threat timestamps from `apps/api/src/db/schema/security.ts:81-100`, `apps/api/src/db/schema/sentinelOne.ts:60-84`, and `apps/api/src/db/schema/huntress.ts:97-117`
- Consumes vulnerability finding columns from `apps/api/src/db/schema/vulnerabilityManagement.ts:125-149`
- Produces `securityOverview(orgId: string, args: { days: number; timezone: string; now: Date }): Promise<SecurityOverviewDto>`
- Produces `securityDevicesPage(orgId: string, args: { page: number; limit: number; timezone: string; now: Date }): Promise<SecurityDevicesDto>`

- [ ] **Step 1: Extend the failing service tests for history, weekly threats, vulnerabilities, and device rows.**

```diff
// extend, do not redeclare, the W04 harness in securityReadModel.test.ts
 const state = vi.hoisted(() => ({
   rows: [] as unknown[][],
   wheres: [] as unknown[],
+  joins: [] as unknown[],
+  orderBys: [] as unknown[][],
 }));

-      for (const method of ['from', 'leftJoin', 'innerJoin', 'where', 'groupBy', 'orderBy', 'limit']) {
-        chain[method] = vi.fn((arg: unknown) => {
-          if (method === 'where') state.wheres.push(arg);
+      for (const method of ['from', 'leftJoin', 'innerJoin', 'where', 'groupBy', 'orderBy', 'limit', 'offset']) {
+        chain[method] = vi.fn((...args: unknown[]) => {
+          if (method === 'where') state.wheres.push(args[0]);
+          if (method === 'leftJoin') state.joins.push(args[1]);
+          if (method === 'orderBy') state.orderBys.push(args);
           return chain;
         });
       }
```

```ts
const catalog = vi.hoisted(() => ({ lookup: vi.fn() }));
vi.mock('./vulnerabilityCatalog', () => ({
  vulnerabilitySeverityForFindings: catalog.lookup,
}));

import {
  securityDevicesPage,
  securityOverview,
} from './securityReadModel';

beforeEach(() => {
  vi.clearAllMocks();
  state.rows.length = 0;
  state.wheres.length = 0;
  state.joins.length = 0;
  state.orderBys.length = 0;
  posture.trend.mockResolvedValue([]);
  catalog.lookup.mockResolvedValue(new Map());
});

it('returns the canonical score, threat-event, and vulnerability fields', async () => {
  posture.trend.mockResolvedValue([
    { timestamp: '2026-09-01', overall: 81 },
  ]);
  catalog.lookup.mockResolvedValue(new Map([
    ['v-1', { severity: 'critical', isKev: true }],
  ]));
  state.rows.push(
    [{ detectedAt: new Date('2026-08-31T00:00:00Z'), resolvedAt: null }],
    [{ detectedAt: new Date('2026-08-30T00:00:00Z'), resolvedAt: new Date('2026-09-01T00:00:00Z') }],
    [{ detectedAt: new Date('2026-08-29T00:00:00Z'), resolvedAt: null }],
    [
      { vulnerabilityId: 'v-1', detectedAt: new Date('2026-08-28T00:00:00Z') },
      { vulnerabilityId: 'catalog-gap', detectedAt: new Date('2026-08-27T00:00:00Z') },
    ],
  );

  const result = await securityOverview(ORG_ID, {
    days: 30,
    timezone: 'UTC',
    now: NOW,
  });
  expect(result).toMatchObject({
    dataStatus: 'ok',
    score: 81,
    band: 'strong',
    scoreHistory: [{ capturedAt: '2026-09-01', score: 81 }],
    threatEvents: { label: 'endpoint threat events' },
    vulnerabilities: {
      openBySeverity: { critical: 1, unknown: 1 },
      kevCount: 1,
      lastDetectedAt: '2026-08-28T00:00:00.000Z',
    },
  });
  expect(result.threatEvents.weeks).toHaveLength(8);

  for (const query of compiledWheres()) {
    expect(query.params).toContain(ORG_ID);
  }
});

it('treats a catalog lookup failure as unknown instead of failing the overview', async () => {
  posture.trend.mockResolvedValue([]);
  catalog.lookup.mockRejectedValue(new Error('catalog gap'));
  state.rows.push([], [], [], [{
    vulnerabilityId: 'missing',
    detectedAt: new Date('2026-08-28T00:00:00Z'),
  }]);

  await expect(securityOverview(ORG_ID, {
    days: 30,
    timezone: 'UTC',
    now: NOW,
  })).resolves.toMatchObject({
    vulnerabilities: {
      openBySeverity: { unknown: 1 },
      kevCount: 0,
    },
  });
});

it('orders unprotected devices in SQL before pagination', async () => {
  state.rows.push(
    [{ count: 2 }],
    [{
      id: 'd-1',
      hostname: 'risk-device',
      displayName: null,
      provider: 'windows_defender',
      avProducts: [{ displayName: 'Windows Defender' }],
      realTimeProtection: false,
      definitionsDate: new Date('2026-08-20T00:00:00Z'),
      encryptionStatus: 'unencrypted',
      firewallEnabled: false,
      securityUpdatedAt: new Date('2026-09-01T00:00:00Z'),
      hasS1Agent: false,
      hasHuntressAgent: false,
      pendingCriticalPatches: 2,
    }],
  );

  await expect(securityDevicesPage(ORG_ID, {
    page: 1,
    limit: 25,
    timezone: 'UTC',
    now: NOW,
  })).resolves.toMatchObject({
    dataStatus: 'ok',
    asOf: NOW.toISOString(),
    data: [{
      id: 'd-1',
      name: 'risk-device',
      protection: 'unprotected',
      avProducts: ['Windows Defender', 'Defender'],
      realTimeProtection: false,
      encryption: 'unencrypted',
      firewall: false,
      pendingCriticalPatches: 2,
    }],
    pagination: { page: 1, limit: 25, total: 2 },
  });

  const order = state.orderBys.at(-1)!
    .map((value) => dialect.sqlToQuery(value as SQL).sql)
    .join(' ');
  expect(order).toContain('case');
  expect(order).toContain('unprotected');
  expect(state.joins.some((join) => {
    const query = dialect.sqlToQuery(join as SQL);
    return query.sql.includes('"security_status"."org_id" =') &&
      query.params.includes(ORG_ID);
  })).toBe(true);
});
```

- [ ] **Step 2: Run the service test and confirm the new functions or DTO fields fail.**

```bash
cd apps/api && npx vitest run src/services/portal/securityReadModel.test.ts
```

- [ ] **Step 3: Add the org-scoped overview and paginated device implementation.**

```ts
// append to apps/api/src/services/portal/securityReadModel.ts
import type {
  SecurityDeviceRow,
  SecurityDevicesDto,
  SecurityOverviewDto,
  ThreatSourceCounts,
} from '@breeze/shared';
import { gte, or } from 'drizzle-orm';
import {
  deviceVulnerabilities,
  huntressIncidents,
  securityThreats,
  s1Threats,
} from '../../db/schema';
import { prettySecurityProvider } from '../securityComplianceReportProducts';
import { vulnerabilitySeverityForFindings } from './vulnerabilityCatalog';

const WEEK_MS = 7 * 86_400_000;
const sourceCounts = (): ThreatSourceCounts => ({
  native: 0,
  sentinelOne: 0,
  huntress: 0,
});

function emptyWeeks(now: Date) {
  const first = new Date(now.getTime() - 8 * WEEK_MS);
  return Array.from({ length: 8 }, (_, index) => ({
    weekStart: new Date(first.getTime() + index * WEEK_MS)
      .toISOString().slice(0, 10),
    detected: 0,
    resolved: 0,
    detectedBySource: sourceCounts(),
    resolvedBySource: sourceCounts(),
  }));
}

export async function securityOverview(
  orgId: string,
  args: { days: number; timezone: string; now: Date },
): Promise<SecurityOverviewDto> {
  const days = Math.min(90, Math.max(1, args.days));
  const threatSince = new Date(args.now.getTime() - 8 * WEEK_MS);

  const [trend, nativeRows, s1Rows, huntressRows, findingRows] =
    await Promise.all([
      getSecurityPostureTrend({ orgId, days }),
      db.select({
        detectedAt: securityThreats.detectedAt,
        resolvedAt: securityThreats.resolvedAt,
      }).from(securityThreats).where(and(
        eq(securityThreats.orgId, orgId),
        or(
          gte(securityThreats.detectedAt, threatSince),
          gte(securityThreats.resolvedAt, threatSince),
        ),
      )),
      db.select({
        detectedAt: s1Threats.detectedAt,
        resolvedAt: s1Threats.resolvedAt,
      }).from(s1Threats).where(and(
        eq(s1Threats.orgId, orgId),
        or(
          gte(s1Threats.detectedAt, threatSince),
          gte(s1Threats.resolvedAt, threatSince),
        ),
      )),
      db.select({
        detectedAt: huntressIncidents.reportedAt,
        resolvedAt: huntressIncidents.resolvedAt,
      }).from(huntressIncidents).where(and(
        eq(huntressIncidents.orgId, orgId),
        or(
          gte(huntressIncidents.reportedAt, threatSince),
          gte(huntressIncidents.resolvedAt, threatSince),
        ),
      )),
      db.select({
        vulnerabilityId: deviceVulnerabilities.vulnerabilityId,
        detectedAt: deviceVulnerabilities.detectedAt,
      }).from(deviceVulnerabilities).where(and(
        eq(deviceVulnerabilities.orgId, orgId),
        eq(deviceVulnerabilities.status, 'open'),
      )),
    ]);

  const scoreHistory = trend.map((point) => ({
    capturedAt: String(point.timestamp),
    score: Number(point.overall),
  }));
  const score = scoreHistory.at(-1)?.score ?? null;
  const weeks = emptyWeeks(args.now);
  const addEvents = (
    source: keyof ThreatSourceCounts,
    rows: Array<{ detectedAt: Date | null; resolvedAt: Date | null }>,
  ) => {
    for (const row of rows) {
      for (const [kind, value] of [
        ['detected', row.detectedAt],
        ['resolved', row.resolvedAt],
      ] as const) {
        if (!value) continue;
        const index = Math.floor(
          (value.getTime() - threatSince.getTime()) / WEEK_MS,
        );
        if (index < 0 || index > 7) continue;
        weeks[index]![kind] += 1;
        weeks[index]![kind === 'detected'
          ? 'detectedBySource'
          : 'resolvedBySource'][source] += 1;
      }
    }
  };
  addEvents('native', nativeRows);
  addEvents('sentinelOne', s1Rows);
  addEvents('huntress', huntressRows);

  let catalog = new Map<string, { severity: string; isKev: boolean }>();
  try {
    catalog = await vulnerabilitySeverityForFindings(
      [...new Set(findingRows.map((row) => row.vulnerabilityId))],
    );
  } catch {
    // The adapter maps unknown ids to `unknown`; this remains defensive for a
    // catalog outage so one gap cannot 500 the whole customer overview.
  }

  const openBySeverity: Record<string, number> = {
    critical: 0, high: 0, medium: 0, low: 0, unknown: 0,
  };
  let kevCount = 0;
  for (const finding of findingRows) {
    const item = catalog.get(finding.vulnerabilityId);
    const severity = item?.severity.toLowerCase() ?? 'unknown';
    const bucket = Object.hasOwn(openBySeverity, severity)
      ? severity
      : 'unknown';
    openBySeverity[bucket] = (openBySeverity[bucket] ?? 0) + 1;
    if (item?.isKev === true) kevCount += 1;
  }

  return {
    dataStatus:
      trend.length || nativeRows.length || s1Rows.length ||
      huntressRows.length || findingRows.length
        ? 'ok'
        : 'no_data',
    asOf: args.now.toISOString(),
    score,
    band: score == null ? null : scoreBand(score),
    scoreHistory,
    threatEvents: {
      label: 'endpoint threat events',
      weeks,
    },
    vulnerabilities: {
      openBySeverity,
      kevCount,
      lastDetectedAt: findingRows
        .map((row) => row.detectedAt)
        .sort((a, b) => b.getTime() - a.getTime())[0]
        ?.toISOString() ?? null,
    },
  };
}

function avProductNames(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!item || typeof item !== 'object') return [];
    const product = item as Record<string, unknown>;
    const name = typeof product.displayName === 'string'
      ? product.displayName
      : typeof product.provider === 'string'
        ? prettySecurityProvider(product.provider)
        : null;
    return name?.trim() ? [name.trim()] : [];
  });
}

export async function securityDevicesPage(
  orgId: string,
  args: {
    page: number;
    limit: number;
    timezone: string;
    now: Date;
  },
): Promise<SecurityDevicesDto> {
  const offset = (args.page - 1) * args.limit;
  const hasS1Agent = sql<boolean>`exists (
    select 1 from s1_agents s1
    where s1.org_id = ${orgId} and s1.device_id = ${devices.id}
  )`;
  const hasHuntressAgent = sql<boolean>`exists (
    select 1 from huntress_agents ha
    where ha.org_id = ${orgId} and ha.device_id = ${devices.id}
  )`;
  const stale = sql`${securityStatus.id} is null or
    ${securityStatus.updatedAt} < ${args.now} -
      ${SECURITY_STATUS_MAX_AGE_DAYS} * interval '1 day'`;
  const protectionOrder = sql`case
    when ${hasS1Agent} or ${hasHuntressAgent} then 'protected'
    when ${stale} then 'unknown'
    when ${securityStatus.provider} <> 'other'
      and ${securityStatus.realTimeProtection} = true then 'protected'
    else 'unprotected'
  end`;

  const [countRows, rows] = await Promise.all([
    db.select({ count: sql<number>`count(*)::int` })
      .from(devices)
      .where(and(
        eq(devices.orgId, orgId),
        eq(devices.isEphemeral, false),
      )),
    db.select({
      id: devices.id,
      hostname: devices.hostname,
      displayName: devices.displayName,
      provider: securityStatus.provider,
      avProducts: securityStatus.avProducts,
      realTimeProtection: securityStatus.realTimeProtection,
      definitionsDate: securityStatus.definitionsDate,
      encryptionStatus: securityStatus.encryptionStatus,
      firewallEnabled: securityStatus.firewallEnabled,
      securityUpdatedAt: securityStatus.updatedAt,
      hasS1Agent,
      hasHuntressAgent,
      pendingCriticalPatches: sql<number>`(
        select count(*)::int
        from device_patches dp
        join patches p on p.id = dp.patch_id
        where dp.org_id = ${orgId}
          and dp.device_id = ${devices.id}
          and dp.status = 'pending'
          and p.severity = 'critical'
      )`,
    })
      .from(devices)
      .leftJoin(securityStatus, and(
        eq(securityStatus.deviceId, devices.id),
        eq(securityStatus.orgId, orgId),
      ))
      .where(and(
        eq(devices.orgId, orgId),
        eq(devices.isEphemeral, false),
      ))
      .orderBy(
        sql`case ${protectionOrder}
          when 'unprotected' then 0
          when 'unknown' then 1
          else 2 end`,
        asc(sql`coalesce(${devices.displayName}, ${devices.hostname})`),
        asc(devices.id),
      )
      .limit(args.limit)
      .offset(offset),
  ]);

  const data: SecurityDeviceRow[] = rows.map((row) => ({
    id: row.id,
    name: row.displayName ?? row.hostname,
    protection: classifyDeviceProtection({
      securityStatus: row.securityUpdatedAt && row.provider
        ? {
            provider: row.provider,
            realTimeProtection: row.realTimeProtection,
            updatedAt: row.securityUpdatedAt,
          }
        : null,
      hasS1Agent: row.hasS1Agent,
      hasHuntressAgent: row.hasHuntressAgent,
      now: args.now,
      maxSecurityStatusAgeDays: SECURITY_STATUS_MAX_AGE_DAYS,
    }),
    avProducts: [...new Set([
      ...(row.hasS1Agent ? ['SentinelOne'] : []),
      ...(row.hasHuntressAgent ? ['Huntress'] : []),
      ...avProductNames(row.avProducts),
      ...(row.provider && row.provider !== 'other'
        ? [prettySecurityProvider(row.provider)]
        : []),
    ])],
    realTimeProtection: row.realTimeProtection,
    definitionsAgeDays: row.definitionsDate
      ? Math.floor(
          (args.now.getTime() - row.definitionsDate.getTime()) / 86_400_000,
        )
      : null,
    encryption: row.securityUpdatedAt ? row.encryptionStatus : null,
    firewall: row.securityUpdatedAt ? row.firewallEnabled : null,
    pendingCriticalPatches: Number(row.pendingCriticalPatches ?? 0),
    observedAt: row.securityUpdatedAt?.toISOString() ?? null,
  }));

  return {
    dataStatus: data.length > 0 ? 'ok' : 'no_data',
    asOf: args.now.toISOString(),
    data,
    pagination: {
      page: args.page,
      limit: args.limit,
      total: Number(countRows[0]?.count ?? 0),
    },
  };
}
```

- [ ] **Step 4: Run the security read-model test green.**

```bash
cd apps/api && npx vitest run src/services/portal/securityReadModel.test.ts
```

- [ ] **Step 5: Commit the security read models.**

```bash
git add apps/api/src/services/portal/securityReadModel.ts apps/api/src/services/portal/securityReadModel.test.ts && git commit -m "feat(portal): add security read models"
```

### Task 5.2: Add the security Hono routes and portal client

**Files:**
- Modify `apps/api/src/routes/portal/security.ts:1-end` (W03 creates and mounts `portalSecurityRoutes` with auth and the strict security gate)
- Create `apps/api/src/routes/portal/security.test.ts`
- Modify `apps/portal/src/lib/api.ts:6-10,698-745`
- Modify `apps/portal/src/lib/api.test.ts:38-59`
- Test `apps/api/src/routes/portal/security.test.ts`
- Test `apps/portal/src/lib/api.test.ts`

**Interfaces:**
- Consumes `securityOverview(orgId, { days, timezone, now })`
- Consumes `securityDevicesPage(orgId, { page, limit, timezone, now })`
- Consumes `auth.timezone`; neither handler calls `resolveOrgTimezone`
- Relies on Task 3.3's existing `portalRoutes.use('/security/*', portalAuthMiddleware)`, strict security gate, and `/security` mount; this task does not edit `portal/index.ts`
- Produces `GET /portal/security/overview?days=30`
- Produces `GET /portal/security/devices?page=1&limit=50`
- Produces `portalApi.getSecurityOverview(days?, config?)`
- Produces `portalApi.getSecurityDevices(params?, config?): Promise<ApiResponse<SecurityDevicesDto>>`

- [ ] **Step 1: Write failing route and client tests.**

```ts
// apps/api/src/routes/portal/security.test.ts
import { beforeEach, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

const mocks = vi.hoisted(() => ({
  overview: vi.fn(),
  devices: vi.fn(),
}));

vi.mock('../../services/portal/securityReadModel', () => ({
  securityOverview: mocks.overview,
  securityDevicesPage: mocks.devices,
}));

import { portalSecurityRoutes } from './security';

function app() {
  const hono = new Hono();
  hono.use('*', async (c, next) => {
    c.set('portalAuth', {
      user: {
        id: 'pu-1',
        orgId: '11111111-1111-4111-8111-111111111111',
        email: 'customer@example.com',
        name: 'Customer',
        receiveNotifications: true,
        status: 'active',
      },
      token: 'token',
      authMethod: 'bearer',
      timezone: 'America/Denver',
    });
    await next();
  });
  hono.route('/security', portalSecurityRoutes);
  return hono;
}

beforeEach(() => vi.clearAllMocks());

it('validates days and calls the overview with the session org', async () => {
  mocks.overview.mockResolvedValue({
    asOf: '2026-09-02T12:00:00.000Z',
    dataStatus: 'no_data',
    score: null,
    band: null,
    scoreHistory: [],
    threatEvents: { label: 'endpoint threat events', weeks: [] },
    vulnerabilities: {
      openBySeverity: {
        critical: 0, high: 0, medium: 0, low: 0, unknown: 0,
      },
      kevCount: 0,
      lastDetectedAt: null,
    },
  });
  const response = await app().request('/security/overview?days=30');
  expect(response.status).toBe(200);
  expect(mocks.overview).toHaveBeenCalledWith(
    '11111111-1111-4111-8111-111111111111',
    {
      days: 30,
      timezone: 'America/Denver',
      now: expect.any(Date),
    },
  );
  expect((await app().request('/security/overview?days=91')).status).toBe(400);
});

it('paginates security devices', async () => {
  mocks.devices.mockResolvedValue({
    dataStatus: 'no_data',
    asOf: '2026-09-02T12:00:00.000Z',
    data: [],
    pagination: { page: 2, limit: 25, total: 0 },
  });
  const response = await app().request('/security/devices?page=2&limit=25');
  expect(response.status).toBe(200);
  expect(mocks.devices).toHaveBeenCalledWith(
    '11111111-1111-4111-8111-111111111111',
    {
      page: 2,
      limit: 25,
      timezone: 'America/Denver',
      now: expect.any(Date),
    },
  );
});
```

```ts
// append to apps/portal/src/lib/api.test.ts
describe('portal security client', () => {
  it('uses the overview and paginated device paths', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        asOf: '2026-09-02T12:00:00.000Z',
        dataStatus: 'no_data',
        score: null,
        band: null,
        scoreHistory: [],
        threatEvents: { label: 'endpoint threat events', weeks: [] },
        vulnerabilities: {
          openBySeverity: {
            critical: 0, high: 0, medium: 0, low: 0, unknown: 0,
          },
          kevCount: 0,
          lastDetectedAt: null,
        },
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        dataStatus: 'no_data',
        asOf: '2026-09-02T12:00:00.000Z',
        data: [],
        pagination: { page: 2, limit: 25, total: 0 },
      }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await portalApi.getSecurityOverview(30);
    await portalApi.getSecurityDevices({ page: 2, limit: 25 });

    expect(String(fetchMock.mock.calls[0][0])).toContain(
      '/portal/security/overview?days=30',
    );
    expect(String(fetchMock.mock.calls[1][0])).toContain(
      '/portal/security/devices?page=2&limit=25',
    );
  });
});
```

- [ ] **Step 2: Run both tests and confirm missing routes/client methods fail.**

```bash
cd apps/api && npx vitest run src/routes/portal/security.test.ts
cd apps/portal && npx vitest run src/lib/api.test.ts
```

- [ ] **Step 3: Add handlers to the pre-mounted route hub, plus caching and client methods.**

```ts
// append imports and handlers to the W03-created portal/security.ts
import { z } from 'zod';
import { zValidator } from '../../lib/validation';
import {
  securityDevicesPage,
  securityOverview,
} from '../../services/portal/securityReadModel';
import {
  applyPortalCacheHeaders,
  buildWeakEtag,
  isEtagFresh,
} from './helpers';

const overviewQuery = z.object({
  days: z.coerce.number().int().min(1).max(90).default(30),
});
const deviceQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

function cached(c: Parameters<typeof applyPortalCacheHeaders>[0], payload: unknown) {
  applyPortalCacheHeaders(c, {
    scope: 'private',
    browserMaxAgeSeconds: 30,
    staleWhileRevalidateSeconds: 0,
    vary: ['Authorization', 'Cookie'],
  });
  const etag = buildWeakEtag(payload);
  c.header('ETag', etag);
  if (isEtagFresh(c.req.header('if-none-match'), etag)) {
    return new Response(null, { status: 304, headers: c.res.headers });
  }
  return c.json(payload);
}

portalSecurityRoutes.get(
  '/overview',
  zValidator('query', overviewQuery),
  async (c) => {
    const auth = c.get('portalAuth');
    return cached(
      c,
      await securityOverview(auth.user.orgId, {
        ...c.req.valid('query'),
        timezone: auth.timezone,
        now: new Date(),
      }),
    );
  },
);

portalSecurityRoutes.get(
  '/devices',
  zValidator('query', deviceQuery),
  async (c) => {
    const auth = c.get('portalAuth');
    return cached(
      c,
      await securityDevicesPage(auth.user.orgId, {
        ...c.req.valid('query'),
        timezone: auth.timezone,
        now: new Date(),
      }),
    );
  },
);
```

```ts
// apps/portal/src/lib/api.ts
import type {
  SecurityDevicesDto,
  SecurityOverviewDto,
} from '@breeze/shared';

getSecurityOverview: (
  days = 30,
  config: ApiRequestConfig = {},
): Promise<ApiResponse<SecurityOverviewDto>> =>
  apiGet<SecurityOverviewDto>(
    `/portal/security/overview${buildQueryString({ days })}`,
    config,
  ),

getSecurityDevices: (
  params: ListParams = {},
  config: ApiRequestConfig = {},
): Promise<ApiResponse<SecurityDevicesDto>> =>
  apiGet<SecurityDevicesDto>(
    `/portal/security/devices${buildQueryString({
      page: params.page ?? 1,
      limit: params.limit ?? 50,
    })}`,
    config,
  ),
```

- [ ] **Step 4: Run both test files green.**

```bash
cd apps/api && npx vitest run src/routes/portal/security.test.ts
cd apps/portal && npx vitest run src/lib/api.test.ts
```

- [ ] **Step 5: Commit the security routes and client.**

```bash
git add apps/api/src/routes/portal/security.ts apps/api/src/routes/portal/security.test.ts apps/portal/src/lib/api.ts apps/portal/src/lib/api.test.ts && git commit -m "feat(portal): add security API client"
```

### Task 5.3: Add the security page, weekly bars, and device table

**Files:**
- Create `apps/portal/src/pages/security/index.astro`
- Create `apps/portal/src/components/portal/SecurityOverview.tsx`
- Create `apps/portal/src/components/portal/SecurityOverview.test.tsx`
- Create `apps/portal/src/components/portal/SecurityDeviceTable.tsx`
- Create `apps/portal/src/components/portal/SecurityDeviceTable.test.tsx`
- Create `apps/portal/src/components/portal/WeeklyBars.tsx`
- Create `apps/portal/src/components/portal/WeeklyBars.test.tsx`
- Test `apps/portal/src/components/portal/SecurityOverview.test.tsx`
- Test `apps/portal/src/components/portal/SecurityDeviceTable.test.tsx`
- Test `apps/portal/src/components/portal/WeeklyBars.test.tsx`

**Interfaces:**
- Consumes `SecurityOverviewDto`, `SecurityDeviceRow`
- Consumes `Sparkline`
- Produces dependency-free `WeeklyBars`
- Produces `SecurityOverview` and `SecurityDeviceTable`

- [ ] **Step 1: Write failing component tests for chart labels, source breakdown, table ordering, and unknown data.**

```tsx
// apps/portal/src/components/portal/WeeklyBars.test.tsx
// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import { expect, it } from 'vitest';
import { WeeklyBars } from './WeeklyBars';

it('renders detected and resolved bars as inline SVG', () => {
  render(
    <WeeklyBars
      label="Endpoint threat events"
      weeks={[
        {
          weekStart: '2026-08-24', detected: 3, resolved: 2,
          detectedBySource: { native: 1, sentinelOne: 1, huntress: 1 },
          resolvedBySource: { native: 1, sentinelOne: 1, huntress: 0 },
        },
        {
          weekStart: '2026-08-31', detected: 1, resolved: 1,
          detectedBySource: { native: 1, sentinelOne: 0, huntress: 0 },
          resolvedBySource: { native: 1, sentinelOne: 0, huntress: 0 },
        },
      ]}
    />,
  );
  expect(screen.getByTestId('portal-weekly-bars').tagName.toLowerCase()).toBe('svg');
  expect(screen.getAllByTestId('portal-weekly-detected')).toHaveLength(2);
  expect(screen.getAllByTestId('portal-weekly-resolved')).toHaveLength(2);
});
```

```tsx
// apps/portal/src/components/portal/SecurityOverview.test.tsx
// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import { expect, it } from 'vitest';
import { SecurityOverview } from './SecurityOverview';

it('labels threats honestly and displays severity and KEV totals', () => {
  render(<SecurityOverview overview={{
    asOf: '2026-09-02T12:00:00Z',
    dataStatus: 'ok',
    score: 82,
    band: 'strong',
    scoreHistory: [{ capturedAt: '2026-09-01', score: 82 }],
    threatEvents: {
      label: 'endpoint threat events',
      weeks: [{
        weekStart: '2026-08-31',
        detected: 3,
        resolved: 2,
        detectedBySource: { native: 1, sentinelOne: 1, huntress: 1 },
        resolvedBySource: { native: 1, sentinelOne: 1, huntress: 0 },
      }],
    },
    vulnerabilities: {
      openBySeverity: { critical: 1, high: 2, medium: 3, low: 4, unknown: 0 },
      kevCount: 1,
      lastDetectedAt: '2026-09-01T00:00:00Z',
    },
  }} />);

  expect(screen.getByTestId('portal-security-overview')).toHaveTextContent(
    'endpoint threat events',
  );
  expect(screen.getByTestId('portal-security-vulnerabilities')).toHaveTextContent(
    '1 KEV',
  );
});
```

```tsx
// apps/portal/src/components/portal/SecurityDeviceTable.test.tsx
// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import { expect, it } from 'vitest';
import { SecurityDeviceTable } from './SecurityDeviceTable';

it('renders customer-safe protection evidence and unknown values', () => {
  render(<SecurityDeviceTable devices={[{
    id: 'd-1',
    name: 'Laptop',
    protection: 'unknown',
    avProducts: [],
    realTimeProtection: null,
    definitionsAgeDays: null,
    encryption: null,
    firewall: null,
    pendingCriticalPatches: 0,
    observedAt: null,
  }]} />);

  const row = screen.getByTestId('portal-security-device-d-1');
  expect(row).toHaveTextContent('Unknown');
  expect(row).toHaveTextContent('Not available');
});
```

- [ ] **Step 2: Run the three component tests and confirm the missing files fail.**

```bash
cd apps/portal && npx vitest run src/components/portal/WeeklyBars.test.tsx
cd apps/portal && npx vitest run src/components/portal/SecurityOverview.test.tsx
cd apps/portal && npx vitest run src/components/portal/SecurityDeviceTable.test.tsx
```

- [ ] **Step 3: Implement the inline SVG, overview, device table, and SSR page.**

```tsx
// apps/portal/src/components/portal/WeeklyBars.tsx
import type { ThreatWeekDto } from '@breeze/shared';

export function WeeklyBars({
  weeks,
  label,
}: {
  weeks: ThreatWeekDto[];
  label: string;
}) {
  const max = Math.max(1, ...weeks.flatMap((week) => [week.detected, week.resolved]));
  return (
    <svg
      viewBox={`0 0 ${Math.max(1, weeks.length) * 28} 100`}
      role="img"
      aria-label={label}
      data-testid="portal-weekly-bars"
      className="h-40 w-full"
    >
      {weeks.map((week, index) => {
        const detectedHeight = week.detected / max * 80;
        const resolvedHeight = week.resolved / max * 80;
        return (
          <g key={week.weekStart} transform={`translate(${index * 28},0)`}>
            <rect
              x="2"
              y={85 - detectedHeight}
              width="10"
              height={detectedHeight}
              data-testid="portal-weekly-detected"
              className="fill-warning"
            />
            <rect
              x="14"
              y={85 - resolvedHeight}
              width="10"
              height={resolvedHeight}
              data-testid="portal-weekly-resolved"
              className="fill-success"
            />
          </g>
        );
      })}
    </svg>
  );
}
```

```tsx
// apps/portal/src/components/portal/SecurityOverview.tsx
import type { SecurityOverviewDto } from '@breeze/shared';
import { Sparkline } from './Sparkline';
import { WeeklyBars } from './WeeklyBars';

export function SecurityOverview({ overview }: { overview: SecurityOverviewDto }) {
  if (overview.dataStatus === 'no_data') {
    return <p data-testid="portal-security-empty">No security observations are available yet.</p>;
  }

  return (
    <section data-testid="portal-security-overview">
      <h1>Security</h1>
      <Sparkline
        values={overview.scoreHistory.map((point) => point.score)}
        label="Security score history"
      />
      <p>{overview.score} · {overview.band}</p>
      <h2>{overview.threatEvents.label}</h2>
      <WeeklyBars
        label={overview.threatEvents.label}
        weeks={overview.threatEvents.weeks}
      />
      <div data-testid="portal-security-vulnerabilities">
        <h2>Open vulnerabilities</h2>
        <p>{overview.vulnerabilities.openBySeverity.critical} critical</p>
        <p>{overview.vulnerabilities.openBySeverity.high} high</p>
        <p>{overview.vulnerabilities.kevCount} KEV</p>
      </div>
    </section>
  );
}
```

```tsx
// apps/portal/src/components/portal/SecurityDeviceTable.tsx
import type { SecurityDeviceRow } from '@breeze/shared';

const show = (value: unknown) =>
  value === null || value === undefined || value === ''
    ? 'Not available'
    : String(value);

export function SecurityDeviceTable({
  devices,
}: {
  devices: SecurityDeviceRow[];
}) {
  if (devices.length === 0) {
    return <p data-testid="portal-security-devices-empty">No devices are enrolled.</p>;
  }

  return (
    <table data-testid="portal-security-device-table">
      <thead>
        <tr>
          <th>Device</th>
          <th>Protection</th>
          <th>Provider</th>
          <th>Definitions age</th>
          <th>Encryption</th>
          <th>Firewall</th>
          <th>Critical patches</th>
        </tr>
      </thead>
      <tbody>
        {devices.map((device) => (
          <tr
            key={device.id}
            data-testid={`portal-security-device-${device.id}`}
          >
            <td>{device.name}</td>
            <td>{device.protection[0].toUpperCase() + device.protection.slice(1)}</td>
            <td>{device.avProducts.join(', ') || 'Not available'}</td>
            <td>{device.definitionsAgeDays == null ? 'Not available' : `${device.definitionsAgeDays} days`}</td>
            <td>{show(device.encryption)}</td>
            <td>{device.firewall == null ? 'Not available' : device.firewall ? 'On' : 'Off'}</td>
            <td>{device.pendingCriticalPatches}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
```

```astro
---
// apps/portal/src/pages/security/index.astro
import PortalLayout from '../../layouts/PortalLayout.astro';
import { SecurityOverview } from '../../components/portal/SecurityOverview';
import { SecurityDeviceTable } from '../../components/portal/SecurityDeviceTable';
import { portalApi } from '../../lib/api';
import { buildServerApiConfig } from '../../lib/server';
import { redirectToLoginAfter401 } from '../../lib/session';

const config = buildServerApiConfig(Astro.request);
const [overview, devices] = await Promise.all([
  portalApi.getSecurityOverview(30, config),
  portalApi.getSecurityDevices({ page: 1, limit: 100 }, config),
]);
if (overview.statusCode === 401 || devices.statusCode === 401) {
  return redirectToLoginAfter401(Astro);
}
---

<PortalLayout title="Security">
  {
    overview.data
      ? <SecurityOverview overview={overview.data} />
      : <p data-testid="portal-security-error">{overview.error}</p>
  }
  <SecurityDeviceTable devices={devices.data?.data ?? []} />
</PortalLayout>
```

- [ ] **Step 4: Run all three component tests green.**

```bash
cd apps/portal && npx vitest run src/components/portal/WeeklyBars.test.tsx
cd apps/portal && npx vitest run src/components/portal/SecurityOverview.test.tsx
cd apps/portal && npx vitest run src/components/portal/SecurityDeviceTable.test.tsx
```

- [ ] **Step 5: Commit the security portal page.**

```bash
git add apps/portal/src/pages/security/index.astro apps/portal/src/components/portal/SecurityOverview.tsx apps/portal/src/components/portal/SecurityOverview.test.tsx apps/portal/src/components/portal/SecurityDeviceTable.tsx apps/portal/src/components/portal/SecurityDeviceTable.test.tsx apps/portal/src/components/portal/WeeklyBars.tsx apps/portal/src/components/portal/WeeklyBars.test.tsx && git commit -m "feat(portal): add security page"
```

## Wave W06 — Backup overview and devices

### Task 6.1: Implement backup overview and device read models

**Files:**
- Modify `apps/api/src/services/portal/backupReadModel.ts:1-end`
- Modify `apps/api/src/services/portal/backupReadModel.test.ts:1-end`
- Test `apps/api/src/services/portal/backupReadModel.test.ts`

**Interfaces:**
- Consumes `backup_jobs.org_id`, `device_id`, `status`, and `completed_at` from `apps/api/src/db/schema/backup.ts:207-278`
- Consumes `RESTORABLE_BACKUP_JOB_STATUSES` from `apps/api/src/db/schema/backup.ts:72-91`
- Consumes verification and readiness columns from `apps/api/src/db/schema/backupVerification.ts:16-49`
- Consumes breach columns from `apps/api/src/db/schema/sla.ts:36-57`
- Reuses `getBackupHealthSummary(orgId)` from `apps/api/src/routes/backup/readinessCalculator.ts:464-533`
- Produces `backupOverview(orgId, { timezone, now }): Promise<BackupOverviewDto>`
- Produces `backupDevicesPage(orgId, { page, limit, timezone, now }): Promise<BackupDevicesDto>`

- [ ] **Step 1: Extend the failing tests for overview and per-device evidence.**

```diff
// extend the W04 chain in apps/api/src/services/portal/backupReadModel.test.ts
-      for (const method of ['from', 'innerJoin', 'leftJoin', 'where', 'orderBy', 'limit']) {
+      for (const method of ['from', 'innerJoin', 'leftJoin', 'where', 'orderBy', 'limit', 'offset']) {
```

```ts
// append to apps/api/src/services/portal/backupReadModel.test.ts
const { getBackupHealthSummaryMock } = vi.hoisted(() => ({
  getBackupHealthSummaryMock: vi.fn(),
}));
vi.mock('../../routes/backup/readinessCalculator', () => ({
  getBackupHealthSummary: getBackupHealthSummaryMock,
}));

import { backupDevicesPage, backupOverview } from './backupReadModel';

beforeEach(() => {
  vi.clearAllMocks();
  state.rows.length = 0;
  state.wheres.length = 0;
});

it('returns overview verification, restore, breach, and readiness evidence', async () => {
  state.rows.push(
    [{ total: 3 }],
    [{ configured: 2 }],
    [{ completedAt: new Date('2026-09-02T09:00:00Z'), verificationType: 'integrity' }],
    [{ completedAt: new Date('2026-09-01T09:00:00Z') }],
    [{ eventType: 'rpo_breach' }, { eventType: 'rto_breach' }, { eventType: 'missed_backup' }],
    [{ readinessCount: 2 }],
  );
  getBackupHealthSummaryMock.mockResolvedValue({
    verification: {}, readiness: { averageScore: 83 }, escalations: {},
  });

  await expect(backupOverview(ORG_ID, {
    timezone: 'America/Denver',
    now: new Date('2026-09-02T12:00:00Z'),
  })).resolves.toEqual({
    asOf: '2026-09-02T12:00:00.000Z',
    dataStatus: 'ok',
    protected: 2,
    unprotected: 1,
    total: 3,
    lastPassedVerification: {
      completedAt: '2026-09-02T09:00:00.000Z',
      verificationType: 'integrity',
    },
    lastTestRestoreAt: '2026-09-01T09:00:00.000Z',
    openRpoBreaches: 1,
    openRtoBreaches: 1,
    meanReadinessScore: 83,
  });
  expect(getBackupHealthSummaryMock).toHaveBeenCalledWith(ORG_ID);

  for (const where of state.wheres) {
    expect(
      new PgDialect().sqlToQuery(where as SQL).params,
    ).toContain(ORG_ID);
  }
});

it('returns every enrolled device, including not configured', async () => {
  state.rows.push(
    [{ count: 2 }],
    [{
      id: 'd-1',
      hostname: 'Laptop',
      displayName: null,
      configured: false,
      lastBackupAt: null,
      lastBackupStatus: null,
      testRestoreStatus: null,
      testRestoreAt: null,
      restoreTimeSeconds: null,
      openBreaches: [],
      readinessScore: null,
      estimatedRtoMinutes: null,
      estimatedRpoMinutes: null,
    }],
  );

  await expect(
    backupDevicesPage(ORG_ID, {
      page: 1,
      limit: 25,
      timezone: 'America/Denver',
      now: new Date('2026-09-02T12:00:00Z'),
    }),
  ).resolves.toEqual({
    dataStatus: 'ok',
    asOf: '2026-09-02T12:00:00.000Z',
    data: [{
      id: 'd-1',
      name: 'Laptop',
      configured: false,
      lastRestorePointAt: null,
      lastRestorePointDegraded: false,
      lastTestRestore: null,
      openBreaches: [],
      readinessScore: null,
      estimatedRtoMinutes: null,
      estimatedRpoMinutes: null,
    }],
    pagination: { page: 1, limit: 25, total: 2 },
  });

  const compiled = state.wheres.map((where) =>
    new PgDialect().sqlToQuery(where as SQL),
  );
  expect(compiled.some(({ sql }) => sql.includes('"devices"."org_id" ='))).toBe(true);
  for (const query of compiled) expect(query.params).toContain(ORG_ID);
});
```

- [ ] **Step 2: Run the backup read-model test and confirm the new exports fail.**

```bash
cd apps/api && npx vitest run src/services/portal/backupReadModel.test.ts
```

- [ ] **Step 3: Add bounded org predicates to every backup evidence subquery and map the DTOs.**

```ts
// append to apps/api/src/services/portal/backupReadModel.ts
import {
  backupSlaEvents,
  recoveryReadiness,
  RESTORABLE_BACKUP_JOB_STATUSES,
} from '../../db/schema';
import { asc, isNull, sql } from 'drizzle-orm';
import { getBackupHealthSummary } from '../../routes/backup/readinessCalculator';
import type {
  BackupDeviceRow,
  BackupDevicesDto,
  BackupOverviewDto,
} from '@breeze/shared';

const restorableStatuses = sql.join(
  RESTORABLE_BACKUP_JOB_STATUSES.map((status) => sql`${status}`),
  sql`, `,
);

export async function backupOverview(
  orgId: string,
  args: { timezone: string; now: Date },
): Promise<BackupOverviewDto> {
  const [tile, restoreRows, breachRows, readinessCountRows, health] = await Promise.all([
    backupTile(orgId, args.now),
    db
      .select({ completedAt: backupVerifications.completedAt })
      .from(backupVerifications)
      .where(and(
        eq(backupVerifications.orgId, orgId),
        eq(backupVerifications.verificationType, 'test_restore'),
      ))
      .orderBy(desc(backupVerifications.completedAt))
      .limit(1),
    db
      .select({ eventType: backupSlaEvents.eventType })
      .from(backupSlaEvents)
      .where(and(
        eq(backupSlaEvents.orgId, orgId),
        isNull(backupSlaEvents.resolvedAt),
      )),
    db
      .select({ readinessCount: sql<number>`count(*)::int` })
      .from(recoveryReadiness)
      .where(eq(recoveryReadiness.orgId, orgId)),
    getBackupHealthSummary(orgId),
  ]);

  const countBreach = (type: 'rpo_breach' | 'rto_breach') =>
    breachRows.filter((row) => row.eventType === type).length;

  return {
    asOf: args.now.toISOString(),
    dataStatus: tile.status,
    protected: tile.configured,
    unprotected:
      tile.total == null || tile.configured == null
        ? null
        : tile.total - tile.configured,
    total: tile.total,
    lastPassedVerification:
      tile.completedAt && tile.verificationType
        ? { completedAt: tile.completedAt, verificationType: tile.verificationType }
        : null,
    lastTestRestoreAt: restoreRows[0]?.completedAt?.toISOString() ?? null,
    openRpoBreaches: countBreach('rpo_breach'),
    openRtoBreaches: countBreach('rto_breach'),
    meanReadinessScore:
      Number(readinessCountRows[0]?.readinessCount ?? 0) > 0
        ? health.readiness.averageScore
        : null,
  };
}

export async function backupDevicesPage(
  orgId: string,
  args: { page: number; limit: number; timezone: string; now: Date },
): Promise<BackupDevicesDto> {
  const offset = (args.page - 1) * args.limit;
  const [countRows, rows] = await Promise.all([
    db
      .select({ count: sql<number>`count(*)::int` })
      .from(devices)
      .where(and(eq(devices.orgId, orgId), eq(devices.isEphemeral, false))),
    db
      .select({
        id: devices.id,
        hostname: devices.hostname,
        displayName: devices.displayName,
        configured: sql<boolean>`
          exists (
            select 1
            from backup_jobs bj
            join backup_configs bc
              on bc.id = bj.config_id
             and bc.org_id = ${orgId}
             and bc.is_active = true
            where bj.org_id = ${orgId}
              and bj.device_id = ${devices.id}
          )
        `,
        lastBackupAt: sql<Date | null>`(
          select max(bj.completed_at)
          from backup_jobs bj
          where bj.org_id = ${orgId}
            and bj.device_id = ${devices.id}
            and bj.status in (${restorableStatuses})
        )`,
        lastBackupStatus: sql<string | null>`(
          select bj.status
          from backup_jobs bj
          where bj.org_id = ${orgId}
            and bj.device_id = ${devices.id}
            and bj.status in (${restorableStatuses})
          order by bj.completed_at desc nulls last
          limit 1
        )`,
        testRestoreStatus: sql<string | null>`(
          select bv.status
          from backup_verifications bv
          where bv.org_id = ${orgId}
            and bv.device_id = ${devices.id}
            and bv.verification_type = 'test_restore'
          order by bv.completed_at desc nulls last
          limit 1
        )`,
        testRestoreAt: sql<Date | null>`(
          select max(bv.completed_at)
          from backup_verifications bv
          where bv.org_id = ${orgId}
            and bv.device_id = ${devices.id}
            and bv.verification_type = 'test_restore'
        )`,
        restoreTimeSeconds: sql<number | null>`(
          select bv.restore_time_seconds
          from backup_verifications bv
          where bv.org_id = ${orgId}
            and bv.device_id = ${devices.id}
            and bv.verification_type = 'test_restore'
          order by bv.completed_at desc nulls last
          limit 1
        )`,
        openBreaches: sql<string[]>`
          coalesce((
            select array_agg(distinct bse.event_type)
            from backup_sla_events bse
            where bse.org_id = ${orgId}
              and bse.device_id = ${devices.id}
              and bse.resolved_at is null
          ), array[]::text[])
        `,
        readinessScore: recoveryReadiness.readinessScore,
        estimatedRtoMinutes: recoveryReadiness.estimatedRtoMinutes,
        estimatedRpoMinutes: recoveryReadiness.estimatedRpoMinutes,
      })
      .from(devices)
      .leftJoin(
        recoveryReadiness,
        and(
          eq(recoveryReadiness.deviceId, devices.id),
          eq(recoveryReadiness.orgId, orgId),
        ),
      )
      .where(and(eq(devices.orgId, orgId), eq(devices.isEphemeral, false)))
      .orderBy(asc(devices.hostname), asc(devices.id))
      .limit(args.limit)
      .offset(offset),
  ]);

  const data: BackupDeviceRow[] = rows.map((row) => ({
    id: row.id,
    name: row.displayName ?? row.hostname,
    configured: row.configured,
    lastRestorePointAt: row.lastBackupAt?.toISOString() ?? null,
    lastRestorePointDegraded: row.lastBackupStatus === 'partial',
    lastTestRestore: row.testRestoreStatus
      ? {
          status: row.testRestoreStatus,
          completedAt: row.testRestoreAt?.toISOString() ?? null,
          restoreTimeSeconds: row.restoreTimeSeconds,
        }
      : null,
    openBreaches: row.openBreaches,
    readinessScore: row.readinessScore,
    estimatedRtoMinutes: row.estimatedRtoMinutes,
    estimatedRpoMinutes: row.estimatedRpoMinutes,
  }));

  return {
    dataStatus: data.length === 0 ? 'no_data' : 'ok',
    asOf: args.now.toISOString(),
    data,
    pagination: {
      page: args.page,
      limit: args.limit,
      total: Number(countRows[0]?.count ?? 0),
    },
  };
}
```

- [ ] **Step 4: Run the backup read-model test green.**

```bash
cd apps/api && npx vitest run src/services/portal/backupReadModel.test.ts
```

- [ ] **Step 5: Commit the backup read models.**

```bash
git add apps/api/src/services/portal/backupReadModel.ts apps/api/src/services/portal/backupReadModel.test.ts && git commit -m "feat(portal): add backup read models"
```

### Task 6.2: Add backup routes and portal API methods

**Files:**
- Modify `apps/api/src/routes/portal/backups.ts` created by Task 3.3
- Create `apps/api/src/routes/portal/backups.test.ts`
- Modify `apps/portal/src/lib/api.ts:6-10,698-745`
- Modify `apps/portal/src/lib/api.test.ts:38-59`
- Test `apps/api/src/routes/portal/backups.test.ts`
- Test `apps/portal/src/lib/api.test.ts`

**Interfaces:**
- Consumes `backupOverview(orgId, { timezone, now })`
- Consumes `backupDevicesPage(orgId, { page, limit, timezone, now })`
- Relies on Task 3.3's existing `portalRoutes.use('/backups/*', portalAuthMiddleware)`, strict backup gate, and `/backups` mount; this task does not edit `portal/index.ts`
- Produces `GET /portal/backups/overview`
- Produces `GET /portal/backups/devices?page&limit`
- Produces `portalApi.getBackupOverview(config?)`
- Produces `portalApi.getBackupDevices(params?, config?): Promise<ApiResponse<BackupDevicesDto>>`

- [ ] **Step 1: Write failing route and client path tests.**

```ts
// apps/api/src/routes/portal/backups.test.ts
import { beforeEach, expect, it, vi } from 'vitest';
import { Hono } from 'hono';

const mocks = vi.hoisted(() => ({
  overview: vi.fn(),
  devices: vi.fn(),
}));

vi.mock('../../services/portal/backupReadModel', () => ({
  backupOverview: mocks.overview,
  backupDevicesPage: mocks.devices,
}));

import { portalBackupRoutes } from './backups';

function app() {
  const hono = new Hono();
  hono.use('*', async (c, next) => {
    c.set('portalAuth', {
      user: {
        id: 'pu-1', orgId: '11111111-1111-4111-8111-111111111111',
        email: 'user@example.com', name: null,
        receiveNotifications: true, status: 'active',
      },
      token: 'token', authMethod: 'bearer', timezone: 'America/Denver',
    });
    await next();
  });
  hono.route('/backups', portalBackupRoutes);
  return hono;
}

beforeEach(() => vi.clearAllMocks());

it('uses the session org for overview', async () => {
  mocks.overview.mockResolvedValue({
    dataStatus: 'not_configured',
    asOf: '2026-09-02T12:00:00.000Z',
    protected: 0,
    unprotected: 0,
    total: 0,
    lastPassedVerification: null,
    lastTestRestoreAt: null,
    openRpoBreaches: 0,
    openRtoBreaches: 0,
    meanReadinessScore: null,
  });
  const response = await app().request('/backups/overview');
  expect(response.status).toBe(200);
  expect(mocks.overview).toHaveBeenCalledWith(
    '11111111-1111-4111-8111-111111111111',
    expect.objectContaining({
      timezone: 'America/Denver',
      now: expect.any(Date),
    }),
  );
  expect(response.headers.get('cache-control')).toContain('max-age=30');
});

it('validates and forwards pagination', async () => {
  mocks.devices.mockResolvedValue({
    dataStatus: 'no_data',
    asOf: '2026-09-02T12:00:00.000Z',
    data: [],
    pagination: { page: 2, limit: 25, total: 0 },
  });
  const response = await app().request('/backups/devices?page=2&limit=25');
  expect(response.status).toBe(200);
  expect(mocks.devices).toHaveBeenCalledWith(
    '11111111-1111-4111-8111-111111111111',
    expect.objectContaining({
      page: 2, limit: 25,
      timezone: 'America/Denver',
      now: expect.any(Date),
    }),
  );
});
```

```ts
// append to apps/portal/src/lib/api.test.ts
it('uses the backup overview and device paths', async () => {
  const fetchMock = vi.fn()
    .mockResolvedValueOnce(new Response(JSON.stringify({
      dataStatus: 'not_configured',
      asOf: '2026-09-02T12:00:00.000Z',
      protected: 0, unprotected: 0, total: 0,
      lastPassedVerification: null, lastTestRestoreAt: null,
      openRpoBreaches: 0, openRtoBreaches: 0,
      meanReadinessScore: null,
    }), { status: 200 }))
    .mockResolvedValueOnce(new Response(JSON.stringify({
      dataStatus: 'no_data',
      asOf: '2026-09-02T12:00:00.000Z',
      data: [],
      pagination: { page: 1, limit: 50, total: 0 },
    }), { status: 200 }));
  vi.stubGlobal('fetch', fetchMock);

  await portalApi.getBackupOverview();
  await portalApi.getBackupDevices();

  expect(String(fetchMock.mock.calls[0][0])).toContain('/portal/backups/overview');
  expect(String(fetchMock.mock.calls[1][0])).toContain(
    '/portal/backups/devices?page=1&limit=50',
  );
});
```

- [ ] **Step 2: Run both test files and confirm missing routes/methods fail.**

```bash
cd apps/api && npx vitest run src/routes/portal/backups.test.ts
cd apps/portal && npx vitest run src/lib/api.test.ts
```

- [ ] **Step 3: Implement the private cached routes and client methods.**

```ts
// append to the W03-created apps/api/src/routes/portal/backups.ts
import { z } from 'zod';
import { zValidator } from '../../lib/validation';
import {
  backupDevicesPage,
  backupOverview,
} from '../../services/portal/backupReadModel';
import {
  applyPortalCacheHeaders,
  buildWeakEtag,
  isEtagFresh,
} from './helpers';

const pageQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

function cached(c: Parameters<typeof applyPortalCacheHeaders>[0], payload: unknown) {
  applyPortalCacheHeaders(c, {
    scope: 'private',
    browserMaxAgeSeconds: 30,
    staleWhileRevalidateSeconds: 0,
    vary: ['Authorization', 'Cookie'],
  });
  const etag = buildWeakEtag(payload);
  c.header('ETag', etag);
  if (isEtagFresh(c.req.header('if-none-match'), etag)) {
    return new Response(null, { status: 304, headers: c.res.headers });
  }
  return c.json(payload);
}

portalBackupRoutes.get('/overview', async (c) => {
  const auth = c.get('portalAuth');
  return cached(c, await backupOverview(auth.user.orgId, {
    timezone: auth.timezone,
    now: new Date(),
  }));
});

portalBackupRoutes.get(
  '/devices',
  zValidator('query', pageQuery),
  async (c) =>
    cached(
      c,
      await backupDevicesPage(c.get('portalAuth').user.orgId, {
        ...c.req.valid('query'),
        timezone: c.get('portalAuth').timezone,
        now: new Date(),
      }),
    ),
);
```

```ts
// apps/portal/src/lib/api.ts
import type {
  BackupDevicesDto,
  BackupOverviewDto,
} from '@breeze/shared';

getBackupOverview: (
  config: ApiRequestConfig = {},
): Promise<ApiResponse<BackupOverviewDto>> =>
  apiGet<BackupOverviewDto>('/portal/backups/overview', config),

getBackupDevices: (
  params: ListParams = {},
  config: ApiRequestConfig = {},
): Promise<ApiResponse<BackupDevicesDto>> =>
  apiGet<BackupDevicesDto>(
    `/portal/backups/devices${buildQueryString({
      page: params.page ?? 1,
      limit: params.limit ?? 50,
    })}`,
    config,
  ),
```

- [ ] **Step 4: Run both tests green.**

```bash
cd apps/api && npx vitest run src/routes/portal/backups.test.ts
cd apps/portal && npx vitest run src/lib/api.test.ts
```

- [ ] **Step 5: Commit the backup routes and client.**

```bash
git add apps/api/src/routes/portal/backups.ts apps/api/src/routes/portal/backups.test.ts apps/portal/src/lib/api.ts apps/portal/src/lib/api.test.ts && git commit -m "feat(portal): add backup API client"
```

### Task 6.3: Add the backups portal page

**Files:**
- Create `apps/portal/src/pages/backups/index.astro`
- Create `apps/portal/src/components/portal/BackupOverview.tsx`
- Create `apps/portal/src/components/portal/BackupOverview.test.tsx`
- Create `apps/portal/src/components/portal/BackupDeviceTable.tsx`
- Create `apps/portal/src/components/portal/BackupDeviceTable.test.tsx`
- Test `apps/portal/src/components/portal/BackupOverview.test.tsx`
- Test `apps/portal/src/components/portal/BackupDeviceTable.test.tsx`

**Interfaces:**
- Consumes `BackupOverviewDto`, `BackupDeviceRow`
- Produces `BackupOverview`
- Produces `BackupDeviceTable`

- [ ] **Step 1: Write failing component tests for configured, degraded, breached, and empty states.**

```tsx
// apps/portal/src/components/portal/BackupOverview.test.tsx
// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import { expect, it } from 'vitest';
import { BackupOverview } from './BackupOverview';

it('renders honest not-configured copy', () => {
  render(<BackupOverview overview={{
    asOf: '2026-09-02T12:00:00Z',
    dataStatus: 'not_configured',
    protected: 0,
    unprotected: 4,
    total: 4,
    lastPassedVerification: null,
    lastTestRestoreAt: null,
    openRpoBreaches: 0,
    openRtoBreaches: 0,
    meanReadinessScore: null,
  }} />);
  expect(screen.getByTestId('portal-backup-overview')).toHaveTextContent(
    'Backups are not configured',
  );
});
```

```tsx
// apps/portal/src/components/portal/BackupDeviceTable.test.tsx
// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import { expect, it } from 'vitest';
import { BackupDeviceTable } from './BackupDeviceTable';

it('shows a not-configured device instead of a blank row', () => {
  render(<BackupDeviceTable devices={[{
    id: 'd-1',
    name: 'Laptop',
    configured: false,
    lastRestorePointAt: null,
    lastRestorePointDegraded: false,
    lastTestRestore: null,
    openBreaches: [],
    readinessScore: null,
    estimatedRtoMinutes: null,
    estimatedRpoMinutes: null,
  }]} />);

  expect(screen.getByTestId('portal-backup-device-d-1')).toHaveTextContent(
    'No backup is configured for this device',
  );
});
```

- [ ] **Step 2: Run both component tests and confirm missing files fail.**

```bash
cd apps/portal && npx vitest run src/components/portal/BackupOverview.test.tsx
cd apps/portal && npx vitest run src/components/portal/BackupDeviceTable.test.tsx
```

- [ ] **Step 3: Implement the overview, table, and SSR page.**

```tsx
// apps/portal/src/components/portal/BackupOverview.tsx
import type { BackupOverviewDto } from '@breeze/shared';

export function BackupOverview({ overview }: { overview: BackupOverviewDto }) {
  return (
    <section data-testid="portal-backup-overview">
      <h1>Backups</h1>
      {overview.dataStatus === 'not_configured' ? (
        <p>Backups are not configured.</p>
      ) : (
        <dl>
          <dt>Protected devices</dt>
          <dd>{overview.protected} of {overview.total}</dd>
          <dt>Last verification</dt>
          <dd>{overview.lastPassedVerification?.completedAt ?? 'No verification is available'}</dd>
          <dt>Mean readiness</dt>
          <dd>{overview.meanReadinessScore ?? 'Not available'}</dd>
          <dt>Open RPO breaches</dt>
          <dd>{overview.openRpoBreaches ?? 'Not available'}</dd>
          <dt>Open RTO breaches</dt>
          <dd>{overview.openRtoBreaches ?? 'Not available'}</dd>
        </dl>
      )}
    </section>
  );
}
```

```tsx
// apps/portal/src/components/portal/BackupDeviceTable.tsx
import type { BackupDeviceRow } from '@breeze/shared';

export function BackupDeviceTable({
  devices,
}: {
  devices: BackupDeviceRow[];
}) {
  return (
    <table data-testid="portal-backup-device-table">
      <thead>
        <tr>
          <th>Device</th>
          <th>Last restore point</th>
          <th>Last test restore</th>
          <th>Open breaches</th>
          <th>Readiness</th>
        </tr>
      </thead>
      <tbody>
        {devices.map((device) => (
          <tr
            key={device.id}
            data-testid={`portal-backup-device-${device.id}`}
          >
            <td>{device.name}</td>
            {!device.configured ? (
              <td colSpan={4}>No backup is configured for this device</td>
            ) : (
              <>
                <td>
                  {device.lastRestorePointAt ?? 'No restore point is available'}
                  {device.lastRestorePointDegraded ? ' (degraded)' : ''}
                </td>
                <td>
                  {device.lastTestRestore
                    ? `${device.lastTestRestore.status} — ${device.lastTestRestore.completedAt ?? 'time unavailable'}`
                    : 'No test restore is available'}
                </td>
                <td>{device.openBreaches.join(', ') || 'None'}</td>
                <td>{device.readinessScore ?? 'Not available'}</td>
              </>
            )}
          </tr>
        ))}
      </tbody>
    </table>
  );
}
```

```astro
---
// apps/portal/src/pages/backups/index.astro
import PortalLayout from '../../layouts/PortalLayout.astro';
import { BackupOverview } from '../../components/portal/BackupOverview';
import { BackupDeviceTable } from '../../components/portal/BackupDeviceTable';
import { portalApi } from '../../lib/api';
import { buildServerApiConfig } from '../../lib/server';
import { redirectToLoginAfter401 } from '../../lib/session';

const config = buildServerApiConfig(Astro.request);
const [overview, devices] = await Promise.all([
  portalApi.getBackupOverview(config),
  portalApi.getBackupDevices({ page: 1, limit: 100 }, config),
]);
if (overview.statusCode === 401 || devices.statusCode === 401) {
  return redirectToLoginAfter401(Astro);
}
---

<PortalLayout title="Backups">
  {
    overview.data
      ? <BackupOverview overview={overview.data} />
      : <p data-testid="portal-backup-error">{overview.error}</p>
  }
  <BackupDeviceTable devices={devices.data?.data ?? []} />
</PortalLayout>
```

- [ ] **Step 4: Run both component tests green.**

```bash
cd apps/portal && npx vitest run src/components/portal/BackupOverview.test.tsx
cd apps/portal && npx vitest run src/components/portal/BackupDeviceTable.test.tsx
```

- [ ] **Step 5: Commit the backups page.**

```bash
git add apps/portal/src/pages/backups/index.astro apps/portal/src/components/portal/BackupOverview.tsx apps/portal/src/components/portal/BackupOverview.test.tsx apps/portal/src/components/portal/BackupDeviceTable.tsx apps/portal/src/components/portal/BackupDeviceTable.test.tsx && git commit -m "feat(portal): add backups page"
```

## Wave W07 — Devices enrichment and CSV export

### Task 7.1: Implement the enriched device read model and CSV iterator

**Files:**
- Create `apps/api/src/services/portal/deviceReadModel.ts`
- Create `apps/api/src/services/portal/deviceReadModel.test.ts`
- Test `apps/api/src/services/portal/deviceReadModel.test.ts`

**Interfaces:**
- Consumes device inventory columns and preserves the ordering in `apps/api/src/routes/portal/devices.ts:29-46`
- Consumes patch installation columns from `apps/api/src/db/schema/patches.ts:193-219`
- Consumes `security_status.provider`, `real_time_protection`, `encryption_status`, and `updated_at` from `apps/api/src/db/schema/security.ts:53-78`
- Consumes backup completion columns from `apps/api/src/db/schema/backup.ts:207-278`
- Consumes warranty end date from `apps/api/src/db/schema/warranty.ts:28-52`
- Reuses `escapeCsvCell` from `packages/shared/src/utils/csvExport.ts:15-20`
- Produces `enrichedDevicesForOrg(orgId, { page, limit, timezone, now })`
- Produces `devicesCsvForOrg(orgId, { timezone, now }): AsyncIterable<string>`

- [ ] **Step 1: Write failing org-predicate, DTO, stable-order, and CSV tests.**

```ts
// apps/api/src/services/portal/deviceReadModel.test.ts
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';

const state = vi.hoisted(() => ({
  rows: [] as unknown[][],
  wheres: [] as unknown[],
}));

vi.mock('../../db', () => ({
  db: {
    select: vi.fn(() => {
      const chain: Record<string, unknown> = {};
      for (const method of ['from', 'leftJoin', 'where', 'orderBy', 'limit', 'offset']) {
        chain[method] = vi.fn((arg: unknown) => {
          if (method === 'where') state.wheres.push(arg);
          return chain;
        });
      }
      chain.then = (resolve: (rows: unknown[]) => unknown) =>
        Promise.resolve(state.rows.shift() ?? []).then(resolve);
      return chain;
    }),
  },
}));

import {
  devicesCsvForOrg,
  enrichedDevicesForOrg,
} from './deviceReadModel';

const ORG_ID = '11111111-1111-4111-8111-111111111111';

describe('deviceReadModel', () => {
  beforeEach(() => {
    state.rows.length = 0;
    state.wheres.length = 0;
  });

  it('returns the enriched customer projection with explicit org scoping', async () => {
    state.rows.push(
      [{ count: 1 }],
      [{
        id: 'd-1',
        hostname: 'Laptop',
        displayName: 'Alice laptop',
        osType: 'windows',
        osVersion: '11',
        status: 'online',
        lastSeenAt: new Date('2026-09-02T11:00:00Z'),
        lastPatchAt: new Date('2026-09-01T00:00:00Z'),
        realTimeProtection: true,
        provider: 'windows_defender',
        avProducts: [{ displayName: 'Defender', provider: 'windows_defender' }],
        securityUpdatedAt: new Date('2026-09-02T10:00:00Z'),
        hasS1Agent: false,
        hasHuntressAgent: false,
        encryption: 'encrypted',
        lastBackupAt: new Date('2026-09-02T08:00:00Z'),
        warrantyEndsAt: '2027-01-01',
      }],
    );

    await expect(
      enrichedDevicesForOrg(ORG_ID, {
        page: 1,
        limit: 50,
        timezone: 'America/Denver',
        now: new Date('2026-09-02T12:00:00Z'),
      }),
    ).resolves.toEqual({
      data: [{
        id: 'd-1',
        hostname: 'Laptop',
        displayName: 'Alice laptop',
        osType: 'windows',
        osVersion: '11',
        status: 'online',
        lastSeenAt: '2026-09-02T11:00:00.000Z',
        lastPatchAt: '2026-09-01T00:00:00.000Z',
        protection: 'protected',
        encryption: 'encrypted',
        lastBackupAt: '2026-09-02T08:00:00.000Z',
        warrantyEndsAt: '2027-01-01',
      }],
      pagination: { page: 1, limit: 50, total: 1 },
    });

    const queries = state.wheres.map((where) =>
      new PgDialect().sqlToQuery(where as SQL),
    );
    for (const query of queries) expect(query.params).toContain(ORG_ID);
    expect(queries.some(({ sql }) => sql.includes('"devices"."org_id" ='))).toBe(true);
  });

  it('streams the UI projection and neutralizes spreadsheet formulas', async () => {
    state.rows.push(
      [{ count: 1 }],
      [{
        id: 'd-1',
        hostname: '=cmd',
        displayName: null,
        osType: 'windows',
        osVersion: '11',
        status: 'online',
        lastSeenAt: null,
        lastPatchAt: null,
        realTimeProtection: null,
        provider: null,
        avProducts: [{ displayName: 'Defender' }],
        securityUpdatedAt: null,
        hasS1Agent: false,
        hasHuntressAgent: false,
        encryption: null,
        lastBackupAt: null,
        warrantyEndsAt: null,
      }],
    );

    let csv = '';
    for await (const chunk of devicesCsvForOrg(ORG_ID, {
      timezone: 'UTC',
      now: new Date('2026-09-02T12:00:00Z'),
    })) csv += chunk;

    expect(csv).toContain(
      '"Device","Type","Status","Last online","Last patch","Protection","Encryption","Last backup","Warranty ends"',
    );
    expect(csv).toContain("'=cmd");
  });
});
```

- [ ] **Step 2: Run the test and confirm the new read-model module is missing.**

```bash
cd apps/api && npx vitest run src/services/portal/deviceReadModel.test.ts
```

- [ ] **Step 3: Implement the stable paginated projection and async CSV generator.**

```ts
// apps/api/src/services/portal/deviceReadModel.ts
import { and, desc, eq, sql } from 'drizzle-orm';
import { escapeCsvCell, type EnrichedPortalDevice } from '@breeze/shared';
import { db } from '../../db';
import {
  deviceWarranty,
  devices,
  securityStatus,
} from '../../db/schema';
import { securityCompliancePostureConfigSchema } from '../../routes/reports/schemas';
import { classifyDeviceProtection } from './protection';

const MAX_SECURITY_STATUS_AGE_DAYS =
  securityCompliancePostureConfigSchema.parse({}).maxSecurityStatusAgeDays;

export async function enrichedDevicesForOrg(
  orgId: string,
  args: { page: number; limit: number; timezone: string; now: Date },
) {
  const offset = (args.page - 1) * args.limit;
  const [countRows, rows] = await Promise.all([
    db
      .select({ count: sql<number>`count(*)::int` })
      .from(devices)
      .where(and(eq(devices.orgId, orgId), eq(devices.isEphemeral, false))),
    db
      .select({
        id: devices.id,
        hostname: devices.hostname,
        displayName: devices.displayName,
        osType: devices.osType,
        osVersion: devices.osVersion,
        status: devices.status,
        lastSeenAt: devices.lastSeenAt,
        lastPatchAt: sql<Date | null>`(
          select max(dp.installed_at)
          from device_patches dp
          where dp.org_id = ${orgId}
            and dp.device_id = ${devices.id}
            and dp.status = 'installed'
        )`,
        realTimeProtection: securityStatus.realTimeProtection,
        provider: securityStatus.provider,
        avProducts: securityStatus.avProducts,
        securityUpdatedAt: securityStatus.updatedAt,
        hasS1Agent: sql<boolean>`exists (
          select 1 from s1_agents s1
          where s1.org_id = ${orgId} and s1.device_id = ${devices.id}
        )`,
        hasHuntressAgent: sql<boolean>`exists (
          select 1 from huntress_agents ha
          where ha.org_id = ${orgId} and ha.device_id = ${devices.id}
        )`,
        encryption: securityStatus.encryptionStatus,
        lastBackupAt: sql<Date | null>`(
          select max(bj.completed_at)
          from backup_jobs bj
          where bj.org_id = ${orgId}
            and bj.device_id = ${devices.id}
            and bj.status in ('completed', 'partial')
        )`,
        warrantyEndsAt: deviceWarranty.warrantyEndDate,
      })
      .from(devices)
      .leftJoin(
        securityStatus,
        and(
          eq(securityStatus.deviceId, devices.id),
          eq(securityStatus.orgId, orgId),
        ),
      )
      .leftJoin(
        deviceWarranty,
        and(
          eq(deviceWarranty.deviceId, devices.id),
          eq(deviceWarranty.orgId, orgId),
        ),
      )
      .where(and(eq(devices.orgId, orgId), eq(devices.isEphemeral, false)))
      // Preserve the existing portal order: most recently seen first.
      .orderBy(desc(devices.lastSeenAt), desc(devices.id))
      .limit(args.limit)
      .offset(offset),
  ]);

  const data: EnrichedPortalDevice[] = rows.map((row) => ({
    id: row.id,
    hostname: row.hostname,
    displayName: row.displayName,
    osType: row.osType,
    osVersion: row.osVersion,
    status: row.status,
    lastSeenAt: row.lastSeenAt?.toISOString() ?? null,
    lastPatchAt: row.lastPatchAt?.toISOString() ?? null,
    protection: classifyDeviceProtection({
      securityStatus: row.securityUpdatedAt
        ? {
            provider: row.provider,
            realTimeProtection: row.realTimeProtection,
            updatedAt: row.securityUpdatedAt,
          }
        : null,
      hasS1Agent: row.hasS1Agent,
      hasHuntressAgent: row.hasHuntressAgent,
      now: args.now,
      maxSecurityStatusAgeDays: MAX_SECURITY_STATUS_AGE_DAYS,
    }),
    encryption: row.encryption,
    lastBackupAt: row.lastBackupAt?.toISOString() ?? null,
    warrantyEndsAt: row.warrantyEndsAt,
  }));

  return {
    data,
    pagination: {
      page: args.page,
      limit: args.limit,
      total: Number(countRows[0]?.count ?? 0),
    },
  };
}

export async function* devicesCsvForOrg(
  orgId: string,
  args: { timezone: string; now: Date },
): AsyncIterable<string> {
  const csvRow = (values: readonly unknown[]) =>
    values.map((value) => escapeCsvCell(String(value ?? ''))).join(',');

  yield csvRow([
    'Device',
    'Type',
    'Status',
    'Last online',
    'Last patch',
    'Protection',
    'Encryption',
    'Last backup',
    'Warranty ends',
  ]) + '\n';

  for (let page = 1; ; page += 1) {
    const result = await enrichedDevicesForOrg(orgId, {
      page,
      limit: 250,
      timezone: args.timezone,
      now: args.now,
    });
    for (const row of result.data) {
      yield csvRow([
        row.displayName ?? row.hostname,
        row.osType ?? '',
        row.status,
        row.lastSeenAt ?? '',
        row.lastPatchAt ?? '',
        row.protection,
        row.encryption ?? '',
        row.lastBackupAt ?? '',
        row.warrantyEndsAt ?? '',
      ]) + '\n';
    }
    if (page * 250 >= result.pagination.total) break;
  }
}
```

- [ ] **Step 4: Run the read-model test green.**

```bash
cd apps/api && npx vitest run src/services/portal/deviceReadModel.test.ts
```

- [ ] **Step 5: Commit the enriched device read model.**

```bash
git add apps/api/src/services/portal/deviceReadModel.ts apps/api/src/services/portal/deviceReadModel.test.ts && git commit -m "feat(portal): add enriched device read model"
```

### Task 7.2: Replace the device route query and add streamed CSV

**Files:**
- Modify `apps/api/src/routes/portal/devices.ts:1-65`
- Create `apps/api/src/routes/portal/devices.test.ts`
- Modify `apps/portal/src/lib/api.ts:301-309,723-734`
- Modify `apps/portal/src/lib/api.test.ts:1-91`
- Test `apps/api/src/routes/portal/devices.test.ts`
- Test `apps/portal/src/lib/api.test.ts`

**Interfaces:**
- Consumes `enrichedDevicesForOrg`
- Consumes `devicesCsvForOrg`
- Consumes `auth.timezone` from `PortalAuthContext`
- Consumes organization slug from `apps/api/src/db/schema/orgs.ts:129-167`
- Consumes `safeContentDispositionFilename` from `apps/api/src/utils/httpHeaders.ts:8`
- Produces enriched `GET /portal/devices`
- Produces streamed `GET /portal/devices/export.csv`
- Produces `portalApi.getDevices(): PaginatedResult<EnrichedPortalDevice>`
- Produces `publicApiPath('/portal/devices/export.csv')`

- [ ] **Step 1: Create the missing route test with session-org, compiled slug predicate, and stream assertions.**

```ts
// apps/api/src/routes/portal/devices.test.ts
import { beforeEach, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';

const mocks = vi.hoisted(() => ({
  enriched: vi.fn(),
  csv: vi.fn(),
  where: null as unknown,
}));

vi.mock('../../services/portal/deviceReadModel', () => ({
  enrichedDevicesForOrg: mocks.enriched,
  devicesCsvForOrg: mocks.csv,
}));
vi.mock('../../db', () => ({
  db: {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn((condition: unknown) => {
          mocks.where = condition;
          return { limit: vi.fn(() => Promise.resolve([{ slug: 'acme' }])) };
        }),
      })),
    })),
  },
}));

import { deviceRoutes } from './devices';

function app() {
  const hono = new Hono();
  hono.use('*', async (c, next) => {
    c.set('portalAuth', {
      user: {
        id: 'pu-1',
        orgId: '11111111-1111-4111-8111-111111111111',
        email: 'user@example.com',
        name: null,
        receiveNotifications: true,
        status: 'active',
      },
      token: 'token',
      authMethod: 'bearer',
      timezone: 'America/Denver',
    });
    await next();
  });
  hono.route('/', deviceRoutes);
  return hono;
}

beforeEach(() => vi.clearAllMocks());

it('delegates the JSON list with the session org', async () => {
  mocks.enriched.mockResolvedValue({
    data: [],
    pagination: { page: 1, limit: 50, total: 0 },
  });
  const response = await app().request('/devices?page=1&limit=50');
  expect(response.status).toBe(200);
  expect(mocks.enriched).toHaveBeenCalledWith(
    '11111111-1111-4111-8111-111111111111',
    expect.objectContaining({
      page: 1,
      limit: 50,
      timezone: 'America/Denver',
      now: expect.any(Date),
    }),
  );
});

it('streams CSV with an org/date filename and scoped slug query', async () => {
  mocks.csv.mockImplementation(async function* () {
    yield 'Device,Status\n';
    yield 'Laptop,online\n';
  });

  const response = await app().request('/devices/export.csv');
  expect(response.status).toBe(200);
  expect(response.headers.get('content-type')).toContain('text/csv');
  expect(response.headers.get('content-disposition')).toMatch(
    /acme-devices-\d{4}-\d{2}-\d{2}\.csv/,
  );
  expect(await response.text()).toBe('Device,Status\nLaptop,online\n');
  expect(mocks.csv).toHaveBeenCalledWith(
    '11111111-1111-4111-8111-111111111111',
    expect.objectContaining({ timezone: 'America/Denver', now: expect.any(Date) }),
  );

  const query = new PgDialect().sqlToQuery(mocks.where as SQL);
  expect(query.sql).toContain('"organizations"."id" =');
  expect(query.params).toContain(
    '11111111-1111-4111-8111-111111111111',
  );
});
```

```ts
// append to apps/portal/src/lib/api.test.ts
it('preserves enriched device fields and exposes a same-origin CSV path', async () => {
  const row = {
    id: 'd-1',
    hostname: 'Laptop',
    displayName: null,
    osType: 'windows',
    osVersion: '11',
    status: 'online',
    lastSeenAt: null,
    lastPatchAt: null,
    protection: 'unknown',
    encryption: null,
    lastBackupAt: null,
    warrantyEndsAt: null,
  };
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
    new Response(JSON.stringify({
      data: [row],
      pagination: { page: 1, limit: 50, total: 1 },
    }), { status: 200 }),
  ));

  await expect(portalApi.getDevices()).resolves.toMatchObject({ data: [row] });
  expect(publicApiPath('/portal/devices/export.csv')).toBe(
    '/api/v1/portal/devices/export.csv',
  );
});
```

- [ ] **Step 2: Run both tests and confirm the existing route lacks service delegation and CSV.**

```bash
cd apps/api && npx vitest run src/routes/portal/devices.test.ts
cd apps/portal && npx vitest run src/lib/api.test.ts
```

- [ ] **Step 3: Replace the route query, register the literal CSV route first, and update the client type.**

```ts
// apps/api/src/routes/portal/devices.ts
import { Hono } from 'hono';
import { zValidator } from '../../lib/validation';
import { eq } from 'drizzle-orm';
import { db } from '../../db';
import { organizations } from '../../db/schema';
import {
  devicesCsvForOrg,
  enrichedDevicesForOrg,
} from '../../services/portal/deviceReadModel';
import { safeContentDispositionFilename } from '../../utils/httpHeaders';
import { listSchema } from './schemas';
import {
  applyPortalCacheHeaders,
  buildWeakEtag,
  getPagination,
  isEtagFresh,
} from './helpers';

export const deviceRoutes = new Hono();

deviceRoutes.get('/devices/export.csv', async (c) => {
  const auth = c.get('portalAuth');
  const orgId = auth.user.orgId;
  const [org] = await db
    .select({ slug: organizations.slug })
    .from(organizations)
    .where(eq(organizations.id, orgId))
    .limit(1);
  const date = new Intl.DateTimeFormat('en-CA', {
    timeZone: auth.timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
  const filename = safeContentDispositionFilename(
    `${org?.slug ?? 'organization'}-devices-${date}.csv`,
  );

  const iterator = devicesCsvForOrg(orgId, {
    timezone: auth.timezone,
    now: new Date(),
  })[Symbol.asyncIterator]();
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      const next = await iterator.next();
      if (next.done) controller.close();
      else controller.enqueue(encoder.encode(next.value));
    },
    async cancel() {
      await iterator.return?.();
    },
  });

  return new Response(body, {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Cache-Control': 'private, max-age=30',
    },
  });
});

deviceRoutes.get(
  '/devices',
  zValidator('query', listSchema),
  async (c) => {
    const auth = c.get('portalAuth');
    const { page, limit } = getPagination(c.req.valid('query'));
    const payload = await enrichedDevicesForOrg(auth.user.orgId, {
      page,
      limit,
      timezone: auth.timezone,
      now: new Date(),
    });

    applyPortalCacheHeaders(c, {
      scope: 'private',
      browserMaxAgeSeconds: 15,
      staleWhileRevalidateSeconds: 90,
      vary: ['Authorization', 'Cookie'],
    });
    const etag = buildWeakEtag(payload);
    c.header('ETag', etag);
    if (isEtagFresh(c.req.header('if-none-match'), etag)) {
      return new Response(null, { status: 304, headers: c.res.headers });
    }
    return c.json(payload);
  },
);
```

```ts
// apps/portal/src/lib/api.ts
import type { EnrichedPortalDevice } from '@breeze/shared';

export type Device = EnrichedPortalDevice;

getDevices: async (
  params: ListParams = {},
  config: ApiRequestConfig = {},
): Promise<PaginatedResult<EnrichedPortalDevice>> => {
  const query = buildQueryString({
    page: params.page ?? 1,
    limit: params.limit ?? 50,
  });
  return mapPaginatedData(
    await apiGet<{
      data: EnrichedPortalDevice[];
      pagination: Pagination;
    }>(`/portal/devices${query}`, config),
  );
},
```

- [ ] **Step 4: Run route and client tests green.**

```bash
cd apps/api && npx vitest run src/routes/portal/devices.test.ts
cd apps/portal && npx vitest run src/lib/api.test.ts
```

- [ ] **Step 5: Commit the enriched route and CSV export.**

```bash
git add apps/api/src/routes/portal/devices.ts apps/api/src/routes/portal/devices.test.ts apps/portal/src/lib/api.ts apps/portal/src/lib/api.test.ts && git commit -m "feat(portal): stream enriched device export"
```

### Task 7.3: Display device enrichment and the CSV action

**Files:**
- Modify `apps/portal/src/pages/devices/index.astro:1-22`
- Modify `apps/portal/src/components/portal/DeviceList.tsx:1-149`
- Create `apps/portal/src/components/portal/DeviceList.test.tsx`
- Test `apps/portal/src/components/portal/DeviceList.test.tsx`

**Interfaces:**
- Consumes `EnrichedPortalDevice`
- Consumes `publicApiPath(path: string): PublicApiPath` from `apps/portal/src/lib/api.ts:102-132`
- Produces enriched device columns
- Produces `data-testid="portal-devices-export"`

- [ ] **Step 1: Write a failing component test for enrichment and same-origin export.**

```tsx
// apps/portal/src/components/portal/DeviceList.test.tsx
// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import { expect, it } from 'vitest';
import { DeviceList } from './DeviceList';

it('renders enrichment and a same-origin export action', () => {
  render(<DeviceList devices={[{
    id: 'd-1',
    hostname: 'Laptop',
    displayName: null,
    osType: 'windows',
    osVersion: '11',
    status: 'online',
    lastSeenAt: null,
    lastPatchAt: '2026-09-01T00:00:00Z',
    protection: 'protected',
    encryption: 'encrypted',
    lastBackupAt: null,
    warrantyEndsAt: '2027-01-01',
  }]} />);

  const row = screen.getByTestId('portal-device-d-1');
  expect(row).toHaveTextContent('Protected');
  expect(row).toHaveTextContent('encrypted');
  expect(row).toHaveTextContent('2027-01-01');
  expect(row).toHaveTextContent('Not available');

  const exportLink = screen.getByTestId('portal-devices-export');
  expect(exportLink.getAttribute('href')).toBe(
    '/api/v1/portal/devices/export.csv',
  );
});
```

- [ ] **Step 2: Run the component test and confirm the current table lacks the fields and action.**

```bash
cd apps/portal && npx vitest run src/components/portal/DeviceList.test.tsx
```

- [ ] **Step 3: Add the export action and enriched columns without replacing the established empty state, status marks, responsive ledger, or summary row.**

```diff
// additive changes to apps/portal/src/components/portal/DeviceList.tsx
-import { Monitor } from 'lucide-react';
-import { type Device } from '@/lib/api';
+import { Download, Monitor } from 'lucide-react';
+import { publicApiPath, type Device } from '@/lib/api';
 import { cn } from '@/lib/utils';
-import { ROW, CELL, TH, PageHeader, StatusMark, EmptyState, ErrorNotice, type MarkTone } from './ui';
+import { BTN_SECONDARY, ROW, CELL, TH, PageHeader, StatusMark, EmptyState, ErrorNotice, type MarkTone } from './ui';
+
+// EnrichedPortalDevice.status is intentionally a string, so keep the three
+// established marks and add a safe neutral fallback for future agent states.
 function statusMark(status: Device['status']): { tone: MarkTone; label: string } {
   switch (status) {
     case 'online':
       return { tone: 'success', label: 'Online' };
     case 'offline':
       return { tone: 'neutral', label: 'Offline' };
     case 'warning':
       return { tone: 'warning', label: 'Warning' };
+    default:
+      return { tone: 'neutral', label: status || 'Unknown' };
   }
 }

 export function DeviceList({ devices, error }: DeviceListProps) {
   if (error) {
     return <ErrorNotice>{error}</ErrorNotice>;
   }
   const online = devices.filter((d) => d.status === 'online').length;
   const footLine =
     devices.length === 0
       ? null
       : online === devices.length
         ? devices.length === 1
           ? 'Your device is online'
           : `All ${devices.length} devices online`
         : `${online} of ${devices.length} online`;
   return (
     <div>
-      <PageHeader title="Devices" lede="The machines your IT team looks after for you." />
+      <PageHeader
+        title="Devices"
+        lede="The machines your IT team looks after for you."
+        action={
+          <a
+            href={publicApiPath('/portal/devices/export.csv')}
+            data-testid="portal-devices-export"
+            className={BTN_SECONDARY}
+          >
+            <Download className="h-4 w-4" aria-hidden="true" />
+            Export CSV
+          </a>
+        }
+      />

       {devices.length === 0 ? (
         <EmptyState icon={<Monitor className="h-10 w-10" strokeWidth={1.5} />} title="No devices">
           <p className="mt-1 text-sm text-muted-foreground">
             Your IT team hasn't linked any devices to your account yet.
           </p>
         </EmptyState>
       ) : (
         <div className="overflow-x-auto">
-          <table className="block w-full sm:table sm:min-w-[36rem]">
+          <table className="block w-full sm:table sm:min-w-[70rem]" data-testid="portal-device-table">
             <thead className="hidden border-b border-border sm:table-header-group">
               <tr>
                 <th scope="col" className={cn(TH, 'text-left')}>Device</th>
                 <th scope="col" className={cn(TH, 'text-left')}>Type</th>
                 <th scope="col" className={cn(TH, 'text-left')}>Status</th>
                 <th scope="col" className={cn(TH, 'text-left')}>Last online</th>
+                <th scope="col" className={cn(TH, 'text-left')}>Last patch</th>
+                <th scope="col" className={cn(TH, 'text-left')}>Protection</th>
+                <th scope="col" className={cn(TH, 'text-left')}>Encryption</th>
+                <th scope="col" className={cn(TH, 'text-left')}>Last backup</th>
+                <th scope="col" className={cn(TH, 'text-left')}>Warranty ends</th>
               </tr>
             </thead>
             <tbody className="block divide-y divide-border/70 sm:table-row-group">
               {devices.map((device) => {
                 const mark = statusMark(device.status);
                 return (
-                  <tr key={device.id} className={ROW}>
+                  <tr key={device.id} className={ROW} data-testid={`portal-device-${device.id}`}>
                     <td className={cn(CELL, 'order-1 grow')}>
                       <span className="font-semibold text-foreground">
                         {device.displayName || device.hostname}
                       </span>
                     </td>
                     <td className={cn(CELL, 'order-3 text-xs text-muted-foreground sm:text-sm')}>
                       <span className="sm:hidden">Type </span>{osLabel(device.osType)}
                     </td>
                     <td className={cn(CELL, 'order-2 shrink-0')}>
                       <StatusMark tone={mark.tone}>{mark.label}</StatusMark>
                     </td>
                     <td className={cn(CELL, 'order-4 text-xs text-muted-foreground sm:text-sm')}>
                       <span className="sm:hidden">Last online </span>{lastSeenLabel(device.lastSeenAt)}
                     </td>
+                    <td className={CELL}>{device.lastPatchAt ?? 'Not available'}</td>
+                    <td className={CELL}>{device.protection[0].toUpperCase() + device.protection.slice(1)}</td>
+                    <td className={CELL}>{device.encryption ?? 'Not available'}</td>
+                    <td className={CELL}>{device.lastBackupAt ?? 'Not available'}</td>
+                    <td className={CELL}>{device.warrantyEndsAt ?? 'Not available'}</td>
                   </tr>
                 );
               })}
             </tbody>
           </table>
           {/* Keep the existing footLine summary and device-ledger-foot markup. */}
           {footLine && (
             <div className="border-t border-border px-4 pt-3.5 text-xs font-semibold uppercase tracking-[0.08em] text-muted-foreground" data-testid="device-ledger-foot">
               {footLine}
             </div>
           )}
         </div>
       )}
     </div>
   );
 }
```

```astro
---
// apps/portal/src/pages/devices/index.astro
import PortalLayout from '../../layouts/PortalLayout.astro';
import { redirectToLoginAfter401 } from '../../lib/session';
import DeviceList from '../../components/portal/DeviceList';
import { portalApi } from '../../lib/api';
import { buildServerApiConfig } from '../../lib/server';

const response = await portalApi.getDevices(
  { page: 1, limit: 100 },
  buildServerApiConfig(Astro.request),
);
if (response.statusCode === 401) {
  return redirectToLoginAfter401(Astro);
}
---

<PortalLayout title="Devices">
  <DeviceList devices={response.data ?? []} error={response.error} />
</PortalLayout>
```

- [ ] **Step 4: Run the device component test green.**

```bash
cd apps/portal && npx vitest run src/components/portal/DeviceList.test.tsx
```

- [ ] **Step 5: Commit the enriched Devices page.**

```bash
git add apps/portal/src/pages/devices/index.astro apps/portal/src/components/portal/DeviceList.tsx apps/portal/src/components/portal/DeviceList.test.tsx && git commit -m "feat(portal): display enriched devices"
```

## Wave W08 — Ticket SLA, support usage, and invoice ticket numbers

### Task 8.1: Add the customer-safe ticket SLA mapper

**Files:**
- Modify `apps/api/src/services/portal/ticketReadModel.ts:1-end`
- Modify `apps/api/src/services/portal/ticketReadModel.test.ts:1-end`
- Modify `apps/api/src/routes/portal/tickets.ts:120-174,244-270`
- Modify `apps/api/src/routes/portal/tickets.test.ts:22-240`
- Test `apps/api/src/services/portal/ticketReadModel.test.ts`
- Test `apps/api/src/routes/portal/tickets.test.ts`

**Interfaces:**
- Consumes `resolveSlaTargets(input: ResolveSlaTargetsInput)` and `SLA_AT_RISK_RATIO` from `apps/api/src/services/ticketSla.ts:10-47`
- Consumes MSP badge rules from `apps/api/src/routes/tickets/tickets.ts:61-85`
- Consumes ticket SLA columns from `apps/api/src/db/schema/portal.ts:76-133`
- Produces `ticketSla(row, now): SlaDto`
- Produces `sla: SlaDto` on portal ticket list and detail DTOs

- [ ] **Step 1: Write the failing SLA matrix and portal-ticket predicate tests against the real route-test harness.**

```ts
// append to apps/api/src/services/portal/ticketReadModel.test.ts
import { ticketSla } from './ticketReadModel';

const NOW = new Date('2026-09-02T02:00:00Z');
const slaRow = (
  overrides: Partial<Parameters<typeof ticketSla>[0]> = {},
): Parameters<typeof ticketSla>[0] => ({
  priority: 'normal',
  status: 'open',
  createdAt: new Date('2026-09-02T00:00:00Z'),
  firstResponseAt: null,
  resolvedAt: null,
  responseSlaMinutes: 100,
  resolutionSlaMinutes: 240,
  slaBreachedAt: null,
  slaPausedAt: null,
  slaPausedMinutes: 0,
  ...overrides,
});

it('covers every portal SLA status', () => {
  expect(ticketSla(slaRow({ slaBreachedAt: NOW }), NOW).status).toBe('breached');
  expect(ticketSla(slaRow(), new Date('2026-09-02T01:25:00Z')).status).toBe('at_risk');
  expect(ticketSla(slaRow({ slaPausedAt: NOW }), NOW).status).toBe('paused');
  expect(ticketSla(slaRow({ status: 'pending' }), NOW).status).toBe('paused');
  expect(ticketSla(slaRow({ status: 'on_hold' }), NOW).status).toBe('paused');
  expect(ticketSla(slaRow(), new Date('2026-09-02T00:30:00Z')).status).toBe('on_track');
  expect(ticketSla(slaRow(), new Date('2026-09-02T04:30:00Z')).status).toBe('at_risk');
  expect(ticketSla(slaRow({
    status: 'resolved',
    resolvedAt: new Date('2026-09-02T01:30:00Z'),
  }), NOW).status).toBe('met');
  expect(ticketSla(slaRow({
    responseSlaMinutes: null,
    resolutionSlaMinutes: null,
  }), NOW).status).toBe('not_configured');
});

it('reports measured minutes and subtracts accumulated resolution pause', () => {
  expect(ticketSla(slaRow({
    firstResponseAt: new Date('2026-09-02T00:30:00Z'),
    resolvedAt: new Date('2026-09-02T02:00:00Z'),
    status: 'resolved',
    slaPausedMinutes: 20,
  }), NOW)).toEqual({
    firstResponseMinutes: 30,
    resolutionMinutes: 100,
    responseTargetMinutes: 100,
    resolutionTargetMinutes: 240,
    status: 'met',
  });
});
```

```ts
// append to apps/api/src/routes/portal/tickets.test.ts
import { portalTicketWhere } from './tickets';

it('builds list/detail predicates with org and submitter isolation', () => {
  const orgId = '11111111-1111-4111-8111-111111111111';
  const portalUserId = '22222222-2222-4222-8222-222222222222';
  const predicate = JSON.stringify(
    portalTicketWhere(orgId, portalUserId),
  );
  // tickets is deliberately string-backed in this file's schema mock, so its
  // Drizzle tree is JSON-safe (the existing tests use the same representation).
  expect(predicate).toContain('orgId');
  expect(predicate).toContain('submittedBy');
  expect(predicate).toContain('deletedAt');
  expect(predicate).toContain(orgId);
  expect(predicate).toContain(portalUserId);

  const detailPredicate = JSON.stringify(
    portalTicketWhere(orgId, portalUserId, TICKET_ID),
  );
  expect(detailPredicate).toContain('id');
  expect(detailPredicate).toContain(TICKET_ID);
});
```

- [ ] **Step 2: Run the service and route tests and confirm `ticketSla` and the reusable predicate are missing.**

```bash
cd apps/api && npx vitest run src/services/portal/ticketReadModel.test.ts
cd apps/api && npx vitest run src/routes/portal/tickets.test.ts
```

- [ ] **Step 3: Implement the SLA mapper and explicit public serialization.**

```ts
// append to apps/api/src/services/portal/ticketReadModel.ts
import type { SlaDto } from '@breeze/shared';
import {
  resolveSlaTargets,
  SLA_AT_RISK_RATIO,
} from '../ticketSla';
import type { tickets } from '../../db/schema';

type TicketSlaRow = Pick<
  typeof tickets.$inferSelect,
  | 'priority'
  | 'status'
  | 'createdAt'
  | 'firstResponseAt'
  | 'resolvedAt'
  | 'responseSlaMinutes'
  | 'resolutionSlaMinutes'
  | 'slaBreachedAt'
  | 'slaPausedAt'
  | 'slaPausedMinutes'
>;

const minutes = (from: Date, to: Date) =>
  Math.max(0, (to.getTime() - from.getTime()) / 60_000);

export function ticketSla(row: TicketSlaRow, now: Date): SlaDto {
  const targets = resolveSlaTargets({
    overrideResponseMinutes: row.responseSlaMinutes,
    overrideResolutionMinutes: row.resolutionSlaMinutes,
    priority: row.priority,
  });
  const firstResponseMinutes = row.firstResponseAt
    ? minutes(row.createdAt, row.firstResponseAt)
    : null;
  const resolutionMinutes = row.resolvedAt
    ? Math.max(
        0,
        minutes(row.createdAt, row.resolvedAt) -
          (row.slaPausedMinutes ?? 0),
      )
    : null;

  const configured =
    targets.responseMinutes !== null ||
    targets.resolutionMinutes !== null;
  let status: SlaDto['status'];

  // Match the MSP list's SQL twins in routes/tickets/tickets.ts:61-85.
  // A stamped breach wins; elapsed time alone never invents one.
  if (row.slaBreachedAt) status = 'breached';
  else if (!configured) status = 'not_configured';
  else if (
    row.status === 'resolved' ||
    row.status === 'closed' ||
    row.resolvedAt
  ) status = 'met';
  else {
    const unmet = [
      row.firstResponseAt ? null : targets.responseMinutes,
      targets.resolutionMinutes,
    ].filter((value): value is number => value !== null);

    if (unmet.length === 0) status = 'met';
    else if (
      row.status === 'pending' ||
      row.status === 'on_hold' ||
      row.slaPausedAt
    ) status = 'paused';
    else {
      const activeElapsed =
        minutes(row.createdAt, now) - (row.slaPausedMinutes ?? 0);
      const target = Math.min(...unmet);
      status = activeElapsed >= target * SLA_AT_RISK_RATIO
          ? 'at_risk'
          : 'on_track';
    }
  }

  return {
    firstResponseMinutes,
    resolutionMinutes,
    responseTargetMinutes: targets.responseMinutes,
    resolutionTargetMinutes: targets.resolutionMinutes,
    status,
  };
}
```

```ts
// apps/api/src/routes/portal/tickets.ts
import { ticketSla } from '../../services/portal/ticketReadModel';

export function portalTicketWhere(
  orgId: string,
  portalUserId: string,
  id?: string,
) {
  return and(
    id ? eq(tickets.id, id) : undefined,
    eq(tickets.orgId, orgId),
    eq(tickets.submittedBy, portalUserId),
    isNull(tickets.deletedAt),
  );
}

const PORTAL_TICKET_SLA_COLUMNS = {
  responseSlaMinutes: tickets.responseSlaMinutes,
  resolutionSlaMinutes: tickets.resolutionSlaMinutes,
  slaBreachedAt: tickets.slaBreachedAt,
  slaPausedAt: tickets.slaPausedAt,
  slaPausedMinutes: tickets.slaPausedMinutes,
  firstResponseAt: tickets.firstResponseAt,
  resolvedAt: tickets.resolvedAt,
};
```

```diff
// exact list/detail edits in apps/api/src/routes/portal/tickets.ts
-  const conditions = and(
-    eq(tickets.orgId, auth.user.orgId),
-    eq(tickets.submittedBy, auth.user.id),
-    isNull(tickets.deletedAt)
-  );
+  const conditions = portalTicketWhere(auth.user.orgId, auth.user.id);

       updatedAt: tickets.updatedAt,
-      statusName: ticketStatuses.name
+      statusName: ticketStatuses.name,
+      ...PORTAL_TICKET_SLA_COLUMNS,
     })

       updatedAt: tickets.updatedAt,
-      statusName: ticketStatuses.name
+      statusName: ticketStatuses.name,
+      ...PORTAL_TICKET_SLA_COLUMNS,
     })
     .from(tickets)
     .leftJoin(ticketStatuses, eq(tickets.statusId, ticketStatuses.id))
-    .where(
-      and(
-        eq(tickets.id, id),
-        eq(tickets.orgId, auth.user.orgId),
-        eq(tickets.submittedBy, auth.user.id),
-        isNull(tickets.deletedAt)
-      )
-    )
+    .where(portalTicketWhere(auth.user.orgId, auth.user.id, id))
     .limit(1);
```

```ts
// Serialize rather than spreading the raw row:
const now = new Date();
const data = rows.map((row) => ({
  id: row.id,
  ticketNumber: row.ticketNumber,
  subject: row.subject,
  status: row.status,
  priority: row.priority,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
  statusName: row.statusName,
  sla: ticketSla(row, now),
}));

// In GET /tickets/:id, replace the current raw `...ticket` spread. Keep the
// established description/comments fields while excluding the SLA source
// columns from the customer response.
const ticketDto = {
  id: ticket.id,
  ticketNumber: ticket.ticketNumber,
  subject: ticket.subject,
  description: ticket.description,
  status: ticket.status,
  priority: ticket.priority,
  createdAt: ticket.createdAt,
  updatedAt: ticket.updatedAt,
  statusName: ticket.statusName,
  sla: ticketSla(ticket, new Date()),
};
const payload = {
  ticket: {
    ...ticketDto,
    comments: commentsWithAttachments,
  },
};
```

- [ ] **Step 4: Run both test files green.**

```bash
cd apps/api && npx vitest run src/services/portal/ticketReadModel.test.ts
cd apps/api && npx vitest run src/routes/portal/tickets.test.ts
```

- [ ] **Step 5: Commit ticket SLA serialization.**

```bash
git add apps/api/src/services/portal/ticketReadModel.ts apps/api/src/services/portal/ticketReadModel.test.ts apps/api/src/routes/portal/tickets.ts apps/api/src/routes/portal/tickets.test.ts && git commit -m "feat(portal): add ticket SLA status"
```

### Task 8.2: Add the support usage endpoint before the ticket id route

**Files:**
- Modify `apps/api/src/routes/portal/schemas.ts:1-180`
- Modify `apps/api/src/routes/portal/tickets.ts:73-120,244-270`
- Modify `apps/api/src/routes/portal/tickets.test.ts:22-240,406-535`
- Test `apps/api/src/routes/portal/tickets.test.ts`

**Interfaces:**
- Consumes the once-per-request `auth.timezone` hydrated by `portalAuthMiddleware`
- Consumes `supportUsageForOrg(args: { orgId: string; month: string; timezone: string; portalUserId: string }): Promise<SupportUsageDto>`
- Produces `GET /portal/tickets/usage?month=YYYY-MM`

- [ ] **Step 1: Write failing tests for explicit/default month, validation, session-derived scope, and literal-route order.**

```ts
// append to apps/api/src/routes/portal/tickets.test.ts
const { supportUsageForOrgMock } = vi.hoisted(() => ({
  supportUsageForOrgMock: vi.fn(),
}));

vi.mock('../../services/portal/supportUsage', () => ({
  supportUsageForOrg: supportUsageForOrgMock,
}));
```

```diff
// update the real buildApp() stand-in at apps/api/src/routes/portal/tickets.test.ts:124-131
-    c.set('portalAuth' as never, { user: PORTAL_USER, token: 'tok-1', authMethod: 'bearer' });
+    c.set('portalAuth' as never, {
+      user: PORTAL_USER,
+      token: 'tok-1',
+      authMethod: 'bearer',
+      timezone: 'America/Denver',
+    });
```

```ts
describe('GET /tickets/usage', () => {
  beforeEach(() => vi.clearAllMocks());

  it('passes only the session org and portal user to the aggregator', async () => {
    supportUsageForOrgMock.mockResolvedValue({
      asOf: '2026-09-02T12:00:00.000Z',
      month: '2026-09',
      timezone: 'America/Denver',
      dataStatus: 'no_data',
      totals: {
        billed: { minutes: 0, hours: 0 },
        toBeBilled: { minutes: 0, hours: 0 },
        coveredByContract: { minutes: 0, hours: 0 },
        pendingReview: { minutes: 0, hours: 0 },
      },
      tickets: [],
    });

    const response = await buildApp().request(
      '/tickets/usage?month=2026-09',
    );
    expect(response.status).toBe(200);
    expect(supportUsageForOrgMock).toHaveBeenCalledWith({
      orgId: 'o-1',
      month: '2026-09',
      timezone: 'America/Denver',
      portalUserId: 'pu-1',
    });
  });

  it('rejects an invalid month before calling the service', async () => {
    const response = await buildApp().request(
      '/tickets/usage?month=2026-13',
    );
    expect(response.status).toBe(400);
    expect(supportUsageForOrgMock).not.toHaveBeenCalled();
  });

  it('registers the literal route before /tickets/:id', async () => {
    supportUsageForOrgMock.mockResolvedValue({
      asOf: '2026-09-02T12:00:00.000Z',
      month: '2026-09',
      timezone: 'America/Denver',
      dataStatus: 'no_data',
      totals: {
        billed: { minutes: 0, hours: 0 },
        toBeBilled: { minutes: 0, hours: 0 },
        coveredByContract: { minutes: 0, hours: 0 },
        pendingReview: { minutes: 0, hours: 0 },
      },
      tickets: [],
    });
    const response = await buildApp().request('/tickets/usage');
    expect(response.status).toBe(200);
    expect(supportUsageForOrgMock).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: Run the route test and confirm `/tickets/usage` is absent or swallowed by `/:id`.**

```bash
cd apps/api && npx vitest run src/routes/portal/tickets.test.ts
```

- [ ] **Step 3: Add strict month validation and register the cached literal route before `/tickets/:id`.**

```ts
// apps/api/src/routes/portal/schemas.ts
export const supportUsageQuerySchema = z.object({
  month: z
    .string()
    .regex(/^\d{4}-(0[1-9]|1[0-2])$/)
    .optional(),
});
```

```ts
// apps/api/src/routes/portal/tickets.ts
import { supportUsageForOrg } from '../../services/portal/supportUsage';
import { supportUsageQuerySchema } from './schemas';

function currentMonthIn(timezone: string, now = new Date()): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
  }).formatToParts(now);
  const value = (type: string) =>
    parts.find((part) => part.type === type)!.value;
  return `${value('year')}-${value('month')}`;
}

// Insert immediately after the existing GET /tickets/forms block and before
// the existing GET /tickets list and GET /tickets/:id blocks. This preserves
// the literal-before-parameter route ordering in the real file.
ticketRoutes.get(
  '/tickets/usage',
  zValidator('query', supportUsageQuerySchema),
  async (c) => {
    const auth = c.get('portalAuth');
    const month =
      c.req.valid('query').month ?? currentMonthIn(auth.timezone);
    const payload = await supportUsageForOrg({
      orgId: auth.user.orgId,
      month,
      timezone: auth.timezone,
      portalUserId: auth.user.id,
    });

    applyPortalCacheHeaders(c, {
      scope: 'private',
      browserMaxAgeSeconds: 30,
      staleWhileRevalidateSeconds: 0,
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
```

- [ ] **Step 4: Run the portal ticket route test green.**

```bash
cd apps/api && npx vitest run src/routes/portal/tickets.test.ts
```

- [ ] **Step 5: Commit the support usage endpoint.**

```bash
git add apps/api/src/routes/portal/schemas.ts apps/api/src/routes/portal/tickets.ts apps/api/src/routes/portal/tickets.test.ts && git commit -m "feat(portal): add support usage endpoint"
```

### Task 8.3: Add support usage and SLA status to the portal UI

**Files:**
- Modify `apps/portal/src/lib/api.ts:291-367,723-790`
- Modify `apps/portal/src/lib/api.test.ts:38-59`
- Modify `apps/portal/src/pages/tickets/index.astro:1-30`
- Modify `apps/portal/src/components/portal/TicketList.tsx:10-122`
- Modify `apps/portal/src/components/portal/TicketList.test.tsx:1-65`
- Create `apps/portal/src/components/portal/SupportUsagePanel.tsx`
- Create `apps/portal/src/components/portal/SupportUsagePanel.test.tsx`
- Test `apps/portal/src/lib/api.test.ts`
- Test `apps/portal/src/components/portal/TicketList.test.tsx`
- Test `apps/portal/src/components/portal/SupportUsagePanel.test.tsx`

**Interfaces:**
- Consumes `SupportUsageDto`, `SlaDto`
- Produces `portalApi.getSupportUsage(month?, config?)`
- Produces `SupportUsagePanel`

- [ ] **Step 1: Write failing client, title-redaction, usage-bucket, and SLA badge tests.**

```ts
// append to apps/portal/src/lib/api.test.ts
it('GETs support usage with an optional month', async () => {
  const dto = {
    asOf: '2026-09-02T12:00:00.000Z',
    month: '2026-09',
    timezone: 'America/Denver',
    dataStatus: 'no_data',
    totals: {
      billed: { minutes: 0, hours: 0 },
      toBeBilled: { minutes: 0, hours: 0 },
      coveredByContract: { minutes: 0, hours: 0 },
      pendingReview: { minutes: 0, hours: 0 },
    },
    tickets: [],
  };
  const fetchMock = vi.fn().mockResolvedValue(
    new Response(JSON.stringify(dto), { status: 200 }),
  );
  vi.stubGlobal('fetch', fetchMock);

  await expect(
    portalApi.getSupportUsage('2026-09'),
  ).resolves.toMatchObject({ data: dto });
  expect(String(fetchMock.mock.calls[0][0])).toContain(
    '/portal/tickets/usage?month=2026-09',
  );
});
```

```tsx
// apps/portal/src/components/portal/SupportUsagePanel.test.tsx
// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import { expect, it } from 'vitest';
import { SupportUsagePanel } from './SupportUsagePanel';

it('renders all buckets and never reveals another submitter title', () => {
  render(<SupportUsagePanel usage={{
    asOf: '2026-09-02T12:00:00Z',
    month: '2026-09',
    timezone: 'America/Denver',
    dataStatus: 'ok',
    totals: {
      billed: { minutes: 60, hours: 1 },
      toBeBilled: { minutes: 30, hours: 0.5 },
      coveredByContract: { minutes: 45, hours: 0.75 },
      pendingReview: { minutes: 15, hours: 0.25 },
    },
    tickets: [
      {
        ticketNumber: 'T-1',
        title: 'My printer',
        billedMinutes: 60,
        toBeBilledMinutes: 0,
        coveredByContractMinutes: 0,
        pendingReviewMinutes: 0,
      },
      {
        ticketNumber: 'T-2',
        title: null,
        billedMinutes: 0,
        toBeBilledMinutes: 30,
        coveredByContractMinutes: 45,
        pendingReviewMinutes: 15,
      },
    ],
  }} />);

  expect(screen.getByTestId('portal-support-usage-billed')).toHaveTextContent('60');
  expect(screen.getByTestId('portal-support-usage-contract')).toHaveTextContent('45');
  expect(screen.getByText('My printer')).toBeTruthy();
  expect(screen.getByText('Ticket #T-2')).toBeTruthy();
  expect(screen.queryByText('Another user secret title')).toBeNull();
});

it('renders honest no-data copy', () => {
  render(<SupportUsagePanel usage={{
    asOf: '2026-09-02T12:00:00.000Z',
    month: '2026-09',
    timezone: 'UTC',
    dataStatus: 'no_data',
    totals: {
      billed: { minutes: 0, hours: 0 },
      toBeBilled: { minutes: 0, hours: 0 },
      coveredByContract: { minutes: 0, hours: 0 },
      pendingReview: { minutes: 0, hours: 0 },
    },
    tickets: [],
  }} />);
  expect(screen.getByTestId('portal-support-usage-empty')).toHaveTextContent(
    'No billable support time has been recorded this month',
  );
});
```

```diff
// update the existing factory in apps/portal/src/components/portal/TicketList.test.tsx:12-22
 const ticket = (over: Partial<TicketSummary> = {}): TicketSummary => ({
   id: 't1',
   ticketNumber: 'T-1',
   subject: 'Printer offline',
   status: 'open',
   priority: 'normal',
   createdAt: '2026-08-01T00:00:00Z',
   updatedAt: '2026-08-02T00:00:00Z',
+  sla: {
+    firstResponseMinutes: null,
+    resolutionMinutes: null,
+    responseTargetMinutes: null,
+    resolutionTargetMinutes: null,
+    status: 'not_configured',
+  },
   ...over,
 });
```

```tsx
// append to apps/portal/src/components/portal/TicketList.test.tsx
it.each([
  ['breached', 'SLA breached'],
  ['at_risk', 'SLA at risk'],
  ['paused', 'SLA paused'],
  ['on_track', 'SLA on track'],
  ['met', 'SLA met'],
  ['not_configured', 'No SLA configured'],
] as const)('renders %s SLA status', (status, copy) => {
  render(<TicketList tickets={[ticket({
    id: status,
    sla: {
      firstResponseMinutes: null,
      resolutionMinutes: null,
      responseTargetMinutes: null,
      resolutionTargetMinutes: null,
      status,
    },
  })]} />);
  expect(screen.getByTestId(`portal-ticket-sla-${status}`)).toHaveTextContent(copy);
});
```

- [ ] **Step 2: Run the client and component tests and confirm missing types/methods/components fail.**

```bash
cd apps/portal && npx vitest run src/lib/api.test.ts
cd apps/portal && npx vitest run src/components/portal/TicketList.test.tsx
cd apps/portal && npx vitest run src/components/portal/SupportUsagePanel.test.tsx
```

- [ ] **Step 3: Add the shared types, client method, panel, badges, and concurrent SSR fetch.**

```ts
// apps/portal/src/lib/api.ts
import type {
  SlaDto,
  SupportUsageDto,
} from '@breeze/shared';

export interface TicketSummary {
  id: string;
  ticketNumber: string;
  subject: string;
  status: TicketStatus;
  priority: TicketPriority;
  createdAt: string;
  updatedAt: string;
  sla: SlaDto;
}

// POST /tickets returns the newly created record before SLA serialization;
// keep that existing response honest instead of claiming it has `sla`.
export type CreatedPortalTicket = Omit<TicketSummary, 'sla'> & {
  description: string;
};

getSupportUsage: (
  month?: string,
  config: ApiRequestConfig = {},
): Promise<ApiResponse<SupportUsageDto>> =>
  apiGet<SupportUsageDto>(
    `/portal/tickets/usage${buildQueryString({ month })}`,
    config,
  ),
```

```diff
// update the existing createTicket method in apps/portal/src/lib/api.ts:792-799
   createTicket: async (
     data: CreateTicketInput,
     config: ApiRequestConfig = {}
-  ): Promise<ApiResponse<TicketSummary & { description: string }>> => {
-    const response = await apiPost<{ ticket: TicketSummary & { description: string } }>(
+  ): Promise<ApiResponse<CreatedPortalTicket>> => {
+    const response = await apiPost<{ ticket: CreatedPortalTicket }>(
       '/portal/tickets',
       data,
       config
     );
```

```tsx
// apps/portal/src/components/portal/SupportUsagePanel.tsx
import type { SupportUsageDto } from '@breeze/shared';
import { ErrorNotice } from './ui';

export function SupportUsagePanel({
  usage,
  error,
}: {
  usage: SupportUsageDto | null;
  error?: string;
}) {
  if (error) return <ErrorNotice>{error}</ErrorNotice>;
  if (!usage) return null;

  if (usage.dataStatus === 'no_data') {
    return (
      <section data-testid="portal-support-usage">
        <h2>Support usage</h2>
        <p>{usage.month} · {usage.timezone}</p>
        <p data-testid="portal-support-usage-empty">
          No billable support time has been recorded this month.
        </p>
      </section>
    );
  }

  return (
    <section data-testid="portal-support-usage">
      <h2>Support usage</h2>
      <p>{usage.month} · {usage.timezone}</p>
      <dl>
        <div data-testid="portal-support-usage-billed">
          <dt>Billed</dt>
          <dd>{usage.totals.billed.minutes} minutes ({usage.totals.billed.hours} hours)</dd>
        </div>
        <div data-testid="portal-support-usage-to-be-billed">
          <dt>To be billed</dt>
          <dd>{usage.totals.toBeBilled.minutes} minutes ({usage.totals.toBeBilled.hours} hours)</dd>
        </div>
        <div data-testid="portal-support-usage-contract">
          <dt>Covered by contract</dt>
          <dd>{usage.totals.coveredByContract.minutes} minutes ({usage.totals.coveredByContract.hours} hours)</dd>
        </div>
        <div data-testid="portal-support-usage-pending">
          <dt>Pending review</dt>
          <dd>{usage.totals.pendingReview.minutes} minutes ({usage.totals.pendingReview.hours} hours)</dd>
        </div>
      </dl>
      <table>
        <tbody>
          {usage.tickets.map((ticket) => (
            <tr
              key={ticket.ticketNumber}
              data-testid={`portal-support-usage-ticket-${ticket.ticketNumber}`}
            >
              <td>{ticket.title ?? `Ticket #${ticket.ticketNumber}`}</td>
              <td>{ticket.billedMinutes}</td>
              <td>{ticket.toBeBilledMinutes}</td>
              <td>{ticket.coveredByContractMinutes}</td>
              <td>{ticket.pendingReviewMinutes}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
```

```tsx
// add inside the ticket row in apps/portal/src/components/portal/TicketList.tsx
const SLA_LABELS = {
  breached: 'SLA breached',
  at_risk: 'SLA at risk',
  paused: 'SLA paused',
  on_track: 'SLA on track',
  met: 'SLA met',
  not_configured: 'No SLA configured',
} as const;

<span data-testid={`portal-ticket-sla-${ticket.id}`}>
  {SLA_LABELS[ticket.sla.status]}
</span>
```

```astro
---
// apps/portal/src/pages/tickets/index.astro
import PortalLayout from '../../layouts/PortalLayout.astro';
import { withBase } from '../../lib/basePath';
import { redirectToLoginAfter401 } from '../../lib/session';
import TicketList from '../../components/portal/TicketList';
import { SupportUsagePanel } from '../../components/portal/SupportUsagePanel';
import { portalApi } from '../../lib/api';
import { buildServerApiConfig } from '../../lib/server';

const config = buildServerApiConfig(Astro.request);
const [response, usageResponse] = await Promise.all([
  portalApi.getTickets({ page: 1, limit: 100 }, config),
  portalApi.getSupportUsage(undefined, config),
]);
if (response.statusCode === 401 || usageResponse.statusCode === 401) {
  return redirectToLoginAfter401(Astro);
}
if (response.statusCode === 403 && response.code === 'PORTAL_TICKETS_DISABLED') {
  return Astro.redirect(withBase('/devices'));
}
const usageStrictlyDisabled = usageResponse.statusCode === 403;
---

<PortalLayout title="Support">
  <TicketList tickets={response.data ?? []} error={response.error} />
  {
    !usageStrictlyDisabled &&
      <SupportUsagePanel
        usage={usageResponse.data ?? null}
        error={usageResponse.error}
      />
  }
</PortalLayout>
```

- [ ] **Step 4: Run all three portal test files green.**

```bash
cd apps/portal && npx vitest run src/lib/api.test.ts
cd apps/portal && npx vitest run src/components/portal/TicketList.test.tsx
cd apps/portal && npx vitest run src/components/portal/SupportUsagePanel.test.tsx
```

- [ ] **Step 5: Commit the support usage and SLA UI.**

```bash
git add apps/portal/src/lib/api.ts apps/portal/src/lib/api.test.ts apps/portal/src/pages/tickets/index.astro apps/portal/src/components/portal/TicketList.tsx apps/portal/src/components/portal/TicketList.test.tsx apps/portal/src/components/portal/SupportUsagePanel.tsx apps/portal/src/components/portal/SupportUsagePanel.test.tsx && git commit -m "feat(portal): show support usage and SLA"
```

### Task 8.4: Add ticket numbers to customer invoice lines

**Files:**
- Modify `apps/api/src/services/invoiceService.ts:634-695,720-741`
- Modify `apps/api/src/services/invoiceService.test.ts:14,394-462`
- Modify `apps/api/src/routes/portal/invoices.test.ts:173-205`
- Modify `apps/portal/src/lib/api.ts:443-470`
- Modify `apps/portal/src/components/portal/InvoiceDetailView.tsx:291-327`
- Modify `apps/portal/src/components/portal/InvoiceDetailView.test.tsx:18-89`
- Test `apps/api/src/services/invoiceService.test.ts`
- Test `apps/api/src/routes/portal/invoices.test.ts`
- Test `apps/portal/src/components/portal/InvoiceDetailView.test.tsx`

**Interfaces:**
- Consumes `invoice_lines.org_id` and `ticket_id` from `apps/api/src/db/schema/invoices.ts:98-136`
- Consumes `tickets.ticket_number` from `apps/api/src/db/schema/portal.ts:76-80`
- Produces `CustomerInvoiceLine.ticketNumber: string | null`
- Produces `InvoiceLine.ticketNumber: string | null`

- [ ] **Step 1: Write failing serializer, compiled join, leak-guard, and rendering tests.**

```diff
// apps/api/src/services/invoiceService.test.ts:14 — extend the existing list
-const methods = ['select', 'from', 'where', 'limit', 'orderBy', 'insert', 'values', 'returning', 'update', 'set', 'delete', 'for', 'innerJoin', 'execute'];
+const methods = ['select', 'from', 'where', 'limit', 'orderBy', 'insert', 'values', 'returning', 'update', 'set', 'delete', 'for', 'innerJoin', 'leftJoin', 'execute'];
```

```ts
// append below the existing imports in apps/api/src/services/invoiceService.test.ts
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';

it('serializes ticketNumber without source metadata', () => {
  expect(svc.toCustomerInvoiceLine({
    ticketNumber: 'T-100',
    name: 'Support',
    description: 'Printer repair',
    quantity: '1',
    unitPrice: '100',
    taxable: false,
    lineTotal: '100',
  })).toEqual({
    ticketNumber: 'T-100',
    name: 'Support',
    description: 'Printer repair',
    quantity: '1',
    unitPrice: '100',
    taxable: false,
    lineTotal: '100',
  });
});

it('joins tickets and scopes both sides to the invoice org', async () => {
  queueResult([{
    id: 'invoice-1', status: 'sent', orgId: 'org1', partnerId: 'p1',
  }]);
  queueResult([]);
  await svc.getCustomerInvoice('invoice-1', 'org1');
  const join = db.leftJoin.mock.calls.at(-1)![1];
  const compiledJoin = new PgDialect().sqlToQuery(join as SQL);
  expect(compiledJoin.sql).toContain(
    '"tickets"."id" = "invoice_lines"."ticket_id"',
  );
  expect(compiledJoin.sql).toContain('"tickets"."org_id" =');
  expect(compiledJoin.params).toContain('org1');

  const where = db.where.mock.calls.at(-1)![0];
  const compiledWhere = new PgDialect().sqlToQuery(where as SQL);
  expect(compiledWhere.sql).toContain('"invoice_lines"."org_id" =');
  expect(compiledWhere.params).toContain('org1');
});
```

```diff
// update both customer-line keyset assertions and the legacy-line value
// assertion already present in apps/api/src/services/invoiceService.test.ts:394-460
-      'description', 'lineTotal', 'name', 'quantity', 'taxable', 'unitPrice',
+      'description', 'lineTotal', 'name', 'quantity', 'taxable', 'ticketNumber', 'unitPrice',
     ]);
     expect(result.lines[0]).toEqual({
+      ticketNumber: null,
       name: null,
       description: 'Customer-facing work',
       quantity: '2.00',
       unitPrice: '75.00',
       taxable: true,
       lineTotal: '150.00',
     });
```

```ts
// update the customer-line keyset assertion in
// apps/api/src/routes/portal/invoices.test.ts
expect(Object.keys(body.lines[0]).sort()).toEqual([
  'description',
  'lineTotal',
  'name',
  'quantity',
  'taxable',
  'ticketNumber',
  'unitPrice',
]);
expect(body.lines[0]).not.toHaveProperty('sourceType');
expect(body.lines[0]).not.toHaveProperty('sourceId');
```

```diff
// update the real line() factory in apps/portal/src/components/portal/InvoiceDetailView.test.tsx:18-31
 function line(overrides: Partial<InvoiceLine> = {}): InvoiceLine {
   return {
+    ticketNumber: null,
     name: null,
     description: '',
     quantity: '1.00',
     unitPrice: '100.00',
     lineTotal: '100.00',
     taxable: false,
     ...overrides,
   };
 }
```

```tsx
// append to apps/portal/src/components/portal/InvoiceDetailView.test.tsx
it('renders a linked ticket number and omits it for an unlinked line', () => {
  renderDetail([
    line({ ticketNumber: 'T-100' }),
    line({ ticketNumber: null }),
  ]);
  expect(screen.getByTestId('invoice-line-ticket-0')).toHaveTextContent(
    'Ticket #T-100',
  );
  expect(screen.queryByTestId('invoice-line-ticket-1')).toBeNull();
});
```

- [ ] **Step 2: Run the three tests and confirm `ticketNumber` is absent.**

```bash
cd apps/api && npx vitest run src/services/invoiceService.test.ts
cd apps/api && npx vitest run src/routes/portal/invoices.test.ts
cd apps/portal && npx vitest run src/components/portal/InvoiceDetailView.test.tsx
```

- [ ] **Step 3: Add the tenant-safe left join, serializer field, portal type, and display.**

```ts
// apps/api/src/services/invoiceService.ts
export type CustomerInvoiceLine = {
  ticketNumber: string | null;
  name: string | null;
  description: string;
  quantity: string;
  unitPrice: string;
  taxable: boolean;
  lineTotal: string;
};

type CustomerInvoiceLineSource = {
  ticketNumber?: string | null;
  name?: string | null;
  description?: string | null;
  quantity: string;
  unitPrice: string;
  taxable: boolean;
  lineTotal: string;
};

export function toCustomerInvoiceLine(
  line: CustomerInvoiceLineSource,
): CustomerInvoiceLine {
  return {
    ticketNumber: line.ticketNumber ?? null,
    name: line.name ?? null,
    description: line.description ?? '',
    quantity: line.quantity,
    unitPrice: line.unitPrice,
    taxable: line.taxable,
    lineTotal: line.lineTotal,
  };
}

export async function getCustomerInvoice(
  invoiceId: string,
  orgId?: string,
) {
  const inv = await getOwnedInvoiceOr404(invoiceId);
  if (orgId !== undefined && inv.orgId !== orgId) {
    throw new InvoiceServiceError(
      'Invoice not found',
      404,
      'INVOICE_NOT_FOUND',
    );
  }

  const rows = await db
    .select({
      ticketNumber: tickets.ticketNumber,
      name: invoiceLines.name,
      description: invoiceLines.description,
      quantity: invoiceLines.quantity,
      unitPrice: invoiceLines.unitPrice,
      taxable: invoiceLines.taxable,
      lineTotal: invoiceLines.lineTotal,
    })
    .from(invoiceLines)
    .leftJoin(
      tickets,
      and(
        eq(tickets.id, invoiceLines.ticketId),
        eq(tickets.orgId, inv.orgId),
      ),
    )
    .where(and(
      eq(invoiceLines.invoiceId, invoiceId),
      eq(invoiceLines.orgId, inv.orgId),
      eq(invoiceLines.customerVisible, true),
    ))
    .orderBy(invoiceLines.sortOrder);

  return {
    invoice: toCustomerInvoiceHeader(inv),
    lines: rows.map(toCustomerInvoiceLine),
    partnerId: inv.partnerId,
  };
}
```

```ts
// apps/portal/src/lib/api.ts
export interface InvoiceLine {
  ticketNumber: string | null;
  name: string | null;
  description: string;
  quantity: string;
  unitPrice: string;
  lineTotal: string;
  taxable: boolean;
}
```

```tsx
// inside the line rendering loop in
// apps/portal/src/components/portal/InvoiceDetailView.tsx
{l.ticketNumber && (
  <div
    className="mt-0.5 text-xs text-muted-foreground"
    data-testid={`invoice-line-ticket-${index}`}
  >
    Ticket #{l.ticketNumber}
  </div>
)}
```

- [ ] **Step 4: Run the invoice service, portal route, and component tests green.**

```bash
cd apps/api && npx vitest run src/services/invoiceService.test.ts
cd apps/api && npx vitest run src/routes/portal/invoices.test.ts
cd apps/portal && npx vitest run src/components/portal/InvoiceDetailView.test.tsx
```

- [ ] **Step 5: Commit customer invoice ticket numbers.**

```bash
git add apps/api/src/services/invoiceService.ts apps/api/src/services/invoiceService.test.ts apps/api/src/routes/portal/invoices.test.ts apps/portal/src/lib/api.ts apps/portal/src/components/portal/InvoiceDetailView.tsx apps/portal/src/components/portal/InvoiceDetailView.test.tsx && git commit -m "feat(portal): link invoice lines to tickets"
```
