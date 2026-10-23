import type { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import type { AiAttachState, AiStreamEvent } from '@breeze/shared/types/ai';
import { requirePermission, requireScope, withAuthDbAccessContext } from '../middleware/auth';
import { PERMISSIONS } from '../services/permissions';
import { getSession } from '../services/aiAgent';
import { isChatSessionType } from '../services/aiChatSessionTypes';
import { streamingSessionManager, type ActiveSession } from '../services/streamingSessionManager';
import type { SequencedEvent } from '../services/sessionEventBus';
import { CLIENT_AI_SSE_PING_INTERVAL_MS } from './clientAi/sse';

/**
 * #9427 — `GET /ai/sessions/:id/stream`: attach to the CURRENT turn of one of
 * the caller's own chat sessions, so a conversation can move between the side
 * panel, an AI Assistant tab, or a reloaded page without re-sending anything.
 *
 * Wire format: `event: ping` (beacon), then one `event: attach_state` frame
 * (see `AiAttachState`), then — only while a turn runs — every later event of
 * that turn as `event: <type>`, `id: <seq>`, `data: {...event, seq}`, until
 * `done` or until the turn's bus closes. A RUNNING attach that ends without
 * `done` means the turn's bus closed — usually because a new `POST /messages`
 * replaced it (attach again); an `idle` or `unavailable` attach always ends
 * right after its `attach_state`.
 *
 * Security: ownership is the DB row, read by `getSession(id, auth)` — the
 * same owner + accessible-org + topology-site filter as `GET /ai/sessions/:id`,
 * never `allowAnyOwnerInOrg`. Every ownership or type refusal is the same 404
 * body as a missing id; the only other pre-stream refusal, 429 `attach_limit`,
 * is reachable only after ownership is proved. The in-memory session is only
 * looked up by an id the caller already proved it owns.
 *
 * Read-only: never creates an in-memory session, never sends, never
 * interrupts. DB: one short `withAuthDbAccessContext` for `getSession` before
 * the stream (the route is a self-managed DB context route), none inside it.
 */

/** Gate B #2: subscribers per turn bus, counting the sender's own `/messages` subscriber. */
export const ATTACH_MAX_SUBSCRIBERS = 8;

const NOT_FOUND_BODY = { error: 'Session not found' } as const;
// The shape Postgres' uuid type accepts in canonical form (any version or
// variant — stricter RFC checks would 404 a real id the column accepts).
const SESSION_ID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const requireAiUse = requirePermission(PERMISSIONS.AI_SESSIONS_USE.resource, PERMISSIONS.AI_SESSIONS_USE.action);

const UNAVAILABLE: AiAttachState = {
  turn: 'unavailable',
  turnId: null,
  lastSeq: 0,
  turnUserMessageId: null,
  replay: [],
  partial: false,
  pendingCards: [],
  activePlan: null,
  turnModel: null,
};

/** An in-memory session that can still produce events for this turn. */
function isLive(session: ActiveSession): boolean {
  return session.state !== 'closing' && session.state !== 'closed' && !session.eventBus.closed;
}

/**
 * `initializing`/`ready`: a session `/messages` has created but not yet
 * claimed for its turn (between `getOrCreate` and `tryTransitionToProcessing`).
 * Reported as `unavailable`, not `idle`, so a client re-attaching after a
 * closed stream or a `turn_in_progress` 409 keeps trying (see the web
 * `shouldReattach`) instead of settling on a turn that is about to start.
 */
function isAwaitingTurn(session: ActiveSession): boolean {
  return session.state === 'initializing' || session.state === 'ready';
}

type Capture =
  | { kind: 'unavailable' }
  | { kind: 'idle'; state: AiAttachState }
  | {
      kind: 'running';
      state: AiAttachState;
      session: ActiveSession;
      subscriptionId: string;
      events: AsyncIterable<SequencedEvent>;
    };

/**
 * Subscribe and snapshot in ONE synchronous step. The bus publishes
 * synchronously, so with no `await` between `subscribeSequenced` and
 * `snapshot` every event is either in the snapshot (`seq <= lastSeq`) or on
 * the subscription — never both, never neither.
 */
function captureTurn(session: ActiveSession, callerUserId: string): Capture {
  // Defense in depth: the DB row already proved ownership of this id, and only
  // its owner can start a turn on it. If the in-memory session disagrees,
  // show nothing rather than trust it — and say so, because it means an
  // invariant broke somewhere.
  if (session.auth?.user?.id !== callerUserId) {
    console.warn('[AI] Attach: in-memory session owner differs from the session row owner; refusing', {
      sessionId: session.breezeSessionId,
    });
    return { kind: 'unavailable' };
  }
  if (!isLive(session) || isAwaitingTurn(session)) return { kind: 'unavailable' };

  const bus = session.eventBus;
  const subscriptionId = crypto.randomUUID();
  const events = bus.subscribeSequenced(subscriptionId);
  const snap = bus.snapshot();
  const pendingCards = [...(session.pendingCards?.values() ?? [])];
  const running = session.state === 'processing' && !snap.sawDone;

  const base = {
    turnId: session.turnId ?? null,
    lastSeq: snap.lastSeq,
    turnUserMessageId: session.turnUserMessageId ?? null,
    activePlan: snap.activePlan,
    turnModel: snap.turnModel,
  };

  if (!running) {
    bus.unsubscribe(subscriptionId);
    // `done` is published before the session leaves `processing`, so a turn
    // that has published it is over even if the state has not caught up. An
    // idle attach carries no replay: the client re-reads the transcript.
    return { kind: 'idle', state: { ...base, turn: 'idle', replay: [], partial: false, pendingCards: [] } };
  }

  return {
    kind: 'running',
    session,
    subscriptionId,
    events,
    state: { ...base, turn: 'running', replay: snap.replay, partial: snap.partial, pendingCards },
  };
}

function attachStateFrame(state: AiAttachState) {
  const event: AiStreamEvent = { type: 'attach_state', ...state };
  return { event: 'attach_state', data: JSON.stringify(event) };
}

const PING_FRAME = { event: 'ping', data: '{}' } as const;

export function registerAiAttachRoute(routes: Hono): void {
  routes.get(
    '/sessions/:id/stream',
    requireScope('organization', 'partner', 'system'),
    requireAiUse,
    async (c) => {
      const auth = c.get('auth');
      const sessionId = c.req.param('id') ?? '';

      // A malformed id can match no row; answer exactly like a missing one.
      if (!SESSION_ID_SHAPE.test(sessionId)) return c.json(NOT_FOUND_BODY, 404);

      // The route's only DB read: the owner-bound row (no allowAnyOwnerInOrg).
      const row = await withAuthDbAccessContext(auth, () => getSession(sessionId, auth));
      if (!row || !isChatSessionType(row.type)) return c.json(NOT_FOUND_BODY, 404);

      const preStream = streamingSessionManager.get(sessionId);
      if (preStream && isLive(preStream) && preStream.eventBus.subscriberCount >= ATTACH_MAX_SUBSCRIBERS) {
        return c.json({ error: 'Too many viewers', code: 'attach_limit' }, 429);
      }

      return streamSSE(c, async (stream) => {
        // Synchronously, before any await: the session must still be the one
        // checked above (a new POST /messages replaces it), and the subscribe +
        // snapshot happen in the same tick.
        const current = streamingSessionManager.get(sessionId);
        const capture: Capture = current && current === preStream
          ? captureTurn(current, auth.user.id)
          : { kind: 'unavailable' };

        let ping: ReturnType<typeof setInterval> | null = null;
        const teardown = () => {
          if (ping) clearInterval(ping);
          ping = null;
          if (capture.kind === 'running') capture.session.eventBus.unsubscribe(capture.subscriptionId);
        };
        stream.onAbort(teardown);

        try {
          await stream.writeSSE(PING_FRAME);
          if (capture.kind !== 'running') {
            await stream.writeSSE(attachStateFrame(capture.kind === 'idle' ? capture.state : UNAVAILABLE));
            return;
          }

          await stream.writeSSE(attachStateFrame(capture.state));
          if (stream.aborted) return;
          ping = setInterval(() => {
            stream.writeSSE(PING_FRAME).catch(() => {
              /* client gone — the abort handler tears down */
            });
          }, CLIENT_AI_SSE_PING_INTERVAL_MS);

          const { lastSeq } = capture.state;
          for await (const { seq, event } of capture.events) {
            if (seq <= lastSeq) continue;
            await stream.writeSSE({ event: event.type, id: String(seq), data: JSON.stringify({ ...event, seq }) });
            if (event.type === 'done') break;
          }
          // Ending without `done` means the bus closed: the turn was replaced.
        } catch (err) {
          // Never stream raw error text; the client treats the early end like a
          // closed stream (bounded re-attach, then a re-read of the transcript).
          console.error('[AI] Attach stream error:', { sessionId, userId: auth.user.id }, err);
        } finally {
          teardown();
        }
      });
    },
  );
}
