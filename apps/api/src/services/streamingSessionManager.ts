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
import { aiSessions, aiMessages, aiBudgets } from '../db/schema';
import { eq, and, isNull, inArray } from 'drizzle-orm';
import type { AuthContext } from '../middleware/auth';
import { buildOrgAccessClosures } from '../middleware/auth';
import type { AiStreamEvent, AiApprovalMode } from '@breeze/shared/types/ai';
import { AsyncEventQueue } from '../utils/asyncQueue';
import {
  recordUsageFromSdkResult,
  calculateCostCents,
  calculateCatalogCostCents,
  sumInputTokens,
  type CatalogPricingSnapshot,
} from './aiCostTracker';
import { sanitizeErrorForClient } from './aiAgent';
import { captureException, captureMessage } from './sentry';
import { createBreezeMcpServer, BREEZE_MCP_TOOL_NAMES } from './aiAgentSdkTools';
import { createSessionPreToolUse, createSessionPostToolUse, settleApprovalWaits } from './aiAgentSdk';
import type { RequestLike } from './auditEvents';
import { getTrustedClientIpOrUndefined } from './clientIp';
import { redactAiToolOutputText, redactSensitiveToolInput } from './aiToolOutput';
import { isRecognizedSelfHostSignal } from '../config/env';
import { resolveWireModel, type ResolvedLlmEndpoint, type UsableLlmConfig } from './llm/llmConfigResolver';
import { getLlmEgressProxy } from './llm/llmEgressProxy';
import { recordLlmEgressEvent } from './llm/llmEgressRecorder';

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

/** Throttle for the all-in-flight capacity alarm, so it cannot flood Sentry. */
const CAPACITY_ALARM_THROTTLE_MS = 5 * 60 * 1000;
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
const MCP_PREFIX = 'mcp__breeze__';
// Use the directly-imported runOutsideDbContext (see commandQueue.ts for explanation).
const runOutsideDbContextSafe = runOutsideDbContext;

const SDK_CHILD_ENV_ALLOWLIST = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  // ANTHROPIC_MODEL (#1412): raw-vLLM model id override. Harmless to forward
  // (the model is also passed explicitly via options.model); not a redirect
  // vector, so unlike ANTHROPIC_BASE_URL it needs no hosted gating.
  'ANTHROPIC_MODEL',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'CLAUDE_AGENT_SDK_CLIENT_APP',
  'HTTPS_PROXY',
  'HTTP_PROXY',
  'NO_PROXY',
  'https_proxy',
  'http_proxy',
  'no_proxy',
  'NODE_EXTRA_CA_CERTS',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
  'PATH',
  'HOME',
  'USERPROFILE',
  'TMPDIR',
  'TEMP',
  'TMP',
  'SystemRoot',
  'COMSPEC',
] as const;

const SDK_CHILD_ENV_CREDENTIAL_KEYS = new Set<string>([
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'CLAUDE_CODE_OAUTH_TOKEN',
]);

/**
 * Proxy configuration the parent process may carry. Forwarded as-is for
 * platform and direct-Anthropic partner sessions (an operator's outbound proxy
 * is legitimate there), but DROPPED wholesale for a catalog session: those must
 * traverse the grant-scoped CONNECT proxy, and a parent `NO_PROXY=*` (or a
 * lowercase `https_proxy` shadowing our uppercase one) would quietly restore
 * direct, unpinned egress to the provider (#3922, quorum P4).
 */
const SDK_CHILD_ENV_PROXY_KEYS = new Set<string>([
  'HTTPS_PROXY',
  'HTTP_PROXY',
  'NO_PROXY',
  'https_proxy',
  'http_proxy',
  'no_proxy',
]);

/** The catalog endpoint of a partner session, or null for every other shape. */
function catalogEndpointOf(
  resolved: UsableLlmConfig,
): Extract<ResolvedLlmEndpoint, { kind: 'catalog' }> | null {
  return resolved.source === 'partner' && resolved.endpoint.kind === 'catalog'
    ? resolved.endpoint
    : null;
}

