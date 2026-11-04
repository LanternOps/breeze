import type { AiStreamEvent, AiApprovalMode, AiApprovalScope, ActionPlanStep, AiScriptRunContext, AiRunResultArtifactRef, AiTopologyProgressPhase, TopologyAiExplanation, AiTurnModel, AiAttachState, AiPendingCardEvent, AiApprovalOutcome } from '@breeze/shared';
// Subpath, not the barrel: this module loads on the topology island, whose CSP
// forbids the barrel's JIT-compiled schemas (see topologyImports.test.ts).
import { topologyAiExplanationSchema } from '@breeze/shared/validators/topologyAi';

export interface AiMessage {
  id: string;
  role: 'user' | 'assistant' | 'tool_use' | 'tool_result';
  content: string;
  toolName?: string;
  toolInput?: Record<string, unknown>;
  toolOutput?: unknown;
  toolUseId?: string;
  isError?: boolean;
  /**
   * Server-asserted approval handoff (#5107) — copied off the SSE event, never
   * derived from `toolOutput`, which the tool itself controls. Absent on rows
   * replayed from history (it is not persisted on the message row), where
   * AiToolCallCard falls back to the payload shape gated on `!isError`.
   */
  handoff?: string;
  /**
   * Topology M4 (#6000): the server-validated, cited structured answer of a
   * topology investigation turn. Present only when the server published one;
   * `content` then holds its plain-text rendering (never raw model output).
   */
  topologyExplanation?: TopologyAiExplanation;
  /**
   * A stored topology answer that failed client-side validation on reload.
   * Its body is never shown; the Explain panel renders its deterministic
   * fallback instead.
   */
  topologyExplanationInvalid?: boolean;
  isStreaming?: boolean;
  createdAt: Date;
}

/** Plain-text rendering of a validated topology explanation for the chat transcript. */
export function renderTopologyExplanation(explanation: TopologyAiExplanation): string {
  const lines: string[] = [];
  for (const finding of explanation.findings) {
    lines.push(finding.kind === 'hypothesis' ? `Hypothesis: ${finding.text}` : finding.text);
  }
  for (const item of explanation.missingData) lines.push(`Missing data: ${item}`);
  for (const check of explanation.nextChecks) lines.push(`Suggested check (${check.recipeId}): ${check.rationale}`);
  return lines.join('\n');
}

export interface DeviceContext {
  hostname: string;
  displayName?: string;
  status: string;
  lastSeenAt?: string;
  activeSessions?: Array<{ username: string; activityState?: string; idleMinutes?: number; sessionType: string }>;
}

export interface PendingApproval {
  executionId: string;
  toolName: string;
  input: Record<string, unknown>;
  description: string;
  deviceContext?: DeviceContext;
  /** Tier-3 durable action-intent (spec §6.1) — see AiApprovalDialog's prop doc. */
  intentBacked?: boolean;
  /** Set when the viewer (requester) holds the fanned-out approval row — enables inline L3 self-approve. */
  selfApprovalRequestId?: string;
  /**
   * The intent's approval scope as classified server-side (#5600). `'supervised'`
   * means the viewer's self-approve IS the whole authorization, and the server
   * no longer requires an L3 proof for it — so the card decides prooflessly and
   * only runs the passkey ceremony if an enforcing partner policy asks for it.
   * `'four_eyes'` (and an absent scope, on older servers) keeps the always-L3
   * behaviour. Never defaulted here: inventing a value would drop the proof
   * from a four_eyes self-approve.
   */
  approvalScope?: AiApprovalScope;
  /** The intent's real server-side expiry (ISO), so the self-approve countdown reflects actual deadline. */
  intentExpiresAt?: string;
  /** #6475 — the org's configured interactive-approval window (ms), sent on every approval card. */
  approvalWindowMs?: number;
  /** #6475 — this specific (legacy, non-intent) wait's real server-side expiry (ISO). */
  approvalExpiresAt?: string;
  /**
   * #4888 — the run context a script launch will actually execute in, resolved
   * server-side. Present only for `run_script` / `execute_script_on_device`.
   * The card renders it as its own visible row: letting an assistant pick
   * SYSTEM for a script whose saved default is the logged-in user is a
   * privilege escalation, and the human approving it has to be told, not left
   * to expand a JSON blob.
   */
  scriptRunContext?: AiScriptRunContext | null;
  /**
   * #9431: set once the server says this card's wait ended — decided here or
   * anywhere else (another window, Approvals, mobile), timed out, or settled.
   * The card stays visible with its buttons disabled and says how it ended,
   * until the turn's next event removes it.
   */
  resolution?: AiApprovalOutcome;
}

