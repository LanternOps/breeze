import { create } from 'zustand';

declare global {
  interface Window {
    __TAURI_INTERNALS__?: unknown;
  }
}

interface AgentConfig {
  api_url: string;
  token: string;
  agent_id: string;
  has_mtls?: boolean;
}

interface ChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'tool_use' | 'tool_result';
  content: string;
  toolName?: string;
  toolInput?: Record<string, unknown>;
  toolOutput?: unknown;
  toolUseId?: string;
  isError?: boolean;
  isStreaming?: boolean;
  createdAt: Date;
}

type ConnectionState = 'disconnected' | 'connecting' | 'connected' | 'error';

interface ChatState {
  connectionState: ConnectionState;
  connectionError: string | null;
  agentConfig: AgentConfig | null;
  sessionId: string | null;
  messages: ChatMessage[];
  isStreaming: boolean;
  error: string | null;

  initialize: () => Promise<void>;
  sendMessage: (content: string) => Promise<void>;
  clearMessages: () => Promise<void>;
}

// ---------------------------------------------------------------------------
// Tauri bridge helpers
// ---------------------------------------------------------------------------

/** Cached reference to the Tauri invoke function, or null if not in Tauri. */
let _tauriInvoke: ((cmd: string, args?: Record<string, unknown>) => Promise<unknown>) | null = null;
let _tauriInvokeResolved = false;

/**
 * Dynamically import Tauri invoke -- returns null in non-Tauri environments.
 */
async function getTauriInvoke(): Promise<
  ((cmd: string, args?: Record<string, unknown>) => Promise<unknown>) | null
> {
  if (_tauriInvokeResolved) return _tauriInvoke;
  try {
    if (!window.__TAURI_INTERNALS__) {
      _tauriInvokeResolved = true;
      return null;
    }
    const mod = await import('@tauri-apps/api/core');
    _tauriInvoke = mod.invoke as (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;
    _tauriInvokeResolved = true;
    return _tauriInvoke;
  } catch {
    _tauriInvokeResolved = true;
    return null;
  }
}

/** Cached reference to the Tauri event listen function. */
let _tauriListen: ((
  event: string,
  handler: (ev: { payload: unknown }) => void,
) => Promise<() => void>) | null = null;
let _tauriListenResolved = false;

async function getTauriListen() {
  if (_tauriListenResolved) return _tauriListen;
  try {
    if (!window.__TAURI_INTERNALS__) {
      _tauriListenResolved = true;
      return null;
    }
    const mod = await import('@tauri-apps/api/event');
    _tauriListen = mod.listen as (
      event: string,
      handler: (ev: { payload: unknown }) => void,
    ) => Promise<() => void>;
    _tauriListenResolved = true;
    return _tauriListen;
  } catch {
    _tauriListenResolved = true;
    return null;
  }
}

// ---------------------------------------------------------------------------
// helper_fetch response types (match Rust structs)
// ---------------------------------------------------------------------------

interface HelperFetchResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
  stream_id: string | null;
}

interface StreamChunkEvent {
  stream_id: string;
  chunk: string | null;
  done: boolean;
  error: string | null;
}

// ---------------------------------------------------------------------------
// Unified HTTP helpers that use helper_fetch in Tauri, plain fetch otherwise
// ---------------------------------------------------------------------------

/**
 * Make a non-streaming HTTP request. In Tauri, uses the Rust backend
 * (which attaches the mTLS client cert). In browser dev mode, uses fetch().
 */