export function buildClaudeSdkChildEnv(
  resolved: UsableLlmConfig,
  source: NodeJS.ProcessEnv = process.env,
  options: { egressProxyUrl?: string } = {},
): Record<string, string> {
  const catalogEndpoint = catalogEndpointOf(resolved);

  const env: Record<string, string> = {
    CI: 'true',
    CLAUDE_AGENT_SDK_CLIENT_APP: source.CLAUDE_AGENT_SDK_CLIENT_APP ?? 'breeze-api/ai-agent',
  };

  for (const key of SDK_CHILD_ENV_ALLOWLIST) {
    if (resolved.source === 'partner' && SDK_CHILD_ENV_CREDENTIAL_KEYS.has(key)) continue;
    if (catalogEndpoint && SDK_CHILD_ENV_PROXY_KEYS.has(key)) continue;
    const value = source[key];
    if (typeof value === 'string' && value.length > 0) {
      env[key] = value;
    }
  }

  // `resolved.source === 'partner'` is implied by a catalog endpoint existing;
  // it is restated so `resolved.apiKey` narrows to a required string.
  if (catalogEndpoint && resolved.source === 'partner') {
    const { egressProxyUrl } = options;
    // No proxy URL means no grant, and no grant means the child would dial the
    // provider itself with none of the allowlisting, DNS pinning, or egress
    // audit this whole path exists for. Refuse to build such an environment
    // rather than start a subprocess that silently egresses unguarded.
    if (!egressProxyUrl) {
      throw new Error(
        'A catalog LLM session requires an egress proxy URL; refusing to build an unproxied child environment.',
      );
    }
    // The endpoint's own URL — deliberately NOT the parent's
    // ANTHROPIC_BASE_URL, which is never in the allowlist and stays irrelevant
    // here whatever IS_HOSTED says (#1412 governs the PLATFORM path only).
    env.ANTHROPIC_BASE_URL = catalogEndpoint.baseUrl;
    // Exactly one credential var; the other was already excluded above with the
    // rest of the parent's credentials, so the SDK cannot fall back to a
    // platform key and leak it to a third party.
    if (catalogEndpoint.authMode === 'bearer') {
      env.ANTHROPIC_AUTH_TOKEN = resolved.apiKey;
    } else {
      env.ANTHROPIC_API_KEY = resolved.apiKey;
    }
    env.HTTPS_PROXY = egressProxyUrl;
    env.HTTP_PROXY = egressProxyUrl;
    // Explicit and empty: an unset NO_PROXY would let the parent's (already
    // dropped) value or a library default exempt hosts from the proxy.
    env.NO_PROXY = '';
    return env;
  }

  if (resolved.source === 'partner') {
    env.ANTHROPIC_API_KEY = resolved.apiKey;
    return env;
  }

  // ANTHROPIC_BASE_URL (#1412): forward ONLY when self-host is affirmatively
  // declared (IS_HOSTED explicitly false/0/no/off). Fail-closed — unset / empty
  // / garbage / truthy IS_HOSTED all strip it, so a stray/misconfigured value
  // (including the #570 unmapped-IS_HOSTED footgun) can never redirect platform
  // AI traffic to a third-party backend. The config validator also boot-refuses
  // this combo; this is defense-in-depth at the actual subprocess boundary (the
  // function reads process.env directly, not the validated config singleton).
  const anthropicBaseUrl = source.ANTHROPIC_BASE_URL;
  if (
    isRecognizedSelfHostSignal(source.IS_HOSTED)
    && typeof anthropicBaseUrl === 'string'
    && anthropicBaseUrl.length > 0
  ) {
    env.ANTHROPIC_BASE_URL = anthropicBaseUrl;
  }

  return env;
}

