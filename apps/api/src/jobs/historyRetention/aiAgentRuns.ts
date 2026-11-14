/**
 * ai_agent_runs retention target (#4342 W5). REPORT-ONLY until
 * AI_AGENT_RUN_RETENTION_ENFORCE=true.
 *
 * A finished run (terminal status, `finished_at` past the window) is deleted
 * unless something still points at it that must not lose it:
 *
 *  - `action_intents` (RESTRICT, on `(requesting_agent_run_id, org_id)`).
 *    Intents are audit-grade and never aged out, so a run an intent names is
 *    kept indefinitely (plan correction 12, OD 5 in the plan).
 *  - `ticket_drafts` (RESTRICT, on `(run_id, org_id)`).
 *  - `ai_run_artifacts` / `ai_run_workspaces` (CASCADE). Both are blob-backed
 *    and have their own sweepers (`aiArtifactSweeper`, `workspaceReaper`);
 *    deleting the run here would drop the rows those sweepers use to remove
 *    the blobs. The run becomes eligible once they are gone.
 *
 * On delete, `ai_agent_fix_watches`, `ai_unattended_exposure` and
 * `ai_alert_verdicts` cascade; op evidence, operator tasks and operations,
 * ticket comments, remediation suggestions and device function assessments
 * keep their row with the run link set to NULL. FK-less provenance ids (for
 * example `action_intents.ai_origin_agent_run_id`, `ai_invocations.agent_run_id`)
 * are documented as tolerating a deleted run.
 *
 * `finished_at` is timestamptz, so it compares against `::timestamptz`.
 * `ai_agent_runs_finished_idx` (W5 migration) serves the age scan.
 */

import { sql } from 'drizzle-orm';

import { resolveRetentionDays, retentionEnforceFromEnv } from '../retentionBatch';
import type { RetentionTarget } from '../retentionTarget';
import { historyKnobs, LOG_PREFIX, type HistoryRetentionEntry } from './shared';

const MAX_DAYS = 1095;
const RETENTION_DAYS = resolveRetentionDays(process.env.AI_AGENT_RUN_RETENTION_DAYS, 400, MAX_DAYS, LOG_PREFIX);
const ENFORCE = retentionEnforceFromEnv(LOG_PREFIX, 'AI_AGENT_RUN_RETENTION_ENFORCE', false);

/** Terminal `AI_AGENT_RUN_STATUSES`; `queued`, `running`, `awaiting_approval` never age out. */
export const AI_AGENT_RUN_TERMINAL_STATUSES = ['completed', 'failed', 'cancelled', 'expired', 'skipped', 'blocked'] as const;

export const AI_AGENT_RUN_RETENTION_TARGET: RetentionTarget = {
  metricName: 'ai_agent_run_retention',
  table: 'ai_agent_runs',
  action: { kind: 'delete' },
  // The outer table is referenced by its bare name (retentionBatch selects FROM
  // it unaliased). Each guard correlates on the child's composite FK columns,
  // which its (org_id, run_id) index serves.
  where: (cutoffIso) => sql`status IN ('completed', 'failed', 'cancelled', 'expired', 'skipped', 'blocked')
    AND finished_at < ${cutoffIso}::timestamptz
    AND NOT EXISTS (SELECT 1 FROM action_intents i
      WHERE i.requesting_agent_run_id = ai_agent_runs.id AND i.org_id = ai_agent_runs.org_id)
    AND NOT EXISTS (SELECT 1 FROM ticket_drafts d
      WHERE d.run_id = ai_agent_runs.id AND d.org_id = ai_agent_runs.org_id)
    AND NOT EXISTS (SELECT 1 FROM ai_run_artifacts ra
      WHERE ra.run_id = ai_agent_runs.id AND ra.org_id = ai_agent_runs.org_id)
    AND NOT EXISTS (SELECT 1 FROM ai_run_workspaces rw
      WHERE rw.run_id = ai_agent_runs.id AND rw.org_id = ai_agent_runs.org_id)`,
};

export const AI_AGENT_RUN_TARGETS: ReadonlyArray<HistoryRetentionEntry> = [
  {
    target: AI_AGENT_RUN_RETENTION_TARGET,
    knobs: historyKnobs(RETENTION_DAYS, ENFORCE),
    enforceVar: 'AI_AGENT_RUN_RETENTION_ENFORCE',
    maxRetentionDays: MAX_DAYS,
  },
];
