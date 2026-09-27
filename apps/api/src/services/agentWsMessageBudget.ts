/**
 * Per-connection message-rate budget for the agent WebSocket's `onMessage`
 * dispatch (`routes/agentWs.ts`).
 *
 * `checkAgentWsRateLimitDistributed` bounds how often an agent credential can
 * OPEN a new connection, but once a socket is open there is no limit at all
 * on how fast it can send FRAMES on it — every frame runs JSON.parse plus
 * schema validation plus (for most message types) a DB/Redis-backed handler,
 * all on the shared event loop. A single connection sending frames as fast as
 * the transport allows can starve every OTHER agent's connection sharing the
 * process. This module adds a simple in-memory token bucket, one per socket,
 * checked at the very top of `onMessage` before any parsing or handler work.
 *
 * Scoped to the SOCKET, not the agent id: keyed by a `WeakMap` on the
 * `WSContext` instance itself, so state is per-connection and is reclaimed by
 * the garbage collector when the socket closes — nothing to reset between
 * reconnects, and nothing that can carry over across a test file's ~5,600-line
 * shared-state suite the way an agent-id-keyed map would (many tests reuse
 * the same literal agent id across cases; a fresh mock `ws` object per test
 * keeps each case's bucket independent).
 *
 * Sized against real agent-ws traffic: heartbeat ping/pong (one pair roughly
 * every `AGENT_PING_INTERVAL_MS`, tens of seconds), command results (one frame
 * per command, not a stream), and the WS-fallback desktop/terminal streams —
 * the highest-rate legitimate traffic on this socket, capped at
 * `agent/internal/remote/desktop/ws_stream.go`'s `MaxFPS` (1-30, default 15).
 * The refill rate and burst capacity below sit comfortably above a 30fps
 * video stream plus concurrent terminal output, so a healthy agent — even one
 * running a live remote session — never trips this budget.
 */

const DECIMAL_INT = /^[+-]?\d+(?:\.\d+)?$/;

function envInt(name: string, defaultValue: number): number {
  const raw = process.env[name];
  if (!raw || !DECIMAL_INT.test(raw)) return defaultValue;
  return Math.trunc(Number(raw));
}

/** Burst capacity in messages — comfortably above a multi-second burst at the sustained refill rate. */
const AGENT_WS_MESSAGE_BUDGET_CAPACITY = envInt('AGENT_WS_MESSAGE_BUDGET_CAPACITY', 300);
/** Sustained refill rate in messages/second — well above a 30fps desktop stream plus terminal chatter. */
const AGENT_WS_MESSAGE_BUDGET_REFILL_PER_SECOND = envInt('AGENT_WS_MESSAGE_BUDGET_REFILL_PER_SECOND', 60);

/**
 * SEPARATE budgets for the two message types that carry TERMINAL STATUS
 * (`command_result`, `update_status`) — see #3001: a silently dropped
 * `command_result` reads to an operator as a successful job vanishing,
 * reaped as "stalled" 15 minutes later with zero trace. Sharing the general
 * per-frame budget would reintroduce that exact symptom under sustained
 * throttling, since the general budget is deliberately type-blind.
 *
 * The two types get DIFFERENT ceilings, not one shared "terminal" bucket:
 *
 * - `command_result` volume is bounded by outstanding commands on a device
 *   (not a per-second stream like desktop/terminal frames), so it can
 *   afford real headroom for a reconnect flush of queued results — sized to
 *   a realistic burst, not an unbounded escape hatch from the general lane.
 * - `update_status` is a self-update notification a device sends at most a
 *   few times a day — it is also the frame type that serializes most on the
 *   database (each frame holds a per-frame transaction that serializes on
 *   the `devices` row). Giving it MORE
 *   throughput than the general lane would widen exactly the mechanism this
 *   whole budget exists to bound, so its ceiling sits AT the general lane's
 *   own default and must never be raised past it.
 *
 * Both lanes can still return 'close' on sustained abuse, same as the
 * general lane — a socket that floods exclusively with one terminal-state
 * type must not be immune to disconnection.
 */
const AGENT_WS_COMMAND_RESULT_MESSAGE_BUDGET_CAPACITY = envInt('AGENT_WS_COMMAND_RESULT_MESSAGE_BUDGET_CAPACITY', 600);
const AGENT_WS_COMMAND_RESULT_MESSAGE_BUDGET_REFILL_PER_SECOND = envInt('AGENT_WS_COMMAND_RESULT_MESSAGE_BUDGET_REFILL_PER_SECOND', 120);
/** At or below the general lane's own defaults — see the module doc above. Independently tunable, but never DEFAULTS above general. */
const AGENT_WS_UPDATE_STATUS_MESSAGE_BUDGET_CAPACITY = envInt('AGENT_WS_UPDATE_STATUS_MESSAGE_BUDGET_CAPACITY', AGENT_WS_MESSAGE_BUDGET_CAPACITY);
const AGENT_WS_UPDATE_STATUS_MESSAGE_BUDGET_REFILL_PER_SECOND = envInt('AGENT_WS_UPDATE_STATUS_MESSAGE_BUDGET_REFILL_PER_SECOND', AGENT_WS_MESSAGE_BUDGET_REFILL_PER_SECOND);

interface SocketBucket {
  tokens: number;
  lastRefillAt: number;
  /** Consecutive throttled frames since the bucket last had a token to give. */
  consecutiveDrops: number;
  /** Total throttled frames on this connection, for the close-on-sustained-abuse threshold and logging. */
  totalDrops: number;
}

