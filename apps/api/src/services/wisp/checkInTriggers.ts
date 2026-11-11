/**
 * Wisp event check-ins W04 (#11493, #10410 wave A; spec
 * 2026-11-06-wisp-chat-grant-followups §6.2 A) — the trigger predicates.
 *
 * An event check-in fires on a STATE, not on trust in a single event: the bus
 * event, the 5-minute tick and the scheduling call each re-read the subject
 * and ask whether the state it waits for holds now.
 *
 *   device_online     devices.status = 'online'
 *   script_finished   script_executions.status is terminal
 *   command_finished  device_commands.status is terminal (no bus event: the
 *                     tick is its only fast path)
 *   run_settled       ai_agent_runs.status is settled
 *
 * The subject must also sit inside the grant's LIVE ceiling (its org and
 * site), at scheduling and again at fire time: a subject deleted, or moved
 * outside the ceiling, is `gone`, and the row is cancelled with that reason
 * rather than fired on stale data (plan Review Focus 4).
 *
 * Every read is a system read (`runOutsideDbContext(withSystemDbAccessContext)`)
 * by id; the ceiling check is what scopes it. Subject output (a script's
 * stdout) is device-written text: it is sanitised and capped before it goes
 * anywhere (`CheckInEvidence.outputHead`).
 */
import { eq } from 'drizzle-orm';
import {
  WISP_CHECK_IN_PENDING_STATE_LINES,
  type WispCheckInTriggerEvent,
  type WispCheckInTriggerKind,
} from '@breeze/shared';
import { db, runOutsideDbContext, withSystemDbAccessContext } from '../../db';
import { aiAgentRuns } from '../../db/schema/aiAgents';
import { deviceCommands, devices } from '../../db/schema/devices';
import { organizations } from '../../db/schema/orgs';
import { scriptExecutions } from '../../db/schema/scripts';
import type { WispCheckInRow } from '../../db/schema/wispCheckIns';
import { sanitizeUntrustedToolText } from '../aiInputSanitizer';
import { assertWithinCeiling, CeilingViolationError, type GrantCeiling } from './grantAuthority';

/** `ai_agent_runs.status` values after which a run does no more work on its own. */
export const AI_AGENT_RUN_SETTLED_STATUSES = ['completed', 'awaiting_approval', 'failed', 'cancelled', 'expired', 'skipped', 'blocked'] as const;
/** Terminal `script_executions.status` values (db/schema/scripts.ts executionStatusEnum). */
export const SCRIPT_FINISHED_STATUSES = ['completed', 'failed', 'timeout', 'cancelled'] as const;
/** Terminal `device_commands.status` values (commandQueue.ts waitForCommandResult). */
export const COMMAND_FINISHED_STATUSES = ['completed', 'failed', 'cancelled'] as const;
/** Code points of script output carried as evidence. */
export const CHECK_IN_EVIDENCE_OUTPUT_MAX = 2048;
/** Raw characters read before sanitising (bounds the work on a large stdout). */
const OUTPUT_READ_MAX = CHECK_IN_EVIDENCE_OUTPUT_MAX * 4;

/**
 * The permission a person needs to see each subject's state. Checked at
 * scheduling against the live ceiling (the Wisp entity-ref rule: see
 * entityRefs.ts ENTITY_READ_PERMISSION).
 */
export const TRIGGER_SUBJECT_PERMISSION: Readonly<Record<WispCheckInTriggerEvent, `${string}:read`>> = Object.freeze({
  device_online: 'devices:read',
  script_finished: 'scripts:read',
  command_finished: 'devices:read',
  run_settled: 'ai_agents:read',
});

/**
 * What the predicate saw when it held. Bounded and, for output, sanitised, so
 * it is safe to pass on as untrusted background: a run check-in (W07,
 * checkInRuns.ts) carries it into its assessment run's `check_in` reason,
 * where the prompt fences it.
 */
export type CheckInEvidence = {
  kind: WispCheckInTriggerEvent;
  status: string;
  /** ISO: when the state was reached (finished / last seen), or the evaluation time when unknown. */
  at: string;
  exitCode?: number | null;
  /** The first CHECK_IN_EVIDENCE_OUTPUT_MAX code points of the script's output, sanitised. */
  outputHead?: string;
  lastSeenAt?: string | null;
};

export type TriggerGoneReason = 'subject_deleted' | 'outside_ceiling';

export type TriggerState =
  | { state: 'met'; evidence: CheckInEvidence }
  | { state: 'pending'; stateLine: string }
  | { state: 'gone'; reason: TriggerGoneReason };

