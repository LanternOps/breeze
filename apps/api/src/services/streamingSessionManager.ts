/**
 * Streaming Session Manager
 *
 * Manages persistent Claude Agent SDK Query instances using AsyncIterable
 * (streaming input mode). Each session holds a long-lived subprocess that
 * accepts follow-up messages without replaying history.
 *
 * Core components:
 * - StreamInputController: AsyncIterable<SDKUserMessage> fed to query({ prompt })
 * - SessionEventBus: pub/sub for AiStreamEvent with ring buffer
 * - StreamingSessionManager: singleton Map<string, ActiveSession> with eviction
 * - Background SDK Processor: iterates Query output, translates to AiStreamEvents
 */

import { query } from '@anthropic-ai/claude-agent-sdk';
import type { Query, SDKResultMessage, SDKUserMessage, McpSdkServerConfigWithInstance } from '@anthropic-ai/claude-agent-sdk';
import { db, withDbAccessContext, withSystemDbAccessContext, runOutsideDbContext } from '../db';
import { dbWriteExpectingRows } from '../db/dbWriteExpectingRows';
import { aiSessions, aiMessages } from '../db/schema';
import { eq, and, isNull, inArray } from 'drizzle-orm';
import type { AuthContext } from '../middleware/auth';
import { buildOrgAccessClosures } from '../middleware/auth';
import type { AiStreamEvent, AiApprovalMode } from '@breeze/shared/types/ai';
// TYPE-ONLY, and it must stay that way: chatRunBridge.ts imports this module at
// runtime for `streamingSessionManager.get`, so a value import back would be a
// real runtime cycle. TypeScript erases this one.
import type { PendingRunResult } from './workspace/chatRunBridge';
import { AsyncEventQueue } from '../utils/asyncQueue';
import { prepareSdkChild, sdkModelOptions } from './aiModels/connectionFactory';
import { takeGatewayFailureNote } from './aiModels/gateway/failureNotes';
import { catalogEndpointOf } from './aiModels/sdkChildEnv';
import {
  newSdkTurnObservation,
  observeSdkMessage,
  sdkTurnUsage,
  type BilledUsage,
  type SdkResultLike,
  type SdkTurnObservation,
  type SdkTurnUsageResult,
  type TurnOutcome,
} from './aiModels/invocationUsage';
import { noteProviderFailureForBinding } from './aiModels/offeringHealth';
import { promptProvenanceFor, renderSystemPrompt, type PromptProvenance } from './aiModels/promptProfiles';
import type { ResolvedModel } from './aiModels/resolveModel';
import { carriesQueryValues, safeErrorMessage } from './aiModels/safeDbError';
import { priceUsage, quoteInvocationCents, settleInvocation, sumCostCents } from './aiModels/settleInvocation';
import { liveQueryKey, turnBindingFrom, type TurnBinding } from './aiModels/turnBinding';
import { REFUSAL_DOCS_URL, listRefusalAlternatives, refusalMessageText, type RefusalAlternative } from './aiModels/refusals';
import { describeTurnModel, persistLastTurnModel, turnDisplayFrom, type TurnDisplay } from './aiModels/turnModel';
import { sanitizeErrorForClient } from './aiAgent';
import { captureException, captureMessage } from './sentry';
import { createBreezeMcpServer, BREEZE_MCP_TOOL_NAMES } from './aiAgentSdkTools';
import type { TopologyTurnRuntime } from './topology/aiInvestigation';
import { createSessionPreToolUse, createSessionPostToolUse, settleApprovalWaits } from './aiAgentSdk';
import type { RequestLike } from './auditEvents';
import { getTrustedClientIpOrUndefined } from './clientIp';
import { redactAiToolOutputText, redactSensitiveToolInput } from './aiToolOutput';
import { markAiBudgetReservationIndeterminate, readSdkUsageSnapshot } from './aiBudgetReservations';
import { getEffectiveAiBudget } from './effectiveSettings';
import { DEFAULT_APPROVAL_WAIT_BUDGET_MS, loadApprovalWaitBudgetMs } from './aiApprovalTimeout';
import { resolveTenantTools, type TenantToolDescriptor } from './toolSources/resolver';
import { buildTenantSdkTools, tenantMcpToolNames } from './toolSources/sdkBridge';
import { isSdkBuiltinToolUse, resolveToolSearchPolicy } from './aiToolSearchPolicy';

const SESSION_IDLE_TIMEOUT_MS = 2 * 60 * 60 * 1000; // 2h idle eviction (aligned with pre-flight check)
const SESSION_MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24h hard limit
const EVICTION_INTERVAL_MS = 60 * 1000; // Check every 60s
const MAX_ACTIVE_SESSIONS = 200;
const EVENT_RING_BUFFER_SIZE = 100;
/**
 * How long a `processing` session may go without stream progress before
 * eviction stops treating it as a live turn.
 *
 * Eviction protects an in-flight turn (see `isTurnInFlight`), and `state` alone
 * would make that protection unbounded: `runBackgroundProcessor` can leave a
 * session in `processing` after a throw or an aborted subprocess, and a hung
 * provider never emits another event — so a wedged session would be pinned in
 * memory forever, and under cap pressure a handful of them would wedge the
 * whole manager. `lastActivityAt` is refreshed when a turn starts and on every
 * assistant-message boundary and text delta, so a live stream never approaches
 * this window; anything past it is a dead turn, and reclaiming it costs
 * nothing.
 *
 * Sized against this path's real worst case, which is longer than the OpenAI
 * twin's: a tier-3 tool can block on `waitForApproval` (300s, aiAgentSdk.ts)
 * and then execute under a 120s vision budget without emitting a single text
 * delta, i.e. ~7 min of legitimate silence — see SDK_TURN_TIMEOUT_MS above.
 * 10 min clears that with headroom while still bounding a wedge.
 */
export const PROCESSING_STALL_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * Stall window for a session whose approval-wait budget is configurable
 * (#6475). The 10-minute floor above was sized for a 5-minute wait + a 120s
 * tool; a longer configured wait keeps the same 5 minutes of headroom past
 * the budget, so a turn legitimately blocked on a 60-minute approval is not
 * evicted as wedged.
 */
export function processingStallTimeoutMsFor(approvalWaitBudgetMs: number): number {
  return Math.max(PROCESSING_STALL_TIMEOUT_MS, approvalWaitBudgetMs + 5 * 60 * 1000);
}

/** Throttle for the all-in-flight capacity alarm, so it cannot flood Sentry. */
const CAPACITY_ALARM_THROTTLE_MS = 5 * 60 * 1000;

/**
 * Bucket how far past MAX_ACTIVE_SESSIONS the manager has been pushed, for the
 * capacity alarm's only scrubber-surviving channel (a tag).
 *
 * Closed four-value set by construction, carrying no tenant, device or session
 * identifier — the shape ALLOWED_TAG_NAMES requires. The raw count would be
 * unbounded cardinality; the bucket still separates "one turn over" from "the
 * manager is wedged", which is the distinction that decides whether to page.
 */
function bucketSessionOvershoot(size: number): string {
  if (size <= MAX_ACTIVE_SESSIONS) return 'at-cap';
  if (size <= MAX_ACTIVE_SESSIONS * 1.25) return 'over-cap';
  if (size <= MAX_ACTIVE_SESSIONS * 2) return 'far-over-cap';
  return 'runaway';
}
/**
 * 6 min per-turn timeout. Sized to accept a single approval wait
 * (`waitForApproval`, aiAgentSdk.ts, 300_000ms = 5 min) plus headroom for
 * execution — but the two are NOT bounded to fit together, and this handler
 * does not reach into the pending call to stop it.
 *
 * #3096 review (raising the vision-tool budget in toolTimeouts.ts to 120s):
 * approval-wait fully resolves BEFORE `withToolTimeout` starts
 * (aiAgentSdkTools.ts onPreToolUse vs. the executeTool wrapper), so the two
 * budgets stack rather than overlap. Worst case for a tier-3 vision/desktop
 * tool call is now approval wait (up to 5 min) + execution (up to 120s) =
 * up to 7 min — past this 6-min ceiling.
 *
 * When that happens today, `startTurnTimeout`'s callback (below) publishes
 * `error` + `done` and sets `state = 'idle'`, but does NOT abort
 * `session.abortController` or otherwise unblock the in-flight
 * `waitForApproval` poll — only `remove()` does that. `runBackgroundProcessor`'s
 * `for await` loop only stops on `state === 'closing' | 'closed'`, so once the
 * approval/tool call eventually settles, its SDK messages (tool_result,
 * closing assistant text, `result`) still get processed and published into a
 * turn the client was already told had ended.
 *
 * This is a known gap, not a new one from #3091/#3096 — the same overlap
 * already existed for two stacked ordinary approval waits before the vision
 * budget was ever raised. It has a proper fix in progress: PR #3104 (Closes
 * #3089) introduces a shared per-cycle `APPROVAL_WAIT_BUDGET_MS` that resets
 * at the same `message_start` point as this timeout, so cumulative approval
 * blocking is bounded to fit inside the turn window. That PR is not merged as
 * of this comment — do not assume the overlap is handled until it lands.
 */
const SDK_TURN_TIMEOUT_MS = 6 * 60 * 1000;

/**
 * Per-turn timeout for a session (#6475): the cycle's approval-wait budget
 * plus the same 60s of headroom SDK_TURN_TIMEOUT_MS has always had over the
 * 5-minute default budget, so the model can still conclude the turn after
 * the wait gives up. Never below SDK_TURN_TIMEOUT_MS.
 */
export function turnTimeoutMsFor(approvalWaitBudgetMs: number): number {
  return Math.max(SDK_TURN_TIMEOUT_MS, approvalWaitBudgetMs + 60 * 1000);
}
const MCP_PREFIX = 'mcp__breeze__';
// Use the directly-imported runOutsideDbContext (see commandQueue.ts for explanation).
const runOutsideDbContextSafe = runOutsideDbContext;

// The SDK child env builders moved to aiModels/sdkChildEnv.ts (W06 Task 9);
// re-exported so existing importers (scripts, tests) keep working.
export { buildClaudeSdkChildEnv } from './aiModels/sdkChildEnv';

/**
 * A model-gateway capability path: the grant token (32 random bytes,
 * base64url) is the only credential a gateway child holds, and the CLI may
 * echo its base URL in an error line.
 */
const GATEWAY_CAPABILITY_PATH = /\/g\/[A-Za-z0-9_-]{43,}/g;

function redactSdkStderrText(data: string): string {
  return redactAiToolOutputText(data.replace(GATEWAY_CAPABILITY_PATH, '/g/[redacted]'));
}

export function redactClaudeSdkStderr(data: string): string {
  return redactSdkStderrText(data).trim();
}

/** Longest stderr line buffered before it is flushed unterminated; also the cap on one logged entry. */
const SDK_STDERR_MAX_LINE = 16 * 1024;
/** Characters kept back when an over-long line is flushed, so a token cut there is matched whole later. */
const SDK_STDERR_CARRY = 64;
const SDK_STDERR_MARKER = /error|Error|FATAL/;

/**
 * Line-buffered, redacting sink for one SDK child's stderr. The CLI's stderr
 * arrives in arbitrary chunks, so a secret (a gateway grant token in a /g/
 * URL, a key) can be split across two of them; redacting each chunk on its own
 * would let both halves through. Text is therefore held until a newline and
 * each write's batch of complete lines is redacted as a whole before it is
 * logged (only when it carries an error marker, as before). A line longer
 * than SDK_STDERR_MAX_LINE is redacted as buffered and flushed except for its
 * last SDK_STDERR_CARRY characters, which stay buffered: a token that is
 * incomplete at the cut lies wholly inside them and is matched once the rest
 * arrives. Every logged entry is at most SDK_STDERR_MAX_LINE characters.
 * `flush()` (child exit / session teardown) logs whatever is left; it is
 * idempotent.
 */
export function createSdkStderrRedactor(emit: (text: string) => void): { write(data: string): void; flush(): void } {
  let pending = '';
  // The current (unterminated) line already had a marked part logged.
  let continuing = false;

  const emitRedacted = (text: string): void => {
    const redacted = redactSdkStderrText(text);
    for (let i = 0; i < redacted.length; i += SDK_STDERR_MAX_LINE) {
      const part = redacted.slice(i, i + SDK_STDERR_MAX_LINE).trim();
      if (part) emit(part);
    }
  };

  return {
    write(data: string): void {
      pending += data;
      const nl = pending.lastIndexOf('\n');
      if (nl >= 0) {
        const batch = pending.slice(0, nl + 1);
        pending = pending.slice(nl + 1);
        if (continuing || SDK_STDERR_MARKER.test(batch)) emitRedacted(batch);
        continuing = false;
      }
      if (pending.length > SDK_STDERR_MAX_LINE) {
        const marked = continuing || SDK_STDERR_MARKER.test(pending);
        // Redact BEFORE cutting, so a complete secret anywhere in the buffer is
        // replaced whole; only redacted text is ever logged or carried.
        const redacted = redactSdkStderrText(pending);
        const cut = Math.max(0, redacted.length - SDK_STDERR_CARRY);
        if (marked) {
          for (let i = 0; i < cut; i += SDK_STDERR_MAX_LINE) {
            const part = redacted.slice(i, Math.min(i + SDK_STDERR_MAX_LINE, cut)).trim();
            if (part) emit(part);
          }
          continuing = true;
        }
        pending = redacted.slice(cut);
      }
    },
    flush(): void {
      if (pending && (continuing || SDK_STDERR_MARKER.test(pending))) emitRedacted(pending);
      pending = '';
      continuing = false;
    },
  };
}

// ============================================
// StreamInputController
// ============================================

/**
 * Wraps an AsyncEventQueue<SDKUserMessage> as the prompt source for query().
 * Follow-up messages are pushed via pushMessage() — no subprocess restart needed.
 *
 * NOTE: The first message is pushed with whatever session_id is known (empty string
 * for new sessions). The SDK manages session IDs internally — the subprocess must
 * receive the first message to start processing, so we cannot block on the init
 * event (which only arrives after the subprocess starts).
 */
export class StreamInputController {
  private queue = new AsyncEventQueue<SDKUserMessage>();
  private sdkSessionId: string | null = null;

  /** Feed this to query({ prompt }) */
  getInputStream(): AsyncIterable<SDKUserMessage> {
    return this.queue;
  }

  /**
   * Set the SDK session ID. Called once by the background processor when
   * the system init event arrives, or upfront for resumed sessions.
   */
  setSdkSessionId(id: string): void {
    if (this.sdkSessionId) {
      console.warn('[StreamInputController] SDK session ID already set, ignoring duplicate:', id);
      return;
    }
    this.sdkSessionId = id;
  }

  /**
   * Push a new user message into the stream.
   * Uses the known SDK session ID if available, otherwise empty string
   * (the SDK assigns session IDs internally for new sessions).
   */
  pushMessage(content: string): void {
    const message: SDKUserMessage = {
      type: 'user',
      message: { role: 'user', content },
      parent_tool_use_id: null,
      session_id: this.sdkSessionId ?? '',
    };

    this.queue.push(message);
  }

  /** Close the input stream, terminating the Query */
  close(): void {
    this.queue.close();
  }
}

// ============================================
// SessionEventBus
// ============================================

/**
 * Pub/sub for AiStreamEvent. Multiple SSE subscribers can listen.
 * Ring buffer stores last N events for potential reconnection replay.
 */
export class SessionEventBus {
  private subscribers = new Map<string, AsyncEventQueue<AiStreamEvent>>();
  private ringBuffer: AiStreamEvent[] = [];

  /** Subscribe to events. Returns an async iterable. Closes any existing subscription with the same ID. */
  subscribe(id: string): AsyncIterable<AiStreamEvent> {
    // Close existing subscriber with same ID to prevent resource leak
    const existing = this.subscribers.get(id);
    if (existing) {
      existing.close();
    }
    const queue = new AsyncEventQueue<AiStreamEvent>();
    this.subscribers.set(id, queue);
    return queue;
  }

  /** Unsubscribe and close the subscriber's queue */
  unsubscribe(id: string): void {
    const queue = this.subscribers.get(id);
    if (queue) {
      queue.close();
      this.subscribers.delete(id);
    }
  }

  /** Publish an event to all subscribers and the ring buffer */
  publish(event: AiStreamEvent): void {
    this.ringBuffer.push(event);
    if (this.ringBuffer.length > EVENT_RING_BUFFER_SIZE) {
      this.ringBuffer.shift();
    }

    for (const queue of this.subscribers.values()) {
      queue.push(event);
    }
  }

  /** Get recent events from the ring buffer for reconnection replay */
  getReplayEvents(fromIndex = 0): AiStreamEvent[] {
    return this.ringBuffer.slice(fromIndex);
  }

  /** Close all subscriber queues */
  closeAll(): void {
    for (const queue of this.subscribers.values()) {
      queue.close();
    }
    this.subscribers.clear();
  }

  get subscriberCount(): number {
    return this.subscribers.size;
  }
}

// ============================================
// ActiveSession
// ============================================

export type SessionState = 'initializing' | 'ready' | 'processing' | 'idle' | 'closing' | 'closed';

/** Token usage accumulated across the model API calls of a single turn. */
export interface PendingTurnUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
}

