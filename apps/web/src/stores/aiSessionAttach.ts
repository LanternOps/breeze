// Read-only attach to a session's current turn (#9427): GET /ai/sessions/:id/stream.
// One attach covers ONE turn - every POST /messages replaces the in-memory
// session and closes its bus, so a RUNNING attach that ends without `done`
// usually means a new turn started and the caller should attach again (see
// shouldReattach). An idle or unavailable attach ends right after attach_state.
//
// Loads on the topology island: '@breeze/shared' imports must stay type-only,
// hence the local structural attach_state check instead of isAttachStateEvent.
import type { AiAttachState, AiStreamEvent } from '@breeze/shared';
import { fetchWithAuth } from './auth';

export type AttachOutcome =
  | { kind: 'done' }
  | { kind: 'idle' }
  | { kind: 'unavailable' }
  | { kind: 'closed' } // a running attach ended without done (bus closed, usually replaced by a new turn)
  | { kind: 'gap' } // seq jumped; caller re-attaches for a fresh snapshot
  | { kind: 'not_found' }
  | { kind: 'busy' }
  | { kind: 'aborted' }
  | { kind: 'error'; message: string };

export interface AttachOptions {
  signal: AbortSignal;
  /** attach_state first, then live events (seq stripped). */
  onEvent: (event: AiStreamEvent) => void;
  /** Applied to live events and to attach_state's replay / pendingCards. */
  filter?: (event: AiStreamEvent) => boolean;
}

export type AttachReady =
  | { kind: 'ready'; turn: 'idle' | 'running' | 'unavailable'; state: AiAttachState }
  | Extract<AttachOutcome, { kind: 'not_found' | 'busy' | 'aborted' | 'error' | 'closed' }>;

type AttachStateFrame = { type: 'attach_state' } & AiAttachState;

function isAttachState(e: unknown): e is AttachStateFrame {
  if (!e || typeof e !== 'object') return false;
  const v = e as Record<string, unknown>;
  return v.type === 'attach_state'
    && (v.turn === 'idle' || v.turn === 'running' || v.turn === 'unavailable')
    && typeof v.lastSeq === 'number'
    && typeof v.partial === 'boolean'
    && Array.isArray(v.replay)
    && Array.isArray(v.pendingCards);
}