export function redactClaudeSdkStderr(data: string): string {
  return redactAiToolOutputText(data).trim();
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

/** Immutable audit snapshot extracted from the HTTP request context */
export interface AuditSnapshot {
  ip: string | undefined;
  userAgent: string | undefined;
}

export interface LlmConfigSnapshot {
  readonly source: UsableLlmConfig['source'];
  readonly configId?: string;
  readonly configVersion?: number;
  /**
   * Catalog revision this session's subprocess was built against (#3922 phase
   * 2). Revisions are immutable, so a changed id means the base URL, auth mode,
   * model map or pricing moved — everything the child env and the cost snapshot
   * were derived from. Absent for direct-Anthropic and platform sessions.
   */
  readonly revisionId?: string;
  /** Wire model id the child sends; moves with the revision's model map. */
  readonly providerModel?: string;
}

function llmConfigSnapshot(resolved: UsableLlmConfig): LlmConfigSnapshot {
  if (resolved.source !== 'partner') return { source: resolved.source };
  const base = {
    source: resolved.source,
    configId: resolved.configId,
    configVersion: resolved.configVersion,
  };
  return resolved.endpoint.kind === 'catalog'
    ? {
        ...base,
        revisionId: resolved.endpoint.revisionId,
        providerModel: resolved.endpoint.providerModel,
      }
    : base;
}

function llmConfigSnapshotsMatch(snapshot: LlmConfigSnapshot, resolved: UsableLlmConfig): boolean {
  const fresh = llmConfigSnapshot(resolved);
  return snapshot.source === fresh.source
    && snapshot.configId === fresh.configId
    && snapshot.configVersion === fresh.configVersion
    // A revision bump (or a swap between direct and catalog, which flips these
    // between a value and undefined) rotates the session exactly as a key
    // rotation does — the subprocess cannot be re-pointed in place.
    && snapshot.revisionId === fresh.revisionId
    && snapshot.providerModel === fresh.providerModel;
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
   * Model id this session runs with (from the aiSessions row). Used to price
   * tokens for cost tracking when the SDK fails to report total_cost_usd.
   */
  readonly model: string;
  readonly llmConfigSnapshot: LlmConfigSnapshot;
  /**
   * Per-million-token rates from the catalog revision this session runs on.
   * Present only for catalog sessions, where the SDK's self-reported
   * `total_cost_usd` describes Anthropic list pricing rather than what the
   * partner is actually charged and must be ignored (#3922 W2 Task 2.4).
   */
  readonly catalogPricing?: CatalogPricingSnapshot;
  /**
   * Releases this session's CONNECT-proxy grant. Set for catalog sessions only;
   * invoked by `remove()` so a torn-down, rotated or evicted session stops
   * being able to reach the provider immediately.
   */
  revokeEgressGrant?: () => void;
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
   * session (device) org via `buildDeviceBoundSessionAuth` (#3087); otherwise
   * it is `auth` itself. Refreshed alongside `auth` on every request.
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
   * underlying model API call). Used as the fallback token source when the
   * `result` message arrives with missing/zero usage (#3095), and flushed if a
   * turn is abandoned without ever producing a `result` (teardown, crash).
   * Reset after every flush.
   */
  pendingTurnUsage: PendingTurnUsage;
  /**
   * Count of tool calls completed (postToolUse fired) during the current turn.
   * Fed into recordUsageFromSdkResult's toolExecutionCount so the
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
  /** Approval mode for this session (loaded from org's aiBudgets) */
  approvalMode: AiApprovalMode;
  /** Optional MCP allowlist for restricted sessions such as helper chat. */
  allowedTools?: string[];
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
  // ── AI for Office (client sessions) — set by routes/clientAi/sessions.ts ──
  /** Client org policy writeMode, refreshed on every client message; the
   *  client tool handler rejects mutating tools when 'readonly'. */
  clientWriteMode?: 'readonly' | 'readwrite';
  /** client_ai_org_policies.dlp_config (jsonb, unknown — the DLP engine parses
   *  it itself), refreshed on every client message. */
  clientDlpConfig?: unknown;
  /** Extra per-turn usage recorder invoked in the result case alongside
   *  recordUsageFromSdkResult (client sessions: per-user client_ai_usage buckets). */
  recordExtraUsage?: (usage: { inputTokens: number; outputTokens: number; costCents: number }) => Promise<void>;
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

// ============================================
// StreamingSessionManager (singleton)
// ============================================

export class StreamingSessionManager {
  private sessions = new Map<string, ActiveSession>();
  private evictionTimer: ReturnType<typeof setInterval> | null = null;

  private lastCapacityAlarmAt = 0;

  constructor() {
    // No `runOutsideDbContext` wrapper around this `setInterval`, unlike the
    // OpenAI twin (llm/openaiSessionManager.ts). That manager is a LAZY
    // singleton first constructed inside an AI request handler, so its timer
    // would inherit the requester's AsyncLocalStorage scope on every tick for
    // the life of the process. This one is a MODULE-LEVEL singleton
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
  tryTransitionToProcessing(session: ActiveSession): boolean {
    if (session.state === 'processing' || session.state === 'closing' || session.state === 'closed') {
      return false;
    }
    session.state = 'processing';
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
      model?: string | null;
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
    },
    auth: AuthContext,
    requestContext: RequestLike | undefined,
    systemPrompt: string,
    maxBudgetUsd: number | undefined,
    resolved: UsableLlmConfig,
    allowedTools?: string[],
    mcpServerFactory?: (
      getAuth: () => AuthContext,
      onPreToolUse: ReturnType<typeof createSessionPreToolUse>,
      onPostToolUse: ReturnType<typeof createSessionPostToolUse>,
      getSession: () => ActiveSession,
    ) => { server: McpSdkServerConfigWithInstance; name: string },
    options?: { injectApprovalModeInstructions?: boolean },
  ): Promise<ActiveSession> {
    const snapshot: AuditSnapshot = {
      ip: requestContext ? getTrustedClientIpOrUndefined(requestContext) : undefined,
      userAgent: requestContext?.req.header('user-agent'),
    };

    const existing = this.sessions.get(breezeSessionId);
    if (existing && existing.state !== 'closed') {
      if (!llmConfigSnapshotsMatch(existing.llmConfigSnapshot, resolved)) {
        if (existing.state === 'processing') {
          // Rotation applies on the next turn. Reusing the live session here
          // lets the route's existing concurrent-message guard return a 409
          // without killing an in-flight stream mid-response.
        } else if (existing.state === 'idle') {
          const oldConfigVersion = existing.llmConfigSnapshot.source === 'partner'
            ? existing.llmConfigSnapshot.configVersion
            : null;
          const newSnapshot = llmConfigSnapshot(resolved);
          const newConfigVersion = newSnapshot.source === 'partner'
            ? newSnapshot.configVersion
            : null;
          console.info(
            '[StreamingSessionManager] rotating idle AI session after provider configuration change',
            { breezeSessionId, oldConfigVersion, newConfigVersion },
          );
          existing.eventBus.publish({
            type: 'error',
            message: 'AI provider configuration changed — please resend your message',
          });
          existing.eventBus.publish({ type: 'done' });
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
        reusable.auth = auth;
        reusable.toolAuth = reusable.deviceId
          ? buildDeviceBoundSessionAuth(auth, dbSession.orgId)
          : auth;
        reusable.auditSnapshot = snapshot;
        reusable.allowedTools = allowedTools;
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

    // Load org's approval mode from aiBudgets
    let approvalMode: AiApprovalMode = 'per_step';
    try {
      const [budget] = await db
        .select({ approvalMode: aiBudgets.approvalMode })
        .from(aiBudgets)
        .where(eq(aiBudgets.orgId, dbSession.orgId))
        .limit(1);
      if (budget?.approvalMode) {
        approvalMode = budget.approvalMode as AiApprovalMode;
      }
    } catch (err) {
      captureException(err);
      console.error('[StreamingSessionManager] Failed to load approval mode, defaulting to per_step:', err);
    }

    const catalogEndpoint = catalogEndpointOf(resolved);

    // Device-bound sessions execute tools under the DEVICE's org, not the
    // login org (#3087). `toolAuth` (MCP tool handlers + their RLS context)
    // is narrowed to the session org; `auth` stays raw so RBAC, rate limits,
    // and audit attribution keep resolving the login identity/role.
    const deviceId = dbSession.deviceId ?? null;
    const toolAuth = deviceId ? buildDeviceBoundSessionAuth(auth, dbSession.orgId) : auth;

    // Build partial session object so callbacks can reference it.
    // query and processorPromise are filled in after creation.
    const now = Date.now();
    const effectiveModel = dbSession.model || resolved.model;
    // `ai_sessions.model` is a free-form, client-supplied string and can also
    // be stale (created before the partner changed `default_model`), while the
    // resolver's `model_unverified` gate keys on the partner DEFAULT only. So
    // translate THIS session's model — and fail closed (LlmUnavailableError)
    // when the pinned revision has not mapped and verified it, rather than
    // silently re-pointing the run at the default model's wire id while the
    // ledger records a model that never ran.
    const wire = resolveWireModel(resolved, effectiveModel);
    const session: ActiveSession = {
      breezeSessionId,
      orgId: dbSession.orgId,
      deviceId,
      model: effectiveModel,
      llmConfigSnapshot: llmConfigSnapshot(resolved),
      // The pricing for the model THIS session runs, not the partner default's.
      catalogPricing: wire.catalogPricing,
      revokeEgressGrant: undefined,
      sdkSessionId: dbSession.sdkSessionId,
      query: null as unknown as Query, // set below
      abortController,
      inputController,
      eventBus,
      state: 'initializing',
      lastActivityAt: now,
      createdAt: now,
      auth,
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
      allowedTools,
      isPaused: false,
      activePlanId: null,
      approvedPlanSteps: new Map(),
      currentPlanStepIndex: 0,
      planApprovalResolver: null,
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
      mcpServer = createBreezeMcpServer(() => session.toolAuth, preToolUse, postToolUse, () => session);
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
    let egressProxyUrl: string | undefined;
    let revokeEgressGrant: (() => void) | undefined;
    if (catalogEndpoint && resolved.source === 'partner') {
      const host = new URL(catalogEndpoint.baseUrl).hostname;
      const partnerId = resolved.partnerId;
      const provenance = {
        orgId: dbSession.orgId,
        partnerId,
        catalogEntryId: catalogEndpoint.catalogEntryId,
        revisionId: catalogEndpoint.revisionId,
        aiSessionId: breezeSessionId,
      };
      const proxy = await getLlmEgressProxy();
      egressProxyUrl = proxy.grant(
        breezeSessionId,
        { host, port: 443 },
        // Every CONNECT the child makes under this grant — tunnelled or
        // refused — becomes one audit row. Synchronous and fire-and-forget by
        // the recorder's contract; it runs inside the proxy's socket handler.
        (attempt) => {
          recordLlmEgressEvent({
            ...provenance,
            surface: 'sdk_proxy_connect',
            host: attempt.host,
            resolvedIp: attempt.resolvedIp,
            blocked: attempt.blocked,
          });
        },
      ).proxyUrl;
      revokeEgressGrant = () => proxy.revoke(breezeSessionId);
      session.revokeEgressGrant = revokeEgressGrant;
      // One row per session create, so the audit shows which provider a session
      // was pointed at even if the child never manages a single CONNECT.
      recordLlmEgressEvent({
        ...provenance,
        surface: 'sdk_session_create',
        host,
        resolvedIp: null,
        blocked: false,
      });
    }

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
    try {
      runOutsideDbContextSafe(() => {
        const sdkQuery = query({
          prompt: inputController.getInputStream(),
          options: {
            systemPrompt: effectiveSystemPrompt,
            // A catalog endpoint speaks its own model ids (`anthropic/…` on
            // OpenRouter, a deployment name on a self-hosted gateway). The wire
            // id is THIS session's model translated through the revision's
            // model map; `session.model` keeps the platform-logical id for
            // provenance and pricing fallback.
            model: wire.model,
            maxTurns,
            maxBudgetUsd,
            tools: [],
            allowedTools: allowedTools ?? BREEZE_MCP_TOOL_NAMES,
            mcpServers: { [mcpServerName]: mcpServer },
            includePartialMessages: true,
            abortController,
            env: buildClaudeSdkChildEnv(resolved, process.env, { egressProxyUrl }),
            resume: dbSession.sdkSessionId ?? undefined,
            persistSession: true,
            settingSources: [],
            thinking: { type: 'disabled' },
            stderr: (data: string) => {
              if (data.includes('error') || data.includes('Error') || data.includes('FATAL')) {
                console.error('[SDK-stderr]', breezeSessionId, redactClaudeSdkStderr(data));
              }
            },
          }
        });

        (session as { query: Query }).query = sdkQuery;

        // Start background processor (inherits the clean context)
        (session as { processorPromise: Promise<void> }).processorPromise = this.runBackgroundProcessor(session);
        session.processorPromise.catch((err) => {
          captureException(err);
          console.error('[StreamingSessionManager] Background processor error:', err);
        });
      });
    } catch (err) {
      // The subprocess never started (a rejected child env, a query() throw).
      // Release the egress grant here — the session was never registered in
      // `this.sessions`, so `remove()` will never run for it and the grant
      // would leak until the process restarted. The grant is taken immediately
      // above this block precisely so there is no un-covered window.
      try { revokeEgressGrant?.(); } catch { /* teardown must not mask err */ }
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
    // Release the CONNECT-proxy allowance (catalog sessions only). Done on
    // every teardown path — rotation, eviction, processor exit — so a session
    // that is going away cannot keep a tunnel to the provider open.
    try { session.revokeEgressGrant?.(); } catch (err) {
      captureException(err); console.error('[StreamingSessionManager] Failed to revoke LLM egress grant:', sessionId, err);
    }
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
    // a cycle's approval waits (<= 5 min total) always leave headroom for the
    // model to emit its closing message before the 6-min timeout fires.
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
        session.eventBus.publish({ type: 'error', message: 'AI request timed out. Please try again.' });
        session.eventBus.publish({ type: 'done' });
        session.state = 'idle';
      }
    }, SDK_TURN_TIMEOUT_MS);
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

    try {
      for await (const message of session.query) {
        // Stop publishing if session is being torn down
        if (session.state === 'closing' || session.state === 'closed') break;

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
              // Reset turn timeout — SDK is actively producing output
              this.startTurnTimeout(session);
              // Same signal, for eviction: a new assistant message is stream
              // progress. Unlike the OpenAI twin, a turn here can run entirely
              // through tool_use blocks and emit no text delta at all, so the
              // message boundary is the only keepalive some turns ever get.
              session.lastActivityAt = Date.now();
              session.eventBus.publish({ type: 'message_start', messageId: currentMessageId });
            } else if (event.type === 'content_block_delta') {
              if ('delta' in event && event.delta.type === 'text_delta') {
                // Stream progress keeps the turn alive for eviction purposes.
                session.lastActivityAt = Date.now();
                session.eventBus.publish({ type: 'content_delta', delta: event.delta.text });
              }
            } else if (event.type === 'content_block_start') {
              if ('content_block' in event && event.content_block.type === 'tool_use') {
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

                session.eventBus.publish({
                  type: 'tool_use_start',
                  toolName: bareStreamToolName,
                  toolUseId: block.id,
                  input: {},
                });
              }
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

            const assistantContent = message.message.content
              .filter((b: { type: string }) => b.type === 'text')
              .map((b: { type: string; text?: string }) => b.text ?? '')
              .join('');

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
              if (block.type === 'tool_use') {
                const bareName = block.name.startsWith(session.mcpPrefix)
                  ? block.name.slice(session.mcpPrefix.length)
                  : block.name;

                try {
                  await withDbAccessContext(
                    { scope: 'organization', orgId: session.orgId, accessibleOrgIds: [session.orgId] },
                    () =>
                      db.insert(aiMessages).values({
                        sessionId: session.breezeSessionId,
                        role: 'tool_use',
                        toolName: bareName,
                        // SR5-16: mask known-sensitive keys (accessKey, secretKey,
                        // password, token, apiKey, clientSecret, privateKey,
                        // connectionString, …) before persisting. Unconditional —
                        // this runs even for tool calls the user later denies.
                        toolInput: redactSensitiveToolInput(block.input as Record<string, unknown>),
                        toolUseId: block.id,
                      })
                  );
                } catch (err) {
                  captureException(err);
                  console.error('[StreamingSessionManager] Failed to save tool_use message:', err);
                }
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

            const resultMsg = message as SDKResultMessage;
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

            // Extract usage with defensive checks — SDK types say usage is non-nullable
            // but in practice it may be missing/zero. Fall back to the usage
            // accumulated from this turn's assistant messages (#3095).
            const sdkUsage = resultMsg.usage as {
              input_tokens?: number;
              output_tokens?: number;
              cache_read_input_tokens?: number | null;
              cache_creation_input_tokens?: number | null;
            } | undefined;
            const sdkReported: PendingTurnUsage = {
              inputTokens: sdkUsage?.input_tokens ?? 0,
              outputTokens: sdkUsage?.output_tokens ?? 0,
              // Cache tokens are billed separately (read ~0.1x input, write ~1.25x
              // input). Capture them so the token-based fallback doesn't undercount
              // cost on cached requests when the SDK reports $0.
              cacheReadInputTokens: sdkUsage?.cache_read_input_tokens ?? 0,
              cacheCreationInputTokens: sdkUsage?.cache_creation_input_tokens ?? 0,
            };
            const effectiveUsage = hasTokens(sdkReported) ? sdkReported : session.pendingTurnUsage;
            // Consumed (or superseded by the SDK's own numbers) — reset for the next turn.
            session.pendingTurnUsage = emptyPendingTurnUsage();
            const turnToolExecutionCount = session.pendingTurnToolExecutionCount;
            session.pendingTurnToolExecutionCount = 0;

            const usageData = {
              total_cost_usd: resultMsg.total_cost_usd ?? 0,
              usage: {
                input_tokens: effectiveUsage.inputTokens,
                output_tokens: effectiveUsage.outputTokens,
                cache_read_input_tokens: effectiveUsage.cacheReadInputTokens,
                cache_creation_input_tokens: effectiveUsage.cacheCreationInputTokens,
              },
              num_turns: resultMsg.num_turns ?? 0,
              // Model id for token-based cost fallback when the SDK reports $0.
              model: session.model,
              // Tool calls completed this turn — feeds ai_cost_usage.tool_execution_count.
              toolExecutionCount: turnToolExecutionCount,
            };

            if (!hasTokens(sdkReported)) {
              console.warn('[StreamingSessionManager] Result message has no/empty usage — using accumulated assistant-message usage:', {
                sessionId: session.breezeSessionId,
                subtype: resultMsg.subtype,
                hasUsage: !!resultMsg.usage,
                totalCostUsd: resultMsg.total_cost_usd,
                fallbackInputTokens: effectiveUsage.inputTokens,
                fallbackOutputTokens: effectiveUsage.outputTokens,
              });
            }

            if (resultMsg.subtype === 'success') {
              try {
                await withDbAccessContext(
                  { scope: 'organization', orgId: session.orgId, accessibleOrgIds: [session.orgId] },
                  () => recordUsageFromSdkResult(
                    session.breezeSessionId,
                    orgId,
                    usageData,
                    session.llmConfigSnapshot.source === 'partner' ? 'partner_key' : 'platform',
                    // Catalog traffic is priced from the revision snapshot; the
                    // SDK's own total_cost_usd reflects Anthropic list pricing
                    // for a request that never went to Anthropic.
                    session.catalogPricing,
                  ),
                );
              } catch (err) {
                captureException(err);
                console.error('[StreamingSessionManager] Failed to record SDK usage:', err);
              }
            } else {
              const errors = 'errors' in resultMsg ? resultMsg.errors : [];
              const errorMsg = errors.length > 0 ? errors[0] : `AI query ended: ${resultMsg.subtype}`;

              if (resultMsg.subtype === 'error_max_budget_usd') {
                session.eventBus.publish({ type: 'error', message: 'AI budget limit reached for this query.' });
              } else if (resultMsg.subtype === 'error_max_turns') {
                session.eventBus.publish({ type: 'error', message: 'Maximum conversation turns reached.' });
              } else {
                session.eventBus.publish({ type: 'error', message: sanitizeErrorForClient(new Error(errorMsg ?? 'Unknown error')) });
              }

              try {
                await withDbAccessContext(
                  { scope: 'organization', orgId: session.orgId, accessibleOrgIds: [session.orgId] },
                  () => recordUsageFromSdkResult(
                    session.breezeSessionId,
                    orgId,
                    usageData,
                    session.llmConfigSnapshot.source === 'partner' ? 'partner_key' : 'platform',
                    // Catalog traffic is priced from the revision snapshot; the
                    // SDK's own total_cost_usd reflects Anthropic list pricing
                    // for a request that never went to Anthropic.
                    session.catalogPricing,
                  ),
                );
              } catch (err) {
                captureException(err);
                console.error('[StreamingSessionManager] Failed to record SDK usage on error:', err);
              }
            }

            // Per-user usage hook (AI for Office): runs alongside the org-level
            // recordUsageFromSdkResult above, never instead of it.
            // Catalog sessions price from the revision snapshot, matching what
            // recordUsageFromSdkResult wrote to the ledger — otherwise the
            // per-user buckets and the client's turn summary would quote
            // Anthropic list pricing for third-party traffic.
            const turnCostCents = session.catalogPricing
              ? calculateCatalogCostCents(
                  session.catalogPricing,
                  usageData.usage.input_tokens,
                  usageData.usage.output_tokens,
                  usageData.usage.cache_read_input_tokens,
                  usageData.usage.cache_creation_input_tokens,
                )
              : Math.round(usageData.total_cost_usd * 100 * 100) / 100;
            // Cache-read and cache-creation tokens are input tokens — they are
            // split out for PRICING only. Reporting the uncached slice alone made
            // per-user ledgers and the client's turn summary read near-zero on
            // any cached (i.e. any multi-turn) session. See sumInputTokens.
            const turnInputTokens = sumInputTokens(usageData.usage);
            if (session.recordExtraUsage) {
              try {
                await session.recordExtraUsage({
                  inputTokens: turnInputTokens,
                  outputTokens: usageData.usage.output_tokens,
                  costCents: turnCostCents,
                });
              } catch (err) {
                captureException(err);
                console.error('[StreamingSessionManager] recordExtraUsage failed:', err);
              }
            }

            // Signal this turn is done, but DON'T close the event bus —
            // session stays alive for follow-up messages. Carries usage so
            // client surfaces can render turn cost (turn_complete).
            session.eventBus.publish({
              type: 'done',
              usage: {
                inputTokens: turnInputTokens,
                outputTokens: usageData.usage.output_tokens,
                costCents: turnCostCents,
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
      captureException(err);
      console.error('[StreamingSessionManager] Query error:', err);
      session.eventBus.publish({ type: 'error', message: sanitizeErrorForClient(err) });
      session.eventBus.publish({ type: 'done' });
    } finally {
      // Flush usage from a turn that never produced a `result` message
      // (teardown mid-turn, subprocess crash, iterator error) so the tokens
      // already spent on model API calls still land in the session counters
      // and org cost aggregates (#3095). Zero after a normal turn — the
      // accumulator is reset when each `result` is recorded.
      if (hasTokens(session.pendingTurnUsage) || session.pendingTurnToolExecutionCount > 0) {
        const abandoned = session.pendingTurnUsage;
        session.pendingTurnUsage = emptyPendingTurnUsage();
        const abandonedToolExecutionCount = session.pendingTurnToolExecutionCount;
        session.pendingTurnToolExecutionCount = 0;
        // Awaited (not fire-and-forget): the most common abandoned-turn trigger
        // is process shutdown (deploy/SIGTERM), where an untracked promise can
        // be killed before it settles — silently, since even the .catch would
        // never run. Awaiting ties the write into processorPromise so it can
        // be drained; failures are logged, never re-credited (the underlying
        // writes are non-idempotent += increments, retry would double-count).
        try {
          await withDbAccessContext(
            { scope: 'organization', orgId: session.orgId, accessibleOrgIds: [session.orgId] },
            () => recordUsageFromSdkResult(
              session.breezeSessionId,
              session.orgId,
              {
                total_cost_usd: 0,
                usage: {
                  input_tokens: abandoned.inputTokens,
                  output_tokens: abandoned.outputTokens,
                  cache_read_input_tokens: abandoned.cacheReadInputTokens,
                  cache_creation_input_tokens: abandoned.cacheCreationInputTokens,
                },
                num_turns: 1,
                model: session.model,
                toolExecutionCount: abandonedToolExecutionCount,
              },
              session.llmConfigSnapshot.source === 'partner' ? 'partner_key' : 'platform',
              session.catalogPricing,
            ),
          );
        } catch (err) {
          captureException(err);
          console.error('[StreamingSessionManager] Failed to record abandoned-turn usage:', err);
        }
        // Mirror the result path's per-user hook (AI for Office): without this,
        // abandoned-turn spend would reach the org ledger but never the
        // client_ai_usage buckets that back per-user caps and invoicing.
        if (session.recordExtraUsage) {
          try {
            await session.recordExtraUsage({
              inputTokens: abandoned.inputTokens,
              outputTokens: abandoned.outputTokens,
              costCents: session.catalogPricing
                ? calculateCatalogCostCents(
                    session.catalogPricing,
                    abandoned.inputTokens,
                    abandoned.outputTokens,
                    abandoned.cacheReadInputTokens,
                    abandoned.cacheCreationInputTokens,
                  )
                : calculateCostCents(
                    session.model,
                    abandoned.inputTokens,
                    abandoned.outputTokens,
                    abandoned.cacheReadInputTokens,
                    abandoned.cacheCreationInputTokens
                  ),
            });
          } catch (err) {
            captureException(err);
            console.error('[StreamingSessionManager] recordExtraUsage failed for abandoned turn:', err);
          }
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
      && now - session.lastActivityAt <= PROCESSING_STALL_TIMEOUT_MS
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
          // Session ids go in the log line, not a Sentry tag — the scrubber
          // allowlist deliberately voids tenant-scoped tags, so a tag here
          // would silently vanish rather than aid correlation.
          captureException(err);
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
        captureMessage('AI session cap exceeded: every session mid-turn', {
          eventCode: 'ai_session_cap_all_in_flight',
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
