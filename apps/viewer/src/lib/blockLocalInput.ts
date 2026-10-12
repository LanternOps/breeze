// Block local input (#966, UI in #8241): asks the agent to block the on-site
// user's physical keyboard and mouse for this session. The agent already
// implements it (agent/internal/remote/desktop/session_control.go):
//
//   viewer → control: {"type":"block_local_input","value":1|0}
//   agent  → control: {"type":"block_local_input_result","supported":bool,
//                      "blocked":bool,"ok":bool,"error"?:string}
//
// The UI is rendered from the reply, never optimistically: the agent may not
// support blocking on this platform, may fail to engage, or (an agent that
// predates #966) may never answer at all. The agent auto-releases the block on
// session end and on its own watchdog.

export interface BlockLocalInputResult {
  supported: boolean;
  blocked: boolean;
  ok: boolean;
  error?: string;
}

export interface BlockLocalInputState {
  /** null until the agent has answered once. */
  supported: boolean | null;
  blocked: boolean;
  /** A request is in flight. */
  pending: boolean;
  error: string | null;
}

export const INITIAL_BLOCK_LOCAL_INPUT: BlockLocalInputState = {
  supported: null,
  blocked: false,
  pending: false,
  error: null,
};

/** How long a toggle waits for the agent before giving up on the reply. */
export const BLOCK_LOCAL_INPUT_REPLY_TIMEOUT_MS = 5000;

export function blockLocalInputMessage(block: boolean): string {
  return JSON.stringify({ type: 'block_local_input', value: block ? 1 : 0 });
}

export function parseBlockLocalInputResult(msg: unknown): BlockLocalInputResult | null {
  if (!msg || typeof msg !== 'object') return null;
  const m = msg as Record<string, unknown>;
  if (m.type !== 'block_local_input_result') return null;
  if (typeof m.supported !== 'boolean' || typeof m.blocked !== 'boolean' || typeof m.ok !== 'boolean') return null;
  return {
    supported: m.supported,
    blocked: m.blocked,
    ok: m.ok,
    error: typeof m.error === 'string' && m.error ? m.error : undefined,
  };
}

export function blockLocalInputRequested(state: BlockLocalInputState): BlockLocalInputState {
  return { ...state, pending: true, error: null };
}

export function applyBlockLocalInputResult(
  state: BlockLocalInputState,
  result: BlockLocalInputResult,
): BlockLocalInputState {
  return {
    ...state,
    supported: result.supported,
    blocked: result.blocked,
    pending: false,
    error: result.ok ? null : result.error ?? 'The remote device could not change local input blocking.',
  };
}

export function blockLocalInputTimedOut(state: BlockLocalInputState): BlockLocalInputState {
  if (!state.pending) return state;
  return {
    ...state,
    pending: false,
    error: 'The remote device did not respond to the block-input request.',
  };
}