export function attachAiSession(
  sessionId: string,
  opts: AttachOptions,
): { ready: Promise<AttachReady>; finished: Promise<AttachOutcome> } {
  let resolveReady!: (r: AttachReady) => void;
  let readySettled = false;
  const ready = new Promise<AttachReady>((r) => { resolveReady = r; });
  const settleReady = (r: AttachReady) => {
    if (readySettled) return;
    readySettled = true;
    resolveReady(r);
  };

  const run = async (): Promise<AttachOutcome> => {
    const { signal, onEvent, filter } = opts;
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    const cancel = () => { void reader?.cancel().catch(() => undefined); };
    try {
      const res = await fetchWithAuth(`/ai/sessions/${sessionId}/stream`, { signal });
      if (res.status === 404) return { kind: 'not_found' };
      if (res.status === 429) return { kind: 'busy' };
      if (!res.ok) return { kind: 'error', message: `Attach failed (${res.status})` };
      reader = res.body?.getReader();
      if (!reader) return { kind: 'error', message: 'No response body' };
      // A parked read() must wake on abort even if the transport ignores the signal.
      signal.addEventListener('abort', cancel, { once: true });

      const decoder = new TextDecoder();
      let buffer = '';
      let eventName = '';
      let state: AttachStateFrame | null = null;
      let prevSeq = 0;
      let outcome: AttachOutcome | null = null;

      // Returns true once the stream has reached a terminal outcome.
      const handleData = (json: string): boolean => {
        let data: unknown;
        try { data = JSON.parse(json); } catch { return false; }
        if (eventName === 'ping') return false;
        if (!data || typeof data !== 'object' || typeof (data as { type?: unknown }).type !== 'string') return false;

        if (!state) {
          // The server's first typed frame is always attach_state. Anything
          // else (e.g. an API/web version skew) must fail loudly, not leave the
          // caller waiting on a ready that never settles for the whole turn.
          if (!isAttachState(data)) {
            console.warn('[AI] Attach: unrecognized first frame', { type: (data as { type: string }).type, turn: (data as { turn?: unknown }).turn });
            outcome = { kind: 'error', message: 'Unrecognized attach response' };
            return true;
          }
          state = data;
          prevSeq = data.lastSeq;
          const keep = (e: AiStreamEvent) => !filter || filter(e);
          const filtered = {
            ...data,
            replay: data.replay.filter(keep),
            pendingCards: data.pendingCards.filter((c) => keep(c)),
          } as AttachStateFrame;
          onEvent(filtered as unknown as AiStreamEvent);
          settleReady({ kind: 'ready', turn: data.turn, state: filtered });
          if (data.turn === 'idle') outcome = { kind: 'idle' };
          else if (data.turn === 'unavailable') outcome = { kind: 'unavailable' };
          return outcome !== null;
        }

        const { seq, ...event } = data as Record<string, unknown> & { type: string; seq?: unknown };
        if (typeof seq === 'number') {
          if (seq <= prevSeq) return false; // already covered by the snapshot
          if (seq > prevSeq + 1) { outcome = { kind: 'gap' }; return true; }
          prevSeq = seq;
        }
        // Filtered-out events still advanced the seq bookkeeping above.
        if (!filter || filter(event as unknown as AiStreamEvent)) onEvent(event as unknown as AiStreamEvent);
        if (event.type === 'done') { outcome = { kind: 'done' }; return true; }
        return false;
      };

      const handleLine = (rawLine: string): boolean => {
        const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
        if (line === '') { eventName = ''; return false; } // blank line ends a frame
        if (line.startsWith('event:')) { eventName = line.slice(6).trim(); return false; }
        if (line.startsWith('data:')) {
          const json = line.slice(5).trim();
          return json ? handleData(json) : false;
        }
        return false; // id: and comments carry nothing we need (seq rides in data)
      };

      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';
        for (const line of lines) {
          if (handleLine(line)) { cancel(); return outcome!; }
        }
      }
      return signal.aborted ? { kind: 'aborted' } : { kind: 'closed' };
    } catch (err) {
      cancel();
      if (signal.aborted) return { kind: 'aborted' };
      return { kind: 'error', message: err instanceof Error ? err.message : 'Attach failed' };
    } finally {
      signal.removeEventListener('abort', cancel);
    }
  };

  const finished = run().then((outcome) => {
    // A failure before attach_state settles ready with the same outcome.
    if (!readySettled) {
      settleReady(outcome as Extract<AttachOutcome, { kind: 'not_found' | 'busy' | 'aborted' | 'error' | 'closed' }>);
    }
    return outcome;
  });
  return { ready, finished };
}

/** Full jitter: uniform in [0, min(8000, 500 * 2^attempt)]. */
export function attachBackoffMs(attempt: number, random: () => number = Math.random): number {
  return Math.round(random() * Math.min(8000, 500 * 2 ** attempt));
}

export const ATTACH_MAX_ATTEMPTS = 4;

/**
 * Re-attach policy shared by the panel and the workspace. `cycle` is owned by
 * the caller's attach loop. `unavailable` re-attaches only inside a cycle that
 * began with `closed` or a turn_in_progress 409 (the gap between the old
 * session's removal and the new one's creation), never on a first open.
 */
export function shouldReattach(
  outcome: AttachOutcome,
  cycle: { attempt: number; afterClosedOr409: boolean },
): boolean {
  if (cycle.attempt >= ATTACH_MAX_ATTEMPTS) return false;
  switch (outcome.kind) {
    case 'closed':
    case 'gap':
    case 'busy':
      return true;
    case 'unavailable':
      return cycle.afterClosedOr409;
    default:
      return false;
  }
}

// Live attaches, so logout can stop them all (no store write after logout).
const tracked = new Set<AbortController>();

export function trackAttach(controller: AbortController): () => void {
  tracked.add(controller);
  return () => { tracked.delete(controller); };
}

export function abortAllAttaches(): void {
  const all = [...tracked];
  tracked.clear();
  for (const c of all) c.abort();
}
