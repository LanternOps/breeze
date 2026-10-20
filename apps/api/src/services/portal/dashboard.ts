import type { AwaitingYouTileDto, DashboardDto } from '@breeze/shared';
import { and, eq, gt, inArray, sql, type SQL } from 'drizzle-orm';
import { db } from '../../db';
import { invoices, quotes } from '../../db/schema';
import { actionItemsTile } from './actionItemsReadModel';
import { dashboardBackupTile } from './backupReadModel';
import { patchesAppliedTile } from './patchReadModel';
import {
  devicesProtectedTile,
  securityScoreTile,
} from './securityReadModel';
import { serviceTile } from './serviceReadModel';
import { supportTile } from './ticketReadModel';

export async function awaitingYouTile(
  orgId: string,
  now: Date,
): Promise<AwaitingYouTileDto> {
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
        inArray(invoices.status, ['sent', 'partially_paid', 'overdue']),
        gt(invoices.balance, '0'),
      )),
  ]);

  return {
    status: 'ok',
    proposals: Number(proposalRows[0]?.count ?? 0),
    invoices: Number(invoiceRows[0]?.count ?? 0),
    asOf: now.toISOString(),
  };
}

export async function dashboardForOrg(
  orgId: string,
  args: { timezone: string; now: Date },
  ticketOwnership: SQL,
): Promise<DashboardDto> {
  const [
    securityScore,
    devicesProtected,
    patchesApplied,
    backup,
    support,
    actionItems,
    awaitingYou,
    service,
  ] = await Promise.all([
    securityScoreTile(orgId, args.now),
    devicesProtectedTile(orgId, args.now),
    patchesAppliedTile(orgId, args),
    dashboardBackupTile(orgId, args.now),
    supportTile(orgId, args, ticketOwnership),
    actionItemsTile(orgId, args.now),
    awaitingYouTile(orgId, args.now),
    serviceTile(orgId, args),
  ]);

  return {
    asOf: args.now.toISOString(),
    timezone: args.timezone,
    securityScore,
    devicesProtected,
    patchesApplied,
    support,
    actionItems,
    awaitingYou,
    // Absent, not null, when enable_service is off: an org that never turns the
    // flag on keeps the exact DashboardDto — and therefore the exact ETag — it
    // had before this wave (routes/portal/dashboard.ts builds the validator
    // from the payload).
    ...(service ? { service } : {}),
    // Same rule for enable_backups (#9351): absent, not null, so an org with
    // Backups on keeps its exact payload and ETag.
    ...(backup ? { backup } : {}),
  };
}