/**
 * #9431: the approve route's answer to a click on a card that was already
 * decided (409 `approval_already_decided`) — the outcome to show on the card,
 * or null for any other response.
 */
export function alreadyDecidedOutcome(status: number, body: unknown): AiApprovalOutcome | null {
  if (status !== 409 || !body || typeof body !== 'object') return null;
  const { code, outcome } = body as { code?: unknown; outcome?: unknown };
  if (code !== 'approval_already_decided') return null;
  return outcome === 'approved' || outcome === 'not_approved' || outcome === 'ended' ? outcome : null;
}

export interface PendingPlan {
  planId: string;
  steps: ActionPlanStep[];
}

export interface ActivePlan {
  planId: string;
  steps: ActionPlanStep[];
  currentStepIndex: number;
  status: 'executing' | 'completed' | 'aborted';
}

/**
 * The subset of state that processStreamEvent needs to read and write.
 * Both aiStore (flat) and workspaceStore (per-tab) implement this shape.
 */
export interface ChatRunProgressEntry {
  step: string;
  label: string;
  ordinal: number;
}

/**
 * A workspace `analysis` run associated with this conversation
 * (execution-plane spec §5.5), advanced by `run_progress`/`run_result` while a
 * turn is open, and reconciled by `AiRunCard`'s poll of
 * `GET /ai/agents/runs/:runId` — which is the source of truth, because the
 * SSE stream only exists during a turn and the run outlives it. Keyed by run
 * id, not by tool-use id: a run survives the turn that started it and can be
 * referred to again later in the conversation. Chat-initiated launch is
 * currently disabled (#6086 — no tool seeds this from within a turn), but the
 * shape and the reconciliation contract are retained for when delegated
 * authorization lands.
 */
export interface ChatRunState {
  runId: string;
  status: 'queued' | 'running' | 'completed' | 'failed';
  progress: ChatRunProgressEntry[];
  summary: string | null;
  artifacts: AiRunResultArtifactRef[];
}

export interface StreamableState {
  messages: AiMessage[];
  pendingApproval: PendingApproval | null;
  pendingPlan: PendingPlan | null;
  activePlan: ActivePlan | null;
  approvalMode: AiApprovalMode;
  isPaused: boolean;
  isStreaming: boolean;
  error: string | null;
  sessionId: string | null;
  sessions: Array<{ id: string; title: string | null; status: string; createdAt: string }>;
  /** Analysis runs launched from this conversation, keyed by run id. */
  chatRuns: Record<string, ChatRunState>;
  /** Topology M4: fixed phase of the running investigation turn (aiStore only). */
  topologyPhase?: AiTopologyProgressPhase | null;
  /** Topology M4: accepted run of an approved diagnostic proposal (aiStore only). */
  topologyRunId?: string | null;
  /** W05: offering ids the server suggests after a refusal (set by Task 13). */
  refusalAlternatives?: string[];
  /** W05: the model is reasoning (thinking_state). */
  thinking?: boolean;
  /** W05: what actually ran the last turn. */
  turnModel?: AiTurnModel | null;
  /**
   * #9427: this surface attached to a running turn whose replay was too large
   * to send (`attach_state.partial`). The reply so far is not on screen; the
   * full reply appears when the turn finishes. Cleared by `done`.
   */
  joinedMidResponse?: boolean;
}