async function helperRequest(
  config: AgentConfig,
  url: string,
  options: { method?: string; headers?: Record<string, string>; body?: string },
): Promise<{ ok: boolean; status: number; body: string }> {
  const invoke = await getTauriInvoke();

  if (invoke) {
    const resp = (await invoke('helper_fetch', {
      request: {
        url,
        method: options.method ?? 'GET',
        headers: options.headers ?? {},
        body: options.body,
        stream: false,
      },
    })) as HelperFetchResponse;

    return {
      ok: resp.status >= 200 && resp.status < 300,
      status: resp.status,
      body: resp.body,
    };
  }

  // Dev fallback: use native fetch
  const res = await fetch(url, {
    method: options.method ?? 'GET',
    headers: {
      Authorization: `Bearer ${config.token}`,
      ...(options.headers ?? {}),
    },
    body: options.body,
  });

  const body = await res.text();
  return { ok: res.ok, status: res.status, body };
}

/**
 * Make a streaming HTTP request. In Tauri, uses helper_fetch with stream=true
 * and listens for Tauri events. In browser dev mode, uses fetch() ReadableStream.
 *
 * Calls `onChunk` for every raw text chunk received and `onDone` when the stream
 * finishes. Returns a cleanup function.
 */
async function helperStreamRequest(
  config: AgentConfig,
  url: string,
  options: { method?: string; headers?: Record<string, string>; body?: string },
  onChunk: (text: string) => void,
  onDone: (error?: string) => void,
): Promise<{
  ok: boolean;
  status: number;
  headers: Record<string, string>;
  cancel: () => void;
}> {
  const invoke = await getTauriInvoke();
  const listen = await getTauriListen();

  if (invoke && listen) {
    // Tauri path: use Rust backend for mTLS support
    const resp = (await invoke('helper_fetch', {
      request: {
        url,
        method: options.method ?? 'GET',
        headers: options.headers ?? {},
        body: options.body,
        stream: true,
      },
    })) as HelperFetchResponse;

    const isOk = resp.status >= 200 && resp.status < 300;
    const streamId = resp.stream_id;

    if (!streamId) {
      // No streaming -- body was returned inline (error responses, etc.)
      if (resp.body) {
        onChunk(resp.body);
      }
      onDone();
      return { ok: isOk, status: resp.status, headers: resp.headers, cancel: () => {} };
    }

    let unlisten: (() => void) | null = null;

    const unlistenPromise = listen('helper-fetch-stream', (ev: { payload: unknown }) => {
      const data = ev.payload as StreamChunkEvent;
      if (data.stream_id !== streamId) return;

      if (data.done) {
        if (data.error) {
          onDone(data.error);
        } else {
          onDone();
        }
        // Clean up listener
        if (unlisten) unlisten();
      } else if (data.chunk) {
        onChunk(data.chunk);
      }
    });

    // Store the unlisten function for cleanup
    unlisten = await unlistenPromise as unknown as () => void;

    return {
      ok: resp.status >= 200 && resp.status < 300,
      status: resp.status,
      headers: resp.headers,
      cancel: () => {
        if (unlisten) unlisten();
      },
    };
  }

  // Dev fallback: use native fetch with ReadableStream
  const res = await fetch(url, {
    method: options.method ?? 'GET',
    headers: {
      Authorization: `Bearer ${config.token}`,
      ...(options.headers ?? {}),
    },
    body: options.body,
  });

  const respHeaders: Record<string, string> = {};
  res.headers.forEach((v, k) => {
    respHeaders[k] = v;
  });

  if (!res.ok) {
    const body = await res.text();
    // Pass the error body text through onChunk so the caller can parse it
    onChunk(body);
    onDone();
    return { ok: false, status: res.status, headers: respHeaders, cancel: () => {} };
  }

  const reader = res.body?.getReader();
  if (!reader) {
    onDone('No response body');
    return { ok: true, status: res.status, headers: respHeaders, cancel: () => {} };
  }

  let cancelled = false;
  const decoder = new TextDecoder();

  // Read in background
  (async () => {
    try {
      while (!cancelled) {
        const { done, value } = await reader.read();
        if (done) break;
        onChunk(decoder.decode(value, { stream: true }));
      }
      onDone();
    } catch (err) {
      if (!cancelled) {
        onDone(err instanceof Error ? err.message : 'Stream read error');
      }
    }
  })();

  return {
    ok: true,
    status: res.status,
    headers: respHeaders,
    cancel: () => {
      cancelled = true;
      reader.cancel().catch(() => {});
    },
  };
}

