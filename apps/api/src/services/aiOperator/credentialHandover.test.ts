/**
 * The created-account credential projection (W07 R2a Task 11, D-R2-6, G8).
 *
 * Read side only. The state is derived from jsonb KEY PRESENCE in SQL (the
 * `routes/ai.ts` tempPasswordState rule), the rest is mapped from named
 * columns, and the rules mirror the shipped reveal route
 * (`POST /action-intents/:id/reveal-secret`): revealable only on a `completed`
 * intent with a sealed key, inside REVEAL_WINDOW_DAYS of `executedAt`, by the
 * intent's requester — who E4 mints as the plan approver (D-E4-2).
 *
 * Stubbing: the repo's table-keyed Drizzle stand-in (`tableKeyedDb`) — a
 * select resolves to the rows registered for its FROM table, projected onto
 * the selected keys; WHERE/JOIN clauses are recorded and rendered with the
 * real PgDialect for the tenancy and no-`result` assertions.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { is, SQL, Column } from 'drizzle-orm';
import { createTableKeyedDb, renderSql, type TableKeyedDb } from '../../__tests__/helpers/tableKeyedDb';

const h = vi.hoisted(() => ({
  db: null as unknown as Record<string, unknown>,
  ctx: true,
  rows: [] as Record<string, unknown>[],
  fields: [] as Array<Record<string, unknown> | undefined>,
}));

vi.mock('../../db', () => ({
  db: new Proxy({}, { get: (_t, p) => (h.db as Record<string | symbol, unknown>)[p] }),
  hasDbAccessContext: () => h.ctx,
  runOutsideDbContext: (fn: () => unknown) => fn(),
  withSystemDbAccessContext: (fn: () => unknown) => fn(),
}));

import { actionIntents } from '../../db/schema/actionIntents';
import { REVEAL_WINDOW_DAYS } from '../actionIntents/resultSecrets';
import {
  CREDENTIAL_STATES,
  listCreatedAccountsForTask,
  type CreatedAccountView,
} from './credentialHandover';

const ORG = '00000000-0000-4000-8000-0000000000a1';
const TASK = '00000000-0000-4000-8000-0000000000b1';
const APPROVER = '00000000-0000-4000-8000-0000000000c1';
const TECH = '00000000-0000-4000-8000-0000000000c2';
const INTENT = '00000000-0000-4000-8000-0000000000d1';
const ENTRA_ID = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';
const NOW = new Date('2026-10-24T12:00:00.000Z');
const DAY_MS = 24 * 60 * 60 * 1000;
const ACCOUNTS_TABLE = 'ai_operator_task_target_accounts';

function m365Row(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    provider: 'm365',
    principalLabel: 'priya@customer.example',
    externalId: ENTRA_ID,
    intentId: INTENT,
    intentStatus: 'completed',
    executedAt: new Date(NOW.getTime() - 60 * 60 * 1000),
    requestedByUserId: APPROVER,
    approverUserId: APPROVER,
    approverName: 'Sam Approver',
    hasSealedCredential: true,
    hasRevealedMarker: false,
    hasExpiredMarker: false,
    hasSealFailedMarker: false,
    ...over,
  };
}

function googleRow(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    provider: 'google',
    principalLabel: 'priya@customer.example',
    externalId: '900100',
    intentId: null,
    intentStatus: null,
    executedAt: null,
    requestedByUserId: null,
    approverUserId: null,
    approverName: null,
    hasSealedCredential: false,
    hasRevealedMarker: false,
    hasExpiredMarker: false,
    hasSealFailedMarker: false,
    ...over,
  };
}

let k: TableKeyedDb;
beforeEach(() => {
  h.ctx = true;
  h.rows = [];
  h.fields = [];
  k = createTableKeyedDb(() => ({ [ACCOUNTS_TABLE]: h.rows }));
  h.db = {
    ...k.db,
    select: (fields?: Record<string, unknown>) => { h.fields.push(fields); return k.db.select(fields); },
  };
});

async function list(rows: Record<string, unknown>[]): Promise<CreatedAccountView[]> {
  h.rows = rows;
  return listCreatedAccountsForTask(ORG, TASK, { now: NOW });
}

/** The single view a one-row fixture yields; fails loudly when there is none. */
async function one(row: Record<string, unknown>): Promise<CreatedAccountView> {
  const views = await list([row]);
  expect(views).toHaveLength(1);
  return views[0]!;
}