/** The subject of one event, as the predicate and the ceiling check need it. */
export type TriggerSubject = {
  kind: WispCheckInTriggerEvent;
  orgId: string;
  /** The org's partner: a subject of another partner reads as deleted, never as "outside" (no existence oracle). */
  partnerId: string | null;
  /** The site the ceiling's site term is checked against (the device's); null when unknown. */
  siteId: string | null;
  status: string;
  /** When the state was reached (finished_at / completed_at / last_seen_at). */
  at: Date | null;
  exitCode: number | null;
  output: string | null;
  lastSeenAt: Date | null;
};

function sys<T>(fn: () => Promise<T>, label: string): Promise<T> {
  return runOutsideDbContext(() => withSystemDbAccessContext(fn, label));
}

export function isTriggerEvent(kind: WispCheckInTriggerKind): kind is WispCheckInTriggerEvent {
  return kind !== 'time';
}

function exitCodeOf(result: unknown): number | null {
  if (!result || typeof result !== 'object') return null;
  const code = (result as { exitCode?: unknown }).exitCode;
  return typeof code === 'number' && Number.isInteger(code) ? code : null;
}

/** One read by id, system scope. null = no such subject. */
export async function loadTriggerSubject(kind: WispCheckInTriggerEvent, subjectId: string): Promise<TriggerSubject | null> {
  return sys(async () => {
    switch (kind) {
      case 'device_online': {
        const [d] = await db
          .select({ orgId: devices.orgId, partnerId: organizations.partnerId, siteId: devices.siteId, status: devices.status, lastSeenAt: devices.lastSeenAt })
          .from(devices)
          .innerJoin(organizations, eq(organizations.id, devices.orgId))
          .where(eq(devices.id, subjectId))
          .limit(1);
        if (!d) return null;
        return { kind, orgId: d.orgId, partnerId: d.partnerId, siteId: d.siteId, status: d.status, at: d.lastSeenAt, exitCode: null, output: null, lastSeenAt: d.lastSeenAt };
      }
      case 'script_finished': {
        const [s] = await db
          .select({
            orgId: scriptExecutions.orgId,
            partnerId: organizations.partnerId,
            siteId: devices.siteId,
            status: scriptExecutions.status,
            completedAt: scriptExecutions.completedAt,
            exitCode: scriptExecutions.exitCode,
            stdout: scriptExecutions.stdout,
            stderr: scriptExecutions.stderr,
          })
          .from(scriptExecutions)
          .innerJoin(organizations, eq(organizations.id, scriptExecutions.orgId))
          .leftJoin(devices, eq(devices.id, scriptExecutions.deviceId))
          .where(eq(scriptExecutions.id, subjectId))
          .limit(1);
        if (!s) return null;
        // stdout first; a script that wrote only to stderr still shows what it said.
        const output = s.stdout && s.stdout.trim() !== '' ? s.stdout : s.stderr;
        return {
          kind, orgId: s.orgId, partnerId: s.partnerId, siteId: s.siteId ?? null, status: s.status, at: s.completedAt,
          exitCode: s.exitCode, output: output ? output.slice(0, OUTPUT_READ_MAX) : null, lastSeenAt: null,
        };
      }
      case 'command_finished': {
        const [c] = await db
          .select({
            orgId: devices.orgId,
            partnerId: organizations.partnerId,
            siteId: devices.siteId,
            status: deviceCommands.status,
            completedAt: deviceCommands.completedAt,
            result: deviceCommands.result,
          })
          .from(deviceCommands)
          .innerJoin(devices, eq(devices.id, deviceCommands.deviceId))
          .innerJoin(organizations, eq(organizations.id, devices.orgId))
          .where(eq(deviceCommands.id, subjectId))
          .limit(1);
        if (!c) return null;
        return { kind, orgId: c.orgId, partnerId: c.partnerId, siteId: c.siteId, status: c.status, at: c.completedAt, exitCode: exitCodeOf(c.result), output: null, lastSeenAt: null };
      }
      case 'run_settled': {
        const [r] = await db
          .select({ orgId: aiAgentRuns.orgId, partnerId: organizations.partnerId, siteId: devices.siteId, status: aiAgentRuns.status, finishedAt: aiAgentRuns.finishedAt })
          .from(aiAgentRuns)
          .innerJoin(organizations, eq(organizations.id, aiAgentRuns.orgId))
          .leftJoin(devices, eq(devices.id, aiAgentRuns.deviceId))
          .where(eq(aiAgentRuns.id, subjectId))
          .limit(1);
        if (!r) return null;
        return { kind, orgId: r.orgId, partnerId: r.partnerId, siteId: r.siteId ?? null, status: r.status, at: r.finishedAt, exitCode: null, output: null, lastSeenAt: null };
      }
    }
  }, `wisp-check-in-trigger-subject-${kind}`);
}

