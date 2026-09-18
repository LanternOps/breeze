/**
 * Who DECIDED a device mutation (#5022 W01).
 *
 * `ai_assistant` — a human asked, in chat or over MCP; the human stays
 *   accountable and `triggered_by` / `created_by` are unchanged.
 * `ai_agent`     — an autonomous agent run decided; no human was in the loop.
 *
 * Absent (undefined here, NULL in the database) means "AI initiation not
 * recorded" — NEVER "a human did this". Consumers must render absence as the
 * absence of a marker.
 */
export const AI_INITIATOR_KINDS = ['ai_assistant', 'ai_agent'] as const;
export type AiInitiatorKind = (typeof AI_INITIATOR_KINDS)[number];

export interface AiOriginRef {
  kind: AiInitiatorKind;
  /** ai_sessions.id — the persisted session, not an MCP transport session id. */
  sessionId?: string;
  /** ai_agent_runs.id */
  agentRunId?: string;
}

export function isAiInitiatorKind(value: unknown): value is AiInitiatorKind {
  return typeof value === 'string' && (AI_INITIATOR_KINDS as readonly string[]).includes(value);
}

/**
 * Column shape for `action_intents` (the `ai_origin_*` prefix). NOT the shape
 * used by `script_executions` / `device_commands`, which use
 * `aiOriginColumns()` in `services/commandQueue.ts` to produce
 * `{ aiInitiatorKind, aiSessionId, aiAgentRunId }`. Same `AiOriginRef` in,
 * different column names out — see the hub plan's cross-wave rule 10.
 */
export function serializeAiOrigin(origin: AiOriginRef | undefined): {
  aiOriginKind: AiInitiatorKind | null;
  aiOriginSessionId: string | null;
  aiOriginAgentRunId: string | null;
} {
  return {
    aiOriginKind: origin?.kind ?? null,
    aiOriginSessionId: origin?.sessionId ?? null,
    aiOriginAgentRunId: origin?.agentRunId ?? null,
  };
}

/**
 * The authorized, per-viewer summary of one execution's or command's AI
 * origin (#5022 W02, spec OD-9 A).
 *
 * A provenance pointer is NOT permission to disclose its target: `session`
 * and `agentRun` are present ONLY when the calling viewer can actually open
 * that transcript/run under its OWN ownership rules. When the id fails that
 * check, the key is omitted entirely (never nulled, never returned-and-hidden
 * client-side) — `resolvable: false` is the only signal, and `kind` still
 * survives, because "an AI did this" is exactly what the device page is for
 * and reveals nothing about whose conversation it was.
 */
export interface AiOriginSummaryDto {
  kind: AiInitiatorKind;
  /** Agent name, or the assistant label. Never a transcript excerpt. */
  label: string;
  occurredAt: string; // ISO
  toolName: string | null;
  /** Present ONLY when the viewer can actually open it. Omitted otherwise. */
  session?: { id: string };
  agentRun?: { id: string };
  /** false ⇒ the UI reads "origin not available". */
  resolvable: boolean;
}

/**
 * The device Overview right-rail's de-duplicated 7-day AI activity count
 * (#5022 W02). DISPATCHED mutations, not completed ones — see the
 * de-duplication rule in services/aiOriginSummary.ts's route handler.
 */
export interface DeviceAiActivityDto {
  dispatchedActions: number;
  windowDays: number;
  since: string; // ISO
}

export function deserializeAiOrigin(row: {
  aiOriginKind: string | null;
  aiOriginSessionId: string | null;
  aiOriginAgentRunId: string | null;
}): AiOriginRef | undefined {
  // The kind is the discriminator. Ids without a kind are a threading bug and
  // must not be laundered into a plausible-looking origin.
  if (!isAiInitiatorKind(row.aiOriginKind)) return undefined;
  return {
    kind: row.aiOriginKind,
    ...(row.aiOriginSessionId ? { sessionId: row.aiOriginSessionId } : {}),
    ...(row.aiOriginAgentRunId ? { agentRunId: row.aiOriginAgentRunId } : {}),
  };
}
