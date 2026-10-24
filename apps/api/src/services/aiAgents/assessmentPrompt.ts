/**
 * Wisp W05b Task 6 — the task turn of an `assessment`-profile run (Wisp
 * design §7.2–7.4; W05 plan Task 6 + the 2026-10-23 amendments).
 *
 * Its own file because `runnerPrompt.ts` is already ~2k lines; re-exported
 * from there, and `buildAgentRunTaskPrompt` dispatches here for
 * `profile: 'assessment'`.
 *
 * Everything the assessment reads about the org — the thread summary, the
 * concerns, the changes digest, readiness, the person's nudge feedback — is
 * tenant- or model-authored text, so each goes inside its own
 * `wrapUntrustedData` fence (fence markers neutralised, size capped) AND each
 * free-text field is single-lined first. Nothing here moves authority: the
 * five outcome tools only RECORD; `finalizeAssessment` re-checks every id
 * against the grant ceiling and the run's org after the run.
 *
 * Runtime imports from `./runnerPrompt` (the authority disclaimer and the
 * single-line sanitizer) form a cycle with that module's re-export. It is
 * safe: both sides read each other's bindings only inside function bodies,
 * never at module evaluation.
 */
import type { Concern } from '@breeze/shared';
import { UNTRUSTED_TOOL_OUTPUT_RULE } from '../aiAgentSystemPrompt';
import { wrapUntrustedData } from '../aiInputSanitizer';
import type { AssessmentDigest, AssessmentReason, OrgReadiness } from '../wisp/assessmentTypes';
import { AGENT_PROMPT_AUTHORITY_DISCLAIMER, sanitizeSweepText, type AgentRunPromptContext } from './runnerPrompt';

/**
 * The prompt-side projection of `RunContext.assessment` (runLoop.ts's
 * `assessmentPromptContext`). `watchLines` is precomputed there with
 * `watchPromptLines` so this module stays free of the DB-bound watches module.
 */
export interface AgentRunAssessmentPromptContext {
  reason: AssessmentReason;
  threadSummary: string;
  openConcerns: Concern[];
  changedSince: string | null;
  digest: AssessmentDigest;
  /** `watchPromptLines(watch)` when the run was requested by a watch that still exists; null otherwise. */
  watchLines: string[] | null;
  readiness: OrgReadiness | null;
  nudgeFeedback: string[];
}

export const ASSESSMENT_NO_CHANGES_LINE = 'No changes since the last assessment.';

const SUMMARY_MAX = 300;
const TITLE_MAX = 160;

function reasonLine(reason: AssessmentReason): string {
  switch (reason.kind) {
    case 'event':
      return `event ${sanitizeSweepText(reason.eventType, 64)} (${sanitizeSweepText(reason.eventId, 64)})`;
    case 'watch':
      return `watch ${sanitizeSweepText(reason.watchId, 64)}`;
    case 'onboarding':
      return 'onboarding (first look at this org under the grant)';
    case 'tick':
      return 'periodic check';
    default: {
      const exhaustive: never = reason;
      return `unknown (${String((exhaustive as { kind?: unknown }).kind)})`;
    }
  }
}

function concernLine(c: Concern): string {
  const r = c.recipient;
  const recipient = r
    ? [
        `nudgeCount=${r.nudgeCount}`,
        `nextEligibleNudgeAt=${r.nextEligibleNudgeAt ?? 'null'}`,
        ...(r.digestOnly ? ['digest-only'] : []),
        ...(r.snoozedUntil ? [`snoozedUntil=${r.snoozedUntil}`] : []),
        ...(r.dismissedAt ? ['dismissed'] : []),
      ].join(', ')
    : 'nudgeCount=0, nextEligibleNudgeAt=null';
  return [
    c.id,
    c.severity,
    `${c.subject.kind}:${c.subject.id}`,
    sanitizeSweepText(c.summary, SUMMARY_MAX) || '(no summary)',
    recipient,
  ].join(' | ');
}

function digestLines(d: AssessmentDigest): string[] {
  const t = (value: string | null | undefined, max = TITLE_MAX) => sanitizeSweepText(value ?? '', max);
  return [
    ...d.alerts.map((a) => `alert ${a.id} | ${t(a.severity, 16)} | ${t(a.status, 32)} | ${t(a.title) || 'untitled'} | ${a.at}`),
    ...d.tickets.map((k) => `ticket ${t(k.number, 32) || k.id} | ${t(k.status, 32)} | ${t(k.title) || 'untitled'} | ${k.updatedAt}`),
    ...d.incidents.map((i) => `incident ${i.id} | ${t(i.sourceKind, 48)} | ${t(i.condition)} | ${i.openedAt}`),
    ...d.runs.map((r) => `run ${r.id} | ${t(r.profile, 32)} | ${t(r.status, 32)} | ${t(r.summary) || '(no summary)'}`),
    ...d.intents.map((x) => `approval ${x.id} | ${t(x.toolName, 64)} | ${t(x.status, 32)}`),
  ];
}

