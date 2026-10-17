import { eq, inArray, sql } from 'drizzle-orm';
import { db } from '../../../db';
import { googleWorkspaceConnections as t, organizations } from '../../../db/schema';
import { googleWorkspaceHealth } from '../../integrationStates';
import { PERMISSIONS } from '../../permissions';
import { runGoogleProbes } from '../googleProbe';
import { cleanDisplayName } from '../sanitize';
import type { HealthObservation } from '../types';
import { defineRowSource, toHealthObservation } from './observeRows';

// Google Workspace (spec §3, W4). Nothing writes a failure for this
// connection, so prepare() runs the rate-limited verification probe
// (googleProbe.ts) and observe() reads its stored result. One row per org:
// the broken set is read through google_workspace_connections_probe_failed_idx.
// The probe error was sanitized when it was stored; it goes through the
// sanitizer again here like every other detail.

const FIX_HREF = '/integrations#google';

export type GoogleWorkspaceRow = {
  id: string;
  orgId: string;
  partnerId: string;
  customerDomain: string;
  createdAt: Date;
  lastProbeStatus: string | null;
  lastProbeError: string | null;
};

export function googleWorkspaceObservation(row: GoogleWorkspaceRow, now: Date): HealthObservation {
  return toHealthObservation({
    kind: 'google_workspace',
    verdict: googleWorkspaceHealth({ probeStatus: row.lastProbeStatus }),
    now,
    createdAt: row.createdAt,
    sourceId: row.id,
    partnerId: row.partnerId,
    orgId: row.orgId,
    displayName: cleanDisplayName(`Google Workspace (${row.customerDomain})`, 'Google Workspace'),
    rawDetail: row.lastProbeError,
    fixHref: FIX_HREF,
    viewPermission: PERMISSIONS.ORGS_READ,
    repairPermission: PERMISSIONS.ORGS_WRITE,
  });
}

export const googleWorkspaceSource = defineRowSource<GoogleWorkspaceRow>({
  kind: 'google_workspace',
  intervalMinutes: 30,
  tables: ['google_workspace_connections'],
  fixHrefs: [FIX_HREF],
  prepare: async (now) => { await runGoogleProbes(now); },
  select: (where) => db
    .select({
      id: t.id,
      orgId: t.orgId,
      partnerId: organizations.partnerId,
      customerDomain: t.customerDomain,
      createdAt: t.createdAt,
      lastProbeStatus: t.lastProbeStatus,
      lastProbeError: t.lastProbeError,
    })
    .from(t)
    .innerJoin(organizations, eq(organizations.id, t.orgId))
    .where(where),
  // Must imply google_workspace_connections_probe_failed_idx's predicate.
  brokenWhere: sql`${t.lastProbeStatus} = ${sql.raw(`'failed'`)}`,
  trackedWhere: (ids) => inArray(t.id, ids),
  sourceIdOf: (r) => r.id,
  toObservation: googleWorkspaceObservation,
});
