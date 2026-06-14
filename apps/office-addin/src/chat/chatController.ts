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
import { dispatchToolRequest, type ToolRequest } from '../tools/dispatcher';
import { ApprovalStore } from '../approval/approvalStore';
import { captureWorkbookContext, captureWorkbookName } from './captureContext';
import type {
  ClientAiStreamEvent,
  CreateSessionBody,
  SendMessageBody,
  SessionCreated,
  SessionHistory,
  SessionListItem,
  ToolCompletedStatus,
  ToolResultBody,
  TurnUsage,
  WorkbookContext,
  WorkbookContextKind,
  WriteApproval,
} from '../api/types';

export type ChatApi = {
  createSession: (body?: CreateSessionBody) => Promise<SessionCreated>;
  sendMessage: (sessionId: string, body: SendMessageBody) => Promise<void>;
  postToolResult: (sessionId: string, result: ToolResultBody) => Promise<void>;
  streamEvents: (sessionId: string, callbacks: StreamCallbacks) => StreamHandle;
  getSession: (sessionId: string) => Promise<SessionHistory>;
  listSessions: () => Promise<SessionListItem[]>;
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
  private nextId = 1;
  private api: ChatApi;
  private capture: (kind: WorkbookContextKind) => Promise<WorkbookContext | undefined>;
  private captureName: () => Promise<string | undefined>;

  constructor(deps: ChatControllerDeps = {}) {
    this.api = deps.api ?? realApi;
    this.capture = deps.captureContext ?? captureWorkbookContext;
    this.captureName = deps.captureName ?? captureWorkbookName;
    this.approvals = new ApprovalStore({
      postToolResult: async (result) => {
        if (!this.sessionId) throw new Error('No active session for tool result');
        await this.api.postToolResult(this.sessionId, result);
      },
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
    const created = await this.api.createSession(workbookName ? { workbookName } : {});
    this.sessionId = created.sessionId;
    // Surface the effective org write policy so the pane can render (or hide)
    // the Auto/Ask toggle. Auto is impossible unless the org opted in.
    this.update({ writeApproval: created.writeApproval });
    this.openStream(this.sessionId);
    return this.sessionId;
  }

  private openStream(sessionId: string): void {
    this.stream = this.api.streamEvents(sessionId, {
      onEvent: (event) => this.handleEvent(event),
      onReconnect: () => this.resync(),
      onPermanentError: () =>
        this.update({
          busy: false,
          banner: { kind: 'error', text: 'Connection to Breeze lost. Reload the task pane.' },
        }),
    });
  }

  /** History list (per-user, workbook-tagged) for the resume picker. */
  listSessions(): Promise<SessionListItem[]> {
    return this.api.listSessions();
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
    await dispatchToolRequest(request, {
      postToolResult: (result) => this.api.postToolResult(sessionId, result),
      enqueueApproval: (req) => this.approvals.enqueue(req),
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
