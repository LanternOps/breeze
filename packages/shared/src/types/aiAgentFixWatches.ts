/**
 * Wave 6.2a (#3828) — "did the fix hold" DTOs.
 *
 * Same safe-projection contract as the wave 6.1 run-trace DTOs: every field is
 * enumerated by hand, and no variant carries a field that could hold a raw
 * tool input/output. The stored `target` jsonb is deliberately NOT projected
 * here — `targetName` (a short, sanitized summary) is what the UI shows.
 */

export const AI_AGENT_FIX_WATCH_DTO_SCHEMA_VERSION = 1 as const;

/**
 * `alert_recurrence` — did an alert of the same identity re-trigger on this
 * device after the remediation finished? A pure DB read, so it resolves even
 * while the device is offline, and it is the only lane that says anything
 * about `run_script` or `execute_playbook`.
 *
 * `postcondition` — re-runs the op's own verify read-back. `service_running`
 * is the only kind watched today.
 */
export type AiAgentFixWatchKindDto = 'alert_recurrence' | 'postcondition';

/**
 * `inconclusive` is NOT a soft regression — it means the check itself did not
 * resolve (an offline device, an unparseable read-back). It never counts
 * against an agent.
 */
export type AiAgentFixWatchStatusDto =
  | 'pending'
  | 'checking'
  | 'held'
  | 'regressed'
  | 'inconclusive'
  | 'cancelled';

export interface AiAgentFixWatchDto {
  schemaVersion: typeof AI_AGENT_FIX_WATCH_DTO_SCHEMA_VERSION;
  id: string;
  runId: string;
  watchKind: AiAgentFixWatchKindDto;
  status: AiAgentFixWatchStatusDto;
  /** Manifest op key of the remediation being watched. */
  opKey: string;
  /** Short, sanitized identity of what was remediated — never a raw input. */
  targetName: string;
  /** When the remediation finished; the start of the recurrence window. */
  baselineAt: string;
  dueAt: string;
  checkedAt: string | null;
  attempts: number;
  /** Short, human-readable outcome note — never a raw tool input/output. */
  detail: string | null;
}

export interface AiAgentFixWatchListDto {
  schemaVersion: typeof AI_AGENT_FIX_WATCH_DTO_SCHEMA_VERSION;
  data: AiAgentFixWatchDto[];
}
