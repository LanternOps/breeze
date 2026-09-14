import { randomUUID } from 'node:crypto';
import { and, count, desc, eq, ne, sql } from 'drizzle-orm';
import { buildReportPdf, type BuildOpts } from '@breeze/shared/reportPdf';
import {
  rowsToCsv,
  type HardwareLifecycleSummary,
  type PortalRunDto,
  type PortalRunsDto,
} from '@breeze/shared';
import { db } from '../../db';
import { tightenStatementTimeout } from '../../db/lockTimeout';
import { portalBranding, reportRuns, reports } from '../../db/schema';
import { checkRateLimit, PORTAL_USE_REDIS } from './rateLimit';
import { getRedis } from '../redis';
import {
  generateReport,
  previousBaselineFor,
  type ReportResult,
} from '../reportGenerationService';
import { getReportBranding } from '../reportBranding';
import {
  persistedSiteScopeValues,
  portalUserReportAuthority,
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
  {
    type: 'hardware_lifecycle',
    name: 'Customer portal — Hardware Lifecycle',
    config: {
      sites: [],
      replaceAgeYears: 4,
      serverReplaceAgeYears: 5,
      includeManualAssets: true,
      includeOtherEquipment: true,
    },
  },
] as const;

type PortalReportInsertExecutor = Pick<typeof db, 'insert'>;
type PortalReportProvisionArgs = {
  orgId: string;
  createdBy: string;
};

export function portalReportDefinitionsInsertQuery(
  executor: PortalReportInsertExecutor,
  args: PortalReportProvisionArgs,
) {
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

  return executor
    .insert(reports)
    .values(PORTAL_DEFINITIONS.map((definition) => ({
      orgId: args.orgId,
      name: definition.name,
      type: definition.type,
      config: definition.config,
      schedule: 'one_time' as const,
      format: 'pdf' as const,
      portalSelfService: true,
      createdBy: args.createdBy,
      ...scopeValues,
    })))
    .onConflictDoNothing({
      target: [reports.orgId, reports.type],
      where: sql`portal_self_service = true`,
    });
}