export type AgentWsMessageBudgetVerdict = 'allow' | 'drop' | 'close';
export type AgentWsMessageBudgetKind = 'general' | 'command_result' | 'update_status';

const BUCKET_MAPS: Record<AgentWsMessageBudgetKind, WeakMap<object, SocketBucket>> = {
  general: new WeakMap(),
  command_result: new WeakMap(),
  update_status: new WeakMap(),
};

const BUCKET_CONFIG: Record<AgentWsMessageBudgetKind, { capacity: number; refillPerSecond: number }> = {
  general: { capacity: AGENT_WS_MESSAGE_BUDGET_CAPACITY, refillPerSecond: AGENT_WS_MESSAGE_BUDGET_REFILL_PER_SECOND },
  command_result: {
    capacity: AGENT_WS_COMMAND_RESULT_MESSAGE_BUDGET_CAPACITY,
    refillPerSecond: AGENT_WS_COMMAND_RESULT_MESSAGE_BUDGET_REFILL_PER_SECOND,
  },
  update_status: {
    capacity: AGENT_WS_UPDATE_STATUS_MESSAGE_BUDGET_CAPACITY,
    refillPerSecond: AGENT_WS_UPDATE_STATUS_MESSAGE_BUDGET_REFILL_PER_SECOND,
  },
};

/**
 * A socket that is STILL sending after this many consecutive throttled
 * frames is not bursting, it is sustaining abuse — close it rather than
 * dropping forever. Comfortably above any legitimate momentary burst once the
 * bucket is empty (a healthy agent backs off; nothing in the codebase retries
 * a WS frame in a tight loop). Shared across all three lanes: sustained abuse
 * is sustained abuse regardless of which message type it is dressed up as.
 */
const SUSTAINED_ABUSE_CLOSE_THRESHOLD = envInt('AGENT_WS_MESSAGE_BUDGET_CLOSE_THRESHOLD', 200);

let totalThrottledMessages = 0;
let totalClosedConnections = 0;

/**
 * Consume one token for `socketKey` (the live `WSContext`, used only as a
 * WeakMap identity — never read or serialized). Returns 'allow' when the
 * frame should proceed, 'drop' when it should be discarded (counted, logged
 * periodically — the caller decides whether that's silent or signalled), or
 * 'close' when the connection has sustained abuse past the point a
 * drop-and-count response is appropriate.
 *
 * `kind` selects one of three independent per-socket lanes — see the module
 * doc above for why `command_result` and `update_status` are sized
 * differently from each other, not shared. All three lanes can return
 * 'close' on sustained abuse.
 */
export function checkAgentWsMessageBudget(
  socketKey: object,
  agentId: string,
  now: number = Date.now(),
  kind: AgentWsMessageBudgetKind = 'general',
): AgentWsMessageBudgetVerdict {
  const bucketMap = BUCKET_MAPS[kind];
  const { capacity, refillPerSecond } = BUCKET_CONFIG[kind];

  let bucket = bucketMap.get(socketKey);
  if (!bucket) {
    bucket = {
      tokens: capacity,
      lastRefillAt: now,
      consecutiveDrops: 0,
      totalDrops: 0,
    };
    bucketMap.set(socketKey, bucket);
  }

  const elapsedMs = Math.max(0, now - bucket.lastRefillAt);
  if (elapsedMs > 0) {
    const refill = (elapsedMs / 1000) * refillPerSecond;
    bucket.tokens = Math.min(capacity, bucket.tokens + refill);
    bucket.lastRefillAt = now;
  }

  if (bucket.tokens < 1) {
    bucket.consecutiveDrops += 1;
    bucket.totalDrops += 1;
    totalThrottledMessages += 1;

    // Log the first drop and then periodically, not every drop — a sustained
    // flood would otherwise itself become a logging flood. The caller layers
    // its OWN unconditional error-level log on top of this for a terminal-kind
    // drop (see routes/agentWs.ts), so a lost command_result is never only
    // this periodic line.
    if (bucket.totalDrops === 1 || bucket.totalDrops % 100 === 0) {
      console.warn(
        `[AgentWs] Message-rate budget exceeded for agent ${agentId} `
        + `(dropped ${bucket.totalDrops} frame(s) on this connection, budget=${kind})`,
      );
    }

    if (bucket.consecutiveDrops >= SUSTAINED_ABUSE_CLOSE_THRESHOLD) {
      totalClosedConnections += 1;
      console.warn(
        `[AgentWs] Closing connection for agent ${agentId} after ${bucket.consecutiveDrops} `
        + `consecutive message-rate-budget drops on the ${kind} lane (sustained abuse)`,
      );
      for (const map of Object.values(BUCKET_MAPS)) map.delete(socketKey);
      return 'close';
    }

    return 'drop';
  }

  bucket.tokens -= 1;
  bucket.consecutiveDrops = 0;
  return 'allow';
}

/** Process-wide throttle metric, for observability/tests. */
export function getAgentWsMessageBudgetMetrics(): { throttled: number; closed: number } {
  return { throttled: totalThrottledMessages, closed: totalClosedConnections };
}

/** Test-only: reset the process-wide metrics between test cases. */
export function __resetAgentWsMessageBudgetMetricsForTest(): void {
  totalThrottledMessages = 0;
  totalClosedConnections = 0;
}
