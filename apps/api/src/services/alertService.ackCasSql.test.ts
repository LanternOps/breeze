import { describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';

// Only the CONNECTION is mocked. drizzle-orm and ../db/schema stay REAL so the
// predicates can be compiled — the whole point of this file.
vi.mock('../db', () => ({ db: {} }));

import { alertStatusEnum } from '../db/schema/alerts';
import {
  ACKNOWLEDGEABLE_ALERT_STATUSES,
  DISMISSIBLE_ALERT_STATUSES,
  RESOLVABLE_ALERT_STATUSES,
  SUPPRESSIBLE_ALERT_STATUSES,
  buildAcknowledgeAlertCas,
  buildSuppressAlertCas,
} from './alertService';

/**
 * COMPILED-SQL assertions for the acknowledge/suppress compare-and-swap predicates
 * (#4101), the acknowledge-side twin of `alertService.resolveCasSql.test.ts`.
 *
 * Compiling is not ceremony. A mocked-drizzle assertion that only checks column
 * names appear cannot tell `and` from `or` — which would stamp every matching
 * alert in EVERY tenant from one request — and cannot see the status list gaining
 * a value that makes the CAS a no-op. Both mutations change the string or the
 * params below.
 */
describe('acknowledge compare-and-swap predicate (compiled SQL)', () => {
  const dialect = new PgDialect();

  it('emits an AND of the id equality and the acknowledgeable-status set', () => {
    const { sql, params } = dialect.sqlToQuery(buildAcknowledgeAlertCas('alert-1')!);

    expect(sql).toBe('("alerts"."id" = $1 and "alerts"."status" in ($2))');
    expect(params).toEqual(['alert-1', 'active']);
  });

  it('admits ONLY active', () => {
    // Every acknowledge call site refuses a non-active alert at its pre-read; the
    // CAS is that same rule expressed where it is actually enforceable. Admitting
    // `resolved` here is the #4101 bug in its purest form: an acknowledge that
    // overwrites somebody else's resolution.
    expect([...ACKNOWLEDGEABLE_ALERT_STATUSES]).toEqual(['active']);
  });
});

describe('suppress compare-and-swap predicate (compiled SQL)', () => {
  const dialect = new PgDialect();

  it('emits an AND of the id equality and the suppressible-status set', () => {
    const { sql, params } = dialect.sqlToQuery(buildSuppressAlertCas('alert-2')!);

    expect(sql).toBe('("alerts"."id" = $1 and "alerts"."status" in ($2, $3, $4))');
    expect(params).toEqual(['alert-2', 'active', 'acknowledged', 'suppressed']);
  });

  it('keeps `suppressed` itself in the set so a mute can be re-timed', () => {
    // Unlike acknowledge, re-suppressing is legitimate (extend/shorten the mute),
    // so dropping `suppressed` here would break a real workflow rather than close
    // a race.
    expect([...SUPPRESSIBLE_ALERT_STATUSES]).toContain('suppressed');
  });
});

/**
 * Drift guard. The four status lists are separate on purpose — they express four
 * different invariants and must be free to diverge — but every one of them is
 * derived from the same enum, so a new `alert_status` value must be classified
 * deliberately rather than silently inheriting whatever the list happens to hold.
 */
describe('CAS status lists stay anchored to the alert_status enum', () => {
  const TERMINAL = ['resolved', 'dismissed'] as const;

  it('lists only real enum values', () => {
    for (const status of [
      ...ACKNOWLEDGEABLE_ALERT_STATUSES,
      ...SUPPRESSIBLE_ALERT_STATUSES,
      ...RESOLVABLE_ALERT_STATUSES,
      ...DISMISSIBLE_ALERT_STATUSES,
    ]) {
      expect(alertStatusEnum.enumValues).toContain(status);
    }
  });

  it('never admits a terminal status into the three NON-dismiss CAS lists', () => {
    // Dismiss is excluded from this loop by design, not by omission — see the
    // dedicated assertion below. The ban stays absolute for the other three: any
    // terminal status in those sets is a transition overwriting somebody's
    // resolution, which is #4101 exactly.
    for (const terminal of TERMINAL) {
      expect(ACKNOWLEDGEABLE_ALERT_STATUSES).not.toContain(terminal);
      expect(SUPPRESSIBLE_ALERT_STATUSES).not.toContain(terminal);
      expect(RESOLVABLE_ALERT_STATUSES).not.toContain(terminal);
    }
  });

  it('lets dismiss — and ONLY dismiss — admit `resolved`, never `dismissed` (#4293)', () => {
    // The one deliberate exception to the rule above. Dismiss is the terminal
    // "make this go away for good" action and is documented as legal from every
    // other status, `resolved` included; that is the workflow it exists for.
    //
    // The half that is NOT an exception is `dismissed` itself. Admitting it would
    // make the predicate match an already-dismissed row, so the losing caller's
    // UPDATE would succeed again and re-stamp dismissedAt/dismissedBy — the CAS
    // present in the code, absent in effect.
    expect([...DISMISSIBLE_ALERT_STATUSES]).toContain('resolved');
    expect([...DISMISSIBLE_ALERT_STATUSES]).not.toContain('dismissed');
  });

  it('dismissible == every enum value except `dismissed`, derived from the enum', () => {
    // Same reasoning as the suppressible check below: a new status nobody classifies
    // here would be silently un-dismissable, with no error to explain why.
    const dismissible = alertStatusEnum.enumValues.filter((status) => status !== 'dismissed');
    expect([...DISMISSIBLE_ALERT_STATUSES].sort()).toEqual([...dismissible].sort());
  });

  it('suppressible == every non-terminal status, derived from the enum', () => {
    // A new non-terminal status (say `snoozed`) that nobody adds here would make
    // suppress silently un-suppressible for those rows. Deriving the expectation
    // from the enum turns that into a failing test instead of a field report.
    const nonTerminal = alertStatusEnum.enumValues.filter(
      (status) => !(TERMINAL as readonly string[]).includes(status)
    );
    expect([...SUPPRESSIBLE_ALERT_STATUSES].sort()).toEqual([...nonTerminal].sort());
  });
});