function emptyPendingTurnUsage(): PendingTurnUsage {
  return { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 };
}

function hasTokens(u: PendingTurnUsage): boolean {
  return u.inputTokens > 0 || u.outputTokens > 0 || u.cacheReadInputTokens > 0 || u.cacheCreationInputTokens > 0;
}

/**
 * The turn's BILLED tokens as the per-user ledger and the `done` event report
 * them. Cache-read and cache-creation tokens are input tokens — split out for
 * pricing only (see sumInputTokens) — so input includes them.
 */
function billedTokenTotals(usage: readonly BilledUsage[]): { inputTokens: number; outputTokens: number } {
  let inputTokens = 0;
  let outputTokens = 0;
  for (const u of usage) {
    inputTokens += u.tokens.input + u.tokens.cacheRead + u.tokens.cacheWrite;
    outputTokens += u.tokens.output;
  }
  return { inputTokens, outputTokens };
}

/** A DB error's statement values never reach Sentry (safeDbError.ts). */
function reportableError(err: unknown): unknown {
  return carriesQueryValues(err) ? new Error(safeErrorMessage(err)) : err;
}

/** Immutable audit snapshot extracted from the HTTP request context */
export interface AuditSnapshot {
  ip: string | undefined;
  userAgent: string | undefined;
}

export interface ActiveSession {
  readonly breezeSessionId: string;
  /**
   * Canonical org ID for this session, captured at creation time from the
   * aiSessions DB row. Use this (not `auth.orgId`) for RLS DB access context
   * inside background callbacks — it is stable for the session's lifetime and
   * is always set, even for system/partner-scoped users who own the session.
   */
  readonly orgId: string;
  /**
   * Bound device ID from the aiSessions DB row (null when the session is not
   * device-bound). When set, `toolAuth` is narrowed to the session org via
   * `buildDeviceBoundSessionAuth` so org-scoped tools query the DEVICE's org,
   * not the login org (#3087).
   */
  readonly deviceId: string | null;
  /**
   * Live-query identity this SDK subprocess was built with (spec §9.2,
   * `liveQueryKey`): connection id, config version, catalog revision, wire
   * model and wire fingerprint. A turn whose key differs never reuses it.
   */
  readonly liveKey: string;
  /**
   * The CURRENT turn's binding (W03 Task 6): the rate settlement bills. Seeded
   * at creation, replaced by the winner of `tryTransitionToProcessing` each
   * turn — so a rate change between turns re-binds settlement without
   * recreating the query (the price is not part of `liveKey`).
   */
  turnBinding: TurnBinding;
  /**
   * W05: display names of the current turn's bound model and its refusal
   * fallback (for `turn_model`). Seeded at creation, re-bound by the winner of
   * `tryTransitionToProcessing` alongside `turnBinding`.
   */
  turnDisplay: TurnDisplay;
  /**
   * W05: index of the thinking content block the model is in, while a
   * `thinking_state: started` is outstanding; null otherwise. On the session
   * (not the processor) so the turn timeout can close it too.
   */
  thinkingBlockIndex?: number | null;
  /**
   * W11 (#7609): the prompt profile and variant this live query's system
   * prompt was built with. Fixed for the query's life, as the system prompt
   * is; every settlement of a turn on this query records it (the per-turn
   * `turnBinding` may carry a newer profile — liveQueryKey ignores it).
   */
  readonly promptProvenance: PromptProvenance;
  /** The Breeze users.id the ledger attributes turns to; null for helper / Office / system. */
  readonly ledgerUserId: string | null;
  /** Refusal-fallback system messages seen during the current turn (W03 Task 5). */
  refusalObservation: SdkTurnObservation;
  /**
   * A session-scope refusal fallback swapped this live query's model for the
   * rest of its life; the binding says otherwise. Rebuilt (resumed) before
   * the next turn instead of billing a model nobody bound.
   */
  forceRecreate: boolean;
  /** Durable org-budget reservation for the current provider turn. */
  budgetReservationId?: string;
  /**
   * Review S5: reservations whose settlement THREW (or came back unrecorded)
   * on this session. They are never re-settled — a second settle of a failed
   * real turn would be the abandoned-turn zero, losing its spend — only marked
   * indeterminate when the processor exits.
   */
  unsettledReservationIds?: string[];
  /**
   * Releases this session's CONNECT-proxy grant. Set for catalog sessions only;
   * invoked by `remove()` so a torn-down, rotated or evicted session stops
   * being able to reach the provider immediately.
   */
  /**
   * Releases every grant the SDK child holds (catalog CONNECT grant; gateway
   * grant + deny-all proxy grant, W06). Idempotent; called on every teardown.
   */
  revokeEgressGrant?: () => void;
  /** Logs any buffered (redacted) SDK stderr tail. Idempotent; called on teardown. */
  flushSdkStderr?: () => void;
  sdkSessionId: string | null;
  query: Query;
  abortController: AbortController;
  inputController: StreamInputController;
  eventBus: SessionEventBus;
  state: SessionState;
  lastActivityAt: number;
  readonly createdAt: number;
  /**
   * RAW login AuthContext from the latest request. Used for actor identity,
   * RBAC (`checkToolPermission` resolves the login role from it — a partner
   * tech keeps their partner role, matching the rest of the API), rate limits,
   * and audit attribution. NOT for tool queries — see `toolAuth`.
   */
  auth: AuthContext;
  /**
   * Effective AuthContext for TOOL EXECUTION (MCP handlers + their RLS DB
   * context). For device-bound sessions this is `auth` narrowed to the
   * session (device) org via `buildDeviceBoundSessionAuth` (#3087). For a
   * device-PAGE session it is `auth` plus `aiWriteDefaultOrgId` (#6675), with
   * no narrowing. Otherwise it is `auth` itself. Built by
   * `buildChatSessionToolAuth`, refreshed alongside `auth` on every request.
   */
  toolAuth: AuthContext;
  /** Immutable audit data extracted from the latest request (avoids holding stale Hono context) */
  auditSnapshot: AuditSnapshot;
  mcpServer: McpSdkServerConfigWithInstance;
  /** MCP tool name prefix for stripping in SSE events (e.g. 'mcp__breeze__' or 'mcp__script_builder__') */
  mcpPrefix: string;
  /** FIFO queue of toolUseIds from content_block_start for postToolUse correlation */
  toolUseIdQueue: string[];
  /**
   * Per-turn usage accumulated from the SDK's `assistant` messages (one per
   * underlying model API call). NOT a billing source (W03: billing is the
   * per-model delta of the result's cumulative modelUsage); it only signals
   * that a turn abandoned without a `result` had reached the model. Reset at
   * every `result` and by the abandoned-turn settlement.
   */
  pendingTurnUsage: PendingTurnUsage;
  /**
   * Count of tool calls completed (postToolUse fired) during the current turn.
   * Fed into settleInvocation's toolExecutionCount so the
   * `ai_cost_usage.tool_execution_count` rollup actually increments — mirrors
   * pendingTurnUsage's accumulate-then-flush-on-`result` lifecycle. Reset to 0
   * after every flush (normal `result` or the abandoned-turn fallback below).
   */
  pendingTurnToolExecutionCount: number;
  /**
   * tool_use id → bare tool name, recorded at content_block_start alongside
   * toolUseIdQueue. Consumed by postToolUse on the normal path, or by the
   * dropped-call fallback in the background processor's 'user' case when the
   * SDK rejected the call before our MCP handler ever ran (issue #3094).
   * Optional so existing fixtures that build ActiveSession literals compile
   * unchanged; the fallback degrades to 'unknown_tool' without it.
   */
  toolUseNames?: Map<string, string>;
  /** Promise that resolves when background processor finishes */
  readonly processorPromise: Promise<void>;
  /** Timer for per-turn timeout; cleared when 'result' arrives */
  turnTimeoutId: ReturnType<typeof setTimeout> | null;
  /**
   * Epoch-ms deadline SHARED by every approval wait in the current assistant
   * cycle (#3089) — set by the first wait of the cycle (beginApprovalWait in
   * aiAgentSdk.ts), reset to null at each message_start via startTurnTimeout.
   * Guarantees cumulative approval blocking per cycle stays under the turn
   * timeout so the model can always conclude the turn.
   */
  approvalWaitDeadline: number | null;
  /**
   * Aborts in-flight approval waits early WITHOUT tearing down the session
   * (settleApprovalWaits in aiAgentSdk.ts) — fired when a new user message or
   * an interrupt arrives while the turn is blocked on approvals.
   */
  approvalWaitAbort: AbortController | null;
  /** Count of approval waits currently blocked inside preToolUse. */
  pendingApprovalWaits: number;
  /** Approval mode for this session (effective: partner override -> org row -> per_step) */
  approvalMode: AiApprovalMode;
  /**
   * Per-assistant-cycle approval-wait budget in ms (#6475): the org's
   * interactive AI approval timeout (org override -> partner default -> 5 min,
   * range 5-60 min; services/aiApprovalTimeout.ts). Resolved at session
   * creation and refreshed between turns, like `approvalMode`. The turn
   * timeout and the stall window are derived from it (turnTimeoutMsFor /
   * processingStallTimeoutMsFor) so a long configured wait is never cut off
   * by a fixed 6-minute ceiling.
   */
  approvalWaitBudgetMs: number;
  /** Optional MCP allowlist for restricted sessions such as helper chat. */
  allowedTools?: string[];
  /**
   * Topology M4 Task 3 (#6000): the host-owned investigation runtime for the
   * CURRENT turn of a topology session (bound by the route through
   * `tryTransitionToProcessing` — only when it wins the slot — and cleared
   * when the turn ends). While set, provider text goes into
   * its output gate instead of the event bus, tool events are replaced by
   * fixed `topology_progress` phases, raw assistant content is never
   * persisted, and the turn ends with one validated `topology_explanation`.
   * Client page context is never authority for it.
   */
  topologyInvestigation?: TopologyTurnRuntime;
  /** Set when a topology token cap stopped the turn; the result then ends in a fixed error. */
  topologyStopped?: boolean;
  /**
   * Set (and never cleared) when a topology turn timed out. The timeout tears
   * the session down — SDK aborted, query closed — and this seal keeps the
   * output gate shut for anything the provider still emits for that turn:
   * the processor loop drops it and the tool hooks refuse/skip it, so late,
   * unvalidated prose can never reach the event bus, replay or ai_messages
   * via the generic (non-topology) paths once `topologyInvestigation` is gone.
   */
  topologyTurnSealed?: boolean;
  /** True when admin has paused auto-approve — falls back to per_step */
  isPaused: boolean;
  /** ID of the currently active action plan (if any) */
  activePlanId: string | null;
  /** Approved plan steps keyed by step index */
  approvedPlanSteps: Map<number, { toolName: string; input: Record<string, unknown> }>;
  /** Current step index in the active plan */
  currentPlanStepIndex: number;
  /** Resolver for the plan approval promise (in-memory, no DB polling) */
  planApprovalResolver: ((approved: boolean) => void) | null;
  /**
   * Results of `analysis` runs associated with this session that have
   * finished but whose summary has not yet been shown to the model
   * (execution-plane spec §5.5). Chat-initiated launch is currently disabled
   * (#6086), so nothing populates this from a live chat turn today; the field
   * is retained for when delegated authorization lands. Filled by
   * `services/workspace/chatRunBridge.ts` out of band; drained by
   * `POST /ai/sessions/:id/messages` and prepended to the next user message.
   * Optional so existing `ActiveSession` fixtures compile unchanged.
   */
  pendingRunResults?: PendingRunResult[];
  // ── AI for Office (client sessions) — set by routes/clientAi/sessions.ts ──
  /** Client org policy writeMode, refreshed on every client message; the
   *  client tool handler rejects mutating tools when 'readonly'. */
  clientWriteMode?: 'readonly' | 'readwrite';
  /** client_ai_org_policies.dlp_config (jsonb, unknown — the DLP engine parses
   *  it itself), refreshed on every client message. */
  clientDlpConfig?: unknown;
  /** Extra per-turn usage recorder invoked in the result case just before
   *  settleInvocation (client sessions: per-user client_ai_usage buckets). Its
   *  costCents is the registry quote of the same billed usage. */
  recordExtraUsage?: (usage: { inputTokens: number; outputTokens: number; costCents: number }) => Promise<void>;
  /**
   * Tenant (BYO MCP) tools this session's `toolAuth` could see at session
   * CREATION time, keyed by qualified name (e.g. `hudu__get_asset`) — Task
   * A10. `createSessionPreToolUse` (aiAgentSdk.ts) consults this to gate a
   * tenant tool call the same way `TOOL_TIERS` gates a core one. Empty for
   * every session a `mcpServerFactory` builds its own MCP server for
   * (script builder, client AI) — those surfaces don't resolve tenant tools.
   */
  tenantTools: ReadonlyMap<string, TenantToolDescriptor>;
}

