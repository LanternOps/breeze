import { describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';

/**
 * `hideAiNoiseCondition` (alerts.ts) — the `hideAiNoise=true` WHERE-clause
 * predicate for `GET /alerts`. Compiled-SQL test, deliberately: a mocked
 * `where` assertion can only substring-match column names, which cannot
 * distinguish `EXISTS` from `NOT EXISTS`, cannot see whether the
 * classification list survived, and cannot confirm the subquery is
 * correlated on THIS alert's own id rather than some other column (repo
 * rule against vacuous Drizzle where-clause assertions — see
 * `jobs/eventDispatchWorker.sql.test.ts` for the established pattern this
 * mirrors).
 *
 * `drizzle-orm` and `../../db/schema` are REAL here, unlike the other
 * `alerts.*.test.ts` suites — `hideAiNoiseCondition` builds a correlated
 * `NOT EXISTS` subquery via `db.select(...).from(...).where(...)`, which
 * needs a genuine drizzle `SQLWrapper` to compile through `PgDialect`; a
 * hand-rolled mock query builder (the other suites' style) does not
 * implement that interface. `../../db`'s `db` export is left UNMOCKED too —
 * building a query's SQL representation never executes it (same pattern as
 * `services/vulnerabilityCorrelation.ts`'s own correlated-subquery
 * builders), so no live connection is needed. Every other import of
 * `alerts.ts` still needs mocking so the module loads without side effects.
 */

vi.mock('../../middleware/auth', () => ({
  authMiddleware: async (_c: unknown, next: () => Promise<void>) => next(),
  requireScope: () => async (_c: unknown, next: () => Promise<void>) => next(),
  requirePermission: () => async (_c: unknown, next: () => Promise<void>) => next(),
  requireMfa: () => async (_c: unknown, next: () => Promise<void>) => next(),
  siteAccessCheck: () => () => true,
}));
vi.mock('../../services/alertCooldown', () => ({
  setCooldown: vi.fn(), markConfigPolicyRuleCooldown: vi.fn(),
}));
vi.mock('../../services/auditEvents', () => ({ writeRouteAudit: vi.fn() }));
vi.mock('../../services/eventBus', () => ({ publishEvent: vi.fn() }));
vi.mock('../../services/mlFeedbackEmitters', () => ({
  emitAlertStateFeedback: vi.fn(), emitCorrelationFeedback: vi.fn(),
}));
vi.mock('../../services/ticketService', () => ({
  createTicketFromAlert: vi.fn(),
  TicketServiceError: class TicketServiceError extends Error { status = 400; },
}));
vi.mock('../../services/aiAgents/alertVerdicts', () => ({
  latestVerdictsForAlerts: vi.fn(),
  projectAlertAiVerdictSummary: vi.fn(),
}));
vi.mock('./helpers', () => ({
  getPagination: vi.fn(), ensureOrgAccess: vi.fn(), getAlertWithOrgCheck: vi.fn(),
}));

import { correlationMetadataCondition, hideAiNoiseCondition } from './alerts';

describe('hideAiNoiseCondition (compiled SQL)', () => {
  const dialect = new PgDialect();

  it('compiles a correlated NOT EXISTS over ai_alert_verdicts, scoped to this alert (or a group it is a member of), live rows, and the three noise classifications', () => {
    const { sql, params } = dialect.sqlToQuery(hideAiNoiseCondition());
    const normalized = sql.replace(/\s+/g, ' ').trim();

    // I3 fix (P2-1 wave B task 16d): a group verdict (`alert_id IS NULL`,
    // `correlation_group_id` set) counts against a member alert too — the
    // `or (... correlation_group_id in (select group_id from
    // alert_correlation_members where alert_id = alerts.id))` branch.
    //
    // #4446: both correlated legs additionally pin `org_id` to the OUTER
    // alert's own `org_id`, so tenant isolation here is dual-layer (RLS plus
    // an explicit predicate) rather than RLS-only.
    expect(normalized).toBe(
      'not exists (select 1 from "ai_alert_verdicts" where '
      + '("ai_alert_verdicts"."org_id" = "alerts"."org_id" and '
      + '("ai_alert_verdicts"."alert_id" = "alerts"."id" or '
      + '"ai_alert_verdicts"."correlation_group_id" in '
      + '(select "group_id" from "alert_correlation_members" where '
      + '("alert_correlation_members"."org_id" = "alerts"."org_id" and '
      + '"alert_correlation_members"."alert_id" = "alerts"."id"))) and '
      + '"ai_alert_verdicts"."superseded_by" is null and '
      + '"ai_alert_verdicts"."classification" in ($1, $2, $3)))'
    );
    expect(params).toEqual(['transient_self_healed', 'recurring_pattern', 'duplicate_of_group']);
  });

  // #4446 — tenant isolation must not rest on RLS alone here. These two
  // assertions are deliberately separate from the whole-string `toBe` above:
  // that one fails on ANY reformatting of the predicate tree, which makes it
  // useless as a signal that specifically the ORG pin was dropped. A future
  // edit that reshapes the subquery has to keep both of these passing.
  it('pins the verdict row to the outer alert org (dual-layer, not RLS-only)', () => {
    const { sql } = dialect.sqlToQuery(hideAiNoiseCondition());
    const normalized = sql.replace(/\s+/g, ' ').trim();

    expect(normalized).toContain('"ai_alert_verdicts"."org_id" = "alerts"."org_id"');
  });

  it('pins the correlation-member row to the outer alert org too', () => {
    const { sql } = dialect.sqlToQuery(hideAiNoiseCondition());
    const normalized = sql.replace(/\s+/g, ' ').trim();

    // The org pin must live INSIDE the correlated member subquery, not just
    // on the verdict row — the member row is what maps a group verdict onto
    // this alert, so an unpinned member row would reintroduce the RLS-only
    // path through the group leg.
    const memberSubquery = normalized.slice(normalized.indexOf('from "alert_correlation_members"'));
    expect(memberSubquery).toContain('"alert_correlation_members"."org_id" = "alerts"."org_id"');
  });

  it('never admits actionable or needs_human into the noise list — those alerts must stay visible', () => {
    const { params } = dialect.sqlToQuery(hideAiNoiseCondition());
    expect(params).not.toContain('actionable');
    expect(params).not.toContain('needs_human');
  });
});

/**
 * #4446 — same compiled-SQL treatment for the OTHER correlation read on
 * `GET /alerts`'s page. The mocked-drizzle suite (`alerts.test.ts`) stubs
 * `../../db/schema` as bare `{}` objects, so every column reference there is
 * `undefined`; a `where` assertion in that file literally cannot tell an
 * org-pinned predicate from an unpinned one. Only compiled SQL can.
 */
describe('correlationMetadataCondition (compiled SQL)', () => {
  const dialect = new PgDialect();
  const ORG_A = '11111111-1111-4111-8111-111111111111';
  const ORG_B = '22222222-2222-4222-8222-222222222222';
  const ALERT_1 = '33333333-3333-4333-8333-333333333333';

  it('pins org_id on BOTH joined rows, not just the member row', () => {
    const { sql, params } = dialect.sqlToQuery(
      correlationMetadataCondition([ORG_A, ORG_B], [ALERT_1]),
    );
    const normalized = sql.replace(/\s+/g, ' ').trim();

    expect(normalized).toBe(
      '("alert_correlation_members"."org_id" in ($1, $2) and '
      + '"alert_correlation_members"."alert_id" in ($3) and '
      + '"alert_correlation_groups"."org_id" in ($4, $5))'
    );
    expect(params).toEqual([ORG_A, ORG_B, ALERT_1, ORG_A, ORG_B]);
  });

  it('keeps the group-side org pin — the innerJoin on group_id alone is not tenancy', () => {
    const { sql } = dialect.sqlToQuery(correlationMetadataCondition([ORG_A], [ALERT_1]));
    const normalized = sql.replace(/\s+/g, ' ').trim();

    // Deliberately separate from the whole-string assertion above: that one
    // breaks on ANY reshaping of the predicate tree, which makes it useless
    // as a signal that specifically the group-side pin was dropped.
    expect(normalized).toContain('"alert_correlation_groups"."org_id" in');
    expect(normalized).toContain('"alert_correlation_members"."org_id" in');
  });
});