// ---------------------------------------------------------------------------
// SSE line parser (shared between Tauri and browser paths)
// ---------------------------------------------------------------------------

function processSSELines(
  lines: string[],
  currentAssistantId: { value: string | null },
  set: (fn: (s: ChatState) => Partial<ChatState>) => void,
  setDirect: (partial: Partial<ChatState>) => void,
) {
  for (const line of lines) {
    if (!line.startsWith('data:')) continue;
    const jsonStr = line.slice(5).trim();
    if (!jsonStr) continue;

    try {
      const event = JSON.parse(jsonStr);

      switch (event.type) {
        case 'message_start': {
          const msg: ChatMessage = {
            id: event.messageId,
            role: 'assistant',
            content: '',
            isStreaming: true,
            createdAt: new Date(),
          };
          set((s) => ({ messages: [...s.messages, msg] }));
          currentAssistantId.value = event.messageId;
          break;
        }

        case 'content_delta': {
          if (currentAssistantId.value) {
            const aid = currentAssistantId.value;
            set((s) => ({
              messages: s.messages.map((m) =>
                m.id === aid ? { ...m, content: m.content + event.delta } : m,
              ),
            }));
          }
          break;
        }

        case 'tool_use_start': {
          const toolMsg: ChatMessage = {
            id: `tool-${event.toolUseId}`,
            role: 'tool_use',
            content: '',
            toolName: event.toolName,
            toolInput: event.input,
            toolUseId: event.toolUseId,
            createdAt: new Date(),
          };
          set((s) => ({ messages: [...s.messages, toolMsg] }));
          break;
        }

        case 'tool_result': {
          const resultMsg: ChatMessage = {
            id: `result-${event.toolUseId}`,
            role: 'tool_result',
            content:
              typeof event.output === 'string'
                ? event.output
                : JSON.stringify(event.output, null, 2),
            toolOutput: event.output,
            toolUseId: event.toolUseId,
            isError: event.isError,
            createdAt: new Date(),
          };
          set((s) => ({ messages: [...s.messages, resultMsg] }));
          break;
        }

        case 'message_end': {
          if (currentAssistantId.value) {
            const aid = currentAssistantId.value;
            set((s) => ({
              messages: s.messages.map((m) =>
                m.id === aid ? { ...m, isStreaming: false } : m,
              ),
            }));
          }
          break;
        }

        case 'error': {
          setDirect({ error: event.message || 'An error occurred' });
          break;
        }

        case 'done': {
          setDirect({ isStreaming: false });
          break;
        }
      }
    } catch (parseErr) {
      console.error('[Helper] Failed to parse SSE event:', jsonStr.slice(0, 200), parseErr);
    }
  }
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export const useChatStore = create<ChatState>((set, get) => ({
  connectionState: 'disconnected',
  connectionError: null,
  agentConfig: null,
  sessionId: null,
  messages: [],
  isStreaming: false,
  error: null,

  initialize: async () => {
    set({ connectionState: 'connecting', connectionError: null });

    try {
      let config: AgentConfig;

      const invoke = await getTauriInvoke();
      if (invoke) {
        config = (await invoke('read_agent_config')) as AgentConfig;
      } else {
        // Dev fallback: read from env or local config
        const apiUrl = (import.meta as unknown as { env?: Record<string, string> }).env?.VITE_API_URL;
        const token = (import.meta as unknown as { env?: Record<string, string> }).env?.VITE_AGENT_TOKEN;
        const agentId = (import.meta as unknown as { env?: Record<string, string> }).env?.VITE_AGENT_ID;

        if (!apiUrl || !token || !agentId) {
          throw new Error('Not running in Tauri and VITE_API_URL/VITE_AGENT_TOKEN/VITE_AGENT_ID not set');
        }

        config = { api_url: apiUrl, token, agent_id: agentId };
      }

      set({ agentConfig: config, connectionState: 'connected' });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to read agent config';
      console.error('[Helper] Initialize failed:', message);
      set({ connectionState: 'error', connectionError: message });
    }
  },

  sendMessage: async (content: string) => {
    const { agentConfig, sessionId, connectionState } = get();
    if (!agentConfig || connectionState !== 'connected') return;

    const trimmed = content.trim();
    if (!trimmed) return;

    // Optimistic user message
    const userMsgId = crypto.randomUUID();
    const userMsg: ChatMessage = {
      id: userMsgId,
      role: 'user',
      content: trimmed,
      createdAt: new Date(),
    };

    set((s) => ({
      messages: [...s.messages, userMsg],
      isStreaming: true,
      error: null,
    }));

    try {
      // Create session if needed
      let currentSessionId = sessionId;
      if (!currentSessionId) {
        const createRes = await helperRequest(
          agentConfig,
          `${agentConfig.api_url}/api/v1/helper/chat/sessions`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({}),
          },
        );

        if (!createRes.ok) {
          const data = (() => {
            try {
              return JSON.parse(createRes.body);
            } catch {
              return { error: 'Failed to create session' };
            }
          })();
          throw new Error(data.error || 'Failed to create session');
        }

        const sessionData = JSON.parse(createRes.body);
        currentSessionId = sessionData.id;
        set({ sessionId: currentSessionId });
      }

      // Send message and process SSE stream
      let buffer = '';
      const currentAssistantId = { value: null as string | null };

      const streamResult = await helperStreamRequest(
        agentConfig,
        `${agentConfig.api_url}/api/v1/helper/chat/sessions/${currentSessionId}/messages`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ content: trimmed }),
        },
        // onChunk
        (text: string) => {
          buffer += text;
          const lines = buffer.split('\n');
          buffer = lines.pop() ?? '';
          processSSELines(lines, currentAssistantId, set, (partial) => set(() => partial));
        },
        // onDone
        (error?: string) => {
          // Process any remaining buffer
          if (buffer.trim()) {
            const lines = buffer.split('\n');
            processSSELines(lines, currentAssistantId, set, (partial) => set(() => partial));
          }
          if (error) {
            set(() => ({ error, isStreaming: false }));
          }
        },
      );

      if (!streamResult.ok) {
        // For Tauri path: error responses are returned inline (not streamed),
        // so the body is available in `buffer` from the onChunk callback.
        // For browser path: the error body was also passed through onChunk.
        const errorText = buffer.trim();
        const data = (() => {
          try {
            return JSON.parse(errorText);
          } catch {
            return { error: errorText || 'Failed to send message' };
          }
        })();

        if (streamResult.status === 409) {
          set((s) => ({
            messages: s.messages.filter((m) => m.id !== userMsgId),
            error: data.error || 'Another response is still in progress.',
          }));
          return;
        }

        throw new Error(data.error || 'Failed to send message');
      }
    } catch (err) {
      set({
        error: err instanceof Error ? err.message : 'Failed to send message',
        isStreaming: false,
      });
    } finally {
      const state = get();
      if (state.isStreaming) {
        set({ isStreaming: false });
      }
    }
  },

  clearMessages: async () => {
    const { agentConfig, sessionId } = get();

    if (agentConfig && sessionId) {
      try {
        await helperRequest(
          agentConfig,
          `${agentConfig.api_url}/api/v1/helper/chat/sessions/${sessionId}`,
          { method: 'DELETE' },
        );
      } catch (err) {
        console.error('[Helper] Failed to close session:', err);
      }
    }

    set({
      sessionId: null,
      messages: [],
      isStreaming: false,
      error: null,
    });
  },
}));