export async function provisionPortalReportDefinitions(
  args: PortalReportProvisionArgs,
): Promise<void> {
  await portalReportDefinitionsInsertQuery(db, args);

  const rows = await db
    .select({ type: reports.type })
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

export const PORTAL_REPORT_TYPES = [
  'security_compliance_posture',
  'executive_summary',
  'hardware_lifecycle',
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

export class PortalReportNoTabularDataError extends Error {
  constructor() {
    super('Report run has no tabular data to download');
    this.name = 'PortalReportNoTabularDataError';
  }
}

// This fallback protects only one API process. Distributed deployments use
// the PORTAL_STATE_BACKEND Redis store below for a cross-process guard.
const inFlightUntil = new Map<string, number>();
const IN_FLIGHT_TTL_SECONDS = 15 * 60;
const PORTAL_REPORT_STATEMENT_TIMEOUT_MS = 60_000;

/**
 * Portal auth holds its organization-scoped RLS transaction through the route
 * handler (#1105). R10-2 deliberately keeps report generation synchronous, so
 * tighten (but never widen) the ambient transaction's statement timeout before
 * the multi-query generation and PDF-render paths can pin that connection.
 */
async function tightenPortalReportStatementTimeout(): Promise<void> {
  await tightenStatementTimeout(db, PORTAL_REPORT_STATEMENT_TIMEOUT_MS);
}

/**
 * The org's `enable_lifecycle` visibility flag, read inside the ambient
 * organization-scoped RLS transaction the portal auth middleware already
 * opened. Fail closed exactly like `createPortalFeatureGateStrict`: a missing
 * portal_branding row, or anything that is not literally `true`, is `false`.
 */
export async function portalLifecycleEnabled(orgId: string): Promise<boolean> {
  const [row] = await db
    .select({ enableLifecycle: portalBranding.enableLifecycle })
    .from(portalBranding)
    .where(eq(portalBranding.orgId, orgId))
    .limit(1);

  return row?.enableLifecycle === true;
}

// Decision B2: the portal's hardware_lifecycle run inherits the MSP's own
// replacement thresholds so the customer sees the same ages the MSP set, but
// never the MSP definition's `sites` — that scope may name sites this portal
// user cannot see, and the portal definition is deliberately org-wide.
const HARDWARE_LIFECYCLE_INHERITED_KEYS = [
  'replaceAgeYears',
  'serverReplaceAgeYears',
  'includeManualAssets',
  'includeOtherEquipment',
] as const;

async function hardwareLifecycleConfigWithInheritance(
  orgId: string,
  portalConfig: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const [mspDefinition] = await db
    .select({ config: reports.config })
    .from(reports)
    .where(and(
      eq(reports.orgId, orgId),
      eq(reports.type, 'hardware_lifecycle'),
      eq(reports.portalSelfService, false),
    ))
    .orderBy(desc(reports.updatedAt))
    .limit(1);

  const merged: Record<string, unknown> = { ...portalConfig };
  const mspConfig = (mspDefinition?.config ?? null) as
    | Record<string, unknown>
    | null;

  if (mspConfig) {
    for (const key of HARDWARE_LIFECYCLE_INHERITED_KEYS) {
      if (mspConfig[key] !== undefined) merged[key] = mspConfig[key];
    }
  }

  // Always org-wide, whatever the MSP row said.
  merged.sites = [];
  return merged;
}

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

// With enable_lifecycle off, a hardware_lifecycle run must be invisible
// through the GENERIC report endpoints too, not just the dedicated
// /reports/lifecycle/* routes: those generic routes are gated on enableReports
// alone, and a run can outlive the flag being turned back off. `and()` drops
// undefined arms, so this is a no-op when the flag is on.
function lifecycleExclusion(lifecycleEnabled: boolean) {
  return lifecycleEnabled ? undefined : ne(reports.type, 'hardware_lifecycle');
}

export function portalRunPredicate(
  runId: string,
  orgId: string,
  lifecycleEnabled: boolean,
) {
  return and(
    eq(reportRuns.id, runId),
    eq(reports.orgId, orgId),
    eq(reports.portalSelfService, true),
    lifecycleExclusion(lifecycleEnabled),
  )!;
}

export function portalRunListPredicate(
  orgId: string,
  lifecycleEnabled: boolean,
) {
  return and(
    eq(reports.orgId, orgId),
    eq(reports.portalSelfService, true),
    eq(reportRuns.status, 'completed'),
    lifecycleExclusion(lifecycleEnabled),
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
  const token = randomUUID();

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
  timezone: string,
  opts: { page: number; limit: number },
): Promise<PortalRunsDto> {
  const page = Math.max(1, opts.page);
  const limit = Math.min(100, Math.max(1, opts.limit));
  const offset = (page - 1) * limit;
  const where = portalRunListPredicate(
    orgId,
    await portalLifecycleEnabled(orgId),
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
    timezone,
  };
}

export async function generatePortalReport(args: {
  orgId: string;
  portalUserId: string;
  type: PortalReportType;
}): Promise<PortalRunDto> {
  await tightenPortalReportStatementTimeout();

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

  let effectiveConfig = (definition.config ?? {}) as Record<string, unknown>;

  if (args.type === 'hardware_lifecycle') {
    // The route-level enableLifecycle gate only covers /reports/lifecycle/*.
    // POST /reports/generate is mounted under /reports/*, which checks
    // enableReports alone, so the flag has to be enforced here too. Reuse the
    // existing not-found error rather than a new one: with the flag off the
    // report is indistinguishable from "never provisioned" by design.
    if (!await portalLifecycleEnabled(args.orgId)) {
      throw new PortalReportNotFoundError();
    }
    effectiveConfig = await hardwareLifecycleConfigWithInheritance(
      args.orgId,
      effectiveConfig,
    );
  }

  const inFlightKey = `portal:report:in-flight:${args.orgId}:${args.type}`;
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
        effectiveConfig,
        authority,
      );
      const previous = await previousBaselineFor(
        definition.id,
        authority.fingerprint,
      );
      if (previous) result.previous = previous;

      const completedAt = new Date();
      const rowCount = result.rowCount
        ?? (Array.isArray(result.rows) ? result.rows.length : null);
      const [completed] = await db.update(reportRuns).set({
        status: 'completed',
        completedAt,
        rowCount,
        result,
        outputUrl: `/api/v1/portal/reports/runs/${run.id}/pdf`,
      }).where(eq(reportRuns.id, run.id)).returning();

      // The MSP Reports list reads this column; the MSP generate path and the
      // scheduler stamp it, so a portal run must too or the MSP sees "Never".
      await db.update(reports)
        .set({ lastGeneratedAt: completedAt, updatedAt: completedAt })
        .where(eq(reports.id, definition.id));

      return toDto({
        ...completed!,
        name: definition.name,
        type: definition.type as PortalReportType,
      });
    } catch (error) {
      const errorMessage = error instanceof Error
        ? error.message
        : 'Report generation failed';
      console.error('[portal-reports] Report generation failed', {
        runId: run.id,
        orgId: args.orgId,
        type: args.type,
        error: errorMessage,
      });
      const [failed] = await db.update(reportRuns).set({
        status: 'failed',
        completedAt: new Date(),
        errorMessage,
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

/**
 * The one dedicated read the portal's Hardware Lifecycle page needs: the most
 * recent COMPLETED self-service hardware_lifecycle run for the session org.
 *
 * `generatedAt` is formatted from the RUN's completion time, not from
 * `summary.generatedAt`. The stored summary carries whatever the generator
 * stamped, which can be stale relative to the row; the run is the authority
 * for when the customer's plan was actually produced.
 *
 * Today this is reached only through /reports/lifecycle/*, which carries both
 * the enableReports and enableLifecycle gates. The flag is re-checked here
 * anyway, so the service is safe for any future caller that is not behind that
 * mount (an SSR page, a worker, an AI tool), and so every read in this file
 * answers the flag the same way rather than one of them depending on where it
 * happens to be mounted.
 */
export type HardwareLifecyclePortalLatestDto = {
  run: { id: string; generatedAt: string };
  summary: HardwareLifecycleSummary | null;
};

export async function latestPortalHardwareLifecycleRun(
  orgId: string,
  timezone: string,
): Promise<HardwareLifecyclePortalLatestDto> {
  if (!await portalLifecycleEnabled(orgId)) {
    throw new PortalReportNotFoundError();
  }

  const [row] = await db.select({
    id: reportRuns.id,
    result: reportRuns.result,
    completedAt: reportRuns.completedAt,
  }).from(reportRuns)
    .innerJoin(reports, eq(reportRuns.reportId, reports.id))
    .where(and(
      eq(reports.orgId, orgId),
      eq(reports.type, 'hardware_lifecycle'),
      eq(reports.portalSelfService, true),
      eq(reportRuns.status, 'completed'),
    ))
    .orderBy(desc(reportRuns.completedAt), desc(reportRuns.id))
    .limit(1);

  if (!row) throw new PortalReportNotFoundError();

  const result = row.result as ReportResult | null;
  const generatedAt = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(row.completedAt ?? new Date());

  return {
    run: { id: row.id, generatedAt },
    summary: (result?.summary as HardwareLifecycleSummary | undefined) ?? null,
  };
}

async function completedRun(runId: string, orgId: string) {
  const lifecycleEnabled = await portalLifecycleEnabled(orgId);

  const [row] = await db.select({
    id: reportRuns.id,
    type: reports.type,
    result: reportRuns.result,
    completedAt: reportRuns.completedAt,
  }).from(reportRuns)
    .innerJoin(reports, eq(reportRuns.reportId, reports.id))
    .where(and(
      portalRunPredicate(runId, orgId, lifecycleEnabled),
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
  await tightenPortalReportStatementTimeout();

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
    summary: result.summary as BuildOpts['summary'],
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
    throw new PortalReportNoTabularDataError();
  }
  return rowsToCsv(result.rows);
}
