// apps/api/src/services/aiAgents/runFindings.ts
/**
 * "How much did this run leave for a human?" — the ONE definition of
 * `findingsToReview`, plus the run-summary excerpt the list surfaces render
 * beside it.
 *
 * WHY THIS FILE EXISTS. `runVerdict` understates a run: `no_action` is
 * computed from the run's own remediation outcome, so a sweep that found six
 * problems and was permitted to execute none of them still rolls up as "no
 * action". The run DETAIL page (apps/web/.../RunDetailPage.tsx) already
 * overrides the verdict badge with "N findings to review" — but it derives N
 * itself, from the detail DTO. The run LIST and the agents list have no
 * outcome payload at all (deliberately: see `mapRunListItem`), so they could
 * not, and rendered "No action" over unread findings.
 *
 * Putting the rule here — and using it on BOTH sides — is what stops the two
 * surfaces from badging the same run with different numbers.
 *
 * THE RULE: sweep findings + PROPOSED tool calls. A `denied` action is not a
 * finding: for a read-only profile it is the guardrail working as intended
 * (`runLoop.ts`'s `enforceReadOnlyProfile` logs one for every mutating tool
 * the model merely attempted), so counting it would inflate the badge with
 * denials nobody needs to act on. An `executed` action is not a finding
 * either — it already happened.
 *
 * TWO REPRESENTATIONS, ONE SOURCE. The detail route has the run's whole
 * `outcome` jsonb in memory and counts it in TypeScript
 * (`countFindingsToReview`). The two LIST routes must NOT pull that column —
 * `sweepFindingsOutcomeSchema` caps a run at 50 model-authored findings, so
 * shipping the blob for 25 list rows would move megabytes to count integers,
 * and the full outcome is exactly where this file's siblings' safe-projection
 * risk lives. They therefore count in Postgres (`findingsToReviewSql`), which
 * returns two bounded ints per row and no payload.
 *
 * Both representations are generated from `FINDINGS_TO_REVIEW_OUTCOME_PATHS`
 * below, so the part most likely to drift — WHICH outcome arrays count — has
 * a single definition. `runFindings.test.ts` pins both ends: a parity test
 * against the detail DTO's own numbers, and a compiled-SQL test asserting one
 * array-length term per path and no denied/executed term.
 */

import { sql, type SQL } from 'drizzle-orm';
import type { AnyColumn } from 'drizzle-orm';
import { AI_AGENT_RUN_SUMMARY_EXCERPT_MAX_CHARS } from '@breeze/shared';

/**
 * The `ai_agent_runs.outcome` json paths whose ARRAY LENGTHS make up
 * `findingsToReview`, innermost key last.
 *
 * `sweepFindings.findings` mirrors `projectSweep` (sweepFindings.ts), which
 * returns `null` — hence zero findings on the detail DTO — when the outcome
 * carries no `sweepFindings` object at all, and treats a non-array `findings`
 * as empty. `proposedActions` is 1:1 with the detail DTO's `proposed` trace
 * entries (`buildTraceEntries` maps every element, filtering none).
 *
 * `deniedActions` and `executedActions` are absent ON PURPOSE — see the file
 * header. Adding a path here changes BOTH the list SQL and the detail count
 * in one edit, which is the point.
 */
export const FINDINGS_TO_REVIEW_OUTCOME_PATHS: readonly (readonly string[])[] = [
  ['sweepFindings', 'findings'],
  ['proposedActions'],
] as const;

/** Guards the `sql.raw` splice below — every key is a module constant, and
 *  this asserts none can ever become something that needs quoting. */
const JSON_KEY_PATTERN = /^[A-Za-z][A-Za-z0-9]*$/;

/**
 * Detail-side derivation: count the configured arrays on an already-loaded
 * `ai_agent_runs.outcome` object.
 *
 * Defensive by design — `outcome` is a jsonb column with no compile-time
 * shape, and a maximally-corrupt row (a `findings` that is a string, a
 * `sweepFindings` that is a number) must project a number rather than throw
 * inside a read route. Anything that is not an array contributes 0, which is
 * exactly what `projectSweep`/`buildTraceEntries` already do on the same
 * data.
 */
export function countFindingsToReview(outcome: Record<string, unknown> | null | undefined): number {
  if (!outcome || typeof outcome !== 'object') return 0;
  let total = 0;
  for (const path of FINDINGS_TO_REVIEW_OUTCOME_PATHS) {
    let node: unknown = outcome;
    for (const key of path) {
      node = node && typeof node === 'object' ? (node as Record<string, unknown>)[key] : undefined;
    }
    if (Array.isArray(node)) total += node.length;
  }
  return total;
}

/**
 * List-side derivation: the same rule as a scalar SQL expression over an
 * `ai_agent_runs.outcome` jsonb column, for callers that must not select the
 * column itself (`GET /ai/agents/runs`, and `loadLastRuns`'s `DISTINCT ON`
 * probe behind `GET /ai/agents`).
 *
 * Each path becomes `case when jsonb_typeof(<path>) = 'array' then
 * jsonb_array_length(<path>) else 0 end` — the SQL spelling of
 * `Array.isArray(x) ? x.length : 0`, so a missing key, a null, or a corrupt
 * non-array value contributes 0 exactly as it does above instead of raising
 * `cannot get array length of a non-array`.
 *
 * The json keys are spliced with `sql.raw` (pattern-asserted module
 * constants, never caller input) rather than bound as parameters: `jsonb ->
 * $1` with an untyped parameter is ambiguous between the `-> integer` and
 * `-> text` operators, and this matches how `GET /runs` already reads
 * `outcome->>'runVerdict'` inline.
 */
