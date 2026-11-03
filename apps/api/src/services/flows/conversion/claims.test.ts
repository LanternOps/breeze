import { describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import { OCCURRENCE_KEY_RE, occurrenceKey } from '@breeze/shared';

/**
 * Tool Catalog W06 (#5221) Task B2 — the occurrence-claim helpers. The SQL
 * boundary is a fake executor that answers each `execute` from a queue and
 * records every statement (text + params) and every savepoint rollback. The
 * real-database half (atomicity with the run insert, the unique index under
 * concurrency, both engines end to end) is
 * __tests__/integration/automationOccurrenceClaims.integration.test.ts.
 */

const { systemCtx } = vi.hoisted(() => ({ systemCtx: vi.fn((fn: () => unknown) => fn()) }));
vi.mock('../../../db', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../db')>()),
  withSystemDbAccessContext: systemCtx,
  withDbAccessContext: systemCtx,
}));

vi.mock('../../sentry', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../sentry')>()),
  captureMessage: vi.fn(),
}));

import { captureMessage } from '../../sentry';
import { formatScheduleTriggerKey } from '../../automationRuntime';
import {
  reportOccurrenceAnomaly,
  claimOccurrence,
  eventInstant,
  eventOccurrenceKey,
  flowPrefers,
  legacyPrefers,
  legacyScheduleHistoryKeys,
  scheduleInstantFromSlotKey,
  type DbExecutor,
} from './claims';

const AUTOMATION = '11111111-1111-4111-8111-111111111111';
const ORG = '22222222-2222-4222-8222-222222222222';
const CONVERSION = '33333333-3333-4333-8333-333333333333';
const LEGACY_RUN = '44444444-4444-4444-8444-444444444444';
const FLOW_RUN = '55555555-5555-4555-8555-555555555555';
const EVENT_ID = '66666666-6666-4666-8666-666666666666';

const dialect = new PgDialect();
type Stmt = { sql: string; params: unknown[] };

function fakeTx(results: unknown[]) {
  const statements: Stmt[] = [];
  const rollbacks: unknown[] = [];
  const tx = {
    execute: async (q: SQL) => {
      const { sql, params } = dialect.sqlToQuery(q);
      statements.push({ sql, params });
      const value = results.shift();
      if (value instanceof Error) throw value;
      return value ?? [];
    },
    transaction: async <T>(fn: (inner: unknown) => Promise<T>): Promise<T> => {
      try {
        return await fn(tx);
      } catch (err) {
        rollbacks.push(err);
        throw err;
      }
    },
  };
  return { tx: tx as unknown as DbExecutor, statements, rollbacks };
}

const base = {
  automationId: AUTOMATION,
  owner: { orgId: ORG, partnerId: null },
  conversionId: CONVERSION,
  occurrenceAt: new Date('2027-01-09T03:00:00Z'),
};

describe('preference', () => {
  const switchAt = new Date('2027-01-09T03:00:00Z');
  const before = new Date('2027-01-09T02:59:59Z');
  const after = new Date('2027-01-09T03:00:00Z');

  it('legacy prefers everything with no conversion, a shadow or a reverted generation', () => {
    expect(legacyPrefers(null, after, false)).toBe(true);
    expect(legacyPrefers({ state: 'shadow', switchAt: null }, after, false)).toBe(true);
    expect(legacyPrefers({ state: 'reverted', switchAt }, after, false)).toBe(true);
  });

  it('for a switched generation legacy prefers only pre-switch instants, unswitched enqueues and a missing instant', () => {
    const c = { state: 'switched' as const, switchAt };
    expect(legacyPrefers(c, before, false)).toBe(true);
    expect(legacyPrefers(c, after, false)).toBe(false);
    expect(legacyPrefers(c, after, true)).toBe(true);
    expect(legacyPrefers(c, null, false)).toBe(true);
  });

  it('the flow prefers exactly a switched generation', () => {
    expect(flowPrefers(null)).toBe(false);
    expect(flowPrefers({ state: 'shadow' })).toBe(false);
    expect(flowPrefers({ state: 'switched' })).toBe(true);
    expect(flowPrefers({ state: 'reverted' })).toBe(false);
  });
});