function readinessLines(r: OrgReadiness): string[] {
  const lines = r.checks.map((c) => (c.serviceable
    ? `${c.watchKind}: can watch`
    : `${c.watchKind}: cannot watch${c.reason ? ` (${sanitizeSweepText(c.reason, 160)})` : ''}`));
  if (r.missingIntegrations.length > 0) {
    lines.push(`missing integrations: ${r.missingIntegrations.map((m) => sanitizeSweepText(m, 64)).join(', ')}`);
  }
  return lines;
}

export function buildAssessmentTaskPrompt(ctx: AgentRunPromptContext): string {
  const a = ctx.assessment ?? null;
  const lines: string[] = [];

  // (1) Mode + the five outcomes.
  lines.push('## Mode: assessment');
  lines.push(
    'You are Wisp, assessing ONE organization for the person who granted you access. Decide which outcome '
    + 'fits what changed: stay quiet | update a concern | nudge | propose an action | request a specialist — '
    + 'call the matching tool; call nothing when nothing changed.',
  );
  lines.push('- New problem worth tracking → record_concern (one subject per call, at most 10 per run).');
  lines.push('- Known concern changed or is fixed → update_concern (resolve it with an outcome when it is fixed).');
  lines.push('- The person should act now → nudge (one concern, one next step).');
  lines.push('- A Tier-2/3 change would help → propose_action (it becomes an approval request; nothing runs).');
  lines.push('- Needs a specialist → request_specialist (not available yet: recorded and refused).');
  lines.push(`Why this assessment: ${a ? reasonLine(a.reason) : 'unknown'}.`);
  lines.push('');

  // (2) Authority disclaimer.
  lines.push(AGENT_PROMPT_AUTHORITY_DISCLAIMER);
  lines.push('');

  // (3) Thread summary.
  lines.push(wrapUntrustedData('wisp-thread-summary', a?.threadSummary.trim() || '(no summary yet)'));
  lines.push('');

  // (4) Open concerns, one line each.
  const concerns = a?.openConcerns ?? [];
  lines.push('Open concerns (id | severity | subject | summary | recipient):');
  lines.push(wrapUntrustedData(
    'wisp-open-concerns',
    concerns.length > 0 ? concerns.map(concernLine).join('\n') : 'No open concerns.',
  ));
  lines.push('');

  // (5) What changed since the watermark.
  const changes = a ? digestLines(a.digest) : [];
  lines.push(`What changed since ${a?.changedSince ?? 'the last assessment'}:`);
  lines.push(wrapUntrustedData(
    'wisp-changes-since-watermark',
    changes.length > 0 ? changes.join('\n') : ASSESSMENT_NO_CHANGES_LINE,
  ));

  // Amendments (w00 A33/A34): readiness, then the person's nudge feedback.
  if (a?.readiness) {
    lines.push('');
    lines.push('What Wisp can and cannot watch for this org:');
    lines.push(wrapUntrustedData('wisp-readiness', readinessLines(a.readiness).join('\n') || 'No checks.'));
  }
  if (a && a.nudgeFeedback.length > 0) {
    lines.push('');
    lines.push('The person has marked these past nudges useful or not useful; weigh that before you nudge.');
    lines.push(wrapUntrustedData(
      'wisp-nudge-feedback',
      a.nudgeFeedback.map((f) => sanitizeSweepText(f, 300)).join('\n'),
    ));
  }

  // (6) The requesting watch.
  if (a?.watchLines && a.watchLines.length > 0) {
    lines.push('');
    lines.push('## Watch that requested this assessment');
    lines.push(...a.watchLines);
  }

  // (7) Tool-output rule.
  lines.push('');
  lines.push(UNTRUSTED_TOOL_OUTPUT_RULE);

  // (8) Closing rule.
  lines.push('');
  lines.push(
    'Nudge only when `recipient.nextEligibleNudgeAt` is null or in the past; never nudge a concern marked '
    + 'digest-only; one nudge names one person, one subject, one next step.',
  );

  return lines.join('\n');
}
