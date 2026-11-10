/**
 * #10432 (W09) — the replay driver: plays a scripted Wisp chat through the
 * REAL StreamingSessionManager and records what the session did.
 *
 * Offline and deterministic. What is real and what stands in:
 *
 *  - Real: the session manager's turn loop (the Wisp turn record, the reply
 *    text buffer, the turn-end hooks and `done`); the standing-state block
 *    (`standingStateForTurn`: facts → render → the per-session send gate),
 *    put ahead of the user's text the way `POST /ai/sessions/:id/messages`
 *    does (the route's content sanitising and fired check-in block are not
 *    replayed); the promise linter and the correction message; the
 *    instruction prefilter,
 *    the capture status and the extractor (parse, name resolution, blocks);
 *    the standing-instruction check (verb map, registry device args, matcher,
 *    decision); the dispatch-evidence normaliser.
 *  - Stand-ins (mocked in replay.test.ts, backed by world.ts): Postgres,
 *    Redis, the grant ceiling and standing-fact reads, budget and settlement,
 *    and both models. The chat model is a script; the extractor model returns
 *    the fixture's recorded reply.
 *  - Tool calls run inside the fake Agent SDK, as the real SDK runs the
 *    in-process MCP handler: the standing-instruction check the Wisp
 *    pre-tool runs (aiAgentSdk.ts), then the fixture's recorded output, then
 *    the normaliser the Wisp tool wrapper runs (aiAgentSdkTools.ts), then the
 *    outcome is recorded on the turn as the Wisp post-tool does. Guardrail
 *    tiers, approval cards and the ceiling gate are not replayed; their own
 *    suites pin them. The SDK stream carries the reply text and `result`.
 *
 * The scripted model reads what a real model would see: the turn content
 * (with any standing-state block) and this turn's tool results. A step can be
 * a function of that view, so a fixture says "answer from the standing state
 * when it is there, otherwise go and look" and a regression in what Wisp is
 * told shows up as extra tool calls, not as a silent pass.
 */
import { vi } from 'vitest';
import type { AiStreamEvent } from '@breeze/shared';
import type { AuthContext } from '../../middleware/auth';
import { buildOrgAccessClosures } from '../../middleware/auth';
import { makeResolvedModel } from '../../services/aiModels/__fixtures__/resolvedModel';
import { StreamingSessionManager, type ActiveSession } from '../../services/streamingSessionManager';
import { normaliseDispatchResult } from '../../services/wisp/dispatchEvidence';
import type { GrantCeiling } from '../../services/wisp/grantAuthority';
import { readInstructionCapture } from '../../services/wisp/instructionCaptureStatus';
import { STANDING_STATE_TAG, type StandingStateFacts } from '../../services/wisp/standingLoop';
import { checkStandingInstructionsForCall } from '../../services/wisp/standingInstructionGate';
import { clearStandingStateCache, markStandingStateSent, standingStateForTurn } from '../../services/wisp/standingStateTurn';
import { recordWispToolOutcome } from '../../services/wisp/turnRecord';
import type { ReplayInventory, ReplayScore, ReplayToolCall, ReplayTrace, ReplayTurnTrace } from './score';
import { replayWorld, resetReplayWorld } from './world';

/** What the scripted model can see when it decides its next step. */
export type ModelView = {
  /** This turn's content as the model receives it (standing-state block first, the user's text last). */
  turnContent: string;
  /** The newest `<wisp_standing_state>` block in the conversation so far, or null. */
  standingState: string | null;
  /** This turn's tool results so far, in order. */
  toolResults: Array<{ tool: string; output: string; isError: boolean }>;
};

export type ScriptedModelStep =
  | { say: string }
  | { call: string; input: Record<string, unknown>; approvalWaitSeconds?: number }
  | ((view: ModelView) => ScriptedModelStep | ScriptedModelStep[]);

/** Something the technician does between turns, outside chat. */
export type ReplayAction =
  /** Taps Keep on the instruction chip: every unconfirmed standing instruction becomes confirmed. */
  | 'keep_captured_instructions';