describe('occurrence identity', () => {
  it('legacyScheduleHistoryKeys round-trips with formatScheduleTriggerKey (drift in either goes red)', () => {
    for (const iso of ['2027-01-09T03:00:00Z', '2026-12-31T23:59:00Z', '2027-03-28T01:30:00Z', '2027-10-31T00:05:00Z']) {
      const at = new Date(iso);
      const key = occurrenceKey.schedule(at);
      const legacy = `schedule:${formatScheduleTriggerKey(at)}`;
      expect(legacyScheduleHistoryKeys(key)).toEqual([key, legacy]);
      expect(scheduleInstantFromSlotKey(formatScheduleTriggerKey(at))?.toISOString()).toBe(at.toISOString());
    }
    expect(legacyScheduleHistoryKeys(occurrenceKey.event(EVENT_ID))).toEqual([occurrenceKey.event(EVENT_ID)]);
    expect(() => legacyScheduleHistoryKeys('schedule:202701090300')).toThrow();
    expect(scheduleInstantFromSlotKey('2027-01-09T03:00Z')).toBeNull();
    expect(scheduleInstantFromSlotKey('202713090300')).toBeNull();
  });

  it('an event id that is not a uuid has no key; a missing or invalid timestamp has no instant', () => {
    expect(eventOccurrenceKey(EVENT_ID)).toBe(`event:${EVENT_ID}`);
    expect(eventOccurrenceKey('not-a-uuid')).toBeNull();
    expect(eventOccurrenceKey(undefined)).toBeNull();
    expect(eventInstant('2027-01-09T03:00:00.000Z')?.toISOString()).toBe('2027-01-09T03:00:00.000Z');
    expect(eventInstant('soon')).toBeNull();
    expect(eventInstant(undefined)).toBeNull();
    expect(OCCURRENCE_KEY_RE.test(eventOccurrenceKey(EVENT_ID)!)).toBe(true);
  });

  it('an anomaly is reported to Sentry once per occurrence and engine, with a literal code', () => {
    vi.mocked(captureMessage).mockClear();
    reportOccurrenceAnomaly('flow_conversion_event_instant_missing', 'legacy', `event:${EVENT_ID}`);
    reportOccurrenceAnomaly('flow_conversion_event_instant_missing', 'legacy', `event:${EVENT_ID}`);
    reportOccurrenceAnomaly('flow_conversion_event_instant_missing', 'flow', `event:${EVENT_ID}`);
    expect(captureMessage).toHaveBeenCalledTimes(2);
    expect(vi.mocked(captureMessage).mock.calls[0]![1]).toMatchObject({ eventCode: 'flow_conversion_event_instant_missing' });
  });
});

