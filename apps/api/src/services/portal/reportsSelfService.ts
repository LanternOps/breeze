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
import { organizationScope } from '../reportScope';
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
  // #5784 W02 — MANAGED EVIDENCE, not self-service. The customer sees and
  // downloads this once the occurrence is delivered (deliveredEvidenceOnly),
  // but never generates it: the type is deliberately absent from
  // PORTAL_REPORT_TYPES and from both allowlist literals in
  // reportGenerationService.ts (OD-10 = A).
  //
  // Name and config are literals rather than an import of
  // MANAGED_EVIDENCE_REGISTRY because this array is `as const` and feeds a
  // Drizzle insert. Divergence from the registry is caught by
  // managedEvidenceRegistry.test.ts, which compares the two.
  {
    type: 'threat_detection_review',
    name: 'Service evidence — Threat detection review',
    config: {
      sites: [],
      includeCarriedIn: true,
      topIncidents: 100,
    },
  },
  // #5784 W03 — managed evidence, NOT self-service. The definition exists so a
  // DELIVERED run can be listed and downloaded in the portal; the type is
  // deliberately absent from PORTAL_REPORT_TYPES, so there is no generate
  // button (OD-10 = A). `config` must stay byte-identical to
  // MANAGED_EVIDENCE_REGISTRY.endpoint_management_review.defaultConfig —
  // reportsSelfService.test.ts pins the two together.
  {
    type: 'endpoint_management_review',
    name: 'Service evidence — Endpoint management review',
    config: {
      sites: [],
      staleEnrolmentDays: 14,
      trendDays: 30,
      includeLicences: true,
    },
  },
  // #5784 W04 — managed evidence, NOT self-service. Provisioned here so an org
  // that already enabled portal reports has the definition ready (and so
  // `resolveManagedEvidenceDefinition` adopts it rather than racing to create
  // it), but deliberately ABSENT from PORTAL_REPORT_TYPES: a portal user can
  // never generate it, and a run only becomes visible when the deliverable
  // occurrence is delivered (OD-12). Name and config are spelled identically
  // to MANAGED_EVIDENCE_REGISTRY's entry.
  {
    type: 'vulnerability_management',
    name: 'Service evidence — Vulnerability management',
    config: {
      sites: [],
      severityFloor: 'high',
      topN: 25,
      includeAccepted: true,
    },
  },
  // #5784 W06 — MANAGED EVIDENCE, not self-service, and the one that carries the
  // most PII in the feature (user principal names, IP addresses, cities). Same
  // rule as W02 above: absent from PORTAL_REPORT_TYPES and from both allowlist
  // literals in reportGenerationService.ts (OD-10 = A), so a customer can read a
  // DELIVERED artifact but can never generate one on demand.
  //
  // No `sites` key: M365 identity data has no site dimension (OD-8 = A).
  {
    type: 'identity_access_review',
    name: 'Service evidence — Identity and access review',
    config: {
      dormantDays: 45,
      homeCountries: [],
      adminDetail: true,
    },
  },
] as const;

/** Exported for `managedEvidenceRegistry.test.ts`, which pins this array
 *  against MANAGED_EVIDENCE_REGISTRY. Not part of the module's API. */
export const PORTAL_DEFINITIONS_FOR_TEST = PORTAL_DEFINITIONS;

type PortalReportInsertExecutor = Pick<typeof db, 'insert'>;
type PortalReportProvisionArgs = {
  orgId: string;
  createdBy: string;
};

/**
 * Build ONE portal-self-service report definition row. Extracted from
 * `portalReportDefinitionsInsertQuery` so #5784's managed-evidence provisioning
 * can insert a single type on demand, under a caller-supplied executor, without
 * re-inserting the whole PORTAL_DEFINITIONS array. There is exactly one
 * row-shape definition; both callers go through it.
 */
export function portalReportDefinitionRow(args: {
  orgId: string;
  createdBy: string;
  type: (typeof reports.$inferInsert)['type'];
  name: string;
  config: Record<string, unknown>;
}) {
  const scope = { version: 1, kind: 'unrestricted', orgId: args.orgId } as const;
  const authority: UserReportExecutionAuthority = {
    principalKind: 'user',
    principalUserId: args.createdBy,
    scope,
    capturedAt: new Date(),
    fingerprint: siteScopeFingerprint(scope),
  };
  return {
    orgId: args.orgId,
    name: args.name,
    type: args.type,
    config: args.config,
    schedule: 'one_time' as const,
    format: 'pdf' as const,
    portalSelfService: true,
    createdBy: args.createdBy,
    ...persistedSiteScopeValues(authority),
  };
}

