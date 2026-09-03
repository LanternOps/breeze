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

  await db
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
      where: eq(reports.portalSelfService, true),
    });

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
