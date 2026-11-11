/**
 * Wisp W05b Task 6 — the task turn of an `assessment`-profile run (Wisp
 * design §7.2–7.4; W05 plan Task 6 + the 2026-10-23 amendments).
 *
 * Its own file because `runnerPrompt.ts` is already ~2k lines; re-exported
 * from there, and `buildAgentRunTaskPrompt` dispatches here for
 * `profile: 'assessment'`.
 *
 * Everything the assessment reads about the org — the thread summary, the
 * concerns, the changes digest, the metric anomalies, readiness, the person's
 * nudge feedback — is
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
import type { AssessmentDigest, AssessmentReason, OrgReadiness, WatchHitSummary } from '../wisp/assessmentTypes';
import { AGENT_PROMPT_AUTHORITY_DISCLAIMER, sanitizeSweepText, type AgentRunPromptContext } from './runnerPrompt';

/**
 * The prompt-side projection of `RunContext.assessment` (runLoop.ts's
 * `assessmentPromptContext`). `watchLines` is precomputed there with
 * `watchPromptLines` so this module stays free of the DB-bound watches module.
 */
export interface AgentRunAssessmentPromptContext {
  /**
   * The run's org (#10387): `id` is `run.orgId`, the only id an `org` subject
   * may carry; `name` is tenant-authored, so it is rendered fenced.
   */
  org: { id: string; name: string | null };
  reason: AssessmentReason;
  threadSummary: string;
  openConcerns: Concern[];
  changedSince: string | null;
  digest: AssessmentDigest;
  /** `watchPromptLines(watch)` when the run was requested by a watch that still exists; null otherwise. */
  watchLines: string[] | null;
  readiness: OrgReadiness | null;
  nudgeFeedback: string[];
  /** #10389: no earlier assessment of this org — `digest.alerts` holds its open alerts. */
  firstLook: boolean;
}

export const ASSESSMENT_NO_CHANGES_LINE = 'No changes since the last assessment.';
export const ASSESSMENT_NO_ANOMALIES_LINE = 'No open metric anomalies.';
/** #11425: the section was not read (no devices:read, or the read failed) — never "none". */
export const ASSESSMENT_ANOMALIES_NOT_READ_LINE =
  'Metric anomalies were not read for this assessment, so this list says nothing about whether any are open.';

/**
 * #11425: the model read "incident" (connection-health rows, then the
 * anomaly wake) as a security incident and called list_incidents, found
 * nothing, and raised a "can't verify" concern for every anomaly wake.
 */
const ANOMALY_TOOLS_LINE =
  '`list_incidents` covers security/IR incidents only; metric anomalies appear in the Metric anomalies section. '
  + "For a device's anomaly rows, call manage_device_anomalies with action list and that device id.";
export const ASSESSMENT_FIRST_LOOK_EMPTY_LINE =
  'No open alerts and nothing else changed recently in this digest — check the current state with your tools.';

/**
 * #10389: the first look has nothing to diff against, so the general "call
 * nothing when nothing changed" rule must not end it with zero tool calls.
 */
const FIRST_LOOK_LINE =
  'First look: there is no completed earlier assessment of this org, so judge its current state, not what changed — '
  + '"call nothing when nothing changed" does not apply. Read what is open now with your tools (the open alerts '
  + 'below, failed patches, pending reboots, backups, security findings) before you choose an outcome; stay quiet '
  + 'only once you have looked and found nothing worth tracking.';

/**
 * #10406: an on-demand assessment reads the open alerts like a first look, but
 * an earlier assessment may well exist, so it gets its own line rather than
 * FIRST_LOOK_LINE's "no completed earlier assessment".
 */
const ON_DEMAND_LINE =
  'On demand: a person asked for this assessment now, so judge the org\'s current state, not what changed — '
  + '"call nothing when nothing changed" does not apply. Work through the open alerts below and read what else is '
  + 'open with your tools (failed patches, pending reboots, backups, security findings) before you choose an '
  + 'outcome; stay quiet only once you have looked and found nothing worth tracking.';

const SUMMARY_MAX = 300;
const ORG_NAME_MAX = 200;
const TITLE_MAX = 160;

const WATCH_HIT_SUBJECT_LABEL: Record<WatchHitSummary['subject'], string> = {
  alert: 'open alert(s)',
  device: 'device(s) below the threshold',
  finding: 'open finding(s) (device vulnerabilities / EDR detections)',
};
const WATCH_HIT_CHANGE_LINE: Record<WatchHitSummary['change'], string> = {
  first: 'first evaluation of this watch',
  new: 'new: the previous evaluation found none',
  cleared: 'cleared: nothing matches any more',
  changed: 'changed since the previous evaluation (hits added, removed or changed state)',
};