/**
 * Roles a turn writes as its own output. After the turn's user row, these are
 * exactly what an `attach_state` replay re-creates; any other persisted row
 * (e.g. a script-proposal system note) is kept.
 */
const TURN_OUTPUT_ROLES: ReadonlySet<string> = new Set(['assistant', 'tool_use', 'tool_result']);

/**
 * #9427: a running, fully replayed snapshot names this turn's user row, but the
 * hydrated messages do not contain it (they were read before the row was
 * written). The caller re-hydrates once and re-attaches; if the row is still
 * absent the second time it applies the snapshot anyway, which then drops
 * nothing (see the `attach_state` case).
 */
export function attachAnchorMissing(state: AiAttachState, messages: AiMessage[]): boolean {
  if (state.turn !== 'running' || state.partial || state.turnUserMessageId === null) return false;
  const anchor = state.turnUserMessageId;
  return !messages.some((m) => m.id === anchor);
}

function pendingApprovalFromCard(card: Extract<AiPendingCardEvent, { type: 'approval_required' }>): PendingApproval {
  return {
    executionId: card.executionId,
    toolName: card.toolName,
    input: card.input,
    description: card.description,
    deviceContext: card.deviceContext,
    intentBacked: card.intentBacked,
    selfApprovalRequestId: card.selfApprovalRequestId,
    approvalScope: card.approvalScope,
    intentExpiresAt: card.intentExpiresAt,
    approvalWindowMs: card.approvalWindowMs,
    approvalExpiresAt: card.approvalExpiresAt,
    scriptRunContext: card.scriptRunContext ?? null,
  };
}

type StreamSetter = (fn: (s: StreamableState) => Partial<StreamableState>) => void;
type StreamGetter = () => StreamableState;

