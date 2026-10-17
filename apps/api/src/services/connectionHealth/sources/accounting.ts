import { inArray, sql } from 'drizzle-orm';
import { db } from '../../../db';
import { accountingConnections as t } from '../../../db/schema';
import { accountingHealth } from '../../integrationStates';
import { PERMISSIONS } from '../../permissions';
import type { HealthObservation } from '../types';
import { defineRowSource, toHealthObservation } from './observeRows';

// QuickBooks / Xero (one connection per partner). The token refresh path
// writes reauth_required with canned text; a disconnect deletes the row.

const FIX_HREFS = { quickbooks: '/integrations#quickbooks', xero: '/integrations#xero' } as const;

export type AccountingRow = {
  id: string;
  partnerId: string;
  provider: string;
  status: string;
  lastError: string | null;
  createdAt: Date;
};

export function accountingObservation(row: AccountingRow, now: Date): HealthObservation {
  const xero = row.provider === 'xero';
  return toHealthObservation({
    kind: 'accounting',
    verdict: accountingHealth(row),
    now,
    createdAt: row.createdAt,
    sourceId: row.id,
    partnerId: row.partnerId,
    orgId: null,
    displayName: xero ? 'Xero' : 'QuickBooks',
    rawDetail: row.lastError,
    fixHref: xero ? FIX_HREFS.xero : FIX_HREFS.quickbooks,
    viewPermission: PERMISSIONS.ACCOUNTING_READ,
    repairPermission: PERMISSIONS.BILLING_MANAGE,
  });
}

export const accountingSource = defineRowSource<AccountingRow>({
  kind: 'accounting',
  intervalMinutes: 15,
  tables: ['accounting_connections'],
  fixHrefs: [FIX_HREFS.quickbooks, FIX_HREFS.xero],
  select: (where) => db
    .select({
      id: t.id,
      partnerId: t.partnerId,
      provider: t.provider,
      status: t.status,
      lastError: t.lastError,
      createdAt: t.createdAt,
    })
    .from(t)
    .where(where),
  brokenWhere: sql`${t.status} IN (${sql.raw(`'reauth_required', 'disconnected', 'error'`)})`,
  trackedWhere: (ids) => inArray(t.id, ids),
  sourceIdOf: (r) => r.id,
  toObservation: accountingObservation,
});