describe('claimOccurrence', () => {
  it('second engine gets the existing linkage', async () => {
    const key = occurrenceKey.event(EVENT_ID);
    // flow: history probe (none) → insert conflicts (no row back) → the winner's linkage.
    const f = fakeTx([[], [], [{ engine: 'legacy', legacy_run_id: LEGACY_RUN, flow_run_id: null }]]);
    const result = await claimOccurrence(f.tx, { ...base, keys: [key], engine: 'flow', flowRunId: FLOW_RUN });
    expect(result).toEqual({ ok: false, existing: { engine: 'legacy', legacyRunId: LEGACY_RUN, flowRunId: null } });
    expect(f.statements[1]!.sql).toMatch(/insert into "?automation_occurrence_claims"?/i);
    expect(f.statements[1]!.sql).toMatch(/on conflict \(automation_id, occurrence_key\) do nothing/i);
    expect(f.rollbacks).toHaveLength(1);

    // legacy after a flow claim: no history probe, the flow run is the linkage.
    const l = fakeTx([[], [{ engine: 'flow', legacy_run_id: null, flow_run_id: FLOW_RUN }]]);
    const lr = await claimOccurrence(l.tx, { ...base, keys: [key], engine: 'legacy', legacyRunId: LEGACY_RUN });
    expect(lr).toEqual({ ok: false, existing: { engine: 'flow', legacyRunId: null, flowRunId: FLOW_RUN } });
    expect(l.statements.some((s) => /automation_runs/.test(s.sql))).toBe(false);
  });

  it('pre-claim automation_runs history counts as a claim', async () => {
    const at = new Date('2027-01-09T03:00:00Z');
    const key = occurrenceKey.schedule(at);
    const f = fakeTx([[{ id: LEGACY_RUN }]]);
    const result = await claimOccurrence(f.tx, { ...base, keys: [key], engine: 'flow', flowRunId: FLOW_RUN });
    expect(result).toEqual({ ok: false, existing: { engine: 'legacy', legacyRunId: LEGACY_RUN, flowRunId: null } });
    expect(f.statements).toHaveLength(1);
    expect(f.statements[0]!.sql).toMatch(/from "?automation_runs"?/i);
    // Both spellings of the slot: the claim's ISO minute and legacy's compact UTC slot.
    expect(f.statements[0]!.params).toEqual(expect.arrayContaining([AUTOMATION, key, `schedule:${formatScheduleTriggerKey(at)}`]));
  });

  it('webhook aliases conflict on either key', async () => {
    const sig = occurrenceKey.webhookSig('a'.repeat(64));
    const dlv = occurrenceKey.webhookDelivery('evt_1');
    // The delivery alias was claimed before: only the signature row came back, so
    // the savepoint rolls the partial claim back and the winner is named.
    const f = fakeTx([[{ occurrence_key: sig }], [{ engine: 'legacy', legacy_run_id: LEGACY_RUN, flow_run_id: null }]]);
    const r = await claimOccurrence(f.tx, { ...base, keys: [sig, dlv], engine: 'flow', flowRunId: FLOW_RUN });
    expect(r).toEqual({ ok: false, existing: { engine: 'legacy', legacyRunId: LEGACY_RUN, flowRunId: null } });
    expect(f.rollbacks).toHaveLength(1);
    // No webhook key has automation_runs history, so no probe ran.
    expect(f.statements.some((s) => /automation_runs/.test(s.sql))).toBe(false);
    expect(f.statements[0]!.params).toEqual(expect.arrayContaining([sig, dlv]));

    const ok = fakeTx([[{ occurrence_key: sig }, { occurrence_key: dlv }]]);
    await expect(claimOccurrence(ok.tx, { ...base, keys: [sig, dlv, sig], engine: 'flow', flowRunId: FLOW_RUN })).resolves.toEqual({ ok: true });
    expect(ok.rollbacks).toHaveLength(0);
  });

  it('claim and run commit together (a forced failure after the claim leaves no claim)', async () => {
    // Every statement runs on the caller's executor: no context of its own,
    // no commit of its own. The caller's rollback therefore takes the claim
    // with it (proved against real Postgres in the integration suite).
    const key = occurrenceKey.event(EVENT_ID);
    const f = fakeTx([[{ occurrence_key: key }]]);
    systemCtx.mockClear();
    await expect(claimOccurrence(f.tx, { ...base, keys: [key], engine: 'legacy', legacyRunId: LEGACY_RUN })).resolves.toEqual({ ok: true });
    expect(systemCtx).not.toHaveBeenCalled();
    expect(f.statements).toHaveLength(1);
    expect(f.statements[0]!.params).toEqual(expect.arrayContaining([ORG, AUTOMATION, key, 'legacy', CONVERSION, LEGACY_RUN]));
  });

  it('refuses malformed input instead of writing it', async () => {
    const f = fakeTx([]);
    await expect(claimOccurrence(f.tx, { ...base, keys: [], engine: 'flow' })).rejects.toThrow(/no occurrence key/);
    await expect(claimOccurrence(f.tx, { ...base, keys: ['schedule:202701090300'], engine: 'flow' })).rejects.toThrow(/occurrence key/);
    await expect(claimOccurrence(f.tx, { ...base, keys: [occurrenceKey.event(EVENT_ID)], engine: 'legacy' })).rejects.toThrow(/legacyRunId/);
    expect(f.statements).toHaveLength(0);
  });
});
