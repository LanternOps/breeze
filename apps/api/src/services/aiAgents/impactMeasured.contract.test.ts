/**
 * AI Scorecard W04 (#5761, refs #4182) — contract tests for the measured-impact
 * cohort SQL. No database: these pin the *shape* of the generated SQL, which is
 * where the three defects the exposure predicate exists to close would silently
 * reappear if someone "simplified" it back to a linkage join.
 */
import { PgDialect } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';

import { ALERT_EXPOSURE_AGE_MINUTES, TICKET_EXPOSURE_AGE_MINUTES } from '@breeze/shared';

import { UNGROUPED_VERDICT_DELAY_MINUTES } from '../../jobs/alertVerdictScheduler';
import {
  alertCohortQuery,
  alertExposureCte,
  ticketCohortQuery,
  ticketExposureCte,
} from './impactMeasuredCohorts';

const dialect = new PgDialect();
const render = (fragment: Parameters<PgDialect['sqlToQuery']>[0]) => dialect.sqlToQuery(fragment).sql;
const renderParams = (fragment: Parameters<PgDialect['sqlToQuery']>[0]) => dialect.sqlToQuery(fragment).params;

const ORGS = ['00000000-0000-4000-8000-000000000001'];
const FROM = '2026-01-01';
const THROUGH = '2026-01-31';

describe('cohort-formation age vs the scheduler delay', () => {
  it('L exceeds the scheduler delay, so the AI arm is reachable at all', () => {
    // An alert must stay open and uncorrelated for UNGROUPED_VERDICT_DELAY_MINUTES
    // before it gets its own verdict run. An L at or below that leaves the AI arm
    // systematically empty and the whole comparison vacuous. This is the real
    // cross-package check the shared-package test can only assert as a literal.
    expect(ALERT_EXPOSURE_AGE_MINUTES).toBeGreaterThan(UNGROUPED_VERDICT_DELAY_MINUTES);
    expect(TICKET_EXPOSURE_AGE_MINUTES).toBeGreaterThan(UNGROUPED_VERDICT_DELAY_MINUTES);
  });
});

