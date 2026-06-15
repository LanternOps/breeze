/**
 * Framework-free chat state machine (D6): owns the thread, streaming buffer,
 * banners, composer draft, and tool routing. React renders snapshots via
 * subscribe()/getState() (useSyncExternalStore). The session is created
 * lazily on the first send; the SSE stream opens in the same step.
 */
import {
  ApiError,
  createSession,
  flagSession,
  getSession,
  listSessions,
  postToolResult,
  sendMessage,
  streamEvents,
  type StreamCallbacks,
  type StreamHandle,
} from '../api/client';
import { ApprovalStore } from '../approval/approvalStore';
import type { HostAdapter } from '../host/types';
import type {
  ClientAiStreamEvent,
  ClientHost,
  CreateSessionBody,
  SendMessageBody,
  SessionCreated,
  SessionHistory,
  SessionListItem,
  ToolCompletedStatus,
  ToolExecutor,
  ToolResultBody,
  TurnUsage,
  WorkbookContext,
  WorkbookContextKind,
  WriteApproval,
} from '../api/types';

/** One tool_request event off the SSE stream (host-neutral discriminant). */
type ToolRequest = Extract<ClientAiStreamEvent, { type: 'tool_request' }>;

/**
 * Max time the first send() waits for the SSE stream to confirm open before
 * sending anyway. The server's eager ping normally arrives in well under this;
 * the cap only guards against a missing/slow open signal hanging the message.
 */
const STREAM_OPEN_TIMEOUT_MS = 2000;

/**
 * Host-neutral tool runner: invokes one executor from the host's tool layer and
 * never throws — executor failures collapse to { status: 'error' } so the model
 * can react. Mirrors the Excel dispatcher's executeTool, but bound to whatever
 * tool layer the injected host supplies (no static Excel import).
 */
async function runTool(
  toolName: string,
  input: Record<string, unknown>,
  executors: Record<string, ToolExecutor>,
): Promise<{ status: 'success' | 'error'; output: unknown }> {
  const executor = executors[toolName];
  if (!executor) return { status: 'error', output: { error: `Unknown tool: ${toolName}` } };
  try {
    return { status: 'success', output: await executor(input) };
  } catch (err) {
    return { status: 'error', output: { error: err instanceof Error ? err.message : String(err) } };
  }
}

export type ChatApi = {
  createSession: (body?: CreateSessionBody) => Promise<SessionCreated>;
  sendMessage: (sessionId: string, body: SendMessageBody) => Promise<void>;
  postToolResult: (sessionId: string, result: ToolResultBody) => Promise<void>;
  streamEvents: (sessionId: string, callbacks: StreamCallbacks) => StreamHandle;
  getSession: (sessionId: string) => Promise<SessionHistory>;
  listSessions: (host?: ClientHost) => Promise<SessionListItem[]>;
  flagSession: (sessionId: string, reason?: string) => Promise<void>;
};

const realApi: ChatApi = {
  createSession,
  sendMessage,
  postToolResult,
  streamEvents,
  getSession,
  listSessions,
  flagSession,
};

export type ThreadMessage =
  | { kind: 'user'; id: number; text: string; context?: WorkbookContext }
  | { kind: 'assistant'; id: number; text: string }
  | {
      kind: 'tool';
      id: number;
      toolName: string;
      status: ToolCompletedStatus;
      redactions: number;
      blockReason: string | null;
    };

export type ChatState = {
  thread: ThreadMessage[];
  streamingText: string;
  busy: boolean;
  banner: { kind: 'error' | 'blocked'; text: string } | null;
  draft: string;
  contextKind: WorkbookContextKind;
  usage: TurnUsage | null;
  /**
   * Effective org write-approval policy for this session (server-authoritative;
   * 'ask' until the session is created). The pane only shows the Auto/Ask
   * toggle when this is 'allow_auto'.
   */
  writeApproval: WriteApproval;
  /** Mirror of approvals.isAutoApply() for the toggle UI. */
  autoApply: boolean;
  /** True once the end user has flagged this conversation (Feature 2). */
  flagged: boolean;
};

const ERROR_BANNERS: Record<string, string> = {
  budget_exceeded:
    "Your organization's AI budget for this period has been reached. Contact your IT provider.",
  rate_limited: 'You are sending messages too quickly. Wait a moment and try again.',
  no_session: 'Not signed in. Reload the task pane.',
};