export type ReplayTurn = {
  user: string;
  before?: ReplayAction[];
  /**
   * The standing facts from this turn on, read as if the 60 s fact cache had
   * expired (time passing is not replayed). Omitted: unchanged.
   */
  standingFacts?: StandingStateFacts;
  modelScript: ScriptedModelStep[];
  /**
   * The recorded handler output per tool name: a string as is, anything else
   * as JSON. An object with `error` and no `success` is an error result.
   */
  toolOutputs?: Record<string, unknown>;
};

export type ReplayTurnExpectation = {
  standingStateSent?: boolean;
  maxToolCalls?: number;
  /** Exactly these corrections, in order ([] = none). */
  corrections?: string[];
  captureStatus?: string | null;
  /** Tools refused this turn (bare names, in order). */
  refused?: string[];
  /** Tools whose result was rewritten as unverified (bare names, in order). */
  unverified?: string[];
};

export type ReplayExpectations = {
  /** Upper bounds on the session score. */
  max?: Partial<ReplayScore>;
  /** Lower bounds on the session score. */
  min?: Partial<ReplayScore>;
  /** Per turn, by index; omitted entries are not checked. */
  turns?: Array<ReplayTurnExpectation | undefined>;
};

export type ReplayFixture = {
  name: string;
  /** Which filed defect class the fixture guards, for the failure message. */
  guards: string;
  inventory: ReplayInventory;
  ceiling: GrantCeiling;
  standingFacts: StandingStateFacts;
  /** The extractor model's replies, one per capture, in order. */
  extractorReplies?: unknown[];
  turns: ReplayTurn[];
  expect: ReplayExpectations;
};

const SESSION_ID = 'a1a1a1a1-1111-4222-8333-444455556666';
const THREAD_ID = 'b2b2b2b2-1111-4222-8333-444455556666';
const TURN_TIMEOUT_MS = 10_000;
const CAPTURE_TIMEOUT_MS = 10_000;
const MAX_SCRIPT_STEPS = 50;

const STANDING_BLOCK_RE = new RegExp(`<${STANDING_STATE_TAG}\\b[\\s\\S]*?</${STANDING_STATE_TAG}>`, 'g');

function newestStandingState(contents: string[]): string | null {
  for (let i = contents.length - 1; i >= 0; i -= 1) {
    const blocks = contents[i]!.match(STANDING_BLOCK_RE);
    if (blocks && blocks.length > 0) return blocks[blocks.length - 1]!;
  }
  return null;
}

function userContentText(input: unknown): string {
  const content = (input as { message?: { content?: unknown } } | null)?.message?.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((b) => (b && typeof b === 'object' && typeof (b as { text?: unknown }).text === 'string' ? (b as { text: string }).text : '')).join('');
  }
  return '';
}

function recordedOutput(value: unknown): { text: string; isError: boolean } {
  if (typeof value === 'string') return { text: value, isError: false };
  const isError = value !== null && typeof value === 'object' && 'error' in value && !('success' in value);
  return { text: JSON.stringify(value), isError };
}

/** One assistant message of reply text, as the SDK streams it. */
function textMessage(text: string): unknown[] {
  return [
    { type: 'stream_event', event: { type: 'message_start' } },
    { type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } },
    { type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } } },
  ];
}

const SDK_RESULT = {
  type: 'result', subtype: 'success', stop_reason: 'end_turn', total_cost_usd: 0, num_turns: 1,
  usage: { input_tokens: 0, output_tokens: 0 },
};

function grantorAuth(ceiling: GrantCeiling): AuthContext {
  const orgIds = [...ceiling.orgIds];
  return {
    scope: 'partner',
    orgId: null,
    partnerId: ceiling.partnerId,
    partnerOrgAccess: 'all',
    accessibleOrgIds: orgIds,
    ...buildOrgAccessClosures(orgIds),
    user: { id: ceiling.grantorUserId, email: 'tech@msp.example' },
  } as unknown as AuthContext;
}

/** The grant `lookupWispGrant` hands the session (replay.test.ts mocks it to this). */
export function replayGrant(ceiling: GrantCeiling): { grantId: string; revisionId: string; threadId: string } {
  return { grantId: ceiling.grantId, revisionId: ceiling.revisionId, threadId: THREAD_ID };
}