/** The subject's org, or null when there is no such subject. */
export async function subjectOrgId(kind: WispCheckInTriggerEvent, subjectId: string): Promise<string | null> {
  return (await loadTriggerSubject(kind, subjectId))?.orgId ?? null;
}

/**
 * Whether the subject is inside the ceiling: its partner, then its org, its
 * site and the kind's read permission. null when inside. Scheduling and the
 * fire-time re-check apply the same rule, so a grant revised to drop the
 * permission cancels a pending check-in instead of delivering its evidence.
 */
export function triggerSubjectScope(subject: TriggerSubject | null, ceiling: GrantCeiling): TriggerGoneReason | null {
  if (!subject || subject.partnerId !== ceiling.partnerId) return 'subject_deleted';
  try {
    assertWithinCeiling(ceiling, {
      orgId: subject.orgId,
      siteId: subject.siteId,
      permission: TRIGGER_SUBJECT_PERMISSION[subject.kind],
    });
  } catch (err) {
    if (err instanceof CeilingViolationError) return 'outside_ceiling';
    throw err;
  }
  return null;
}

function capCodePoints(text: string, max: number): string {
  const chars = Array.from(text);
  return chars.length <= max ? text : `${chars.slice(0, Math.max(0, max - 1)).join('')}…`;
}

const isOneOf = <T extends string>(set: readonly T[], value: string): boolean => (set as readonly string[]).includes(value);

/** Does the state the check-in waits for hold? Pure: the subject alone decides. */
export function triggerConditionOf(
  subject: TriggerSubject,
  now: Date,
): { met: true; evidence: CheckInEvidence } | { met: false; stateLine: string } {
  const met =
    subject.kind === 'device_online' ? subject.status === 'online'
      : subject.kind === 'script_finished' ? isOneOf(SCRIPT_FINISHED_STATUSES, subject.status)
        : subject.kind === 'command_finished' ? isOneOf(COMMAND_FINISHED_STATUSES, subject.status)
          : isOneOf(AI_AGENT_RUN_SETTLED_STATUSES, subject.status);
  if (!met) return { met: false, stateLine: WISP_CHECK_IN_PENDING_STATE_LINES[subject.kind] };

  const evidence: CheckInEvidence = { kind: subject.kind, status: subject.status, at: (subject.at ?? now).toISOString() };
  if (subject.kind === 'device_online') evidence.lastSeenAt = subject.lastSeenAt?.toISOString() ?? null;
  if (subject.kind === 'script_finished' || subject.kind === 'command_finished') evidence.exitCode = subject.exitCode;
  if (subject.kind === 'script_finished' && subject.output) {
    const clean = sanitizeUntrustedToolText(subject.output).trim();
    if (clean !== '') evidence.outputHead = capCodePoints(clean, CHECK_IN_EVIDENCE_OUTPUT_MAX);
  }
  return { met: true, evidence };
}

/** Scope first (a gone subject never reports a state), then the predicate. */
export function triggerStateOf(subject: TriggerSubject | null, ceiling: GrantCeiling, now: Date): TriggerState {
  const gone = triggerSubjectScope(subject, ceiling);
  if (gone) return { state: 'gone', reason: gone };
  const condition = triggerConditionOf(subject!, now);
  return condition.met ? { state: 'met', evidence: condition.evidence } : { state: 'pending', stateLine: condition.stateLine };
}

/** The live state of an event row's trigger under `ceiling`. A `time` row has no trigger. */
export async function evaluateCheckInTrigger(
  row: Pick<WispCheckInRow, 'id' | 'triggerKind' | 'triggerSubjectId'>,
  ceiling: GrantCeiling,
  now: Date = new Date(),
): Promise<TriggerState> {
  if (!isTriggerEvent(row.triggerKind) || row.triggerSubjectId === null) {
    throw new Error(`evaluateCheckInTrigger: check-in ${row.id} is not an event check-in`);
  }
  return triggerStateOf(await loadTriggerSubject(row.triggerKind, row.triggerSubjectId), ceiling, now);
}
