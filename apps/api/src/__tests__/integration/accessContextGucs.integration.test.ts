/**
 * #8052 — the single-statement RLS prologue, against real Postgres.
 *
 * `src/db/accessContextGucs.test.ts` proves the statement the app SENDS (one
 * `select set_config(...), ...` carrying all seven GUCs). This file proves what
 * Postgres DOES with it: inside a live context every `breeze.*` GUC reads back
 * the expected value, and a narrowing prologue re-applied onto an open
 * system-scope transaction (`withResolvedDbAccessContext`) replaces all seven.
 *
 * Not covered here: `is_local = true` itself (a session-level write would only
 * show on a later contextless use of the same pooled connection, which this
 * suite cannot pin deterministically). The unit test
 * `src/db/accessContextGucs.test.ts` asserts `true` on every set_config.
 */

import { describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import {
  db,
  withDbAccessContext,
  withResolvedDbAccessContext,
  withSystemDbAccessContext,
  type DbAccessContext,
} from '../../db';

const hasDatabase = Boolean(process.env.DATABASE_URL || process.env.DATABASE_URL_APP);
const describeIf = hasDatabase ? describe : describe.skip;

const ORG_A = '7f1b0a4e-0c2d-4c8a-9a0e-2f9c1b3d4e5f';
const ORG_B = '0a6c3f2e-9d1b-4e7a-8c5f-1b2d3e4f5a6b';
const PARTNER = '3c9e1d2f-4a5b-4c6d-8e7f-9a0b1c2d3e4f';
const USER = 'b2c3d4e5-f6a7-4b8c-9d0e-1f2a3b4c5d6e';
const HIST = 'c1d2e3f4-a5b6-4c7d-8e9f-0a1b2c3d4e5f';

type GucRow = {
  scope: string | null;
  org_id: string | null;
  accessible_org_ids: string | null;
  accessible_partner_ids: string | null;
  user_id: string | null;
  current_partner_id: string | null;
  report_history_org_ids: string | null;
};

async function readGucs(): Promise<GucRow> {
  const rows = (await db.execute(sql`
    select
      current_setting('breeze.scope', true) as scope,
      current_setting('breeze.org_id', true) as org_id,
      current_setting('breeze.accessible_org_ids', true) as accessible_org_ids,
      current_setting('breeze.accessible_partner_ids', true) as accessible_partner_ids,
      current_setting('breeze.user_id', true) as user_id,
      current_setting('breeze.current_partner_id', true) as current_partner_id,
      current_setting('breeze.report_history_org_ids', true) as report_history_org_ids
  `)) as unknown as GucRow[];
  return rows[0]!;
}

describeIf('#8052 single-statement prologue (live database)', () => {
  it('system scope: every GUC lands', async () => {
    const gucs = await withSystemDbAccessContext(readGucs, 'accessContextGucsTest');
    expect(gucs).toEqual({
      scope: 'system',
      org_id: '',
      accessible_org_ids: '*',
      accessible_partner_ids: '*',
      user_id: '',
      current_partner_id: '',
      report_history_org_ids: '',
    });
  });

  it('partner scope with report history: every GUC lands with its own value', async () => {
    const context: DbAccessContext = {
      scope: 'partner',
      orgId: null,
      accessibleOrgIds: [ORG_A, ORG_B],
      accessiblePartnerIds: [PARTNER],
      userId: USER,
      currentPartnerId: PARTNER,
      reportHistoryOrgIds: [HIST],
    };
    const gucs = await withDbAccessContext(context, readGucs);
    expect(gucs).toEqual({
      scope: 'partner',
      org_id: '',
      accessible_org_ids: `${ORG_A},${ORG_B}`,
      accessible_partner_ids: PARTNER,
      user_id: USER,
      current_partner_id: PARTNER,
      report_history_org_ids: HIST,
    });
  });

  it('organization scope: unset axes are written as empty strings', async () => {
    const gucs = await withDbAccessContext(
      { scope: 'organization', orgId: ORG_A, accessibleOrgIds: [ORG_A], currentPartnerId: PARTNER },
      readGucs,
    );
    expect(gucs).toEqual({
      scope: 'organization',
      org_id: ORG_A,
      accessible_org_ids: ORG_A,
      accessible_partner_ids: '',
      user_id: '',
      current_partner_id: PARTNER,
      report_history_org_ids: '',
    });
  });

  it('withResolvedDbAccessContext: the narrowing prologue overwrites all seven system GUCs in the SAME transaction', async () => {
    // The stale-GUC case that matters: a second prologue re-applied onto an
    // ambient transaction that already holds the system values ('*'
    // allowlists). Any GUC the single statement failed to write would read
    // back the system value here instead of the narrowed one.
    const result = await withResolvedDbAccessContext(
      async () => {
        // System scope leaves these three '', so seed stale values: the
        // narrowing prologue must overwrite them too, not just the '*' ones.
        await db.execute(sql`select
          set_config('breeze.user_id', ${USER}, true),
          set_config('breeze.current_partner_id', ${PARTNER}, true),
          set_config('breeze.report_history_org_ids', ${HIST}, true)`);
        const before = await readGucs();
        return {
          context: { scope: 'organization' as const, orgId: ORG_B, accessibleOrgIds: [ORG_B] },
          value: before,
        };
      },
      async (before) => ({ before, after: await readGucs() }),
    );
    expect(result.before.scope).toBe('system');
    expect(result.before.accessible_org_ids).toBe('*');
    expect(result.before.accessible_partner_ids).toBe('*');
    expect(result.before.user_id).toBe(USER);
    expect(result.before.current_partner_id).toBe(PARTNER);
    expect(result.before.report_history_org_ids).toBe(HIST);
    const after = result.after;
    expect(after).toEqual({
      scope: 'organization',
      org_id: ORG_B,
      accessible_org_ids: ORG_B,
      accessible_partner_ids: '',
      user_id: '',
      current_partner_id: '',
      report_history_org_ids: '',
    });
  });
});