export function portalReportDefinitionsInsertQuery(
  executor: PortalReportInsertExecutor,
  args: PortalReportProvisionArgs,
) {
  return executor
    .insert(reports)
    .values(PORTAL_DEFINITIONS.map((definition) => portalReportDefinitionRow({
      orgId: args.orgId,
      createdBy: args.createdBy,
      type: definition.type,
      name: definition.name,
      config: definition.config,
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
 * Read lifecycle visibility and Devices access in the ambient org-scoped RLS
 * transaction. Lifecycle visibility requires an explicit true; device links
 * require either enable_devices or enable_self_service to be explicitly true.
 * The legacy enableSelfService result field carries this combined link grant.
 * Missing branding values fail closed.
 */
async function portalBrandingLifecycleFlags(
  orgId: string,
): Promise<{ enableLifecycle: boolean; enableSelfService: boolean }> {
  const [row] = await db
    .select({
      enableLifecycle: portalBranding.enableLifecycle,
      enableSelfService: portalBranding.enableSelfService,
      enableDevices: portalBranding.enableDevices,
    })
    .from(portalBranding)
    .where(eq(portalBranding.orgId, orgId))
    .limit(1);

  return {
    enableLifecycle: row?.enableLifecycle === true,
    enableSelfService: row?.enableSelfService === true || row?.enableDevices === true,
  };
}

export async function portalLifecycleEnabled(orgId: string): Promise<boolean> {
  return (await portalBrandingLifecycleFlags(orgId)).enableLifecycle;
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

/**
 * OD-12 (#5784): a managed evidence run becomes customer-visible on DELIVERY,
 * not on generation. Without this, `portalRunListPredicate` — which filters only
 * on org, portal_self_service and status — would show a security artifact at
 * 05:18 on the due day, before the technician reviewed it.
 *
 * Derived, not stamped: the occurrence already carries `delivered_at`,
 * `delivered_by_user_id` and `delivered_via`, so a `published_at` column would
 * only add a second copy of the truth that could drift when a delivery is
 * reverted or the occurrence is waived.
 *
 * Runs no deliverable references (ordinary portal self-service) are unaffected.
 * Fail-closed: a run referenced only by non-delivered occurrences is hidden.
 * `sd_evidence_report_run_idx` (report_run_id) serves both sub-queries.
 */
export function deliveredEvidenceOnly() {
  return sql`(
    NOT EXISTS (
      SELECT 1 FROM service_deliverable_evidence e
      WHERE e.report_run_id = ${reportRuns.id}
    )
    OR EXISTS (
      SELECT 1 FROM service_deliverable_evidence e
      JOIN service_deliverable_occurrences o ON o.id = e.occurrence_id
      WHERE e.report_run_id = ${reportRuns.id}
        AND o.status = 'delivered'
    )
  )`;
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
    deliveredEvidenceOnly(),
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
    deliveredEvidenceOnly(),
  )!;
}

function toDto(row: {
  id: string;
  reportId: string;
  name: string;
  // The DTO's own union, NOT PortalReportType: portalRunListPredicate has no
  // type filter, so a managed-evidence run of a type outside the three
  // self-service ones legitimately flows through here. Typing it as
  // PortalReportType was a lie the compiler could not see, because the value
  // comes from the database (#5784 W02, W03, W04).
  type: PortalRunDto['type'];
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
        organizationScope(args.orgId),
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
  contact: { name: string | null; email: string } | null;
  // Legacy field name: device deep-links are enabled by either the Devices
  // visibility flag or self-service, matching the Devices page's access grants.
  enableSelfService: boolean;
};

export async function latestPortalHardwareLifecycleRun(
  orgId: string,
  timezone: string,
): Promise<HardwareLifecyclePortalLatestDto> {
  const flags = await portalBrandingLifecycleFlags(orgId);
  if (!flags.enableLifecycle) {
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
      // OD-12 (#5784): this dedicated reader is a third portal path to a run.
      // A deliverable may name the canonical lifecycle definition as its
      // auto-evidence, so the delivery gate applies here exactly as in
      // portalRunPredicate — or "latest" leaks an unreviewed run.
      deliveredEvidenceOnly(),
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

  const branding = await getReportBranding(orgId);

  return {
    run: { id: row.id, generatedAt },
    summary: (result?.summary as HardwareLifecycleSummary | undefined) ?? null,
    contact: branding.contactEmail
      ? { name: branding.contactName ?? null, email: branding.contactEmail }
      : null,
    enableSelfService: flags.enableSelfService,
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
