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

  // Wisp W04 (w00 A24): a thread attachment is stored with session_id NULL and
  // must be readable from every later session on the SAME thread — one more
  // exact pointer, never "any session of this user".
  const THREAD = '00000000-0000-4000-8000-0000000000a6';

  it('with wispThreadId the ownership predicate ORs an EXISTS on wisp_thread_attachments keyed by thread_id; org, expiry, export_dataset and redacted-marker predicates remain', () => {
    const { sql, params } = findArtifactForCallerQuery(ART, { orgId: ORG, sessionId: SESSION, wispThreadId: THREAD }).toSQL();
    expect(sql).toMatch(
      /\("ai_run_artifacts"\."session_id" = \$\d+ or exists \(select 1 from "wisp_thread_attachments" "ta" where \("ta"\."artifact_id" = "ai_run_artifacts"\."id" and "ta"\."thread_id" = \$\d+\)\)\)/,
    );
    expect(params).toEqual(expect.arrayContaining([ART, ORG, SESSION, THREAD, 'export_dataset', 'input_capture', REDACTED_CAPTURE_NAME_PATTERN]));
    expect(sql).toMatch(/"ai_run_artifacts"\."org_id" = \$\d/);
    expect(sql).toMatch(/"ai_run_artifacts"\."expires_at" > \$\d/);
    expect(sql).toMatch(/"ai_run_artifacts"\."created_by_tool" <> \$\d/);
    expect(sql).toMatch(/\("ai_run_artifacts"\."kind" <> \$\d+ or "ai_run_artifacts"\."name" like \$\d+\)/);
    // The thread arm is AND-ed under the org predicate, never a sibling of it.
    expect(sql.indexOf('"ai_run_artifacts"."org_id" =')).toBeLessThan(sql.indexOf('exists'));

    // A run anchor gets the same extra arm (the run arm stays exact).
    const run = findArtifactForCallerQuery(ART, { orgId: ORG, runId: RUN, wispThreadId: THREAD }).toSQL();
    expect(run.sql).toMatch(/\("ai_run_artifacts"\."run_id" = \$\d+ or exists \(select 1 from "wisp_thread_attachments"/);
  });

  it('without wispThreadId the compiled SQL is byte-identical to before (no wisp_thread_attachments reference)', () => {
    const cols = 'select "id", "org_id", "run_id", "session_id", "kind", "name", "content_type", "bytes", "sha256", "blob_key", "head_preview", "tail_preview", "source_device_id", "created_by_tool", "dataset", "expires_at", "created_at" from "ai_run_artifacts"';
    const tail = 'and "ai_run_artifacts"."expires_at" > $4 and "ai_run_artifacts"."created_by_tool" <> $5 and ("ai_run_artifacts"."kind" <> $6 or "ai_run_artifacts"."name" like $7)) limit $8';
    // Captured from the pre-W04 builder.
    const BEFORE_SESSION = `${cols} where ("ai_run_artifacts"."id" = $1 and "ai_run_artifacts"."org_id" = $2 and "ai_run_artifacts"."session_id" = $3 ${tail}`;
    const BEFORE_RUN = `${cols} where ("ai_run_artifacts"."id" = $1 and "ai_run_artifacts"."org_id" = $2 and "ai_run_artifacts"."run_id" = $3 ${tail}`;

    for (const wispThreadId of [undefined, null] as const) {
      for (const analysisOutputs of [undefined, null] as const) {
        const extra = {
          ...(wispThreadId === undefined ? {} : { wispThreadId }),
          ...(analysisOutputs === undefined ? {} : { analysisOutputs }),
        };
        const session = findArtifactForCallerQuery(ART, { orgId: ORG, sessionId: SESSION, ...extra }).toSQL();
        expect(session.sql).toBe(BEFORE_SESSION);
        expect(session.sql).not.toContain('wisp_thread_attachments');
        expect(session.sql).not.toContain('ai_agent_runs');
        const run = findArtifactForCallerQuery(ART, { orgId: ORG, runId: RUN, ...extra }).toSQL();
        expect(run.sql).toBe(BEFORE_RUN);
      }
    }
  });

  // Wisp analysis sessions W01 (#11845): an output of a chat-launched analysis
  // run under the caller's grant is readable from any session of that grant
  // (the thread rule), in any org of the live ceiling.
  const GRANT = '00000000-0000-4000-8000-0000000000b1';
  const ORG2 = '00000000-0000-4000-8000-0000000000b3';
  const scope = { grantId: GRANT, orgIds: [ORG, ORG2] };

  it('with analysisOutputs a session read also matches an output of a chat-launched analysis run under this grant', () => {
    const { sql, params } = findArtifactForCallerQuery(ART, { orgId: ORG, sessionId: SESSION, analysisOutputs: scope }).toSQL();
    expect(sql).toMatch(/"ai_run_artifacts"\."kind" = \$\d+/);
    expect(sql).toMatch(/"ai_run_artifacts"\."org_id" in \(\$\d+, \$\d+\)/);
    expect(sql).toMatch(/exists \(select 1 from "ai_agent_runs" "ar" where/);
    expect(sql).toMatch(/"ar"\."id" = "ai_run_artifacts"\."run_id"/);
    expect(sql).toMatch(/"ar"\."org_id" = "ai_run_artifacts"\."org_id"/);
    expect(sql).toMatch(/"ar"\."profile" = \$\d+/);
    expect(sql).toMatch(/"ar"\."grant_id" = \$\d+/);
    expect(sql).toMatch(/\("ar"\."trigger_ref"\s*->>\s*'originSessionId'\) is not null/);
    expect(params).toEqual(expect.arrayContaining(['output', 'analysis', GRANT, ORG, ORG2]));
    // Thread rule: the arm never binds the caller's session id (the session arm beside it does, once).
    expect(params.filter((p) => p === SESSION)).toHaveLength(1);
  });

  it('expiry, export_dataset and redacted-marker terms still bind the analysis arm', () => {
    const { sql } = findArtifactForCallerQuery(ART, { orgId: ORG, sessionId: SESSION, analysisOutputs: scope }).toSQL();
    const arm = sql.indexOf('exists (select 1 from "ai_agent_runs"');
    expect(arm).toBeGreaterThan(-1);
    expect(sql.indexOf('"ai_run_artifacts"."expires_at" >')).toBeGreaterThan(arm);
    expect(sql.indexOf('"ai_run_artifacts"."created_by_tool" <>')).toBeGreaterThan(arm);
    expect(sql).toMatch(/\("ai_run_artifacts"\."kind" <> \$\d+ or "ai_run_artifacts"\."name" like \$\d+\)/);
    // The handle term sits outside the OR.
    expect(sql).toMatch(/^select .* where \("ai_run_artifacts"\."id" = \$1 and \(\(/);
  });

  it('the session-org arm is unchanged beside it', () => {
    const { sql } = findArtifactForCallerQuery(ART, { orgId: ORG, sessionId: SESSION, analysisOutputs: scope }).toSQL();
    expect(sql).toMatch(/\(\("ai_run_artifacts"\."org_id" = \$\d+ and "ai_run_artifacts"\."session_id" = \$\d+\) or \(/);
  });

  it('keeps the thread-attachment arm under the session org when both are set', () => {
    const THREAD2 = '00000000-0000-4000-8000-0000000000a7';
    const { sql } = findArtifactForCallerQuery(ART, { orgId: ORG, sessionId: SESSION, wispThreadId: THREAD2, analysisOutputs: scope }).toSQL();
    expect(sql).toMatch(
      /\(\("ai_run_artifacts"\."org_id" = \$\d+ and \("ai_run_artifacts"\."session_id" = \$\d+ or exists \(select 1 from "wisp_thread_attachments"/,
    );
    expect(sql).toContain('exists (select 1 from "ai_agent_runs" "ar"');
  });

  it('no arm for a run anchor, a missing session or an empty ceiling', () => {
    for (const anchor of [
      { orgId: ORG, runId: RUN, analysisOutputs: scope },
      { orgId: ORG, runId: RUN, sessionId: SESSION, analysisOutputs: scope },
      { orgId: ORG, analysisOutputs: scope },
      { orgId: ORG, sessionId: SESSION, analysisOutputs: { ...scope, orgIds: [] } },
      { orgId: ORG, sessionId: SESSION, analysisOutputs: null },
    ]) expect(findArtifactForCallerQuery(ART, anchor).toSQL().sql).not.toContain('ai_agent_runs');
  });
});