function bannerText(err: unknown): string {
  if (err instanceof ApiError) return ERROR_BANNERS[err.code] ?? `Request failed (${err.code}).`;
  return err instanceof Error ? err.message : 'Something went wrong.';
}

export type ChatControllerDeps = {
  api?: ChatApi;
  /**
   * The concrete host. REQUIRED — the controller is host-neutral and routes all
   * capture/preview/tool execution through this adapter. The composition root
   * (ChatPane) injects the Excel adapter; tests inject a fake.
   */
  host: HostAdapter;
  /**
   * Which Office host this pane runs inside (distinct from the `host` adapter
   * above — this is the wire discriminant, not the object-model seam). Threaded
   * to the server on createSession/listSessions so it serves the matching tool
   * registry + system prompt. Defaults to 'excel' for back-compat: without it
   * the server defaults to 'excel' too, so an unthreaded pane would silently get
   * Excel tools.
   */
  clientHost?: ClientHost;
  /**
   * Direct overrides for the context-capture seams. Take precedence over the
   * host adapter so existing tests that inject these keep working; production
   * leaves them unset and the host adapter supplies them.
   */
  captureContext?: (kind: WorkbookContextKind) => Promise<WorkbookContext | undefined>;
  captureName?: () => Promise<string | undefined>;
};

export class ChatController {
  readonly approvals: ApprovalStore;
  private state: ChatState = {
    thread: [],
    streamingText: '',
    busy: false,
    banner: null,
    draft: '',
    contextKind: 'selection',
    usage: null,
    writeApproval: 'ask',
    autoApply: false,
    flagged: false,
  };
  private listeners = new Set<() => void>();
  private sessionId: string | null = null;
  private stream: StreamHandle | null = null;
  // Resolves when the current stream is confirmed open (server subscriber
  // registered). The first send() awaits this so the opening turn never streams
  // before anyone is listening. Re-armed by every openStream().
  private streamReady: Promise<void> = Promise.resolve();
  private nextId = 1;
  private api: ChatApi;
  private host: HostAdapter;
  private clientHost: ClientHost;
  private capture: (kind: WorkbookContextKind) => Promise<WorkbookContext | undefined>;
  private captureName: () => Promise<string | undefined>;