export function processStreamEvent(
  event: AiStreamEvent,
  set: StreamSetter,
  get: StreamGetter,
  currentAssistantId: string | null
): string | null {
  switch (event.type) {
    case 'message_start': {
      const msg: AiMessage = {
        id: event.messageId,
        role: 'assistant',
        content: '',
        isStreaming: true,
        createdAt: new Date()
      };
      set((s) => ({ messages: [...s.messages, msg], refusalAlternatives: [], turnModel: null }));
      return event.messageId;
    }

    case 'content_delta': {
      if (currentAssistantId) {
        set((s) => ({
          messages: s.messages.map((m) =>
            m.id === currentAssistantId
              ? { ...m, content: m.content + event.delta }
              : m
          )
        }));
      }
      return currentAssistantId;
    }

    case 'tool_use_start': {
      const toolMsg: AiMessage = {
        id: `tool-${event.toolUseId}`,
        role: 'tool_use',
        content: '',
        toolName: event.toolName,
        toolInput: event.input && Object.keys(event.input).length > 0 ? event.input : undefined,
        toolUseId: event.toolUseId,
        createdAt: new Date()
      };
      set((s) => ({ messages: [...s.messages, toolMsg] }));
      return currentAssistantId;
    }

    // Sweep E6: `tool_use_start`'s `input` is always `{}` (the SDK hasn't
    // finished streaming the tool's arguments yet at that point). This event
    // arrives once they're known and fills in the SAME message row, so the
    // live tool card's label (aiToolLabel, which needs `input.action` to
    // tell a read from a write) matches what a history reload of this exact
    // row would compute.
    case 'tool_use_input': {
      set((s) => ({
        messages: s.messages.map((m) =>
          m.role === 'tool_use' && m.toolUseId === event.toolUseId
            ? { ...m, toolInput: Object.keys(event.input).length > 0 ? event.input : undefined }
            : m
        )
      }));
      return currentAssistantId;
    }

    case 'tool_result': {
      const resultMsg: AiMessage = {
        id: `result-${event.toolUseId}`,
        role: 'tool_result',
        content: typeof event.output === 'string' ? event.output : JSON.stringify(event.output, null, 2),
        toolOutput: event.output as Record<string, unknown>,
        toolUseId: event.toolUseId,
        isError: event.isError,
        handoff: event.handoff,
        createdAt: new Date()
      };
      set((s) => {
        // The approval this card is waiting on can be decided somewhere else
        // (mobile push, the Approvals queue). The server then runs the tool and
        // this result arrives on the still-open stream — so a result for the
        // awaited tool IS the decision landing, and the card must go with it.
        // Matched by tool name via the tool_use row: the event carries no
        // executionId, and the awaited tool is by construction the one whose
        // result has not yet arrived.
        const awaited = s.pendingApproval;
        const toolUse = s.messages.find((m) => m.role === 'tool_use' && m.toolUseId === event.toolUseId);
        // Parallel calls to the same tool: the awaited one is the LATEST
        // tool_use of that name (approval_required is published from the
        // pre-tool hook, i.e. right after its tool_use_start), so an earlier
        // sibling's result must not dismiss it.
        const latestOfName = toolUse
          ? [...s.messages].reverse().find((m) => m.role === 'tool_use' && m.toolName === toolUse.toolName)
          : undefined;
        const resolvesPending =
          !!awaited && !!toolUse && toolUse.toolName === awaited.toolName && latestOfName?.toolUseId === toolUse.toolUseId;
        return {
          // Specialized result cards (including analysis runs) need the tool
          // name even when the tool did not require approval.
          messages: [...s.messages, { ...resultMsg, toolName: toolUse?.toolName }],
          ...(resolvesPending ? { pendingApproval: null } : {}),
        };
      });
      return currentAssistantId;
    }

    case 'approval_required':
      set(() => ({ pendingApproval: pendingApprovalFromCard(event) }));
      return currentAssistantId;

    // #9431: the card's wait ended, wherever it was decided. Matched by
    // executionId, so another card (or none) is never touched.
    case 'approval_resolved':
      set((s) => (s.pendingApproval?.executionId === event.executionId
        ? { pendingApproval: { ...s.pendingApproval, resolution: event.outcome } }
        : {}));
      return currentAssistantId;

    case 'title_updated':
      // Only the side panel keeps a sessions list. A workspace tab's state has
      // none (its title lives on the tab), and the first turn of a conversation
      // replays title_updated first: mapping an absent list threw and dropped
      // the whole attach (#9840 lab, row A2).
      set((s) => (Array.isArray(s.sessions)
        ? {
            sessions: s.sessions.map((sess) =>
              sess.id === s.sessionId ? { ...sess, title: event.title } : sess
            ),
          }
        : {}));
      return currentAssistantId;

    case 'message_end': {
      if (currentAssistantId) {
        set((s) => ({
          messages: s.messages.map((m) =>
            m.id === currentAssistantId ? { ...m, isStreaming: false } : m
          )
        }));
      }
      return null;
    }

    case 'error':
      set(() => ({ error: event.message, errorCode: event.code ?? null, isStreaming: false }));
      return currentAssistantId;

    case 'plan_approval_required':
      set(() => ({
        pendingPlan: {
          planId: event.planId,
          steps: event.steps,
        },
      }));
      return currentAssistantId;

    case 'plan_step_start': {
      set((s) => ({
        activePlan: s.activePlan ? { ...s.activePlan, currentStepIndex: event.stepIndex } : s.activePlan,
      }));
      return currentAssistantId;
    }

    case 'plan_step_complete': {
      set((s) => {
        if (!s.activePlan) return {};
        const steps = s.activePlan.steps.map((step, i) =>
          i === event.stepIndex ? { ...step, status: event.isError ? 'failed' as const : 'completed' as const } : step
        );
        return { activePlan: { ...s.activePlan, steps, currentStepIndex: event.stepIndex + 1 } };
      });
      return currentAssistantId;
    }

    case 'plan_complete': {
      const completedPlanId = event.planId;
      set((s) => ({
        activePlan: s.activePlan ? { ...s.activePlan, status: event.status } : null,
      }));
      setTimeout(() => {
        const state = get();
        if (state.activePlan?.planId === completedPlanId) {
          set(() => ({ activePlan: null }));
        }
      }, 3000);
      return currentAssistantId;
    }

    case 'plan_screenshot': {
      const screenshotMsg: AiMessage = {
        id: `plan-screenshot-${event.planId}-${event.stepIndex}`,
        role: 'tool_result',
        content: '',
        toolName: 'plan_screenshot',
        toolOutput: { imageBase64: event.imageBase64, stepIndex: event.stepIndex },
        createdAt: new Date(),
      };
      set((s) => ({ messages: [...s.messages, screenshotMsg] }));
      return currentAssistantId;
    }

    // W04 (#5612): the reviewer-gated unattended lane approved this run at
    // creation — no card, an inline note instead (never dropped silently).
    case 'unattended_release': {
      const releaseMsg: AiMessage = {
        id: `unattended-release-${event.intentId}`,
        role: 'tool_result',
        content: '',
        toolName: 'unattended_release',
        toolOutput: {
          intentId: event.intentId,
          executionId: event.executionId,
          description: event.description,
          deviceContext: event.deviceContext ?? null,
          scriptRunContext: event.scriptRunContext ?? null,
          scriptProposal: event.scriptProposal ?? null,
        },
        createdAt: new Date(),
      };
      set((s) => ({ messages: [...s.messages, releaseMsg], pendingApproval: null }));
      return currentAssistantId;
    }

    case 'approval_mode_changed': {
      set(() => ({ approvalMode: event.mode, isPaused: event.mode === 'per_step' }));
      return currentAssistantId;
    }

    case 'run_progress': {
      set((s) => {
        const existing = s.chatRuns[event.runId];
        const entry: ChatRunProgressEntry = { step: event.step, label: event.label, ordinal: event.ordinal };
        // De-duplicate by ordinal: the bridge is best-effort and BullMQ can
        // redeliver a job, so the same step can arrive twice. Sorting rather
        // than appending also survives out-of-order pub/sub delivery.
        const progress = [...(existing?.progress ?? []).filter((p) => p.ordinal !== entry.ordinal), entry]
          .sort((a, b) => a.ordinal - b.ordinal);
        return {
          chatRuns: {
            ...s.chatRuns,
            [event.runId]: {
              runId: event.runId,
              // Never downgrade a run that already reported terminal: a late
              // progress event must not resurrect a finished card.
              status: existing?.status === 'completed' || existing?.status === 'failed'
                ? existing.status
                : 'running',
              progress,
              summary: existing?.summary ?? null,
              artifacts: existing?.artifacts ?? [],
            },
          },
        };
      });
      return currentAssistantId;
    }

    case 'run_result': {
      set((s) => {
        const existing = s.chatRuns[event.runId];
        return {
          chatRuns: {
            ...s.chatRuns,
            [event.runId]: {
              runId: event.runId,
              status: event.status,
              progress: existing?.progress ?? [],
              summary: event.summary,
              artifacts: event.artifacts,
            },
          },
        };
      });
      return currentAssistantId;
    }

    case 'done':
      // #9431: a card whose wait already ended has nothing left to show once
      // the turn is over (a denied / settled call may send no tool_result).
      set((s) => ({
        isStreaming: false, thinking: false, joinedMidResponse: false,
        ...(s.pendingApproval?.resolution ? { pendingApproval: null } : {}),
      }));
      return null;

    // #9427: the first frame of an attach. Applies the snapshot of the
    // session's current turn; live events (seq > lastSeq) follow on the
    // returned assistant id.
    case 'attach_state':
      return applyAttachState(event, set, get);

    // Topology M4 (#6000): progress phases are status only; the explanation
    // is the ONLY answer a topology turn ever sends, already validated.
    case 'topology_progress':
      set(() => ({ topologyPhase: event.phase }));
      return currentAssistantId;

    case 'topology_explanation': {
      // Defense in depth: the server validated it; an answer that does not
      // parse here is shown as nothing but the invalid marker.
      const parsed = topologyAiExplanationSchema.safeParse(event.explanation);
      const patch: Partial<AiMessage> = parsed.success
        ? { content: renderTopologyExplanation(parsed.data), topologyExplanation: parsed.data }
        : { content: '', topologyExplanationInvalid: true };
      // The explanation is published AFTER the transport's message_end (which
      // clears the current id), and a cached answer arrives with no
      // message_start at all. Attach it to this turn's assistant message —
      // the last one after the last user message — or start one.
      set((s) => {
        const lastUser = s.messages.map((m) => m.role).lastIndexOf('user');
        const targetIndex = currentAssistantId
          ? s.messages.findIndex((m) => m.id === currentAssistantId)
          : s.messages.findIndex((m, i) => i > lastUser && m.role === 'assistant');
        if (targetIndex >= 0) {
          return { topologyPhase: null, messages: s.messages.map((m, i) => (i === targetIndex ? { ...m, ...patch, isStreaming: false } : m)) };
        }
        const message: AiMessage = { id: crypto.randomUUID(), role: 'assistant', content: '', createdAt: new Date(), ...patch };
        return { topologyPhase: null, messages: [...s.messages, message] };
      });
      return currentAssistantId;
    }

    case 'topology_diagnostic_run':
      set(() => ({ topologyRunId: event.runId }));
      return currentAssistantId;

    // Deliberate no-ops, named so the exhaustiveness guard below can be exact.
    // Each of these is handled by a DIFFERENT surface, not by this technician
    // chat store: `warning` and `tool_completed`/`tool_request`/
    // `client_tool_request` belong to the Office/Helper client-session loops,
    // and `script_proposal_update` is delivered durably as an ai_messages row
    // that history replay picks up. Listing them as cases rather than letting
    // them fall through is the point — a fall-through is indistinguishable from
    // a forgotten event.
    case 'warning':
    case 'client_tool_request':
    case 'tool_request':
    case 'tool_completed':
    case 'script_proposal_update':
      return currentAssistantId;

    // §9.1a: the refusal explanation already streamed as ordinary
    // message_start/content_delta/message_end events and renders as the
    // assistant message. This structured twin is for the W05 model picker.
    case 'thinking_state':
      set(() => ({ thinking: event.state === 'started' }));
      return currentAssistantId;
    case 'turn_model':
      set(() => ({ turnModel: event.turnModel }));
      return currentAssistantId;
    case 'model_refusal':
      set(() => ({ refusalAlternatives: event.alternatives.map((a) => a.offeringId) }));
      return currentAssistantId;

    default: {
      /*
       * Every member of `AiStreamEvent` must be handled above. If a new event
       * type is added to the shared union and not here, `event` is no longer
       * `never` at this point and THIS LINE fails to compile — which is the
       * only signal there is, because the runtime behaviour of forgetting a
       * case is "nothing happens", indistinguishable from an event that never
       * arrived. Do not "fix" a red here by widening the annotation.
       */
      const _exhaustive: never = event;
      // Unreachable when the compiler is satisfied; kept so a hand-built event
      // object from an older client is dropped rather than throwing.
      void _exhaustive;
      return currentAssistantId;
    }
  }

  return null;
}