describe('listCreatedAccountsForTask', () => {
  it('exports exactly the credential states the projection can produce', () => {
    expect([...CREDENTIAL_STATES]).toEqual(['available', 'revealed', 'expired', 'unretrievable', 'not_applicable']);
  });

  it('1. a sealed credential executed 1 hour ago is available, revealable by the approver, until executedAt + REVEAL_WINDOW_DAYS', async () => {
    const executedAt = new Date(NOW.getTime() - 60 * 60 * 1000);
    const view = await one(m365Row({ executedAt }));
    expect(view).toEqual({
      provider: 'm365',
      principalLabel: 'priya@customer.example',
      externalId: ENTRA_ID,
      credentialState: 'available',
      intentId: INTENT,
      revealableByUserId: APPROVER,
      revealableByName: 'Sam Approver',
      revealExpiresAt: new Date(executedAt.getTime() + REVEAL_WINDOW_DAYS * DAY_MS).toISOString(),
    });
  });

  it('2. the same, executed 8 days ago, is expired with no expiry and no one to reveal it', async () => {
    const view = await one(m365Row({ executedAt: new Date(NOW.getTime() - 8 * DAY_MS) }));
    expect(view.credentialState).toBe('expired');
    expect(view.revealExpiresAt).toBeNull();
    expect(view.revealableByUserId).toBeNull();
    expect(view.intentId).toBe(INTENT);
  });

  it('2b. exactly at the window edge it is still available (the route expires only PAST the window)', async () => {
    const view = await one(m365Row({ executedAt: new Date(NOW.getTime() - REVEAL_WINDOW_DAYS * DAY_MS) }));
    expect(view.credentialState).toBe('available');
  });

  it('2c. a sealed key on a completed intent with no executedAt is expired (the route 410s it)', async () => {
    const view = await one(m365Row({ executedAt: null }));
    expect(view.credentialState).toBe('expired');
    expect(view.revealExpiresAt).toBeNull();
  });

  it('3. a revealed marker is revealed, with no expiry', async () => {
    const view = await one(m365Row({ hasSealedCredential: false, hasRevealedMarker: true }));
    expect(view.credentialState).toBe('revealed');
    expect(view.revealExpiresAt).toBeNull();
    expect(view.revealableByUserId).toBeNull();
  });

  it('4. an expired marker is expired', async () => {
    const view = await one(m365Row({ hasSealedCredential: false, hasExpiredMarker: true }));
    expect(view.credentialState).toBe('expired');
    expect(view.revealExpiresAt).toBeNull();
  });

  it('4b. a seal-failed marker is unretrievable — the credential was dropped, not expired', async () => {
    const view = await one(m365Row({ hasSealedCredential: false, hasSealFailedMarker: true }));
    expect(view.credentialState).toBe('unretrievable');
    expect(view.revealableByUserId).toBeNull();
    expect(view.revealExpiresAt).toBeNull();
    expect(view.intentId).toBe(INTENT);
  });

  it('5. a Google account is not_applicable with no intent and no revealer', async () => {
    const view = await one(googleRow());
    expect(view).toEqual({
      provider: 'google',
      principalLabel: 'priya@customer.example',
      externalId: '900100',
      credentialState: 'not_applicable',
      intentId: null,
      revealableByUserId: null,
      revealableByName: null,
      revealExpiresAt: null,
    });
  });

  it('6. a create intent still pending_approval is not_applicable, not available — even with a sealed key', async () => {
    for (const over of [
      { intentStatus: 'pending_approval', executedAt: null, hasSealedCredential: false },
      { intentStatus: 'pending_approval', executedAt: null, hasSealedCredential: true },
      { intentStatus: 'executing', hasSealedCredential: true },
    ]) {
      const view = await one(m365Row(over));
      expect(view.credentialState, JSON.stringify(over)).toBe('not_applicable');
      expect(view.intentId).toBeNull();
      expect(view.revealableByUserId).toBeNull();
      expect(view.revealExpiresAt).toBeNull();
    }
  });

  it('7. every read is org- and task-predicated, the approval join is org-scoped, and a missing user row keeps the account', async () => {
    const views = await list([m365Row({ approverName: null })]);
    expect(views).toHaveLength(1);
    expect(views[0]!.revealableByUserId).toBe(APPROVER);
    expect(views[0]!.revealableByName).toBeNull();

    expect(k.selects).toHaveLength(1);
    const sel = k.selects[0]!;
    expect(sel.table).toBe(ACCOUNTS_TABLE);
    const where = renderSql(sel.where);
    expect(where.sql).toContain('"ai_operator_task_target_accounts"."org_id" = $');
    expect(where.sql).toContain('"ai_operator_task_target_accounts"."task_id" = $');
    expect(where.params).toEqual(expect.arrayContaining([ORG, TASK, 'identity_onboarding']));

    const join = (table: string) => {
      const j = sel.joins.find((x) => x.table === table);
      expect(j, `no join on ${table}`).toBeDefined();
      return renderSql(j!.on).sql;
    };
    expect(join('ai_operator_tasks')).toContain('"ai_operator_tasks"."org_id" = "ai_operator_task_target_accounts"."org_id"');
    expect(join('action_intents')).toContain('"action_intents"."org_id" = "ai_operator_task_target_accounts"."org_id"');
    expect(join('ai_operator_operations')).toContain('"ai_operator_operations"."org_id" = "action_intents"."org_id"');
    const approvalOn = join('ai_operator_plan_approvals');
    expect(approvalOn).toContain('"ai_operator_plan_approvals"."org_id" = "ai_operator_operations"."org_id"');
    expect(approvalOn).toContain('"ai_operator_plan_approvals"."plan_revision" = "ai_operator_operations"."plan_revision"');
    expect(approvalOn).toContain('"ai_operator_plan_approvals"."step_key" = "ai_operator_operations"."task_step_key"');
  });

  it('7b. the create intent is bound to THIS account: the create step, the create tool and result userId = externalId', async () => {
    await list([m365Row()]);
    const on = k.selects[0]!.joins.find((x) => x.table === 'action_intents')!;
    const { sql, params } = renderSql(on.on);
    expect(sql).toContain('"action_intents"."task_id" = "ai_operator_task_target_accounts"."task_id"');
    expect(sql).toContain('"action_intents"."task_step_key" = $');
    expect(sql).toContain('"action_intents"."action_name" = $');
    expect(sql).toContain('"action_intents"."result" ->> $');
    expect(sql).toContain('= "ai_operator_task_target_accounts"."external_id"');
    expect(params).toEqual(expect.arrayContaining(['m365', 'create_accounts', 'm365_create_user', 'userId']));
  });

  it('8. accounts come back in a stable provider-ascending order, one per provider', async () => {
    const views = await list([m365Row(), googleRow(), m365Row({ intentId: '00000000-0000-4000-8000-0000000000d2' })]);
    expect(views.map((v) => v.provider)).toEqual(['google', 'm365']);
    expect(views[1]!.intentId).toBe(INTENT);
  });

  it('9. the query never selects `result` — only boolean key-presence predicates touch it', async () => {
    await list([m365Row()]);
    expect(h.fields).toHaveLength(1);
    const fields = h.fields[0]!;
    expect(Object.keys(fields)).not.toContain('result');
    for (const [key, value] of Object.entries(fields)) {
      expect(value, key).not.toBe(actionIntents.result);
      if (is(value, Column)) {
        expect(value.name, key).not.toBe('result');
        continue;
      }
      expect(is(value, SQL), `${key} is neither a column nor SQL`).toBe(true);
      const rendered = renderSql(value).sql;
      if (rendered.includes('"result"')) {
        // Only `coalesce(result ? key, false)` / `coalesce(result ?| array[...], false)`.
        expect(rendered, key).toMatch(/^coalesce\("action_intents"\."result" \?\|? (array\[\$\d+::text(, \$\d+::text)*\]|\$\d+::text), false\)$/);
      }
    }
    // The key-presence columns are what the state is derived from.
    expect(Object.keys(fields)).toEqual(expect.arrayContaining([
      'hasSealedCredential', 'hasRevealedMarker', 'hasExpiredMarker', 'hasSealFailedMarker',
    ]));
  });

  it('10. revealable only when the intent requester IS the approver — the route admits the requester, never anyone else', async () => {
    const mismatch = await list([m365Row({ requestedByUserId: TECH })]);
    expect(mismatch[0]!.credentialState).toBe('available');
    expect(mismatch[0]!.revealableByUserId).toBeNull();
    expect(mismatch[0]!.revealableByName).toBeNull();

    const noRequester = await list([m365Row({ requestedByUserId: null })]);
    expect(noRequester[0]!.revealableByUserId).toBeNull();

    const noApproval = await list([m365Row({ approverUserId: null, approverName: null })]);
    expect(noApproval[0]!.revealableByUserId).toBeNull();
  });

  it('11. needs a db access context: request path or the caller\'s system context, never a bare pool', async () => {
    h.ctx = false;
    h.rows = [m365Row()];
    await expect(listCreatedAccountsForTask(ORG, TASK, { now: NOW })).rejects.toThrow(/db access context/);
    expect(k.selects).toHaveLength(0);
  });

  it('12. an empty account set is an empty list', async () => {
    expect(await list([])).toEqual([]);
  });
});