describe('alertExposureCte', () => {
  const sqlText = render(alertExposureCte(ORGS, FROM, THROUGH));

  it('traverses correlation-group membership, not just the direct link', () => {
    // Correlation-group verdicts carry alert_id = NULL by design
    // (services/aiAgents/alertVerdicts.ts), so a `WHERE v.alert_id = a.id`
    // predicate silently drops every grouped alert.
    expect(sqlText).toContain('alert_correlation_members');
    expect(sqlText).toContain('correlation_group_id');
  });

  it('takes the earliest contact across all three paths', () => {
    expect(sqlText).toMatch(/min\(/i);
    expect((sqlText.match(/union all/gi) ?? []).length).toBe(2);
  });

  it('ignores a run that never started', () => {
    expect(sqlText).toMatch(/"started_at"\s+is not null/i);
  });

  it('converts every timestamptz contact column to the naive UTC instant', () => {
    // ai_alert_verdicts.created_at and ai_agent_runs.started_at are timestamptz;
    // alerts.triggered_at is a plain timestamp. Comparing them without the cast
    // shifts the bound by the session offset.
    expect(sqlText).toMatch(/"created_at"\s+at time zone 'UTC'/i);
    expect(sqlText).toMatch(/"started_at"\s+at time zone 'UTC'/i);
  });

  it('scopes every branch by org', () => {
    expect((sqlText.match(/"org_id" in/gi) ?? []).length).toBeGreaterThanOrEqual(3);
  });
});

describe('alertCohortQuery', () => {
  const sqlText = render(alertCohortQuery(ORGS, FROM, THROUGH, undefined));

  it('does NOT apply AT TIME ZONE to the naive alerts columns', () => {
    // alerts.triggered_at / resolved_at are `timestamp` WITHOUT time zone
    // (db/schema/alerts.ts). Copying P2-6's timestamptz casts onto them shifts
    // the window bound by twice the session offset.
    expect(sqlText).not.toMatch(/"triggered_at"\s+at time zone/i);
    expect(sqlText).not.toMatch(/"resolved_at"\s+at time zone/i);
  });

  it('bounds the window with inlined date casts, not a bounds CTE', () => {
    // A `bounds` CTE referenced by sibling CTEs is materialized, the range
    // predicates stop being constant-folded, and the index range scans this
    // wave's migration adds are lost (P2-6 learned this).
    expect(sqlText).toMatch(/::date\)?::timestamp/i);
    expect(sqlText).not.toMatch(/\bbounds\s+AS\s*\(/i);
  });

  it('keeps only alerts still open at the exposure age L, in both arms', () => {
    // The cohort entry instant is `triggered_at + L`, and membership demands the
    // alert was still open then -- in BOTH arms, so the untouched arm is not
    // loaded with trivially-fast items the AI never had a chance to see.
    expect(sqlText).toMatch(/make_interval\(mins =>/i);
    expect(renderParams(alertCohortQuery(ORGS, FROM, THROUGH, undefined)))
      .toContain(ALERT_EXPOSURE_AGE_MINUTES);
    expect(sqlText).toMatch(/"resolved_at" is null or "alerts"\."resolved_at" >=/i);
  });

  it('does not treat suppressed or dismissed as a resolution', () => {
    // `resolved` must be the ONLY status that counts as an outcome. A bare
    // `toMatch(/'resolved'/)` would still pass if someone widened the predicate
    // to `status IN ('resolved','suppressed','dismissed')` -- which is exactly
    // the regression this test exists to catch -- so assert the equality shape
    // AND the absence of the other two literals.
    expect(sqlText).toMatch(/"status"\s*=\s*'resolved'/i);
    expect(sqlText).not.toMatch(/'suppressed'/i);
    expect(sqlText).not.toMatch(/'dismissed'/i);
    expect(sqlText).not.toMatch(/"status"\s+in\s*\(/i);
  });
});

describe('ticketExposureCte', () => {
  const sqlText = render(ticketExposureCte(ORGS, FROM, THROUGH));

  it('counts an AI DRAFT as exposure, not only an agent run', () => {
    // A draft is written for a ticket without necessarily having a run attached
    // to that ticket, so dropping this branch would silently shrink the AI arm.
    expect(sqlText).toContain('ticket_drafts');
    expect(sqlText).toContain('ai_agent_runs');
    expect((sqlText.match(/union all/gi) ?? []).length).toBe(1);
  });

  it('ignores a run that never started', () => {
    expect(sqlText).toMatch(/"started_at"\s+is not null/i);
  });

  it('takes the earliest contact and scopes every branch by org', () => {
    expect(sqlText).toMatch(/min\(/i);
    expect((sqlText.match(/"org_id" in/gi) ?? []).length).toBeGreaterThanOrEqual(2);
  });

  it('converts both timestamptz sources to the naive UTC instant', () => {
    // ticket_drafts.created_at and ai_agent_runs.started_at are BOTH timestamptz;
    // tickets.created_at is not. Comparing them uncast shifts the bound.
    expect(sqlText).toMatch(/"started_at"\s+at time zone 'UTC'/i);
    expect(sqlText).toMatch(/"created_at"\s+at time zone 'UTC'/i);
  });
});

describe('ticketCohortQuery', () => {
  const sqlText = render(ticketCohortQuery(ORGS, FROM, THROUGH, undefined));

  it('excludes soft-deleted tickets', () => {
    expect(sqlText).toMatch(/"deleted_at" is null/i);
  });

  it('does NOT apply AT TIME ZONE to the naive tickets columns', () => {
    // tickets.created_at / first_response_at are `timestamp` WITHOUT time zone.
    // (ticket_drafts.created_at in the exposure CTE IS timestamptz and is cast --
    // hence the table-qualified assertions here.)
    expect(sqlText).toMatch(/"tickets"\."created_at" >=/i);
    expect(sqlText).not.toMatch(/"tickets"\."created_at"\s+at time zone/i);
    expect(sqlText).not.toMatch(/"first_response_at"\s+at time zone/i);
  });

  it('keys cohorts by priority and category', () => {
    expect(sqlText).toContain('"priority"');
    expect(sqlText).toContain('"category"');
  });
});
