import { describe, expect, it } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import { buildEscalationCas, buildEnrichmentClaimScope } from './incidentJobs';

/**
 * COMPILED-SQL assertions, in their own file so it imports the REAL drizzle-orm.
 *
 * The sibling `incidentJobs.atomicWinner.test.ts` mocks drizzle to exercise the
 * pass bodies; its `where` assertions substring-match column names and are
 * therefore blind to the mutations that actually matter. All of these passed
 * green before this file existed:
 *
 *   - escalation CAS drops `eq(incidents.id, ...)`  -> the first stale row's
 *     iteration stamps EVERY un-escalated incident in every tenant and pages
 *     on-call for it;
 *   - escalation CAS `and` -> `or`                  -> same blast radius;
 *   - enrichment claim loses `FOR UPDATE SKIP LOCKED` -> the entire
 *     cross-process safety of the claim is gone, silently.
 */
describe('incident winner predicates (compiled SQL)', () => {
  const dialect = new PgDialect();

  it('escalation CAS is an AND of the incident id and an unescalated marker', () => {
    const { sql, params } = dialect.sqlToQuery(buildEscalationCas('inc-1')!);

    expect(sql).toBe('("incidents"."id" = $1 and "incidents"."escalated_at" is null)');
    expect(params).toEqual(['inc-1']);
  });

  it('enrichment claim scope is open-and-unclaimed, keyed on the marker column', () => {
    const { sql, params } = dialect.sqlToQuery(buildEnrichmentClaimScope()!);

    // Note it does NOT mention `timeline` — the marker column is the gate, not
    // the jsonb array the pass renders into.
    expect(sql).toBe(
      '("incidents"."status" <> $1 and "incidents"."timeline_enriched_at" is null)'
    );
    expect(params).toEqual(['closed']);
  });
});