/**
 * Narrow a caller's AuthContext to a device-bound session's org (#3087).
 *
 * `ai_sessions.org_id` is anchored to the bound DEVICE's org at creation
 * (services/aiAgent.ts createSession — gated on `auth.canAccessOrg` +
 * `auth.canAccessSite`), but tool execution historically ran under the raw
 * login AuthContext. For a partner-scope tech whose login org differs from the
 * device's org, org-scoped tools (`getOrgId(auth)` → `accessibleOrgIds[0]`,
 * `auth.orgCondition(...)` → whole partner) silently queried the WRONG org —
 * e.g. `manage_patches` returned a sibling org's patches and `search_logs`
 * returned empty for the device's own logs.
 *
 * The returned context pins the org axis to the session org:
 * - `orgId` / `accessibleOrgIds` = the session (device) org only, with matching
 *   `orgCondition` / `canAccessOrg` closures from `buildOrgAccessClosures`.
 * - `scope` and `partnerId` are PRESERVED — collapsing a partner scope to
 *   'organization' would drop `accessiblePartnerIds` from the derived RLS
 *   context and black out partner-axis tables (scripts, alert templates,
 *   update rings — the #2822 failure mode). Partner-wide config rows apply to
 *   the device's org and must stay readable.
 * - Site restrictions (`allowedSiteIds` / `canAccessSite`), `helperDeviceId`,
 *   principal/user/token are preserved via spread — this narrows, never widens.
 *
 * Defensive: throws if the caller cannot access the session org. Unreachable
 * in practice (`getSession` pre-filters by `auth.orgCondition`), but if auth
 * ever regresses we must fail loudly rather than run tools cross-org.
 */
/**
 * Stamp the interactive-chat AI origin onto a request AuthContext (#5022 W01).
 *
 * `breezeSessionId` is the persisted `ai_sessions.id` — not an MCP transport
 * session id — so the resulting pointer is resolvable by the device-page chip.
 * Returns the same reference when the origin is already correct, so a caller
 * that identity-compares is not surprised.
 */
export function withChatAiOrigin(auth: AuthContext, breezeSessionId: string): AuthContext {
  if (auth.aiOrigin?.kind === 'ai_assistant' && auth.aiOrigin.sessionId === breezeSessionId) {
    return auth;
  }
  return { ...auth, aiOrigin: { kind: 'ai_assistant', sessionId: breezeSessionId } };
}

export function buildDeviceBoundSessionAuth(auth: AuthContext, sessionOrgId: string): AuthContext {
  if (!auth.canAccessOrg(sessionOrgId)) {
    throw new Error('Device-bound AI session org is not accessible to the caller');
  }
  const alreadyPinned =
    auth.orgId === sessionOrgId &&
    auth.accessibleOrgIds?.length === 1 &&
    auth.accessibleOrgIds[0] === sessionOrgId;
  if (alreadyPinned) return auth;

  return {
    ...auth,
    orgId: sessionOrgId,
    accessibleOrgIds: [sessionOrgId],
    ...buildOrgAccessClosures([sessionOrgId]),
  };
}

/**
 * Tool auth for a chat session (#3087, #6675).
 *
 * - Device-bound session (`ai_sessions.device_id`): pinned to the session org.
 * - Device-PAGE session (org anchored by the page it was opened from): full
 *   read scope, plus `aiWriteDefaultOrgId` so an org-scoped write with no
 *   `orgId` lands in the page's org instead of being refused as ambiguous.
 *   `resolveWritableToolOrgId` re-checks access to it on every call.
 * - Anything else: the session auth itself.
 */
export function buildChatSessionToolAuth(
  auth: AuthContext,
  sessionOrgId: string,
  deviceId: string | null | undefined,
  writeDefaultOrgId: string | null | undefined,
): AuthContext {
  if (deviceId) return buildDeviceBoundSessionAuth(auth, sessionOrgId);
  if (writeDefaultOrgId) return { ...auth, aiWriteDefaultOrgId: writeDefaultOrgId };
  return auth;
}

// ============================================
// StreamingSessionManager (singleton)
// ============================================

const APPROVAL_MODES: readonly AiApprovalMode[] = ['per_step', 'action_plan', 'auto_approve', 'hybrid_plan'];

/**
 * Effective approval mode for a session's org (#5593).
 *
 * Resolves through `getEffectiveAiBudget` — partner JSONB `aiBudgets`
 * override, then the org's `ai_budgets` row, then `per_step` — instead of
 * reading the org row directly, which silently ignored a partner-wide default.
 * The partner override is free-form JSON, so an unrecognized value is rejected
 * rather than handed to the approval gate. Any failure keeps the previous
 * fail-safe behaviour: the strictest mode, `per_step`.
 */
async function loadApprovalMode(orgId: string): Promise<AiApprovalMode> {
  try {
    const budget = await getEffectiveAiBudget(orgId);
    const mode = budget.approvalMode as AiApprovalMode;
    if (APPROVAL_MODES.includes(mode)) return mode;
    console.warn(
      '[StreamingSessionManager] Unrecognized approval mode, defaulting to per_step:',
      budget.approvalMode,
    );
  } catch (err) {
    captureException(err);
    console.error('[StreamingSessionManager] Failed to load approval mode, defaulting to per_step:', err);
  }
  return 'per_step';
}

export class StreamingSessionManager {
  private sessions = new Map<string, ActiveSession>();
  private evictionTimer: ReturnType<typeof setInterval> | null = null;

  private lastCapacityAlarmAt = 0;

  constructor() {
    // No `runOutsideDbContext` wrapper around this `setInterval`: a LAZY
    // singleton first constructed inside an AI request handler would need one,
    // because its timer would inherit the requester's AsyncLocalStorage scope
    // on every tick for the life of the process. This one is a MODULE-LEVEL singleton
    // (bottom of file), constructed at import time with no ambient context, so
    // the sweep starts clean. `markSessionsExpired` still re-enters the escape
    // per statement — that is what actually guarantees the write's context,
    // and it does not depend on this construction-order accident holding.
    this.evictionTimer = setInterval(() => this.evictStaleSessions(), EVICTION_INTERVAL_MS);
  }

  /**
   * Check state and transition to 'processing'.
   * Allows transition from 'initializing', 'ready', or 'idle' states.
   * Rejects only true concurrent work and teardown/closed sessions.
   * Returns true if successful, false if session is not in a valid state.
   */
  /**
   * Claim the session's single turn slot, and — atomically with that claim —
   * attach the reservation that turn will settle.
   *
   * #5557: `budgetReservationId` used to be assigned only when the session was
   * CREATED, so from the second message onward on a warm in-memory session the
   * reservation the route had just taken never reached the settle path: the
   * turn's spend was recorded unsettled and the hold — the org's ENTIRE
   * remaining cap — sat until the 30-minute sweep, locking the tenant out of
   * its own budget.
   *
   * The attach belongs HERE and not in `getOrCreate` because `getOrCreate`
   * awaits (`loadApprovalMode`) before returning, so two concurrent callers can
   * attach and then return in the opposite order: the winner of the slot would
   * be left carrying the LOSER's reservation, and the loser would release it —
   * out from under a live dispatch — on its 409 path. This method has no
   * awaits, so the claim and the attach cannot interleave: whoever takes the
   * slot attaches their own reservation, and every loser releases a reservation
   * that was never attached to anything.
   */
  tryTransitionToProcessing(
    session: ActiveSession,
    budgetReservationId?: string,
    turn?: { topologyInvestigation?: TopologyTurnRuntime; turnBinding?: TurnBinding; turnDisplay?: TurnDisplay },
  ): boolean {
    if (session.state === 'processing' || session.state === 'closing' || session.state === 'closed') {
      return false;
    }
    session.state = 'processing';
    if (budgetReservationId !== undefined) {
      session.budgetReservationId = budgetReservationId;
    }
    // Same claim-then-attach rule for the topology runtime (PR #7147 F1): only
    // the caller that takes the slot binds its turn's runtime (or clears a
    // previous one) and resets the cap stop. A loser binds nothing, so the
    // running turn keeps streaming into its OWN gate and its cap stop holds.
    if (turn) {
      session.topologyInvestigation = turn.topologyInvestigation;
      session.topologyStopped = false;
    }
    // And for the turn binding (W03): only the winner binds the rate its
    // reservation carries; settlement bills exactly that.
    if (turn?.turnBinding) {
      session.turnBinding = turn.turnBinding;
    }
    // W05: and the display names `turn_model` reports for that binding.
    if (turn?.turnDisplay) {
      session.turnDisplay = turn.turnDisplay;
    }
    session.refusalObservation = newSdkTurnObservation();
    // The state and its staleness clock move together: eviction reads
    // lastActivityAt to tell a live turn from a wedged one, and before this the
    // stamp was refreshed only in getOrCreate() — so a session that had been
    // sitting idle stayed the LRU victim for the whole turn it was streaming.
    session.lastActivityAt = Date.now();
    return true;
  }