/**
 * #11424: the scheduler's in-code evaluation of the requesting watch, rendered
 * under the watch lines so the run does not re-query it. Every value is an
 * enum, a count or a uuid (parseWatchHitSummary drops anything else).
 */
export function watchHitLines(hits: WatchHitSummary): string[] {
  const previous = hits.previousCount === null ? 'none recorded' : String(hits.previousCount);
  const lines = [
    'Wisp evaluated this watch in code and wakes you only when its hit-set changes; the hits below are current, so do not re-query them to find out what changed.',
    `hits: ${hits.count} ${WATCH_HIT_SUBJECT_LABEL[hits.subject]} in org ${hits.orgId} (previous evaluation: ${previous}) — ${WATCH_HIT_CHANGE_LINE[hits.change]}`,
  ];
  if (hits.ids.length > 0) {
    const more = hits.count > hits.ids.length ? ` (${hits.count - hits.ids.length} more not listed)` : '';
    // Patch devices carry no timestamp, so they come in id order.
    const order = hits.subject === 'device' ? '' : ', newest first';
    lines.push(`hit ids${order}: ${hits.ids.join(', ')}${more}`);
  }
  if (hits.partnerWide) {
    lines.push('partner-wide watch: evaluated in this org only; the previous evaluation may have covered another org.');
  }
  return lines;
}

function reasonLine(reason: AssessmentReason): string {
  switch (reason.kind) {
    case 'event': {
      // #10388: name the event's subject, never the bus event id — the model
      // took that id for an alert id and its lookup failed.
      const subject = reason.alertId
        ? ` for alert ${sanitizeSweepText(reason.alertId, 64)}`
        : reason.anomalyIncidentId
          ? ` for metric anomaly incident ${sanitizeSweepText(reason.anomalyIncidentId, 64)}`
          : '';
      const device = reason.deviceId
        ? `${subject ? ' on' : ' for'} device ${sanitizeSweepText(reason.deviceId, 64)}`
        : '';
      return `event ${sanitizeSweepText(reason.eventType, 64)}${subject}${device}`;
    }
    case 'watch':
      return `watch ${sanitizeSweepText(reason.watchId, 64)}`;
    case 'onboarding':
      return 'onboarding (first look at this org under the grant)';
    case 'tick':
      return 'periodic check';
    // The request id is traceability only: no tool can look it up (#10388).
    case 'on_demand':
      return 'on demand (a person asked Wisp for this assessment in chat)';
    // W07: the check-in id is traceability only, like the request id.
    case 'check_in':
      return 'a check-in the person scheduled in chat';
    default: {
      const exhaustive: never = reason;
      return `unknown (${String((exhaustive as { kind?: unknown }).kind)})`;
    }
  }
}

/** Code points of a check-in instruction rendered (the column's own limit). */
const CHECK_IN_INSTRUCTION_MAX = 1000;
const CHECK_IN_ANSWER_LINE =
  'Do that check first with your read tools. Then end with a short plain-text answer for the person (at most 6 '
  + 'sentences): what you checked and what you found. It is posted to their Wisp thread as your reply, so say '
  + 'plainly when you could not tell. Record a concern, nudge or proposal only if what you found calls for one.';

/**
 * W07 (#11496): the follow-up a run-mode check-in asked for. The instruction
 * was approved by the person on a card when it was scheduled, and was
 * sanitised when the run was admitted; it is single-lined again here so it
 * can never start a line of its own. The trigger's evidence (a script's
 * output head) is device text: fenced.
 */
function checkInLines(reason: Extract<AssessmentReason, { kind: 'check_in' }>): string[] {
  const lines = [`Follow-up the user asked for: ${sanitizeSweepText(reason.instruction, CHECK_IN_INSTRUCTION_MAX) || '(empty)'}`];
  const e = reason.evidence;
  if (e) {
    const head = [
      `trigger ${sanitizeSweepText(e.kind, 32)}`,
      `status ${sanitizeSweepText(e.status, 64)}`,
      `at ${sanitizeSweepText(e.at, 40)}`,
      ...(e.exitCode !== undefined ? [`exit code ${e.exitCode ?? 'unknown'}`] : []),
      ...(e.lastSeenAt !== undefined ? [`last seen ${e.lastSeenAt ? sanitizeSweepText(e.lastSeenAt, 40) : 'unknown'}`] : []),
    ].join(' | ');
    const body = e.outputHead ? `${head}\noutput (first part):\n${e.outputHead}` : head;
    lines.push('What the trigger showed when the check-in fired:');
    lines.push(wrapUntrustedData('check_in_evidence', body));
  }
  lines.push(CHECK_IN_ANSWER_LINE);
  return lines;
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
    // #11425: prefixed "integration" so a connection-health row is not read
    // as a security incident (list_incidents).
    ...d.incidents.map((i) => `integration incident ${i.id} | ${t(i.sourceKind, 48)} | ${t(i.condition)} | ${i.openedAt}`),
    ...d.runs.map((r) => `run ${r.id} | ${t(r.profile, 32)} | ${t(r.status, 32)} | ${t(r.summary) || '(no summary)'}`),
    ...d.intents.map((x) => `approval ${x.id} | ${t(x.toolName, 64)} | ${t(x.status, 32)}`),
  ];
}

