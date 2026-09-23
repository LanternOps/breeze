/**
 * A-W05 (D13a/Q4, blocking) — the ONE assertion that must not be vacuous.
 * `artifactService.test.ts` mocks `../../db`, so its `findArtifactForCaller`
 * tests can only prove "the code returns whatever the mock hands back" — they
 * cannot prove the real predicate actually excludes a cross-session read, an
 * expired artifact, an `export_dataset` artifact, or a legacy unmarked (raw) capture
 * (memory: vacuous Drizzle where-clause assertions). This file deliberately
 * does NOT mock `../../db`, so the real Drizzle builder produces real SQL.
 */
import { describe, expect, it } from 'vitest';
import { REDACTED_CAPTURE_NAME_PATTERN, findArtifactForCallerQuery } from './artifactService';

const ORG = '00000000-0000-4000-8000-0000000000a1';
const ART = '00000000-0000-4000-8000-0000000000a4';
const RUN = '00000000-0000-4000-8000-0000000000a3';
const SESSION = '00000000-0000-4000-8000-0000000000a5';

describe('findArtifactForCallerQuery — compiled SQL (vacuous-Drizzle trap)', () => {
  it('anchors on run_id exactly (never session_id) when a run is supplied', () => {
    const { sql, params } = findArtifactForCallerQuery(ART, { orgId: ORG, runId: RUN }).toSQL();
    expect(sql).toMatch(/"ai_run_artifacts"\."run_id" = \$\d/);
    expect(sql).not.toMatch(/"ai_run_artifacts"\."session_id" = \$\d/);
    expect(params).toEqual(expect.arrayContaining([ART, ORG, RUN]));
  });

  it('anchors on session_id exactly (never run_id) when no run is supplied — "any session of this user" is not a match', () => {
    const { sql, params } = findArtifactForCallerQuery(ART, { orgId: ORG, sessionId: SESSION }).toSQL();
    expect(sql).toMatch(/"ai_run_artifacts"\."session_id" = \$\d/);
    expect(sql).not.toMatch(/"ai_run_artifacts"\."run_id" = \$\d/);
    expect(params).toEqual(expect.arrayContaining([ART, ORG, SESSION]));
  });

  it('prefers the run anchor over a session id supplied alongside it', () => {
    const { sql } = findArtifactForCallerQuery(ART, { orgId: ORG, runId: RUN, sessionId: SESSION }).toSQL();
    expect(sql).toMatch(/"ai_run_artifacts"\."run_id" = \$\d/);
    expect(sql).not.toMatch(/"ai_run_artifacts"\."session_id" = \$\d/);
  });

  it('requires expires_at strictly greater than now (a boundary-equal artifact is expired, not readable)', () => {
    const { sql } = findArtifactForCallerQuery(ART, { orgId: ORG, runId: RUN }).toSQL();
    expect(sql).toMatch(/"ai_run_artifacts"\."expires_at" > \$\d/);
  });

  it('excludes export_dataset artifacts entirely (Q5)', () => {
    const { sql, params } = findArtifactForCallerQuery(ART, { orgId: ORG, runId: RUN }).toSQL();
    expect(sql).toMatch(/"ai_run_artifacts"\."created_by_tool" <> \$\d/);
    expect(params).toContain('export_dataset');
  });

  it('admits an input_capture row only when its name carries the redact-then-capture marker; other kinds are not gated on it (Q5)', () => {
    const { sql, params } = findArtifactForCallerQuery(ART, { orgId: ORG, runId: RUN }).toSQL();
    expect(sql).toMatch(/"ai_run_artifacts"\."kind" <> \$\d/);
    expect(sql).toMatch(/"ai_run_artifacts"\."name" like \$\d/i);
    expect(sql).not.toMatch(/"ai_run_artifacts"\."created_at" >=/);
    expect(params).toContain('input_capture');
    expect(params).toContain(REDACTED_CAPTURE_NAME_PATTERN);
  });

  it('is capped to one row', () => {
    const { sql } = findArtifactForCallerQuery(ART, { orgId: ORG, runId: RUN }).toSQL();
    expect(sql).toMatch(/limit \$\d/i);
  });
});
