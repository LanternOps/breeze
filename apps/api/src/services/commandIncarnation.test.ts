import { describe, expect, it } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import {
  commandIncarnationAcceptedForCallerCondition,
  commandIncarnationIsCurrentCondition,
  commandStampIncarnation,
  commandStampIsCurrent,
  commandStampMatchesCaller,
  commandStampMatchesCallerCondition,
  SUPERSEDED_BY_REATTACH_REASON,
} from './commandIncarnation';

describe('the caller half of the incarnation check (#8318 §6.4)', () => {
  it('a stamp matches the caller only when it equals the incarnation the caller authenticated under', () => {
    expect(commandStampMatchesCaller(null, 1)).toBe(true);
    expect(commandStampMatchesCaller(2, 2)).toBe(true);
    expect(commandStampMatchesCaller(2, 1)).toBe(false); // enqueued after a confirm the caller predates
    expect(commandStampMatchesCaller(1, 2)).toBe(false); // the old install's row, seen by the new one
  });

  it('compiles the caller condition with the incarnation bound as a parameter and NULL read as 1', () => {
    const { sql, params } = new PgDialect().sqlToQuery(commandStampMatchesCallerCondition({ installIncarnation: 7 }));
    expect(sql).toBe('COALESCE("device_commands"."device_incarnation", 1) = $1');
    expect(params).toEqual([7]);
  });

  it('the accepted-for-caller condition is the current check AND the caller check, in one statement', () => {
    const { sql, params } = new PgDialect().sqlToQuery(commandIncarnationAcceptedForCallerCondition({ installIncarnation: 3 }));
    const current = new PgDialect().sqlToQuery(commandIncarnationIsCurrentCondition()).sql;
    expect(sql).toBe(`(${current} and COALESCE("device_commands"."device_incarnation", 1) = $1)`);
    expect(params).toEqual([3]);
  });
});

describe('command incarnation stamps (#8318 §4.1 null rule)', () => {
  it('reads a NULL stamp as incarnation 1', () => {
    expect(commandStampIncarnation(null)).toBe(1);
    expect(commandStampIncarnation(undefined)).toBe(1);
    expect(commandStampIncarnation(3)).toBe(3);
  });

  it('a stamp is current only when it equals the device incarnation', () => {
    expect(commandStampIsCurrent(null, 1)).toBe(true);
    expect(commandStampIsCurrent(1, 1)).toBe(true);
    expect(commandStampIsCurrent(null, 2)).toBe(false);
    expect(commandStampIsCurrent(1, 2)).toBe(false);
    expect(commandStampIsCurrent(3, 2)).toBe(false);
  });

  it('names the spec reason', () => {
    expect(SUPERSEDED_BY_REATTACH_REASON).toBe('superseded_by_reattach');
  });
});