  /**
   * Get or create an active streaming session.
   * If the session exists in memory and is alive, reuse it.
   * If not, create a new one (potentially resuming from saved sdkSessionId).
   */
  async getOrCreate(
    breezeSessionId: string,
    dbSession: {
      orgId: string;
      sdkSessionId: string | null;
      maxTurns: number;
      turnCount: number;
      systemPrompt: string | null;
      /**
       * Bound device from the aiSessions row. When set, the session's
       * effective auth is narrowed to the session org (#3087). Callers whose
       * middleware already pins the auth to one org (helper chat, client AI)
       * may omit it — narrowing would be a no-op there.
       */
      deviceId?: string | null;
      /**
       * Device-page write default (#6675): the session org when it was
       * anchored by the page the chat was opened from
       * (`pageContextWriteDefaultOrgId`). Never narrows reads; ignored for a
       * device-bound session. Omitted by every other chat surface.
       */
      writeDefaultOrgId?: string | null;
    },
    auth: AuthContext,
    requestContext: RequestLike | undefined,
    systemPrompt: string,
    maxBudgetUsd: number | undefined,
    /** The turn's model from resolveModel / resolveSessionTurn (W03): connection, wire params, rate. */
    resolved: ResolvedModel,
    allowedTools?: string[],
    mcpServerFactory?: (
      getAuth: () => AuthContext,
      onPreToolUse: ReturnType<typeof createSessionPreToolUse>,
      onPostToolUse: ReturnType<typeof createSessionPostToolUse>,
      getSession: () => ActiveSession,
    ) => { server: McpSdkServerConfigWithInstance; name: string },
    options?: {
      injectApprovalModeInstructions?: boolean;
      budgetReservationId?: string;
      topologyInvestigation?: TopologyTurnRuntime;
      /**
       * A-W04 (#6151): this surface registers the full Breeze registry and may
       * defer it behind the SDK's ToolSearch built-in. Only web chat opts in;
       * `resolveToolSearchPolicy` still decides per host, budget and operator
       * override. Static-subset surfaces leave it unset.
       */
      toolSearch?: boolean;
      /** The Breeze users.id the ledger attributes this session's turns to (null: helper / Office / system). */
      ledgerUserId?: string | null;
      /**
       * W05: this turn deliberately switches model (planModelTransition said
       * `switch_resume`). An idle live query with a different key is
       * recreated — `resume` + this turn's resolved options, never setModel
       * (spike D3) — silently: the user asked for it.
       */
      modelSwitch?: boolean;
    },
  ): Promise<ActiveSession> {
    const snapshot: AuditSnapshot = {
      ip: requestContext ? getTrustedClientIpOrUndefined(requestContext) : undefined,
      userAgent: requestContext?.req.header('user-agent'),
    };

    const binding = turnBindingFrom(resolved);
    const key = liveQueryKey(binding);
    const existing = this.sessions.get(breezeSessionId);
    if (existing && existing.state !== 'closed') {
      // Spec §9.2: a live SDK query is reused only while connection id,
      // config_version, catalog revision, wire model and wire fingerprint are
      // unchanged — the subprocess's env and model are fixed at creation.
      if (existing.liveKey !== key || existing.forceRecreate) {
        if (existing.state === 'processing') {
          // Rotation applies on the next turn. Reusing the live session here
          // lets the route's existing concurrent-message guard return a 409
          // without killing an in-flight stream mid-response.
        } else if (existing.state === 'idle') {
          if (existing.liveKey !== key && options?.modelSwitch) {
            console.info('[StreamingSessionManager] model switch: recreating the idle query with resume', {
              breezeSessionId, from: existing.liveKey, to: key,
            });
          } else if (existing.liveKey !== key) {
            console.info(
              '[StreamingSessionManager] rotating idle AI session after model/provider change',
              { breezeSessionId, from: existing.liveKey, to: key },
            );
            existing.eventBus.publish({
              type: 'error',
              message: 'AI provider configuration changed — please resend your message',
            });
            existing.eventBus.publish({ type: 'done' });
          }
          this.remove(breezeSessionId);
        }
      }

      const reusable = this.sessions.get(breezeSessionId);
      if (reusable && reusable.state !== 'closed') {
        // Update per-request context. Device-bound sessions re-narrow the fresh
        // request auth to the session org every time (#3087) — `toolAuth` must
        // never revert to the raw login scope on a follow-up message. Narrow
        // against the freshly-loaded `dbSession.orgId`, not the possibly-stale
        // `existing.orgId` snapshot captured at session creation — this is the
        // current DB value, so it survives the device being moved to a
        // different org mid-session.
        // #5022 W01: re-mint the chat origin on the REFRESHED auth. Stamping
        // only at creation loses the origin on every follow-up message, since
        // the request auth handed in here is built fresh per request.
        const refreshedAuthWithOrigin = withChatAiOrigin(auth, breezeSessionId);
        reusable.auth = refreshedAuthWithOrigin;
        reusable.toolAuth = buildChatSessionToolAuth(
          refreshedAuthWithOrigin,
          dbSession.orgId,
          reusable.deviceId,
          dbSession.writeDefaultOrgId,
        );
        reusable.auditSnapshot = snapshot;
        reusable.allowedTools = allowedTools;
        // Topology fields are NOT touched here (PR #7147 F1): this session may
        // be processing another request's turn, which this caller is about to
        // lose with a 409. Rebinding here streamed the running turn into the
        // loser's (then aborted) runtime and cleared a cap stop mid-turn. The
        // winner of `tryTransitionToProcessing` binds its runtime there.
        // Re-resolve the approval mode so a settings change applies to the NEXT
        // message rather than only to a brand-new in-memory session (#5593).
        // Skipped while a turn is in flight: the route answers a concurrent
        // message with 409, and swapping the mode mid-turn would change the
        // gate the running turn already started under. The state is re-checked
        // AFTER the await as well — a concurrent request can transition the
        // session to `processing` while this lookup is outstanding, and the
        // assignment must not land behind a turn that already started.
        if (reusable.state !== 'processing') {
          // Same for the approval timeout (#6475): a settings change applies
          // from the next message, never to a turn already in flight.
          const [refreshedApprovalMode, refreshedWaitBudgetMs] = await Promise.all([
            loadApprovalMode(dbSession.orgId),
            loadApprovalWaitBudgetMs(dbSession.orgId),
          ]);
          // Re-read through the map rather than the narrowed `reusable` alias:
          // a concurrent request may have started a turn — or evicted the
          // session entirely — while this lookup was outstanding.
          const stateAfterLookup = this.sessions.get(breezeSessionId)?.state;
          if (stateAfterLookup && stateAfterLookup !== 'processing') {
            reusable.approvalMode = refreshedApprovalMode;
            reusable.approvalWaitBudgetMs = refreshedWaitBudgetMs;
          }
        }
        reusable.lastActivityAt = Date.now();
        return reusable;
      }
    }

    // Create new session components
    const inputController = new StreamInputController();
    const eventBus = new SessionEventBus();
    const abortController = new AbortController();

    if (dbSession.sdkSessionId) {
      inputController.setSdkSessionId(dbSession.sdkSessionId);
    }

    const [approvalMode, approvalWaitBudgetMs] = await Promise.all([
      loadApprovalMode(dbSession.orgId),
      loadApprovalWaitBudgetMs(dbSession.orgId),
    ]);

    // Catalog provenance stamp only (below). A gateway connection (W06) has no
    // catalog revision: its provenance is llm_egress_events.connection_id and
    // ai_invocations.connection_id, so the stamp clears both columns.
    const connectionConfig = resolved.connection.config;
    const catalogEndpoint = connectionConfig.source === 'gateway' ? null : catalogEndpointOf(connectionConfig);

    // Device-bound sessions execute tools under the DEVICE's org, not the
    // login org (#3087). `toolAuth` (MCP tool handlers + their RLS context)
    // is narrowed to the session org; `auth` stays raw so RBAC, rate limits,
    // and audit attribution keep resolving the login identity/role.
    const deviceId = dbSession.deviceId ?? null;
    // #5022 W01: the AI-surface mint site for interactive chat. `breezeSessionId`
    // IS the persisted `ai_sessions.id`, so it is the id a device-page chip can
    // resolve back to a conversation. Applied to BOTH `auth` and `toolAuth`:
    // the act/verify bypass lanes read the carrier off `auth`, while every
    // MCP tool handler reads `toolAuth`.
    const authWithOrigin = withChatAiOrigin(auth, breezeSessionId);
    const toolAuth = buildChatSessionToolAuth(
      authWithOrigin,
      dbSession.orgId,
      deviceId,
      dbSession.writeDefaultOrgId,
    );

    // Tenant (BYO MCP) tools — Task A10. Script-builder / client-AI sessions
    // supply their own `mcpServerFactory` and keep their own (non-Breeze)
    // server, so they never resolve tenant tools.
    //
    // A throw here (a source unreachable, a decrypt failure, a Redis blip in
    // the resolver's own guardrail checks) must not fail the WHOLE chat turn
    // — the MCP surface deliberately degrades per-source (see
    // toolSources/discovery.ts), so a session simply loses its tenant tools
    // for this turn rather than erroring out entirely. Mirrors
    // `loadApprovalMode`'s degrade-on-failure shape above.
    let tenantDescriptors: TenantToolDescriptor[] = [];
    if (!mcpServerFactory) {
      try {
        // `dbSession.orgId` is this session's pinned, already-access-checked
        // org (see the device-bound comment above) — passed as `targetOrgId`
        // so a partner-scoped tech's session can resolve that org's own tool
        // sources too, not just partner-wide ones (#6023). A no-op for
        // org-scoped `toolAuth`, which ignores `targetOrgId`.
        tenantDescriptors = await resolveTenantTools(toolAuth, dbSession.orgId);
      } catch (err) {
        captureException(err);
        console.error('[StreamingSessionManager] Failed to resolve tenant tools, degrading to none:', err);
      }
    }
    const tenantToolsByName = new Map(tenantDescriptors.map((d) => [d.qualifiedName, d]));

    // Build partial session object so callbacks can reference it.
    // query and processorPromise are filled in after creation.
    const now = Date.now();
    const resumeSdkSessionId = dbSession.sdkSessionId ?? undefined;
    // W11: the canary is sticky per breeze session — the same session keeps
    // its variant across query re-creations while the registry is unchanged.
    const promptProvenance = promptProvenanceFor({
      surface: binding.surface, profile: resolved.promptProfile, subjectId: breezeSessionId,
    });
    const session: ActiveSession = {
      breezeSessionId,
      orgId: dbSession.orgId,
      deviceId,
      liveKey: key,
      turnBinding: binding,
      turnDisplay: turnDisplayFrom(resolved),
      promptProvenance,
      ledgerUserId: options?.ledgerUserId ?? null,
      refusalObservation: newSdkTurnObservation(),
      forceRecreate: false,
      budgetReservationId: options?.budgetReservationId,
      revokeEgressGrant: undefined,
      sdkSessionId: dbSession.sdkSessionId,
      query: null as unknown as Query, // set below
      abortController,
      inputController,
      eventBus,
      state: 'initializing',
      lastActivityAt: now,
      createdAt: now,
      auth: authWithOrigin,
      toolAuth,
      auditSnapshot: snapshot,
      mcpServer: null as unknown as McpSdkServerConfigWithInstance, // set below
      mcpPrefix: MCP_PREFIX, // updated below if custom factory
      toolUseIdQueue: [],
      pendingTurnUsage: emptyPendingTurnUsage(),
      pendingTurnToolExecutionCount: 0,
      toolUseNames: new Map(),
      processorPromise: Promise.resolve(),
      turnTimeoutId: null,
      approvalWaitDeadline: null,
      approvalWaitAbort: null,
      pendingApprovalWaits: 0,
      approvalMode,
      approvalWaitBudgetMs,
      allowedTools,
      // Seeds a brand-new session only; a reused session is never rebound
      // here (see the reuse branch and tryTransitionToProcessing).
      topologyInvestigation: options?.topologyInvestigation,
      topologyStopped: false,
      isPaused: false,
      activePlanId: null,
      approvedPlanSteps: new Map(),
      currentPlanStepIndex: 0,
      planApprovalResolver: null,
      pendingRunResults: [],
      tenantTools: tenantToolsByName,
    };

    // Create session-scoped callbacks (close over session object)
    const preToolUse = createSessionPreToolUse(session);
    const postToolUse = createSessionPostToolUse(session);

    // Create MCP server with pre/post tool-use callbacks
    // Use custom factory if provided (e.g., script builder), otherwise default to breeze tools
    let mcpServer: McpSdkServerConfigWithInstance;
    let mcpServerName = 'breeze';
    if (mcpServerFactory) {
      const custom = mcpServerFactory(() => session.toolAuth, preToolUse, postToolUse, () => session);
      mcpServer = custom.server;
      mcpServerName = custom.name;
    } else {
      mcpServer = createBreezeMcpServer(
        () => session.toolAuth,
        preToolUse,
        postToolUse,
        () => session,
        // `session.orgId` is set ONCE at session creation and never refreshed
        // on reuse (unlike `session.toolAuth`, which the reuse branch above
        // re-narrows to the CURRENT device org every turn, #3087). Since
        // `execute.ts` now threads this org through the dispatch-time
        // OWNER-predicate reload (#6023), a stale `session.orgId` would let a
        // device-bound session keep dispatching a tool under its OLD org's
        // credentials after the device moved — read `session.toolAuth.orgId`
        // (fresh every turn for a device-bound session) and fall back to
        // `session.orgId` only when `toolAuth` carries none (non-device
        // sessions, whose org doesn't drift the same way).
        buildTenantSdkTools(tenantDescriptors, () => session.toolAuth, () => session.toolAuth.orgId ?? session.orgId),
      );
    }
    session.mcpServer = mcpServer;
    session.mcpPrefix = `mcp__${mcpServerName}__`;

    const maxTurns = Math.max(1, dbSession.maxTurns - dbSession.turnCount);

    // Inject approval mode instructions into system prompt
    let effectiveSystemPrompt = systemPrompt;
    if (options?.injectApprovalModeInstructions !== false && approvalMode !== 'per_step') {
      const modeInstructions: Record<string, string> = {
        auto_approve: '\n\n## Approval Mode\nTier 2 tools execute without individual approval and are audit logged. Tier 3 destructive or remote-control tools still require explicit approval.',
        action_plan: '\n\n## Approval Mode\nWhen executing multiple Tier 2+ operations, call `propose_action_plan` first with all planned steps. Wait for approval. Execute steps in order. Do NOT deviate from the approved plan.',
        hybrid_plan: '\n\n## Approval Mode\nWhen executing multiple Tier 2+ operations, call `propose_action_plan` first. Wait for approval. Execute steps in order. Screenshots will be captured between steps. The user can click Stop to abort. Do NOT deviate from the approved plan.',
      };
      effectiveSystemPrompt += modeInstructions[approvalMode] ?? '';
    }

    // ── Catalog egress grant (#3922 phase 2) ────────────────────────────────
    // A catalog session's subprocess may open exactly one destination, through
    // the local allowlisting CONNECT proxy. The grant must exist BEFORE the
    // child env is built (it carries the proxy URL) and before query() spawns
    // the subprocess. Any failure here propagates: fail loud, never start an
    // unproxied child (phase-1 invariant).
    //
    // Taken as late as possible, immediately before the try/catch that
    // releases it: anything that throws between the grant and that catch —
    // `mcpServerFactory`, `createBreezeMcpServer` — would otherwise leak the
    // grant until the process restarted, since `remove()` never runs for a
    // session that was never registered.
    // Shared with agent runs (aiModels/connectionFactory.prepareSdkChild, the
    // one SDK-child seam): the child env plus every grant it needs — an
    // audited CONNECT grant for a catalog connection, a gateway grant and a
    // deny-all proxy grant for a gateway connection (W06), nothing otherwise.
    const child = await prepareSdkChild(resolved, {
      key: breezeSessionId, orgId: dbSession.orgId, aiSessionId: breezeSessionId,
    });
    const revokeEgressGrant = child.revoke;
    session.revokeEgressGrant = revokeEgressGrant;

    // Durable per-session provenance (#3922 phase 2). `billing_source` stays
    // 'partner_key' for direct and catalog BYOK alike, so these two columns are
    // the only record in the ledger of WHICH third party processed a session's
    // content — and of which immutable revision's URL/model map/pricing it ran
    // under. Written on every create (including back to NULL when a partner
    // unpins and the session rotates) so the row can never describe a routing
    // the session is no longer using. Best-effort: provenance bookkeeping must
    // not take AI away from a partner whose traffic is already correctly pinned
    // and already audited in `llm_egress_events`.
    //
    // Self-contexted (#2190/#1375, mirroring `recordUsage`): the ambient
    // request context can be closed or org-scoped by the time this runs, and a
    // contextless write under forced RLS matches 0 rows SILENTLY. Wrapped in
    // `dbWriteExpectingRows` so that 0-row case is loud, because the two
    // directions of this write fail asymmetrically: a lost STAMP leaves a row
    // with no claim (under-reported), while a lost CLEAR leaves a row still
    // claiming a catalog the session no longer uses — a FALSE provenance
    // claim, and the worse of the two. The row count is the only thing that
    // makes either detectable.
    try {
      await withSystemDbAccessContext(() => dbWriteExpectingRows(
        'streamingSessionManager.stampCatalogProvenance',
        () => db
          .update(aiSessions)
          .set({
            catalogEntryId: catalogEndpoint?.catalogEntryId ?? null,
            catalogRevisionId: catalogEndpoint?.revisionId ?? null,
          })
          .where(eq(aiSessions.id, breezeSessionId))
          .returning({ id: aiSessions.id }),
      ));
    } catch (err) {
      // `org_id` and `cas_label`, NOT `service`/`orgId`/`sessionId`:
      // `setCallerTags` drops every key outside ALLOWED_TAG_NAMES, so a
      // camelCase tag is a silent no-op. `cas_label` is the allowlist's
      // designated call-site discriminator (hardcoded literal, no identifiers)
      // and is what keeps this out of the manager's shared bare-capture bucket;
      // the session id is high-cardinality and stays in the log line only.
      captureException(err, undefined, {
        org_id: dbSession.orgId,
        cas_label: 'streamingSessionManager.stampCatalogProvenance',
      });
      console.error(
        '[StreamingSessionManager] Failed to stamp catalog provenance on session:',
        breezeSessionId,
        err,
      );
    }

    // CRITICAL: Create SDK query and background processor OUTSIDE the request's
    // AsyncLocalStorage DB context. The auth middleware wraps requests in a
    // transaction (via withDbAccessContext). Without this escape hatch, the SDK's
    // tool handlers inherit the transaction context and hang after the HTTP
    // request completes and the transaction commits.
    const stderrLog = createSdkStderrRedactor((text) => console.error('[SDK-stderr]', breezeSessionId, text));
    session.flushSdkStderr = () => stderrLog.flush();
    try {
      runOutsideDbContextSafe(() => {
        const childEnv = child.env;
        const toolSearchPolicy = resolveToolSearchPolicy({
          surfaceSearch: options?.toolSearch === true,
          childEnv,
          remainingTurns: maxTurns,
        });
        const sdkQuery = query({
          prompt: inputController.getInputStream(),
          options: {
            systemPrompt: renderSystemPrompt(effectiveSystemPrompt, session.promptProvenance),
            // model (the resolver's wire id — a catalog endpoint's own id),
            // fallbackModel (the refusal fallback) and thinking/effort: all
            // from the resolved model, nothing derived here.
            ...sdkModelOptions(resolved),
            maxTurns,
            maxBudgetUsd,
            tools: toolSearchPolicy.tools,
            allowedTools: allowedTools ?? [...BREEZE_MCP_TOOL_NAMES, ...tenantMcpToolNames(tenantDescriptors)],
            mcpServers: { [mcpServerName]: mcpServer },
            includePartialMessages: true,
            abortController,
            env: { ...childEnv, ...toolSearchPolicy.env },
            // Gateway connections only: an empty temp working directory, so
            // the environment context sent upstream names no host path.
            ...(child.cwd !== undefined ? { cwd: child.cwd } : {}),
            // Gateway connections only, after maxBudgetUsd: the registry price
            // of the bound models, so the SDK's budget cap is not a guess.
            ...(child.queryOptions ?? {}),
            resume: resumeSdkSessionId,
            persistSession: true,
            settingSources: [],
            // Redacted per complete line, never per chunk (see createSdkStderrRedactor).
            stderr: (data: string) => stderrLog.write(data),
          }
        });

        (session as { query: Query }).query = sdkQuery;

        // Start background processor (inherits the clean context)
        (session as { processorPromise: Promise<void> }).processorPromise = this.runBackgroundProcessor(session);
        session.processorPromise.catch((err) => {
          captureException(err);
          console.error('[StreamingSessionManager] Background processor error:', err);
        }).finally(() => stderrLog.flush());
      });
    } catch (err) {
      // The subprocess never started (a rejected child env, a query() throw).
      // Release the egress grant here — the session was never registered in
      // `this.sessions`, so `remove()` will never run for it and the grant
      // would leak until the process restarted. The grant is taken immediately
      // above this block precisely so there is no un-covered window.
      // Reported, never rethrown: the teardown must not mask `err`.
      try { revokeEgressGrant(); } catch (revokeErr) {
        captureException(revokeErr);
        console.error('[StreamingSessionManager] Failed to revoke LLM egress grant:', breezeSessionId, revokeErr);
      }
      throw err;
    }

    // Enforce max active sessions via LRU eviction
    if (this.sessions.size >= MAX_ACTIVE_SESSIONS) {
      this.evictLeastRecentlyActive();
    }

    this.sessions.set(breezeSessionId, session);

    return session;
  }