/**
 * #9427: apply an `attach_state` snapshot (see `AiAttachState`).
 *
 * 1. Running, full replay: everything up to and including the turn's user row
 *    (`turnUserMessageId`) is kept; after it only the turn's own output rows
 *    are dropped (the replay re-creates them) and any other persisted row is
 *    kept. The anchor is matched exactly — never guessed. A null or absent
 *    anchor drops nothing (no turn output is persisted yet, or the caller has
 *    already re-hydrated once; see `attachAnchorMissing`).
 * 2. Running, partial: hydrated rows are kept and one streaming assistant
 *    placeholder is appended so live `content_delta`s have a target.
 * 3. Pending cards are REPLACED, never merged with what the surface had.
 * 4. The active plan is the server's value at `lastSeq`, installed after the
 *    replay fold (which already moved it through the replayed step events).
 *    An idle or unavailable turn has no executing plan to show.
 */
function applyAttachState(
  snapshot: AiAttachState,
  set: StreamSetter,
  get: StreamGetter,
): string | null {
  const running = snapshot.turn === 'running';
  let currentAssistantId: string | null = null;

  if (running && !snapshot.partial) {
    const anchor = snapshot.turnUserMessageId;
    set((s) => {
      const anchorIndex = anchor === null ? -1 : s.messages.findIndex((m) => m.id === anchor);
      if (anchorIndex < 0) return {};
      return {
        messages: s.messages.filter((m, i) => i <= anchorIndex || !TURN_OUTPUT_ROLES.has(m.role)),
      };
    });
    for (const event of snapshot.replay) {
      // A nested attach_state can never be in a replay; ignore one defensively
      // rather than recursing.
      if (event.type === 'attach_state') continue;
      currentAssistantId = processStreamEvent(event, set, get, currentAssistantId);
    }
  } else if (running) {
    const placeholder: AiMessage = {
      id: crypto.randomUUID(),
      role: 'assistant',
      content: '',
      isStreaming: true,
      createdAt: new Date(),
    };
    set((s) => ({ messages: [...s.messages, placeholder] }));
    currentAssistantId = placeholder.id;
  }

  let pendingApproval: PendingApproval | null = null;
  let pendingPlan: PendingPlan | null = null;
  for (const card of snapshot.pendingCards) {
    if (card.type === 'approval_required') pendingApproval = pendingApprovalFromCard(card);
    else if (card.type === 'plan_approval_required') pendingPlan = { planId: card.planId, steps: card.steps };
  }

  set(() => ({
    pendingApproval,
    pendingPlan,
    activePlan: running ? snapshot.activePlan : null,
    isStreaming: running,
    joinedMidResponse: running && snapshot.partial,
    ...(snapshot.turnModel ? { turnModel: snapshot.turnModel } : {}),
  }));

  return currentAssistantId;
}