  constructor(deps: ChatControllerDeps) {
    this.api = deps.api ?? realApi;
    this.host = deps.host;
    this.clientHost = deps.clientHost ?? 'excel';
    this.capture = deps.captureContext ?? this.host.captureContext;
    this.captureName = deps.captureName ?? this.host.captureName;
    const host = this.host;
    this.approvals = new ApprovalStore({
      postToolResult: async (result) => {
        if (!this.sessionId) throw new Error('No active session for tool result');
        await this.api.postToolResult(this.sessionId, result);
      },
      buildPreview: host.buildPreview,
      // Bind execution to the host's tool layer so apply/auto-apply/revert use
      // the same executors as the dispatcher.
      execute: (toolName, input) => runTool(toolName, input, host.toolExecutors),
      // A failed Apply/Reject/auto-apply post must NOT vanish: surface it (or
      // swallow the benign post-timeout 404) instead of letting the model's
      // parked turn hang until the bridge timeout.
      reportPostError: (err) => this.handlePostError(err),
    });
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  getState(): ChatState {
    return this.state;
  }

  private update(patch: Partial<ChatState>): void {
    this.state = { ...this.state, ...patch };
    for (const listener of [...this.listeners]) listener();
  }

  setDraft(text: string): void {
    this.update({ draft: text });
  }

  /** Template picker → composer (spec §10: templates land in the input, not auto-sent). */
  insertTemplate(body: string): void {
    this.update({ draft: this.state.draft ? `${this.state.draft}\n\n${body}` : body });
  }

  setContextKind(kind: WorkbookContextKind): void {
    this.update({ contextKind: kind });
  }

  dismissBanner(): void {
    this.update({ banner: null });
  }

  /**
   * Auto/Ask toggle (Feature 1). Hard-gated on the org policy: a request to
   * enable auto-apply is IGNORED unless writeApproval === 'allow_auto'. The
   * server is the real gate (it refuses to mark the policy auto otherwise), but
   * the pane refuses too so a UI bug can't silently auto-write.
   */
  setAutoApply(value: boolean): void {
    const allowed = value && this.state.writeApproval === 'allow_auto';
    const next = value ? allowed : false;
    this.approvals.setAutoApply(next);
    this.update({ autoApply: this.approvals.isAutoApply() });
  }

  /**
   * Flag this conversation for the MSP admin to review (Feature 2). No-op
   * before a session exists (nothing to flag). On success sets flagged=true so
   * the action can render as done; on failure surfaces an error banner and
   * leaves flagged false so the user can retry.
   */
  async flagConversation(reason?: string): Promise<void> {
    if (!this.sessionId) return;
    try {
      await this.api.flagSession(this.sessionId, reason);
      this.update({ flagged: true });
    } catch (err) {
      this.update({ banner: { kind: 'error', text: bannerText(err) } });
    }
  }

  private async ensureSession(): Promise<string> {
    if (this.sessionId) return this.sessionId;
    let workbookName: string | undefined;
    try {
      workbookName = await this.captureName();
    } catch {
      workbookName = undefined; // workbook-name capture must never block session creation
    }
    const created = await this.api.createSession({
      host: this.clientHost,
      ...(workbookName ? { workbookName } : {}),
    });
    this.sessionId = created.sessionId;
    // Surface the effective org write policy so the pane can render (or hide)
    // the Auto/Ask toggle. Auto is impossible unless the org opted in.
    this.update({ writeApproval: created.writeApproval });
    this.openStream(this.sessionId);
    // Gate the first message on the subscription being live (see streamReady).
    await this.streamReady;
    return this.sessionId;
  }

  private openStream(sessionId: string): void {
    // Re-arm the readiness gate for this connection. onOpen fires when the
    // server's eager ping arrives; a timeout and a permanent-error both release
    // the gate so a missing signal can never hang the first send — it just falls
    // back to the prior (send-immediately) behavior.
    let release = () => {};
    this.streamReady = new Promise<void>((resolve) => {
      release = resolve;
    });
    const timer = setTimeout(release, STREAM_OPEN_TIMEOUT_MS);
    const markReady = () => {
      clearTimeout(timer);
      release();
    };
    this.stream = this.api.streamEvents(sessionId, {
      onOpen: markReady,
      onEvent: (event) => this.handleEvent(event),
      onReconnect: () => this.resync(),
      onPermanentError: () => {
        markReady(); // unblock any pending first send so it can surface the error
        this.update({
          busy: false,
          banner: { kind: 'error', text: 'Connection to Breeze lost. Reload the task pane.' },
        });
      },
    });
  }

  /** History list (per-user, workbook-tagged) for the resume picker. */
  listSessions(): Promise<SessionListItem[]> {
    return this.api.listSessions(this.clientHost);
  }

  /** "New chat" — tear down the current session/stream and reset the thread. */
  startNewSession(): void {
    this.stream?.stop();
    this.stream = null;
    this.sessionId = null;
    this.update({
      thread: [],
      streamingText: '',
      busy: false,
      banner: null,
      draft: '',
      usage: null,
    });
  }

  /**
   * Resume a past session: tear down any current stream, adopt the chosen id,
   * rehydrate the thread from server history (already redacted), and reopen the
   * live SSE stream so new turns flow.
   */
  async resumeSession(sessionId: string): Promise<void> {
    this.stream?.stop();
    this.stream = null;
    this.sessionId = sessionId;
    this.update({ thread: [], streamingText: '', busy: false, banner: null, usage: null });
    await this.resync();
    this.openStream(sessionId);
  }

  async send(content?: string): Promise<void> {
    const text = (content ?? this.state.draft).trim();
    if (!text || this.state.busy) return;
    let workbookContext: WorkbookContext | undefined;
    try {
      workbookContext = await this.capture(this.state.contextKind);
    } catch {
      workbookContext = undefined; // context capture must never block sending
    }
    this.update({
      thread: [
        ...this.state.thread,
        { kind: 'user', id: this.nextId++, text, ...(workbookContext ? { context: workbookContext } : {}) },
      ],
      draft: '',
      busy: true,
      banner: null,
    });
    try {
      const sessionId = await this.ensureSession();
      await this.api.sendMessage(sessionId, {
        content: text,
        ...(workbookContext ? { workbookContext } : {}),
      });
    } catch (err) {
      this.update({ busy: false, banner: { kind: 'error', text: bannerText(err) } });
    }
  }

  /** Moves any streamed text into the thread, optionally appending one more item. */
  private flushStreaming(extra?: ThreadMessage): void {
    const thread = [...this.state.thread];
    if (this.state.streamingText)
      thread.push({ kind: 'assistant', id: this.nextId++, text: this.state.streamingText });
    if (extra) thread.push(extra);
    this.update({ thread, streamingText: '' });
  }

  handleEvent(event: ClientAiStreamEvent): void {
    switch (event.type) {
      case 'message_delta':
        this.update({ streamingText: this.state.streamingText + event.text });
        break;
      case 'turn_complete':
        this.flushStreaming();
        this.update({ busy: false, usage: event.usage });
        break;
      case 'tool_request':
        void this.handleToolRequest(event);
        break;
      case 'tool_completed': {
        this.flushStreaming({
          kind: 'tool',
          id: this.nextId++,
          toolName: event.toolName,
          status: event.status,
          redactions: event.redactions.reduce((n, r) => n + r.count, 0),
          blockReason: event.blockReason,
        });
        if (event.blockReason)
          this.update({
            banner: {
              kind: 'blocked',
              text: `Blocked by your IT provider's data policy (${event.blockReason}).`,
            },
          });
        break;
      }
      case 'session_error':
        this.update({ busy: false, banner: { kind: 'error', text: event.message } });
        break;
      case 'ping':
        break; // server keepalive — nothing to do
    }
  }

  private async handleToolRequest(request: ToolRequest): Promise<void> {
    const sessionId = this.sessionId;
    if (!sessionId) return; // events only flow on an open stream, which implies a session
    // Defense-in-depth: the server flag is OR-ed with the host's local set so a
    // server bug can never auto-execute a write.
    const mutating = request.mutating || this.host.mutatingTools.has(request.toolName);
    if (mutating) {
      await this.approvals.enqueue(request);
      return;
    }
    const { status, output } = await runTool(request.toolName, request.input, this.host.toolExecutors);
    // A non-mutating tool result posts directly (no approval card). The post can
    // still be rejected (network/5xx, or the post-timeout 404) — surface it via
    // the same classifier the approval store uses instead of letting the parked
    // turn hang silently.
    try {
      await this.api.postToolResult(sessionId, { toolUseId: request.toolUseId, status, output });
    } catch (err) {
      this.handlePostError(err);
    }
  }

  /**
   * Classify a FAILED postToolResult. A post-timeout 404 `unknown_tool_request`
   * is BENIGN — the server already gave up on that parked request (unknown id /
   * already resolved / timed out), so re-reporting it does nothing useful: we
   * swallow it (debug log only, no banner). ANY other failure (network error,
   * 5xx) is surfaced to the user as an error banner AND logged, because the
   * model's turn is now stuck waiting for a result that will never arrive.
   */
  private handlePostError(err: unknown): void {
    if (err instanceof ApiError && err.status === 404 && err.code === 'unknown_tool_request') {
      // eslint-disable-next-line no-console
      console.debug('client-ai: tool result post hit a benign 404 (server already gave up)', err);
      return;
    }
    // eslint-disable-next-line no-console
    console.error('client-ai: failed to post tool result to server', err);
    this.update({
      banner: {
        kind: 'error',
        text: "Couldn't send your change to Breeze. Check your connection and try again.",
      },
    });
  }

  /** After an SSE reconnect: replace the local thread with server history (already redacted). */
  private async resync(): Promise<void> {
    if (!this.sessionId) return;
    try {
      const history = await this.api.getSession(this.sessionId);
      const thread: ThreadMessage[] = [];
      for (const m of history.messages) {
        if (m.toolName) {
          thread.push({
            kind: 'tool',
            id: this.nextId++,
            toolName: m.toolName,
            status: 'success',
            redactions: 0,
            blockReason: null,
          });
        } else if (m.role === 'user') {
          thread.push({ kind: 'user', id: this.nextId++, text: m.content ?? '' });
        } else if (m.content) {
          thread.push({ kind: 'assistant', id: this.nextId++, text: m.content });
        }
      }
      this.update({ thread, streamingText: '' });
    } catch {
      // keep the local thread when the history fetch fails — better stale than empty
    }
  }

  dispose(): void {
    this.stream?.stop();
    this.stream = null;
  }
}