  /** Get an existing session without creating */
  get(sessionId: string): ActiveSession | undefined {
    return this.sessions.get(sessionId);
  }

  /** Remove a session (close query, clean up resources) */
  remove(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    session.state = 'closing';
    if (session.turnTimeoutId) {
      clearTimeout(session.turnTimeoutId);
      session.turnTimeoutId = null;
    }
    // Topology M4: a torn-down session never keeps unvalidated output or a lease.
    void this.abortTopologyTurn(session);
    try { session.inputController.close(); } catch (err) {
      captureException(err); console.error('[StreamingSessionManager] Failed to close input controller:', sessionId, err);
    }
    // Abort the SDK's AbortController first to signal in-flight MCP tool
    // handlers to stop. This prevents the race where handleControlRequest
    // completes after the subprocess is killed and tries to write a response
    // to the dead ProcessTransport — crashing the process.
    try { session.abortController.abort(); } catch (err) {
      captureException(err); console.error('[StreamingSessionManager] Failed to abort session controller:', sessionId, err);
    }
    try { session.query.close(); } catch (err) {
      captureException(err); console.error('[StreamingSessionManager] Failed to close SDK query:', sessionId, err);
    }
    // Release the child's grants (catalog CONNECT allowance; gateway grant +
    // deny-all proxy grant). Done on every teardown path — rotation, eviction,
    // processor exit — so a session that is going away cannot keep a tunnel
    // to the provider, or a gateway grant, open.
    try { session.revokeEgressGrant?.(); } catch (err) {
      captureException(err); console.error('[StreamingSessionManager] Failed to revoke LLM egress grant:', sessionId, err);
    }
    try { session.flushSdkStderr?.(); } catch { /* logging must not block teardown */ }
    session.eventBus.closeAll();
    session.state = 'closed';
    this.sessions.delete(sessionId);
  }

