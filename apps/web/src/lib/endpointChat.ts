import {
  agentSupportsEndpointChat,
  type EndpointChatDirection,
  type EndpointConversationStatus,
} from '@breeze/shared';
import { fetchWithAuth } from '../stores/auth';
import { runAction, type RunActionOptions } from './runAction';

export type ChatStatus = EndpointConversationStatus;

export interface ChatConversation {
  id: string;
  orgId: string;
  deviceId: string;
  status: ChatStatus;
  allowUserReply: boolean;
  targetUsername: string | null;
  errorCode: string | null;
  closeReason: string | null;
  openedBy: { id: string; name: string } | null;
  createdAt: string;
  lastActivityAt: string;
  closedAt: string | null;
}

export interface ChatMessage {
  id: string;
  conversationId: string;
  direction: EndpointChatDirection;
  body: string | null;
  senderName: string | null;
  /** Attested Windows username for user replies. */
  senderUsername: string | null;
  createdAt: string;
  /** Bumped when deliveredAt or errorCode changes; the poll cursor follows it. */
  updatedAt?: string;
  deliveredAt: string | null;
  errorCode: string | null;
}

export interface ChatSnapshot {
  conversation: ChatConversation;
  messages: ChatMessage[];
}

export interface ChatCloseResponse {
  conversation: ChatConversation;
  alreadyClosed?: boolean;
  /** False when the agent could not be told, so the user's window may linger. */
  agentNotified?: boolean;
}

export type ChatCapability = { supported: true } | { supported: false; reason: 'platform' | 'agent_version' };

/**
 * Chat needs the Assist helper in a Windows console session, and an agent that
 * understands chat commands (the same shared gate the API enforces).
 */
export function deviceChatCapability(device: {
  osType: 'windows' | 'macos' | 'linux' | string;
  agentVersion: string | null | undefined;
}): ChatCapability {
  if (device.osType !== 'windows') return { supported: false, reason: 'platform' };
  if (!agentSupportsEndpointChat(device.agentVersion)) return { supported: false, reason: 'agent_version' };
  return { supported: true };
}

/** Newest `updatedAt ?? createdAt` over the messages, or undefined for none. */
export function latestMessageStamp(messages: ChatMessage[]): string | undefined {
  let newest: string | undefined;
  for (const m of messages) {
    const stamp = m.updatedAt ?? m.createdAt;
    if (!newest || stamp > newest) newest = stamp;
  }
  return newest;
}

/** A failed conversation read; `status` drives terminal-vs-transient handling. */
export class ChatReadError extends Error {
  status: number;
  constructor(status: number) {
    super(`chat_read_failed_${status}`);
    this.name = 'ChatReadError';
    this.status = status;
  }
}

export function isTerminalReadError(err: unknown): boolean {
  return err instanceof ChatReadError && (err.status === 403 || err.status === 404);
}

export function isLiveStatus(status: ChatStatus): boolean {
  return status === 'opening' || status === 'open';
}

/** Union by id (incoming wins), ordered by createdAt then id. */
export function mergeMessages(existing: ChatMessage[], incoming: ChatMessage[]): ChatMessage[] {
  const byId = new Map<string, ChatMessage>();
  for (const m of existing) byId.set(m.id, m);
  for (const m of incoming) byId.set(m.id, m);
  return [...byId.values()].sort((a, b) =>
    a.createdAt === b.createdAt ? a.id.localeCompare(b.id) : a.createdAt < b.createdAt ? -1 : 1,
  );
}

const BASE = '/endpoint-messages/conversations';

/** GET /conversations?deviceId=: newest conversations for a device. */
export async function listConversations(deviceId: string): Promise<ChatConversation[]> {
  const response = await fetchWithAuth(`${BASE}?deviceId=${encodeURIComponent(deviceId)}`);
  if (!response.ok) throw new Error(`chat_list_failed_${response.status}`);
  return ((await response.json()) as { conversations: ChatConversation[] }).conversations ?? [];
}

/** GET /conversations/:id?since=: the conversation plus messages created after `since`. */
export async function getConversation(id: string, since?: string): Promise<ChatSnapshot> {
  const qs = since ? `?since=${encodeURIComponent(since)}` : '';
  const response = await fetchWithAuth(`${BASE}/${encodeURIComponent(id)}${qs}`);
  if (!response.ok) throw new ChatReadError(response.status);
  return (await response.json()) as ChatSnapshot;
}

