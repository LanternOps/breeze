import {
  SOFTWARE_INSTALL_DOWNLOAD_TIMEOUT_MS,
  SOFTWARE_INSTALL_INSTALLER_TIMEOUT_MS,
} from "@breeze/shared";

/**
 * #3578 — what an in-flight software install row can say beyond "Pending".
 *
 * - `sent`: the server handed the command to the agent (WS push or poll
 *   claim) and the agent has reported no stage — every agent version gets
 *   this, since the timestamp is the server's own.
 * - `downloading` / `installing`: the last stage the agent reported (agents
 *   that advertise `command_progress`).
 * - `running`: a stage newer than this UI knows about.
 */
export type InFlightStage = "sent" | "downloading" | "installing" | "running";

export interface InFlightSource {
  status: string;
  queuedOffline?: boolean;
  sentAt?: string | null;
  agentStage?: string | null;
  agentStageAt?: string | null;
}

export interface InFlightState {
  stage: InFlightStage;
  /** Whole minutes since the last word from the agent (stage start, or the send). */
  elapsedMinutes: number;
  /**
   * The agent has been quiet for longer than it allows itself for this stage
   * (its own download/installer ceilings), so the install is likely stuck or
   * the agent lost it. Advisory: the server's reaper still owns the timeout.
   */
  silent: boolean;
}

/**
 * How long the agent may legitimately stay quiet in each stage. With no stage
 * report the whole agent budget applies (download + installer). Package-manager
 * installs run under a shorter limit than the direct installer, so these are
 * upper bounds: the hint may come late, never early.
 */
const SILENCE_CEILING_MS: Record<InFlightStage, number> = {
  downloading: SOFTWARE_INSTALL_DOWNLOAD_TIMEOUT_MS,
  installing: SOFTWARE_INSTALL_INSTALLER_TIMEOUT_MS,
  sent: SOFTWARE_INSTALL_DOWNLOAD_TIMEOUT_MS + SOFTWARE_INSTALL_INSTALLER_TIMEOUT_MS,
  running: SOFTWARE_INSTALL_DOWNLOAD_TIMEOUT_MS + SOFTWARE_INSTALL_INSTALLER_TIMEOUT_MS,
};

function parseTime(value?: string | null): number | null {
  if (!value) return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : ms;
}

/** Derive the in-flight presentation for a result row, or null when the row is not in flight. */
export function describeInFlight(row: InFlightSource, nowMs: number = Date.now()): InFlightState | null {
  if (row.status !== "pending" || row.queuedOffline) return null;
  const sentMs = parseTime(row.sentAt);
  if (sentMs === null) return null;

  const stageMs = parseTime(row.agentStageAt);
  let stage: InFlightStage = "sent";
  if (row.agentStage && stageMs !== null) {
    stage = row.agentStage === "downloading" || row.agentStage === "installing"
      ? row.agentStage
      : "running";
  }
  const sinceMs = stage === "sent" ? sentMs : (stageMs as number);
  const quietMs = Math.max(0, nowMs - sinceMs);

  return {
    stage,
    elapsedMinutes: Math.floor(quietMs / 60_000),
    silent: quietMs > SILENCE_CEILING_MS[stage],
  };
}