  /** Interrupt the current query for a session */
  async interrupt(sessionId: string): Promise<{ interrupted: boolean; reason?: string }> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return { interrupted: false, reason: 'Session not found in memory' };
    }
    if (session.state !== 'processing') {
      return { interrupted: false, reason: 'Session is not currently processing' };
    }

    try {
      // Settle any in-flight approval waits first: while a preToolUse approval
      // wait is blocking an MCP tool handler, query.interrupt() alone cannot
      // conclude the turn (#3089). The tier-3 intents stay pending_approval
      // and are still executed by the durable release worker once decided.
      settleApprovalWaits(session);
      await session.query.interrupt();
      return { interrupted: true };
    } catch (err) {
      captureException(err);
      console.error('[StreamingSessionManager] Interrupt failed:', err);
      return { interrupted: false, reason: 'Failed to interrupt SDK query' };
    }
  }

  /** Shutdown: clean up all sessions and stop eviction timer */
  shutdown(): void {
    if (this.evictionTimer) {
      clearInterval(this.evictionTimer);
      this.evictionTimer = null;
    }
    for (const sessionId of [...this.sessions.keys()]) {
      this.remove(sessionId);
    }
  }

  get activeCount(): number {
    return this.sessions.size;
  }

  /** Start the per-turn timeout. Publishes error + done if SDK hangs. */
  startTurnTimeout(session: ActiveSession): void {
    this.clearTurnTimeout(session);
    // New assistant cycle: reset the shared approval-wait budget (#3089) at
    // the same point this turn timeout resets, preserving the invariant that
    // a cycle's approval waits (<= the session's approvalWaitBudgetMs total,
    // 5 min by default) always leave headroom for the model to emit its
    // closing message before the turn timeout (budget + 60s) fires.
    // Guarded: never reset while a wait is actually in flight (waits only run
    // in the tool phase, between assistant messages) — EXCEPT when the
    // deadline is already exhausted, where an in-flight wait is settling
    // within milliseconds anyway and skipping the reset would poison every
    // later cycle with a permanently zero budget.
    if (
      session.pendingApprovalWaits === 0
      || (session.approvalWaitDeadline ?? Infinity) <= Date.now()
    ) {
      session.approvalWaitDeadline = null;
      session.approvalWaitAbort = null;
    }
    session.turnTimeoutId = setTimeout(() => {
      if (session.state === 'processing') {
        console.error('[StreamingSessionManager] Turn timeout for session:', session.breezeSessionId);
        // The timeout can fire while approval waits are still blocked (e.g.
        // long-running sibling tools delayed the first wait's start past the
        // headroom window). Settle them so the SDK turn can actually conclude
        // in the background instead of holding the subprocess for the rest of
        // the 5-minute wait (#3089).
        settleApprovalWaits(session);
        if (session.topologyInvestigation) {
          // Topology M4 (C1): a timed-out investigation must not keep running
          // behind a cleared gate. Seal first (so nothing the provider still
          // emits takes a generic path), then tear the session down, which
          // discards the runtime and its lease, aborts in-flight tool
          // handlers and closes the SDK query. The next message rebuilds the
          // session from its row.
          session.topologyTurnSealed = true;
          session.eventBus.publish({ type: 'error', message: 'AI request timed out. Please try again.' });
          session.eventBus.publish({ type: 'done' });
          this.remove(session.breezeSessionId);
          return;
        }
        this.stopThinking(session);
        // #7794: a model-gateway failure behind the timeout (the CLI keeps
        // retrying it) is the actionable part; say it.
        const gatewayNote = takeGatewayFailureNote(session.breezeSessionId);
        session.eventBus.publish({
          type: 'error',
          message: gatewayNote ? `AI request timed out. ${gatewayNote}` : 'AI request timed out. Please try again.',
        });
        session.eventBus.publish({ type: 'done' });
        session.state = 'idle';
      }
    }, turnTimeoutMsFor(session.approvalWaitBudgetMs ?? DEFAULT_APPROVAL_WAIT_BUDGET_MS));
  }

  /**
   * Topology M4 Task 3: end a topology turn. Only a validated (or the fixed
   * fallback / scope-changed) explanation is published, and only an
   * `explanation`/`fallback` outcome is persisted — as the structured answer,
   * never raw text. Failure, cancellation and cap paths discard.
   */
  private async finishTopologyTurn(session: ActiveSession, succeeded: boolean): Promise<void> {
    const runtime = session.topologyInvestigation;
    if (!runtime) return;
    session.topologyInvestigation = undefined;
    if (!succeeded || session.topologyStopped) {
      await runtime.abort().catch((err) => captureException(err));
      session.eventBus.publish({
        type: 'error',
        message: session.topologyStopped
          ? 'This investigation reached its limit. Start a new investigation to continue.'
          : 'The topology explanation could not be completed.',
      });
      session.topologyStopped = false;
      return;
    }
    session.eventBus.publish({ type: 'topology_progress', phase: 'validating' });
    let result;
    try {
      result = await runtime.complete();
    } catch (err) {
      captureException(err);
      session.eventBus.publish({ type: 'error', message: 'The topology explanation could not be completed.' });
      return;
    }
    session.eventBus.publish({ type: 'topology_explanation', explanation: result.explanation });
    if (result.outcome === 'scope_changed') return;
    try {
      await withDbAccessContext(
        { scope: 'organization', orgId: session.orgId, accessibleOrgIds: [session.orgId] },
        () => db.insert(aiMessages).values({
          sessionId: session.breezeSessionId,
          role: 'assistant',
          content: JSON.stringify(result.explanation),
          contentBlocks: [{ type: 'topology_explanation', explanation: result.explanation }] as unknown as Record<string, unknown>[],
        }),
      );
    } catch (err) {
      captureException(err);
      console.error('[StreamingSessionManager] Failed to save topology explanation:', err);
    }
  }

  /** Discard an unfinished topology turn (idempotent). */
  private async abortTopologyTurn(session: ActiveSession): Promise<void> {
    const runtime = session.topologyInvestigation;
    if (!runtime) return;
    session.topologyInvestigation = undefined;
    session.topologyStopped = false;
    await runtime.abort().catch((err) => captureException(err));
  }

  /** Clear the per-turn timeout (called when 'result' arrives) */
  clearTurnTimeout(session: ActiveSession): void {
    if (session.turnTimeoutId) {
      clearTimeout(session.turnTimeoutId);
      session.turnTimeoutId = null;
    }
  }

  // ============================================
  // Background SDK Processor
  // ============================================

  private async runBackgroundProcessor(session: ActiveSession): Promise<void> {
    let currentMessageId = crypto.randomUUID();
    let messageStarted = false;
    // #5106: whether a text content block has already started for the
    // CURRENT assistant message. A turn can be text -> tool_use -> text (the
    // model narrates, calls a tool, then reports back) — without a separator
    // between the two text blocks, every client concatenates them raw
    // ("...last night.Here's a summary"). Reset at message_start, alongside
    // `messageStarted` above.
    let sawTextBlockThisMessage = false;

    try {
      for await (const message of session.query) {
        // Stop publishing if session is being torn down
        if (session.state === 'closing' || session.state === 'closed') break;
        // A sealed topology turn (timed out) never publishes or persists again.
        if (session.topologyTurnSealed) break;

        // W03 Task 5: every message of the turn feeds the refusal observation
        // (it reads only the model_refusal_* system messages). The served
        // model is taken from what was observed, never assumed.
        observeSdkMessage(session.refusalObservation, message);
        if (session.refusalObservation.refusalFallback) {
          // A session-scope refusal fallback swaps a live query's model for
          // the rest of its life; our binding says otherwise. Rebuild (with
          // resume) before the next turn rather than run an unbound model.
          session.forceRecreate = true;
        }

        switch (message.type) {
          case 'system': {
            if ('subtype' in message && message.subtype === 'init' && 'session_id' in message) {
              const sid = message.session_id;
              session.sdkSessionId = sid;
              session.inputController.setSdkSessionId(sid);

              withDbAccessContext(
                { scope: 'organization', orgId: session.orgId, accessibleOrgIds: [session.orgId] },
                () =>
                  db.update(aiSessions)
                    .set({ sdkSessionId: sid })
                    .where(eq(aiSessions.id, session.breezeSessionId))
              ).catch((err) => { captureException(err); console.error('[StreamingSessionManager] Failed to store SDK session ID:', err); });
            }

            if (session.state === 'initializing') {
              session.state = 'ready';
            }
            break;
          }

          case 'stream_event': {
            const event = message.event;

            if (event.type === 'message_start') {
              currentMessageId = crypto.randomUUID();
              messageStarted = true;
              sawTextBlockThisMessage = false;
              // Reset turn timeout — SDK is actively producing output
              this.startTurnTimeout(session);
              // Same signal, for eviction: a new assistant message is stream
              // progress. Unlike the OpenAI twin, a turn here can run entirely
              // through tool_use blocks and emit no text delta at all, so the
              // message boundary is the only keepalive some turns ever get.
              session.lastActivityAt = Date.now();
              session.eventBus.publish({ type: 'message_start', messageId: currentMessageId });
            } else if (event.type === 'content_block_delta') {
              if ('delta' in event && (event.delta.type === 'thinking_delta' || event.delta.type === 'signature_delta')) {
                // W05: a long think is stream progress, not a wedged turn.
                session.lastActivityAt = Date.now();
              } else if ('delta' in event && event.delta.type === 'text_delta') {
                // Stream progress keeps the turn alive for eviction purposes.
                session.lastActivityAt = Date.now();
                // Topology M4: raw provider text goes to the server-only output
                // gate at THIS publish point — never onto the bus/replay ring.
                if (session.topologyInvestigation) session.topologyInvestigation.append(event.delta.text);
                else session.eventBus.publish({ type: 'content_delta', delta: event.delta.text });
              }
            } else if (event.type === 'content_block_start') {
              if ('content_block' in event
                && (event.content_block.type === 'thinking' || event.content_block.type === 'redacted_thinking')) {
                // W05: never a silent pause while the model reasons (spec §11).
                // The block's text is empty without `thinkingDisplay` (W01 D1),
                // so the stream carries a state, not text. Topology turns
                // publish fixed phases only and are excluded.
                session.lastActivityAt = Date.now();
                if (!session.topologyInvestigation) {
                  if (session.thinkingBlockIndex == null) {
                    session.eventBus.publish({ type: 'thinking_state', state: 'started' });
                  }
                  session.thinkingBlockIndex = event.index;
                }
              } else if ('content_block' in event && event.content_block.type === 'text') {
                // #5106: every text content_block_start AFTER the first one in
                // this assistant message means a tool_use block sat between
                // two text blocks (text -> tool_use -> text). Emit a
                // paragraph-break delta so streamed clients don't concatenate
                // them raw; `assistantContent` below joins with the SAME
                // separator so persisted history matches the stream
                // byte-for-byte.
                if (session.topologyInvestigation) {
                  // Topology M4: narration blocks are never the answer; only the
                  // final text block is parsed, and no separator is published.
                  session.topologyInvestigation.startBlock();
                } else if (sawTextBlockThisMessage) {
                  session.eventBus.publish({ type: 'content_delta', delta: '\n\n' });
                }
                sawTextBlockThisMessage = true;
              } else if (
                'content_block' in event
                && event.content_block.type === 'tool_use'
                // A-W04: ToolSearch never reaches the MCP hooks — queueing it
                // would misattribute the next postToolUse and turn its result
                // into a #3094 "rejected before execution" drop.
                && !isSdkBuiltinToolUse(event.content_block.name)
              ) {
                const block = event.content_block;

                // Track toolUseId for postToolUse correlation.
                // content_block_start fires before the tool executes;
                // postToolUse shifts the queue after execution.
                session.toolUseIdQueue.push(block.id);
                const bareStreamToolName = block.name.startsWith(session.mcpPrefix)
                  ? block.name.slice(session.mcpPrefix.length)
                  : block.name;
                // Name lookup for the dropped-call fallback (#3094): if the
                // SDK rejects this call before the MCP handler runs, the
                // orphaned tool_result only carries the id, not the name.
                session.toolUseNames?.set(block.id, bareStreamToolName);

                // Topology M4: a fixed phase, never the model's tool name/arguments.
                session.eventBus.publish(session.topologyInvestigation
                  ? { type: 'topology_progress', phase: 'gathering_evidence' }
                  : {
                    type: 'tool_use_start',
                    toolName: bareStreamToolName,
                    toolUseId: block.id,
                    input: {},
                  });
              }
            } else if (event.type === 'content_block_stop' && event.index === session.thinkingBlockIndex) {
              this.stopThinking(session);
            } else if (event.type === 'message_delta') {
              if (messageStarted) {
                session.eventBus.publish({
                  type: 'message_end',
                  inputTokens: 0,
                  outputTokens: event.usage?.output_tokens ?? 0,
                });
                messageStarted = false;
              }
            }
            break;
          }

          case 'assistant': {
            // Accumulate per-API-call usage as the fallback token source for
            // this turn's cost recording (#3095). Each SDK assistant message
            // wraps one model API response whose `usage` is authoritative for
            // that call; the turn's `result` message *should* aggregate these,
            // but has been observed arriving with missing/zero usage.
            const apiUsage = message.message.usage as {
              input_tokens?: number;
              output_tokens?: number;
              cache_read_input_tokens?: number | null;
              cache_creation_input_tokens?: number | null;
            } | undefined;
            if (apiUsage) {
              session.pendingTurnUsage.inputTokens += apiUsage.input_tokens ?? 0;
              session.pendingTurnUsage.outputTokens += apiUsage.output_tokens ?? 0;
              session.pendingTurnUsage.cacheReadInputTokens += apiUsage.cache_read_input_tokens ?? 0;
              session.pendingTurnUsage.cacheCreationInputTokens += apiUsage.cache_creation_input_tokens ?? 0;
            }

            // Topology M4: bounded per-call input and cumulative output; the
            // raw assistant content and tool_use rows are NEVER persisted or
            // republished — only the validated answer is, at `result`.
            if (session.topologyInvestigation) {
              const withinBudget = session.topologyInvestigation.noteUsage({
                inputTokens: (apiUsage?.input_tokens ?? 0) + (apiUsage?.cache_read_input_tokens ?? 0) + (apiUsage?.cache_creation_input_tokens ?? 0),
                outputTokens: apiUsage?.output_tokens ?? 0,
              });
              if (!withinBudget && !session.topologyStopped) {
                session.topologyStopped = true;
                void Promise.resolve().then(() => session.query.interrupt()).catch(() => undefined);
              }
              break;
            }

            // #5106: joined with the SAME "\n\n" separator the stream emits
            // at each non-first text content_block_start, so persisted
            // history is byte-for-byte identical to what streamed clients saw.
            const assistantContent = message.message.content
              .filter((b: { type: string }) => b.type === 'text')
              .map((b: { type: string; text?: string }) => b.text ?? '')
              .join('\n\n');

            try {
              await withDbAccessContext(
                { scope: 'organization', orgId: session.orgId, accessibleOrgIds: [session.orgId] },
                () =>
                  db.insert(aiMessages).values({
                    sessionId: session.breezeSessionId,
                    role: 'assistant',
                    content: assistantContent || null,
                    // SR5-16: the assistant content blocks embed each tool_use's
                    // raw `input`, so redact those here too — otherwise the same
                    // plaintext secret persisted below in `tool_input` would still
                    // land here in cleartext.
                    contentBlocks: message.message.content.map((b) =>
                      b.type === 'tool_use'
                        ? { ...b, input: redactSensitiveToolInput(b.input as Record<string, unknown>) }
                        : b,
                    ) as unknown as Record<string, unknown>[],
                    inputTokens: message.message.usage?.input_tokens ?? 0,
                    outputTokens: message.message.usage?.output_tokens ?? 0,
                  })
              );
            } catch (err) {
              captureException(err);
              console.error('[StreamingSessionManager] Failed to save assistant message:', err);
            }

            for (const block of message.message.content) {
              // ToolSearch stays in the assistant row's contentBlocks above but
              // gets no tool row or tool card (A-W04).
              if (block.type === 'tool_use' && !isSdkBuiltinToolUse(block.name)) {
                const bareName = block.name.startsWith(session.mcpPrefix)
                  ? block.name.slice(session.mcpPrefix.length)
                  : block.name;
                // SR5-16: mask known-sensitive keys (accessKey, secretKey,
                // password, token, apiKey, clientSecret, privateKey,
                // connectionString, …) before persisting OR publishing.
                // Unconditional — this runs even for tool calls the user
                // later denies, and for the live SSE copy below.
                const redactedInput = redactSensitiveToolInput(block.input as Record<string, unknown>);

                try {
                  await withDbAccessContext(
                    { scope: 'organization', orgId: session.orgId, accessibleOrgIds: [session.orgId] },
                    () =>
                      db.insert(aiMessages).values({
                        sessionId: session.breezeSessionId,
                        role: 'tool_use',
                        toolName: bareName,
                        toolInput: redactedInput,
                        toolUseId: block.id,
                      })
                  );
                } catch (err) {
                  captureException(err);
                  console.error('[StreamingSessionManager] Failed to save tool_use message:', err);
                }

                // Sweep E6: the `tool_use_start` published earlier for this
                // same block carried `input: {}` (real args aren't known at
                // content_block_start) — now that they are, tell the live
                // client so its tool row's label/preview matches what a
                // history reload of the row just persisted above would show.
                session.eventBus.publish({
                  type: 'tool_use_input',
                  toolUseId: block.id,
                  input: redactedInput,
                });
              }
            }
            break;
          }

          case 'user': {
            // Ordinary user content is skipped (the SDK replays user messages
            // during resume; they are already in DB). BUT this is also the only
            // place a tool_result the model received WITHOUT our MCP handler
            // running is visible: when the SDK rejects a tool call before
            // dispatch (e.g. a -32602 input-schema validation failure), the
            // model is fed an error tool_result while preToolUse/postToolUse
            // never fire — historically leaving NO ai_messages row, NO SSE
            // event, and a stale toolUseIdQueue entry that misattributes every
            // subsequent result (issue #3094: a set_device_context call with a
            // parenthesized details value vanished from the transcript while
            // the model saw a validation error and silently retried). Detect
            // exactly those orphans — a tool_result whose tool_use id is still
            // queued; postToolUse shifts the queue before the MCP call
            // returns, so normally-executed calls never match here, and
            // replayed history predates this process's queue — and record an
            // explicit error result instead of silence.
            const userContent = (message as SDKUserMessage).message?.content;
            if (Array.isArray(userContent)) {
              for (const block of userContent) {
                if (
                  typeof block === 'object' && block !== null &&
                  (block as { type?: string }).type === 'tool_result'
                ) {
                  await this.recordDroppedToolResult(
                    session,
                    block as { tool_use_id?: string; content?: unknown; is_error?: boolean },
                  );
                }
              }
            }
            break;
          }

          case 'result': {
            // Clear per-turn timeout on result
            this.clearTurnTimeout(session);
            // W05: a turn that ends mid-thought still closes the indicator.
            this.stopThinking(session);
            // The binding/display this turn ran under (read before anything
            // awaits; nothing can re-bind them while the turn is processing).
            const turnBinding = session.turnBinding;
            const turnDisplay = session.turnDisplay;
            // Topology M4: validate BEFORE anything is persisted or streamed.
            const topologyTurn = Boolean(session.topologyInvestigation);
            if (topologyTurn) {
              await this.finishTopologyTurn(session, (message as SDKResultMessage).subtype === 'success');
            }

            const resultMsg = message as SDKResultMessage;
            // #7794: the model gateway's reason for this turn's failure, if it
            // had one. Always taken here, so a note from a retry that later
            // recovered never surfaces on a later turn.
            const gatewayNote = takeGatewayFailureNote(session.breezeSessionId);
            // #3095: use the session's canonical org id (from the aiSessions DB
            // row — always set), NOT `auth.orgId`, which is null for partner-
            // and system-scoped users. The old guard on `auth.orgId` silently
            // skipped usage recording for EVERY turn of every session run by a
            // partner-scoped technician, leaving ai_sessions token counters at 0.
            const orgId = session.orgId;

            if (!orgId) {
              console.warn('[StreamingSessionManager] Skipping usage recording — no orgId on session', session.breezeSessionId);
              session.eventBus.publish({ type: 'done' });
              session.state = 'idle';
              break;
            }

            if (resultMsg.subtype !== 'success') {
              const errors = 'errors' in resultMsg ? resultMsg.errors : [];
              const errorMsg = errors.length > 0 ? errors[0] : `AI query ended: ${resultMsg.subtype}`;

              if (topologyTurn) {
                // A fixed error was already published; provider error text never reaches a topology turn.
              } else if (resultMsg.subtype === 'error_max_budget_usd') {
                session.eventBus.publish({ type: 'error', message: 'AI budget limit reached for this query.' });
              } else if (resultMsg.subtype === 'error_max_turns') {
                session.eventBus.publish({ type: 'error', message: 'Maximum conversation turns reached.' });
              } else {
                session.eventBus.publish({ type: 'error', message: gatewayNote ?? sanitizeErrorForClient(new Error(errorMsg ?? 'Unknown error')) });
              }
            } else if (gatewayNote && !topologyTurn && (resultMsg as { is_error?: unknown }).is_error === true) {
              // The CLI gave up on the upstream after its own retries and
              // reports that as a "success" flagged is_error: without this the
              // technician sees an empty turn with no error (#7794).
              session.eventBus.publish({ type: 'error', message: gatewayNote });
            }

            // W03: ONE cost, from the registry rate bound to this turn, over the
            // per-model DELTA of the SDK's cumulative modelUsage (W05 spike) —
            // never total_cost_usd, so #7667's running-total problem cannot
            // recur. The Office per-user ledger, the `done` event and the org
            // settlement all read this one number.
            const turn = await this.settleSdkTurn(session, resultMsg);

            // §9.1a: a refused final answer is explained, never a silent empty
            // turn. Topology turns never stream model text (their gate fails
            // through finishTopologyTurn); the ledger still records the refusal.
            if (turn.outcome.refused && !topologyTurn) {
              await this.publishRefusal(session, turn.outcome.refusalCategory);
            }

            // W05 (spike constraint 5): what actually ran — the served model and
            // applied options from the turn's OUTCOME, never the request — then
            // persisted so a reload shows exactly what was published.
            if (!topologyTurn) {
              await this.publishTurnModel(session, turnBinding, turnDisplay, turn.outcome);
            }

            // Signal this turn is done, but DON'T close the event bus —
            // session stays alive for follow-up messages. Carries usage so
            // client surfaces can render turn cost (turn_complete).
            session.eventBus.publish({
              type: 'done',
              usage: {
                inputTokens: turn.inputTokens,
                outputTokens: turn.outputTokens,
                costCents: turn.costCents,
              },
            });
            session.state = 'idle';
            break;
          }

          default:
            break;
        }
      }
    } catch (err) {
      captureException(reportableError(err));
      console.error('[StreamingSessionManager] Query error:', safeErrorMessage(err));
      this.stopThinking(session);
      // A topology turn never surfaces transport/provider text, sanitized or
      // not: it ends in the same fixed failure as a failed result (W06 made
      // this the only topology transport).
      const topologyTurn = Boolean(session.topologyInvestigation);
      await this.abortTopologyTurn(session);
      const gatewayNote = takeGatewayFailureNote(session.breezeSessionId);
      session.eventBus.publish({
        type: 'error',
        message: topologyTurn ? 'The topology explanation could not be completed.' : gatewayNote ?? sanitizeErrorForClient(err),
      });
      session.eventBus.publish({ type: 'done' });
    } finally {
      // W05: a turn that ended without a `result` mid-thought (teardown,
      // crash) still closes the indicator.
      this.stopThinking(session);
      // A turn that ended without a `result` (teardown, crash) discards any
      // unvalidated topology output and releases its lease.
      await this.abortTopologyTurn(session);
      // A turn that ended without a `result` (teardown mid-turn, subprocess
      // crash, iterator error) settles as `no_result` (W05 spike): ZERO billed,
      // usage_unconfirmed, the session's SDK usage snapshot left where it was —
      // so a resumed query's next delta picks up whatever the CLI persisted
      // (under-bill, never double-bill). Settling it releases the turn's
      // reservation instead of holding it for the indeterminate TTL. Awaited:
      // the common trigger is shutdown, where an untracked write is lost.
      if (
        session.budgetReservationId
        || hasTokens(session.pendingTurnUsage)
        || session.pendingTurnToolExecutionCount > 0
      ) {
        await this.settleSdkTurn(session, null);
      }

      // Only when a settlement failed AND marking it indeterminate at the time
      // failed too: retry the mark — never a re-settle (S5).
      for (const reservationId of session.unsettledReservationIds?.splice(0) ?? []) {
        try {
          // N12: no context wrap. markAiBudgetReservationIndeterminate opens its
          // own short SYSTEM transaction (runOutsideDbContext +
          // withSystemDbAccessContext), so an org context opened here is exited
          // immediately and only costs a pooled connection for the round trip.
          await markAiBudgetReservationIndeterminate({ orgId: session.orgId, reservationId });
        } catch (err) {
          const message = safeErrorMessage(err);
          captureException(new Error(`AI budget reservation not retained as indeterminate: ${message}`), undefined, {
            org_id: session.orgId, ai_reservation_id: reservationId,
          });
          console.error('[StreamingSessionManager] Failed to retain indeterminate budget reservation:', { reservationId, error: message });
        }
      }

      // Always clean up the session from the map after the processor exits
      this.clearTurnTimeout(session);
      if (this.sessions.get(session.breezeSessionId) === session) {
        this.remove(session.breezeSessionId);
      }
    }
  }

  /**
   * Persist + emit an explicit error tool_result for a tool call the SDK
   * rejected BEFORE our MCP handler ran (issue #3094).
   *
   * Detection contract: a tool_result block inside an SDK 'user' message whose
   * tool_use id is STILL in session.toolUseIdQueue was never seen by
   * createSessionPostToolUse (which shifts the queue synchronously before the
   * MCP call returns). For those calls nothing else will ever write the
   * transcript row or resolve the UI tool card, so this fallback:
   *  - removes the stale queue entry (it would misattribute every subsequent
   *    tool_result to the wrong toolUseId),
   *  - emits the SSE tool_result event (UI card resolves with the error),
   *  - persists the ai_messages tool_result row (transcript/audit review sees
   *    an explicit failure instead of a vanished call),
   *  - flags the session (parity with postToolUse's tool-failure auto-flag).
   */
  /**
   * Bill one Agent SDK turn through the single billing path (W03 Task 7) and
   * return the numbers every other consumer reports. `result` null = the turn
   * ended without one (abandoned / aborted): settled as `no_result`, zero.
   *
   * 1. the breeze session's previous SDK usage snapshot (W05 spike) — a turn
   *    whose snapshot cannot be read is settled as `no_result` too (never
   *    billed from an unknown baseline; the next turn's delta recovers it);
   * 2. sdkTurnUsage → per-model deltas of the cumulative modelUsage + the
   *    refusal outcome (served model as observed, never assumed);
   * 3. the registry quote (the same rate selection settleInvocation bills);
   * 4. the Office per-user hook FIRST (#5557: the client sub-cap must never
   *    see a turn the reservation already released), then settleInvocation,
   *    which advances the snapshot in the settlement transaction.
   */
  private async settleSdkTurn(
    session: ActiveSession,
    result: SDKResultMessage | null,
  ): Promise<{ inputTokens: number; outputTokens: number; costCents: number; outcome: TurnOutcome }> {
    const toolExecutionCount = session.pendingTurnToolExecutionCount;
    session.pendingTurnToolExecutionCount = 0;
    session.pendingTurnUsage = emptyPendingTurnUsage();
    const observation = session.refusalObservation;
    session.refusalObservation = newSdkTurnObservation();
    const binding = session.turnBinding;

    let billable: SdkResultLike | null = result;
    let previousSnapshot = null;
    if (result) {
      try {
        previousSnapshot = await readSdkUsageSnapshot({ orgId: session.orgId, sessionId: session.breezeSessionId });
      } catch (err) {
        captureException(reportableError(err));
        console.error('[StreamingSessionManager] SDK usage snapshot unreadable; turn settled as no_result:', safeErrorMessage(err));
        billable = null;
      }
    }
    const turn: SdkTurnUsageResult = sdkTurnUsage({ binding, observation, result: billable, previousSnapshot });
    const tokens = billedTokenTotals(turn.usage);

    // W09 (#7607, D5): a chat turn is never replayed on another model. A turn
    // that FAILED on a classified provider error before any output cools its
    // offering, so the next message resolves to a healthy fallback
    // (resolveModel). Fire-and-forget: the cooldown fails open.
    const turnFailed = !result || result.subtype !== 'success' || (result as { is_error?: unknown }).is_error === true;
    if (turnFailed && observation.providerFailure && !observation.sawOutput) {
      void noteProviderFailureForBinding(binding, observation.providerFailure.cause).catch((err) => {
        console.warn('[StreamingSessionManager] cooldown write failed:', safeErrorMessage(err));
      });
    }

    let costCents: number;
    try {
      costCents = await quoteInvocationCents(binding, turn.usage);
    } catch (err) {
      console.error('[StreamingSessionManager] registry quote failed; quoting the bound rate:', safeErrorMessage(err));
      costCents = sumCostCents(priceUsage(binding, turn.usage));
    }

    if (result && session.recordExtraUsage) {
      try {
        await session.recordExtraUsage({ ...tokens, costCents });
      } catch (err) {
        captureException(reportableError(err));
        console.error('[StreamingSessionManager] recordExtraUsage failed:', safeErrorMessage(err));
      }
    }

    const reservationId = session.budgetReservationId;
    // Detached from the session BEFORE settling: whatever happens below, the
    // finally must never settle this reservation a second time (S5).
    session.budgetReservationId = undefined;
    try {
      // Self-contexted (reservation / system transaction): no request context.
      const settled = await settleInvocation({
        binding,
        orgId: session.orgId,
        userId: session.ledgerUserId,
        sessionId: session.breezeSessionId,
        agentRunId: null,
        sourceRef: result ? null : 'abandoned_turn',
        usage: turn.usage,
        outcome: turn.outcome,
        reservationId,
        // W11: the live query's prompt, not the claimed binding's profile (a
        // reused query keeps the system prompt it was created with).
        prompt: session.promptProvenance,
        toolExecutionCount,
        turnCount: result ? (result.num_turns ?? 0) : 1,
        sdkUsage: {
          sessionId: session.breezeSessionId,
          nextSnapshot: turn.nextSnapshot,
          baseSnapshot: previousSnapshot,
          usageConfirmed: turn.usageConfirmed,
          usageNote: turn.usageNote,
        },
      });
      // S1: deferred but not persisted — recorded nowhere. Keep the
      // reservation held (indeterminate); settleInvocation already reported it.
      if (settled.unrecorded && reservationId) await this.retainUnsettled(session, reservationId);
    } catch (err) {
      const message = safeErrorMessage(err);
      captureException(new Error(`SDK turn settlement failed: ${message}`), undefined, {
        org_id: session.orgId, ...(reservationId ? { ai_reservation_id: reservationId } : {}),
      });
      console.error('[StreamingSessionManager] Failed to settle SDK turn usage:', { reservationId: reservationId ?? null, error: message });
      if (reservationId) await this.retainUnsettled(session, reservationId);
    }
    return { ...tokens, costCents, outcome: turn.outcome };
  }

  /**
   * Hold a reservation whose settlement failed as indeterminate NOW (a live
   * session can outlast the active TTL, which would otherwise expire the hold
   * as if nothing was spent). If even that fails, the processor's finally
   * retries it. Never re-settled (S5).
   */
  private async retainUnsettled(session: ActiveSession, reservationId: string): Promise<void> {
    try {
      await markAiBudgetReservationIndeterminate({ orgId: session.orgId, reservationId });
    } catch (err) {
      console.error('[StreamingSessionManager] Failed to mark an unsettled reservation indeterminate; retried at teardown:', {
        reservationId, error: safeErrorMessage(err),
      });
      (session.unsettledReservationIds ??= []).push(reservationId);
    }
  }

  /**
   * W05: close an outstanding `thinking_state: started` (idempotent). Every
   * turn end — result, error, timeout, teardown — calls this, so a client is
   * never left showing "Thinking…" over a finished turn.
   */
  private stopThinking(session: ActiveSession): void {
    if (session.thinkingBlockIndex == null) return;
    session.thinkingBlockIndex = null;
    session.eventBus.publish({ type: 'thinking_state', state: 'stopped' });
  }

  /**
   * W05 (spike constraint 5): publish the turn's `turn_model` and persist it as
   * ai_sessions.last_turn_model. Provenance is informative: a failure here is
   * reported loudly but never fails the turn (`done` still follows).
   */
  private async publishTurnModel(
    session: ActiveSession,
    binding: TurnBinding,
    display: TurnDisplay,
    outcome: TurnOutcome,
  ): Promise<void> {
    let turnModel;
    try {
      turnModel = await describeTurnModel({ binding, outcome, display });
    } catch (err) {
      captureException(err);
      console.error('[StreamingSessionManager] Failed to describe the turn model:', safeErrorMessage(err));
      return;
    }
    session.eventBus.publish({ type: 'turn_model', turnModel });
    try {
      await persistLastTurnModel({ orgId: session.orgId, sessionId: session.breezeSessionId, turnModel });
    } catch (err) {
      captureException(reportableError(err), undefined, { org_id: session.orgId });
      console.error('[StreamingSessionManager] Failed to persist last_turn_model; a reload will not show what ran this turn:', safeErrorMessage(err));
    }
  }

  /**
   * §9.1a: persist + stream the refusal explanation as ordinary message events
   * (every client renders it) plus the structured `model_refusal` event.
   */
  private async publishRefusal(session: ActiveSession, category: string | null): Promise<void> {
    const b = session.turnBinding;
    let alternatives: RefusalAlternative[] = [];
    if (b.partnerId) {
      try {
        alternatives = await listRefusalAlternatives({
          partnerId: b.partnerId,
          orgId: session.orgId,
          userId: session.ledgerUserId,
          surface: b.surface,
          excludeOfferingId: b.offeringId,
        });
      } catch (err) {
        captureException(err); // alternatives are a convenience; the message is not
      }
    }
    const text = refusalMessageText(category, alternatives);
    try {
      await withDbAccessContext(
        { scope: 'organization', orgId: session.orgId, accessibleOrgIds: [session.orgId] },
        () => db.insert(aiMessages).values({
          sessionId: session.breezeSessionId,
          role: 'assistant',
          content: text,
          contentBlocks: [{ type: 'model_refusal', category, alternatives, docsUrl: REFUSAL_DOCS_URL }] as unknown as Record<string, unknown>[],
        }),
      );
    } catch (err) {
      captureException(err);
      console.error('[StreamingSessionManager] Failed to save refusal message:', safeErrorMessage(err));
    }
    session.eventBus.publish({ type: 'message_start', messageId: crypto.randomUUID() });
    session.eventBus.publish({ type: 'content_delta', delta: text });
    session.eventBus.publish({ type: 'message_end', inputTokens: 0, outputTokens: 0 });
    session.eventBus.publish({ type: 'model_refusal', category, alternatives, docsUrl: REFUSAL_DOCS_URL });
  }

  private async recordDroppedToolResult(
    session: ActiveSession,
    block: { tool_use_id?: string; content?: unknown; is_error?: boolean },
  ): Promise<void> {
    const toolUseId = block.tool_use_id;
    if (!toolUseId) return;
    const queueIdx = session.toolUseIdQueue.indexOf(toolUseId);
    if (queueIdx === -1) return; // handled by postToolUse, or replayed history
    session.toolUseIdQueue.splice(queueIdx, 1);
    const toolName = session.toolUseNames?.get(toolUseId) ?? 'unknown_tool';
    session.toolUseNames?.delete(toolUseId);

    const rawText = Array.isArray(block.content)
      ? (block.content as Array<{ type?: string; text?: string }>)
          .map((c) => (typeof c?.text === 'string' ? c.text : ''))
          .join(' ')
          .trim()
      : typeof block.content === 'string'
        ? block.content
        : '';
    // The text is SDK/CLI-authored (typically an input-schema validation error
    // that only references our own advertised tool schema); redact + cap as
    // defense-in-depth before it reaches the stream and the transcript.
    const errorText = redactAiToolOutputText(
      rawText || 'Tool call was rejected before execution and produced no result.',
    ).slice(0, 1000);
    const output = { error: errorText, droppedBeforeExecution: true };

    console.warn(
      `[StreamingSessionManager] Tool call ${toolName} (${toolUseId}) was rejected before the MCP handler ran — recording explicit error tool_result`,
    );

    // SSE first (mirrors createSessionPostToolUse): the UI must receive the
    // result even if persistence fails.
    session.eventBus.publish({
      type: 'tool_result',
      toolUseId,
      output,
      isError: block.is_error ?? true,
    });

    try {
      await withDbAccessContext(
        { scope: 'organization', orgId: session.orgId, accessibleOrgIds: [session.orgId] },
        () =>
          db.insert(aiMessages).values({
            sessionId: session.breezeSessionId,
            role: 'tool_result',
            toolName,
            toolOutput: output,
            toolUseId,
          })
      );
    } catch (err) {
      captureException(err);
      console.error('[StreamingSessionManager] Failed to persist dropped tool_result:', toolName, err);
    }

    // Auto-flag the session (first failure only) so flagged-session review
    // surfaces these drops — mirrors postToolUse's tool-failure flag.
    try {
      await withDbAccessContext(
        { scope: 'organization', orgId: session.orgId, accessibleOrgIds: [session.orgId] },
        () =>
          db.update(aiSessions)
            .set({
              flaggedAt: new Date(),
              flagReason: `Tool rejected before execution: ${toolName} — ${errorText.slice(0, 300)}`,
            })
            .where(and(
              eq(aiSessions.id, session.breezeSessionId),
              isNull(aiSessions.flaggedAt),
            ))
      );
    } catch (err) {
      captureException(err);
      console.error('[StreamingSessionManager] Failed to auto-flag session for dropped tool_result:', session.breezeSessionId, err);
    }
  }

  // ============================================
  // Eviction
  // ============================================

  /**
   * True while a turn is actively streaming for this session.
   *
   * Eviction must never take such a session: `remove()` aborts its
   * AbortController, closes the SDK query and closes the event bus mid-turn, so
   * the client's SSE stream ends on a capacity error in place of the answer it
   * was already receiving, and the assistant text produced so far is lost
   * without ever being persisted.
   *
   * Liveness is `state` AND recent progress, never `state` alone — see
   * PROCESSING_STALL_TIMEOUT_MS for why a wedged turn must stay reclaimable.
   */
  private isTurnInFlight(session: ActiveSession, now: number): boolean {
    return (
      session.state === 'processing'
      && now - session.lastActivityAt
        <= processingStallTimeoutMsFor(session.approvalWaitBudgetMs ?? DEFAULT_APPROVAL_WAIT_BUDGET_MS)
    );
  }

  /**
   * Retire the DB rows for sessions that staleness eviction has just dropped.
   *
   * An evicted session is gone from memory and its client has been told to
   * start a new one, so leaving `status = 'active'` strands the row and every
   * caller keyed on active sessions overcounts. This mirrors what
   * `runPreFlightChecks` would have written lazily on the next request
   * (services/aiAgentSdk.ts) — eviction just stops deferring it.
   *
   * `runOutsideDbContextSafe` is re-entered on EVERY iteration, never once
   * around the loop. `withDbAccessContext` JOINS an already-open context
   * instead of replacing it (db/index.ts), and `AsyncLocalStorage.exit()`
   * covers the synchronous call plus what it schedules — but an iteration
   * resuming after `await` sees the caller's ambient context live again, so a
   * single hoisted escape would leave orgs 2..N running under someone else's
   * GUCs, matching zero rows under RLS while reporting success. Today the only
   * caller is the module-level eviction timer, which has no ambient context and
   * makes this a no-op; the escape is here so that stays true if this is ever
   * reached from a request path (issue #4514 calls that dependence out
   * explicitly).
   *
   * The `status = 'active'` guard keeps a row already closed by the user from
   * being re-stamped as expired.
   */
  private markSessionsExpired(sessionIdsByOrg: Map<string, string[]>): void {
    if (sessionIdsByOrg.size === 0) return;
    void (async () => {
      // One org per statement, one statement at a time. A single tick can
      // retire a whole cohort that idled out together, and a transaction per
      // session would put up to MAX_ACTIVE_SESSIONS (200) of them against a
      // pool of DB_POOL_MAX (30) shared with live request traffic. Eviction is
      // background work with no deadline, so it yields to that traffic.
      for (const [orgId, sessionIds] of sessionIdsByOrg) {
        try {
          // `.returning()` + dbWriteExpectingRows because an UPDATE evaluated
          // under the WRONG tenant's GUCs does not raise under forced RLS — it
          // matches zero rows and reports success. That is exactly the failure
          // the context escape exists to prevent, so it has to be observable
          // rather than assumed. A partial count is normal (the
          // status='active' guard skips rows the user already closed); zero
          // across a whole batch is the RLS signature.
          await runOutsideDbContextSafe(() =>
            withDbAccessContext(
              { scope: 'organization', orgId, accessibleOrgIds: [orgId] },
              () => dbWriteExpectingRows(
                'streamingSessionManager.expireEvictedSessions',
                () => db.update(aiSessions)
                  .set({ status: 'expired', updatedAt: new Date() })
                  .where(and(
                    inArray(aiSessions.id, sessionIds),
                    eq(aiSessions.status, 'active'),
                  ))
                  .returning({ id: aiSessions.id }),
              ),
            ),
          );
        } catch (err) {
          // Never abandon the remaining orgs: a failure here strands rows as
          // 'active', which is the very defect this helper exists to fix.
          //
          // `org_id` IS in sentry.ts's ALLOWED_TAG_NAMES and survives the
          // scrubber, so it goes on the event — without it every org's failure
          // collapses into one untriageable Sentry issue and the on-call has to
          // go log-diving to learn which tenant is stranded. The SESSION ids are
          // the part the allowlist voids, so those stay in the log line only.
          captureException(err, undefined, { org_id: orgId });
          console.error(
            `[StreamingSessionManager] Failed to expire ${sessionIds.length} session(s) for org ${orgId} (${sessionIds.join(', ')}):`,
            err,
          );
        }
      }
    })().catch((err) => {
      // The loop body is fully guarded, so arriving here means the guard itself
      // threw. Terminate the promise regardless: this helper's whole purpose is
      // that an eviction never silently leaves a row 'active'.
      captureException(err);
      console.error('[StreamingSessionManager] Expire sweep failed:', err);
    });
  }

  private evictStaleSessions(): void {
    const now = Date.now();
    const expiredByOrg = new Map<string, string[]>();

    try {
      for (const [sessionId, session] of [...this.sessions.entries()]) {
        const idle = now - session.lastActivityAt;
        const age = now - session.createdAt;

        if (idle <= SESSION_IDLE_TIMEOUT_MS && age <= SESSION_MAX_AGE_MS) continue;

        // Applies to the 24h hard cap too: a session that reaches it mid-stream
        // is evicted on the first tick after its turn ends (bounded by
        // SDK_TURN_TIMEOUT_MS, not by this interval). Turns cannot chain to
        // hold it open indefinitely — runPreFlightChecks enforces the same 24h
        // cap before any NEW turn starts, so the slip is one turn at most.
        // Deferring briefly beats cutting an answer off mid-sentence.
        if (this.isTurnInFlight(session, now)) continue;

        console.log(`[StreamingSessionManager] Evicting session ${sessionId} (idle=${idle}ms, age=${age}ms)`);

        // Notify connected SSE clients before removing
        session.eventBus.publish({
          type: 'error',
          message: age > SESSION_MAX_AGE_MS
            ? 'Session expired (24h limit). Please start a new session.'
            : 'Session expired due to inactivity. Please start a new session.',
        });
        session.eventBus.publish({ type: 'done' });

        this.remove(sessionId);

        // BOTH staleness paths retire the row, not just the 24h one. An
        // idle-evicted session is as dead to the client as an aged-out one, and
        // preflight would have stamped it 'expired' on the next request anyway.
        const forOrg = expiredByOrg.get(session.orgId);
        if (forOrg) forOrg.push(sessionId);
        else expiredByOrg.set(session.orgId, [sessionId]);
      }
    } finally {
      // In a `finally` so a throw mid-sweep still retires the sessions already
      // dropped from the Map. Losing them here would strand exactly the
      // 'active' rows this method exists to clean up, with no record of which.
      this.markSessionsExpired(expiredByOrg);
    }
  }

  private evictLeastRecentlyActive(): void {
    const now = Date.now();
    let oldest: { id: string; lastActivity: number } | null = null;

    for (const [id, session] of this.sessions) {
      // Under cap pressure the least-recently-active session is often the one
      // mid-stream: its stamp predates the turn it is currently serving.
      if (this.isTurnInFlight(session, now)) continue;
      if (!oldest || session.lastActivityAt < oldest.lastActivity) {
        oldest = { id, lastActivity: session.lastActivityAt };
      }
    }

    if (!oldest) {
      // Every session is mid-turn. Overshooting the soft cap is self-correcting
      // — the next getOrCreate reclaims space as soon as any turn ends — while
      // corrupting a live turn is not. But the cap IS being breached and the
      // caller proceeds to add anyway, so this is a resource-exhaustion signal
      // and must reach more than stdout. Throttled: under sustained pressure
      // this fires once per window rather than once per request.
      console.warn(
        `[StreamingSessionManager] LRU eviction skipped: all ${this.sessions.size} sessions have a turn in flight; cap ${MAX_ACTIVE_SESSIONS} exceeded`,
      );
      if (now - this.lastCapacityAlarmAt >= CAPACITY_ALARM_THROTTLE_MS) {
        this.lastCapacityAlarmAt = now;
        // The magnitude has to ride on a TAG: `scrubEvent` deletes `message`
        // from every outbound event, so without this a single-request blip and a
        // sustained runaway produce byte-identical Sentry issues — and the
        // difference is exactly what decides whether anyone should be paged.
        captureMessage('AI session cap exceeded: every session mid-turn', {
          eventCode: 'ai_session_cap_all_in_flight',
          tags: { ai_session_cap_bucket: bucketSessionOvershoot(this.sessions.size) },
        });
      }
      return;
    }

    console.log(`[StreamingSessionManager] LRU evicting session ${oldest.id}`);
    const session = this.sessions.get(oldest.id);
    if (session) {
      session.eventBus.publish({ type: 'error', message: 'Session evicted due to server capacity. Please start a new session.' });
      session.eventBus.publish({ type: 'done' });
    }
    this.remove(oldest.id);
    // Deliberately NOT expired, matching the OpenAI twin (#4406). Unlike the
    // staleness paths, an LRU victim is a perfectly usable conversation dropped
    // for OUR capacity reasons: history lives in ai_messages and the session
    // resumes from `sdkSessionId`, so the user's next message transparently
    // recreates it — exactly like a deploy, which shutdown() is likewise
    // careful not to expire. Stamping 'expired' here would turn a transient
    // server condition into a hard 410 for a conversation minutes old, since
    // runPreFlightChecks rejects on status before getOrCreate ever runs. The
    // row stays truthful: 'active' means resumable, and preflight still expires
    // it lazily once it genuinely goes idle or ages out.
  }
}

// Singleton instance
export const streamingSessionManager = new StreamingSessionManager();
