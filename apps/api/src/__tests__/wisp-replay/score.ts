/**
 * #10432 (W09) — the replay trace and its per-session score.
 *
 * A trace is what one replayed Wisp chat did, turn by turn: whether the
 * standing-state block rode on the turn, the tools the scripted model called
 * (after the real Wisp gates and normalisation), the reply text, the
 * server-written corrections, and the instruction capture, if any. The
 * scorer turns it into the numbers #10432 asked for, so a prompt or tool
 * change can be judged without re-running it on production.
 *
 * Pure: no I/O. The promise count uses the production linter and evidence
 * map (W08), so the scorer and the turn-end correction agree on what a
 * promise is.
 */
import { turnEvidenceFrom } from '../../services/wisp/dispatchEvidence';
import { lintTurnPromises } from '../../services/wisp/promiseLinter';

/** One tool call as the session saw it: after the standing-instruction check and dispatch-evidence normalisation. */
export type ReplayToolCall = {
  /** Bare tool name (no `mcp__breeze__` prefix). */
  tool: string;
  input: Record<string, unknown>;
  /** The output the model received. */
  output: string;
  isError: boolean;
  /** Refused before it ran (a standing instruction, a ceiling or a guardrail). Counted apart from other errors. */
  refused: boolean;
  /** A dispatch-class success that carried no evidence (W08): rewritten to `dispatchUnverified`. */
  unverified: boolean;
  /** A standing instruction matched but did not refuse: the call needs a human card. */
  standingWarning: boolean;
  /** How long the call waited on a human approval (recorded with the fixture). */
  approvalWaitSeconds: number;
};

export type ReplayTurnTrace = {
  /** The technician's own text. */
  user: string;
  /** A `<wisp_standing_state>` block rode on this turn. */
  standingStateSent: boolean;
  toolCalls: ReplayToolCall[];
  /** The model's reply text (never the server-written corrections). */
  assistantText: string;
  /** Server-written correction messages published this turn (W08). */
  corrections: string[];
  /** The turn ended with `done`. */
  done: boolean;
  /** `done` carried a standing-instruction capture id (W05). */
  captureId: string | null;
  /** The capture's terminal status, once the after-`done` extraction settled. */
  captureStatus: string | null;
};

/** The invented orgs and devices a fixture talks about; the cross-org check reads names from here. */
export type ReplayInventory = {
  orgs: Array<{ id: string; name: string }>;
  devices: Array<{ id: string; name: string; orgId: string }>;
};

export type ReplayTrace = {
  name: string;
  inventory: ReplayInventory;
  turns: ReplayTurnTrace[];
};

export type ReplayScore = {
  answeredTurns: number;
  unansweredTurns: number;
  /** Tool calls that came back as errors, refusals excluded. */
  toolErrors: number;
  refusals: number;
  /** Commitments in the reply (follow-up, dispatched, concern) that no tool result backs. */
  promisesWithoutMechanism: number;
  approvalWaitSeconds: number;
  /**
   * Tool calls per answered turn. 0 for a session with no calls; +Infinity
   * when calls were made and nothing was answered.
   */
  toolCallsPerAnswer: number;
  /** A device named beside an org it does not belong to. */
  crossOrgMistakes: number;
};

const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Whole-name, case-insensitive: `FS-01` never matches inside `FS-010`. */
function nameRegExp(name: string): RegExp {
  return new RegExp(`(?<![\\w-])${escapeRegExp(name)}(?![\\w-])`, 'gi');
}

function positions(text: string, name: string): number[] {
  return [...text.matchAll(nameRegExp(name))].map((m) => m.index ?? 0);
}

const SENTENCE_SPLIT = /(?<=[.!?])\s+|\n+/;

/**
 * Device-org pairs that disagree. Each device mention is paired with the
 * nearest org mention in the same sentence (a heuristic: "Harbor Dental has
 * FS-01 and PC-07" pairs PC-07 with Harbor Dental); a sentence that names no
 * org never counts (the device simply was not placed). A hostname reused in
 * several orgs is right beside any of them.
 */
export function crossOrgMistakes(text: string, inventory: ReplayInventory): number {
  const orgsByName = new Map<string, { name: string; orgIds: Set<string> }>();
  for (const device of inventory.devices) {
    const key = device.name.toLowerCase();
    const entry = orgsByName.get(key) ?? { name: device.name, orgIds: new Set<string>() };
    entry.orgIds.add(device.orgId);
    orgsByName.set(key, entry);
  }
  let mistakes = 0;
  for (const sentence of text.split(SENTENCE_SPLIT)) {
    const orgMentions = inventory.orgs.flatMap((org) => positions(sentence, org.name).map((at) => ({ orgId: org.id, at })));
    if (orgMentions.length === 0) continue;
    for (const { name, orgIds } of orgsByName.values()) {
      for (const at of positions(sentence, name)) {
        const nearest = orgMentions.reduce((best, m) => (Math.abs(m.at - at) < Math.abs(best.at - at) ? m : best));
        if (!orgIds.has(nearest.orgId)) mistakes += 1;
      }
    }
  }
  return mistakes;
}

function unbackedPromises(turn: ReplayTurnTrace): number {
  const evidence = turnEvidenceFrom(turn.toolCalls.map((c) => ({ toolName: c.tool, input: c.input, isError: c.isError, output: c.output })));
  return lintTurnPromises(turn.assistantText, evidence).classes.length;
}

export function scoreTrace(trace: ReplayTrace): ReplayScore {
  const calls = trace.turns.flatMap((t) => t.toolCalls);
  const answeredTurns = trace.turns.filter((t) => t.done && t.assistantText.trim() !== '').length;
  const toolCallsPerAnswer = calls.length === 0
    ? 0
    : answeredTurns === 0 ? Number.POSITIVE_INFINITY : Math.round((calls.length / answeredTurns) * 100) / 100;
  return {
    answeredTurns,
    unansweredTurns: trace.turns.length - answeredTurns,
    toolErrors: calls.filter((c) => c.isError && !c.refused).length,
    refusals: calls.filter((c) => c.refused).length,
    promisesWithoutMechanism: trace.turns.reduce((n, t) => n + unbackedPromises(t), 0),
    approvalWaitSeconds: calls.reduce((n, c) => n + c.approvalWaitSeconds, 0),
    toolCallsPerAnswer,
    crossOrgMistakes: trace.turns.reduce((n, t) => n + crossOrgMistakes(t.assistantText, trace.inventory), 0),
  };
}