/** Map raw API message objects to typed AiMessage array */
/**
 * A stored topology investigation answer (M4 #6000) is persisted as
 * `contentBlocks: [{ type: 'topology_explanation', explanation }]` with the
 * JSON in `content`. Map it to the structured answer — never the raw body.
 */
function storedTopologyExplanation(m: Record<string, unknown>): Pick<AiMessage, 'content' | 'topologyExplanation' | 'topologyExplanationInvalid'> | null {
  const blocks = m.contentBlocks;
  if (m.role !== 'assistant' || !Array.isArray(blocks)) return null;
  const block = blocks.find((b): b is { type: string; explanation?: unknown } =>
    !!b && typeof b === 'object' && (b as { type?: unknown }).type === 'topology_explanation');
  if (!block) return null;
  const parsed = topologyAiExplanationSchema.safeParse(block.explanation);
  return parsed.success
    ? { content: renderTopologyExplanation(parsed.data), topologyExplanation: parsed.data }
    : { content: '', topologyExplanationInvalid: true };
}

export function mapMessagesFromApi(rawMessages: Record<string, unknown>[]): AiMessage[] {
  return rawMessages.map((m) => ({
    id: m.id as string,
    role: m.role as AiMessage['role'],
    content: (m.content as string) ?? '',
    toolName: m.toolName as string | undefined,
    toolInput: m.toolInput as Record<string, unknown> | undefined,
    toolOutput: m.toolOutput,
    toolUseId: m.toolUseId as string | undefined,
    createdAt: new Date(m.createdAt as string),
    ...storedTopologyExplanation(m),
  }));
}