/** Peak scores are unbounded magnitudes; two decimals is enough to compare them. */
function formatScore(score: number): string {
  return Number.isFinite(score) ? String(Math.round(score * 100) / 100) : 'unknown';
}

function anomalyLines(anomalies: NonNullable<AssessmentDigest['anomalies']>): string[] {
  const t = (value: string | null | undefined, max = TITLE_MAX) => sanitizeSweepText(value ?? '', max);
  return anomalies.map((x) => [
    `anomaly incident ${x.id}`,
    `${t(x.deviceName, 120) || '(unnamed device)'} (device ${x.deviceId})`,
    t(x.anomalyType, 40),
    x.metricNames.map((m) => t(m, 120)).filter(Boolean).join(', ') || '(no metric names)',
    `peak score ${formatScore(x.peakScore)}`,
    `opened ${x.openedAt}`,
    t(x.status, 20),
  ].join(' | '));
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
  // #10387: without this the model sent org-level concerns with the nil UUID
  // and the finalizer dropped them. The id is server-generated (trusted); the
  // name is tenant-authored and goes in its own fence.
  if (a) {
    lines.push(
      `Organization id: ${a.org.id}. A concern about the organization as a whole uses `
      + `subject { kind: 'org', id: '${a.org.id}' } — never another id.`,
    );
    lines.push(wrapUntrustedData('wisp-org-name', sanitizeSweepText(a.org.name ?? '', ORG_NAME_MAX) || '(no name)'));
  }
  lines.push('- New problem worth tracking → record_concern (one subject per call, at most 10 per run).');
  // #11426: the same-org rollup folds device concerns sharing a pattern into one.
  lines.push('  When the same problem recurs across devices, give each of those record_concern calls the same short '
    + 'pattern key (e.g. phantom_incident_event) so Wisp can group them.');
  lines.push("- Known concern changed or is fixed → update_concern. To close it send status: 'resolved' with an "
    + 'outcome; a summary edit alone keeps it open.');
  lines.push('- The person should act now → nudge (one concern, one next step).');
  lines.push('- A Tier-2/3 change would help → propose_action (it becomes an approval request; nothing runs).');
  lines.push('- Needs a specialist → request_specialist (recorded now; Wisp\'s coordinator handles it after this '
    + 'assessment, and kinds that ask first become an approval card; at most 3 per assessment).');
  lines.push(`Why this assessment: ${a ? reasonLine(a.reason) : 'unknown'}.`);
  if (a?.firstLook) lines.push(a.reason.kind === 'on_demand' ? ON_DEMAND_LINE : FIRST_LOOK_LINE);
  if (a?.reason.kind === 'check_in') lines.push(...checkInLines(a.reason));
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

  // (5) What changed since the watermark — on a first look, the org's open
  // alerts plus the other sections' recent window (#10389).
  const changes = a ? digestLines(a.digest) : [];
  const since = a?.changedSince ?? 'the last assessment';
  lines.push(a?.firstLook
    ? `Open alerts now (worst first, at most 25) and other changes since ${since}:`
    : `What changed since ${since}:`);
  lines.push(wrapUntrustedData(
    'wisp-changes-since-watermark',
    changes.length > 0
      ? changes.join('\n')
      : a?.firstLook ? ASSESSMENT_FIRST_LOOK_EMPTY_LINE : ASSESSMENT_NO_CHANGES_LINE,
  ));

  // Metric anomalies (#11425): current state, not a since-watermark change —
  // the org's open anomaly incidents plus the one that triggered this run.
  // Always rendered, so the pointer line never names a missing section.
  const anomalyRows = a?.digest.anomalies ?? [];
  const anomalies = anomalyLines(anomalyRows);
  lines.push('');
  lines.push(
    'Metric anomalies (open now, plus the one that triggered this assessment; '
    + 'id | device | type | metrics | peak score | opened | status):',
  );
  lines.push(ANOMALY_TOOLS_LINE);
  lines.push(wrapUntrustedData(
    'wisp-metric-anomalies',
    a && a.digest.anomalies === null
      ? ASSESSMENT_ANOMALIES_NOT_READ_LINE
      : anomalies.length > 0 ? anomalies.join('\n') : ASSESSMENT_NO_ANOMALIES_LINE,
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
    if (a.reason.kind === 'watch' && a.reason.hits) lines.push(...watchHitLines(a.reason.hits));
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