type ActiveTurn = { turn: ReplayTurn; calls: ReplayToolCall[] };

async function runTool(
  fixture: ReplayFixture,
  session: ActiveSession,
  turn: ReplayTurn,
  step: { call: string; input: Record<string, unknown>; approvalWaitSeconds?: number },
): Promise<ReplayToolCall> {
  const tool = step.call;
  const call: ReplayToolCall = {
    tool, input: step.input, output: '', isError: false, refused: false, unverified: false, standingWarning: false,
    approvalWaitSeconds: step.approvalWaitSeconds ?? 0,
  };
  // The Wisp pre-tool's standing-instruction check (never throws; fails closed).
  const check = await checkStandingInstructionsForCall({ ceiling: replayWorld.ceiling!, toolName: tool, input: step.input, auth: session.auth });
  if (check.action === 'refuse') {
    call.output = JSON.stringify({ error: check.error });
    call.isError = true;
    call.refused = true;
  } else {
    call.standingWarning = check.action === 'warn';
    if (!turn.toolOutputs || !(tool in turn.toolOutputs)) {
      throw new Error(`replay fixture "${fixture.name}": the script called ${tool} but the turn recorded no output for it`);
    }
    const recorded = recordedOutput(turn.toolOutputs[tool]);
    if (recorded.isError) {
      call.output = recorded.text;
      call.isError = true;
    } else {
      // The Wisp tool wrapper's dispatch-evidence normalisation.
      const normalised = normaliseDispatchResult(tool, step.input, recorded.text);
      call.output = normalised.output;
      call.unverified = normalised.unverified;
    }
  }
  // The Wisp post-tool's turn record. A call refused before it ran never reaches the post-tool, so it is not recorded.
  if (session.currentTurn && !call.refused) {
    recordWispToolOutcome(session.currentTurn, { toolName: `mcp__breeze__${tool}`, input: step.input, isError: call.isError, output: call.output });
  }
  return call;
}

async function* runScript(
  fixture: ReplayFixture,
  session: ActiveSession,
  active: ActiveTurn,
  turnContent: string,
  seen: string[],
): AsyncGenerator<unknown> {
  const queue: ScriptedModelStep[] = [...active.turn.modelScript];
  const view = (): ModelView => ({
    turnContent,
    standingState: newestStandingState(seen),
    toolResults: active.calls.map((c) => ({ tool: c.tool, output: c.output, isError: c.isError })),
  });
  for (let steps = 0; queue.length > 0; steps += 1) {
    if (steps > MAX_SCRIPT_STEPS) throw new Error(`replay fixture "${fixture.name}": the model script did not finish`);
    const step = queue.shift()!;
    if (typeof step === 'function') {
      const next = step(view());
      queue.unshift(...(Array.isArray(next) ? next : [next]));
    } else if ('say' in step) {
      yield* textMessage(step.say);
    } else {
      active.calls.push(await runTool(fixture, session, active.turn, step));
    }
  }
}

async function nextTurnEvents(session: ActiveSession, subscriptionId: string, push: () => void): Promise<AiStreamEvent[]> {
  const stream = session.eventBus.subscribe(subscriptionId);
  push();
  const events: AiStreamEvent[] = [];
  const collect = (async () => {
    for await (const event of stream) {
      events.push(event);
      if (event.type === 'done' || event.type === 'error') return;
    }
  })();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`the turn did not finish in ${TURN_TIMEOUT_MS} ms`)), TURN_TIMEOUT_MS);
  });
  try {
    await Promise.race([collect, timeout]);
  } finally {
    clearTimeout(timer);
    session.eventBus.unsubscribe(subscriptionId);
  }
  return events;
}

async function settledCaptureStatus(captureId: string): Promise<string | null> {
  let status: string | null = null;
  await vi.waitFor(async () => {
    status = (await readInstructionCapture(captureId))?.status ?? null;
    if (status === 'pending') throw new Error('capture still pending');
  }, { timeout: CAPTURE_TIMEOUT_MS, interval: 10 });
  return status;
}

