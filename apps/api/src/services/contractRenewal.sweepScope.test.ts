/**
 * Tenant scope of the contract renewal sweep (org-lifecycle Wave 4, final
 * review fix C-A.2).
 *
 * The sweep selects contracts fleet-wide under the caller's system context, so
 * nothing narrows it by tenant. Without the org-status predicate an ARCHIVED
 * org's contract keeps auto-renewing — its term silently extended and its MSP
 * emailed a renewal notice — inside a tenant that is hidden, read-only, and
 * counting down to permanent erasure.
 *
 * Asserted as COMPILED SQL: this suite seeds zero candidates, so a shape-only
 * assertion could not tell a present predicate from an absent one.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { Mock } from 'vitest';
import { SQL } from 'drizzle-orm';

const { rows } = vi.hoisted(() => ({ rows: [] as unknown[] }));
vi.mock('../db', () => {
  const chain: Record<string, unknown> = {};
  for (const m of ['select', 'from', 'where', 'limit', 'innerJoin', 'insert', 'values', 'onConflictDoNothing', 'returning', 'update', 'set']) {
    chain[m] = vi.fn(() => chain);
  }
  (chain as { then: unknown }).then = (resolve: (v: unknown) => unknown) =>
    Promise.resolve(rows).then(resolve);
  return { db: chain };
});

vi.mock('./contractEvents', () => ({ emitContractEvent: vi.fn() }));
vi.mock('./notificationSenders/inAppSender', () => ({ sendInAppNotification: vi.fn() }));
vi.mock('./email', () => ({ getEmailService: () => null }));
vi.mock('./sentry', () => ({ captureException: vi.fn() }));

import { db } from '../db';
import { runContractRenewalSweep } from './contractRenewal';

const dialect = new PgDialect();

describe('runContractRenewalSweep tenant scope', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    rows.length = 0;
  });

  it('restricts the candidate select to automation-eligible orgs (compiled SQL)', async () => {
    await runContractRenewalSweep(new Date('2026-08-26T00:00:00Z'));

    const whereArg = (db as unknown as { where: Mock }).where.mock.calls[0]![0] as SQL;
    const { sql, params } = dialect.sqlToQuery(whereArg);

    expect(sql).toContain('EXISTS');
    expect(sql).toContain('automation_eligible_org.id = "contracts"."org_id"');
    expect(sql).toContain('automation_eligible_org.status::text IN');
    expect(params).toEqual(
      expect.arrayContaining(['active', 'trial', 'suspended', 'churned', 'offboarding']),
    );
    // The three lifecycle-frozen statuses are the whole point of the predicate.
    expect(params).not.toContain('archived');
    expect(params).not.toContain('purging');
    expect(params).not.toContain('merging');
  });

  it('keeps the pre-existing auto-renew / end-date predicates', async () => {
    await runContractRenewalSweep(new Date('2026-08-26T00:00:00Z'));

    const whereArg = (db as unknown as { where: Mock }).where.mock.calls[0]![0] as SQL;
    const { sql } = dialect.sqlToQuery(whereArg);
    expect(sql).toContain('"contracts"."auto_renew"');
    expect(sql).toContain('"contracts"."end_date" is not null');
  });
});