export function findingsToReviewSql(outcomeColumn: AnyColumn | SQL): SQL<number> {
  const terms = FINDINGS_TO_REVIEW_OUTCOME_PATHS.map((path) => {
    const accessors = path.map((key) => {
      if (!JSON_KEY_PATTERN.test(key)) {
        throw new Error(`findingsToReviewSql: unsafe json key ${JSON.stringify(key)}`);
      }
      return `->'${key}'`;
    }).join('');
    const ref = sql`${outcomeColumn}${sql.raw(accessors)}`;
    return sql`(case when jsonb_typeof(${ref}) = 'array' then jsonb_array_length(${ref}) else 0 end)`;
  });
  return sql<number>`(${sql.join(terms, sql` + `)})`;
}

/**
 * Markdown constructs stripped before the first sentence is picked. Applied
 * in this order so a stripped construct cannot leave a stray marker behind
 * (`**Done.**` must not excerpt as `**Done.`).
 *
 * Emphasis markers only — plus inline code, strikethrough, and link syntax:
 * a raw `](https://…)` inside a 160-character list cell is worse than no
 * excerpt at all, so the link TEXT survives and the url does not. Nothing
 * here is a security control; `summary` is already display-safe narrative
 * text (never a tool payload — see `AiAgentRunDetailDto.summary`), this is a
 * legibility pass.
 */
function stripMarkdown(text: string): string {
  return text
    // Block markers, per line: heading, blockquote, unordered bullet.
    .replace(/^[ \t]{0,3}#{1,6}[ \t]+/gm, '')
    .replace(/^[ \t]*>[ \t]?/gm, '')
    .replace(/^[ \t]*[-*+][ \t]+/gm, '')
    // [text](url) -> text
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/~~(.+?)~~/g, '$1')
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/__(.+?)__/g, '$1')
    .replace(/\*(.+?)\*/g, '$1')
    // Underscore emphasis only when the markers are NOT inside a word —
    // `disk_free_percent` is an identifier, not italics.
    .replace(/(^|[^\w])_(.+?)_(?![\w])/g, '$1$2')
    .replace(/`+/g, '');
}

/**
 * Tokens whose trailing `.` is not a sentence end. Not exhaustive and not
 * meant to be — it covers what actually shows up in run summaries so an
 * excerpt does not read "Several hosts, e.g." and stop.
 */
const NON_TERMINAL_ABBREVIATIONS: ReadonlySet<string> = new Set([
  'e.g.', 'i.e.', 'etc.', 'vs.', 'approx.', 'no.', 'incl.', 'est.',
  'dr.', 'mr.', 'mrs.', 'ms.', 'st.', 'inc.', 'ltd.', 'fig.',
]);

/** First `.`/`!`/`?` followed by whitespace or end-of-text, skipping the
 *  abbreviations above and single-letter initials. Whole text when none. */
function firstSentence(text: string): string {
  const terminator = /[.!?](?=\s|$)/g;
  let match: RegExpExecArray | null = terminator.exec(text);
  while (match !== null) {
    const head = text.slice(0, match.index + 1);
    const lastToken = (/(\S+)$/.exec(head)?.[1] ?? '').toLowerCase();
    const isInitial = /(?:^|\s)[A-Za-z]\.$/.test(head);
    if (!NON_TERMINAL_ABBREVIATIONS.has(lastToken) && !isInitial) return head;
    match = terminator.exec(text);
  }
  return text;
}

/**
 * Cap INCLUDING the ellipsis, so the returned string is never longer than
 * `AI_AGENT_RUN_SUMMARY_EXCERPT_MAX_CHARS`. Breaks on a word boundary when
 * one exists in the back half of the budget — otherwise (one unbroken token)
 * it hard-cuts, which is still better than shipping 400 characters to a list
 * cell.
 */
function truncateWithEllipsis(text: string, max: number): string {
  if (text.length <= max) return text;
  let head = text.slice(0, max - 1);
  // `slice` counts UTF-16 code units, so a cut can land between the halves
  // of a surrogate pair (any astral emoji) and leave a lone high surrogate
  // that serialises as U+FFFD. Step back one unit when that happens.
  if (/[\uD800-\uDBFF]$/.test(head)) head = head.slice(0, -1);
  const lastSpace = head.lastIndexOf(' ');
  const body = lastSpace > max / 2 ? head.slice(0, lastSpace) : head;
  return `${body.trimEnd()}…`;
}

/**
 * `AiAgentRunListItemDto.summaryExcerpt` — the first sentence of a run's
 * `summary`, markdown stripped, whitespace collapsed, capped.
 *
 * `null` (not `''`) for a run with no summary yet, or one whose summary is
 * whitespace-only: the list renders a placeholder for "nothing to say yet",
 * and an empty string would be an ambiguous stand-in for that.
 */
export function summaryExcerpt(summary: string | null | undefined): string | null {
  if (typeof summary !== 'string') return null;
  const plain = stripMarkdown(summary).replace(/\s+/g, ' ').trim();
  if (plain.length === 0) return null;
  return truncateWithEllipsis(firstSentence(plain), AI_AGENT_RUN_SUMMARY_EXCERPT_MAX_CHARS);
}