function applyAction(action: ReplayAction): void {
  switch (action) {
    case 'keep_captured_instructions':
      for (const row of replayWorld.memoryRows) {
        if (row.blockType === 'standing_instruction' && row.status === 'unconfirmed') row.status = 'confirmed';
      }
      break;
  }
}

const CORRECTION_PREFIX = 'Correction: ';

/** Play the fixture's turns through one Wisp session; returns the trace. */
export async function replaySession(fixture: ReplayFixture): Promise<ReplayTrace> {
  resetReplayWorld();
  clearStandingStateCache();
  replayWorld.ceiling = fixture.ceiling;
  replayWorld.standingFacts = fixture.standingFacts;
  replayWorld.extractorReplies = [...(fixture.extractorReplies ?? [])];
  replayWorld.deviceRows = fixture.inventory.devices.map((d) => ({ id: d.id, orgId: d.orgId, siteId: null, hostname: d.name, displayName: null }));

  const auth = grantorAuth(fixture.ceiling);
  const seen: string[] = [];
  let active: ActiveTurn | null = null;
  let session: ActiveSession | null = null;

  replayWorld.sdkQuery = ({ prompt }) => ({
    async *[Symbol.asyncIterator]() {
      for await (const input of prompt) {
        const content = userContentText(input);
        seen.push(content);
        if (!active || !session) throw new Error('replay: a turn arrived with no scripted turn in flight');
        yield* runScript(fixture, session, active, content, seen);
        yield SDK_RESULT;
      }
    },
    interrupt: vi.fn(),
    close: vi.fn(),
  });

  const manager = new StreamingSessionManager();
  const turns: ReplayTurnTrace[] = [];
  try {
    const dbSession = { orgId: [...fixture.ceiling.orgIds][0]!, sdkSessionId: null, maxTurns: 50, turnCount: 0, systemPrompt: null };
    session = await manager.getOrCreate(SESSION_ID, dbSession, auth, undefined, 'PROMPT', undefined, makeResolvedModel('platform'));
    if (!session.wispGrant) throw new Error('replay: the session did not resolve its Wisp grant');
    const live = session;

    for (const [index, turn] of fixture.turns.entries()) {
      for (const action of turn.before ?? []) applyAction(action);
      if (turn.standingFacts) {
        replayWorld.standingFacts = turn.standingFacts;
        clearStandingStateCache();
      }
      // As POST /ai/sessions/:id/messages builds the turn: the standing state, then the user's text.
      const standing = await standingStateForTurn({
        grantId: fixture.ceiling.grantId, revisionId: fixture.ceiling.revisionId, sessionId: SESSION_ID, auth,
      });
      const content = [standing?.block, turn.user].filter(Boolean).join('\n\n');
      if (!manager.tryTransitionToProcessing(live, undefined, { userMessage: turn.user })) {
        throw new Error(`replay fixture "${fixture.name}": turn ${index} could not start (session ${live.state})`);
      }
      active = { turn, calls: [] };
      const events = await nextTurnEvents(live, `replay-${index}`, () => live.inputController.pushMessage(content));
      if (standing) await markStandingStateSent(SESSION_ID, standing.hash);

      const deltas = events.flatMap((e) => (e.type === 'content_delta' ? [e.delta] : []));
      const corrections = deltas.filter((d) => d.startsWith(CORRECTION_PREFIX)).flatMap((d) => d.split('\n'));
      const assistantText = live.currentTurn?.assistantText ?? deltas.filter((d) => !d.startsWith(CORRECTION_PREFIX)).join('\n');
      const done = events.find((e): e is Extract<AiStreamEvent, { type: 'done' }> => e.type === 'done');
      const captureId = done?.wispInstructionCapture?.captureId ?? null;
      turns.push({
        user: turn.user,
        standingStateSent: standing !== null,
        toolCalls: active.calls,
        assistantText,
        corrections,
        done: done !== undefined,
        captureId,
        captureStatus: captureId ? await settledCaptureStatus(captureId) : null,
      });
      active = null;
    }
  } finally {
    manager.shutdown();
  }
  return { name: fixture.name, inventory: fixture.inventory, turns };
}