type MutationOptions<T> = Pick<
  RunActionOptions<T>,
  'errorFallback' | 'friendly' | 'suppressErrorToast' | 'onUnauthorized' | 'successMessage'
>;

/**
 * POST /conversations. `conversationId` is client-generated: a retry with the
 * same id never opens a second chat.
 */
export function openConversation(
  input: { conversationId: string; deviceId: string; body: string },
  opts: MutationOptions<ChatSnapshot>,
): Promise<ChatSnapshot> {
  return runAction<ChatSnapshot>({
    ...opts,
    request: () =>
      fetchWithAuth(BASE, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(input),
      }),
  });
}

/** POST /conversations/:id/messages. A retry with the same `messageId` is a no-op replay. */
export function sendChatMessage(
  conversationId: string,
  input: { messageId: string; body: string },
  opts: MutationOptions<{ message: ChatMessage }>,
): Promise<{ message: ChatMessage }> {
  return runAction<{ message: ChatMessage }>({
    ...opts,
    request: () =>
      fetchWithAuth(`${BASE}/${encodeURIComponent(conversationId)}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(input),
      }),
  });
}

/** POST /conversations/:id/close (idempotent). */
export function closeConversation(
  conversationId: string,
  opts: MutationOptions<ChatCloseResponse>,
): Promise<ChatCloseResponse> {
  return runAction<ChatCloseResponse>({
    ...opts,
    request: () => fetchWithAuth(`${BASE}/${encodeURIComponent(conversationId)}/close`, { method: 'POST' }),
  });
}

export const CHAT_POLL_INTERVAL_MS = 3000;

export interface ConversationPollerOptions {
  conversationId: string;
  initialStatus: ChatStatus;
  /** Newest message createdAt already held; the poller advances it itself. */
  initialSince?: string;
  intervalMs?: number;
  fetchConversation?: (id: string, since?: string) => Promise<ChatSnapshot>;
  onUpdate: (snapshot: ChatSnapshot) => void;
  /** `terminal` is true for 403/404: the poller has stopped for good. */
  onError?: (err: unknown, terminal: boolean) => void;
}

export interface ConversationPoller {
  start: () => void;
  stop: () => void;
}

/**
 * Polls one conversation every 3 s, only while the tab is visible and the
 * conversation is `opening`/`open`. Hidden pauses (a catch-up poll runs on
 * return); closed/expired/failed or stop() end it for good.
 */
export function createConversationPoller(opts: ConversationPollerOptions): ConversationPoller {
  const interval = opts.intervalMs ?? CHAT_POLL_INTERVAL_MS;
  const fetchOnce = opts.fetchConversation ?? getConversation;
  let status = opts.initialStatus;
  let since = opts.initialSince;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let stopped = true;
  let inFlight = false;

  const visible = () => typeof document === 'undefined' || document.visibilityState === 'visible';
  const clear = () => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
  };
  const schedule = (delay: number) => {
    clear();
    if (stopped || !isLiveStatus(status) || !visible()) return;
    timer = setTimeout(() => void tick(), delay);
  };

  async function tick() {
    timer = null;
    if (stopped || inFlight || !isLiveStatus(status) || !visible()) return;
    inFlight = true;
    try {
      const snapshot = await fetchOnce(opts.conversationId, since);
      if (stopped) return;
      status = snapshot.conversation.status;
      const stamp = latestMessageStamp(snapshot.messages);
      if (stamp && (!since || stamp > since)) since = stamp;
      opts.onUpdate(snapshot);
    } catch (err) {
      if (!stopped) {
        const terminal = isTerminalReadError(err);
        if (terminal) {
          stopped = true;
          clear();
          document.removeEventListener('visibilitychange', onVisibility);
        }
        opts.onError?.(err, terminal);
      }
    } finally {
      inFlight = false;
      schedule(interval);
    }
  }

  const onVisibility = () => {
    if (stopped) return;
    if (!visible()) {
      clear();
      return;
    }
    if (isLiveStatus(status) && timer === null && !inFlight) schedule(0);
  };

  return {
    start() {
      if (!stopped) return;
      stopped = false;
      document.addEventListener('visibilitychange', onVisibility);
      schedule(interval);
    },
    stop() {
      stopped = true;
      clear();
      document.removeEventListener('visibilitychange', onVisibility);
    },
  };
}
