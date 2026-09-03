import type { AwaitingYouTileDto, DashboardDto } from '@breeze/shared';
import { and, eq, gt, inArray, ne, sql } from 'drizzle-orm';
import { db } from '../../db';
import { invoices, quotes } from '../../db/schema';
import { actionItemsTile } from './actionItemsReadModel';
import { backupTile } from './backupReadModel';
import { patchesAppliedTile } from './patchReadModel';
import {
  devicesProtectedTile,
  securityScoreTile,
} from './securityReadModel';
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
        ne(invoices.status, 'draft'),
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
