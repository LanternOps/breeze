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

import { hideAiNoiseCondition } from './alerts';

describe('hideAiNoiseCondition (compiled SQL)', () => {
  const dialect = new PgDialect();

  it('compiles a correlated NOT EXISTS over ai_alert_verdicts, scoped to this alert (or a group it is a member of), live rows, and the three noise classifications', () => {
    const { sql, params } = dialect.sqlToQuery(hideAiNoiseCondition());
    const normalized = sql.replace(/\s+/g, ' ').trim();

    // I3 fix (P2-1 wave B task 16d): a group verdict (`alert_id IS NULL`,
    // `correlation_group_id` set) counts against a member alert too — the
    // `or (... correlation_group_id in (select group_id from
    // alert_correlation_members where alert_id = alerts.id))` branch.
    expect(normalized).toBe(
      'not exists (select 1 from "ai_alert_verdicts" where '
      + '(("ai_alert_verdicts"."alert_id" = "alerts"."id" or '
      + '"ai_alert_verdicts"."correlation_group_id" in '
      + '(select "group_id" from "alert_correlation_members" where '
      + '"alert_correlation_members"."alert_id" = "alerts"."id")) and '
      + '"ai_alert_verdicts"."superseded_by" is null and '
      + '"ai_alert_verdicts"."classification" in ($1, $2, $3)))'
    );
    expect(params).toEqual(['transient_self_healed', 'recurring_pattern', 'duplicate_of_group']);
  });

  it('never admits actionable or needs_human into the noise list — those alerts must stay visible', () => {
    const { params } = dialect.sqlToQuery(hideAiNoiseCondition());
    expect(params).not.toContain('actionable');
    expect(params).not.toContain('needs_human');
  });
});
