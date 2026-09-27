import type { IncomingMessage } from 'node:http';
import type { NodeWebSocket } from '@hono/node-ws';

// `ws` is a transitive dependency (via `@hono/node-ws`), not a direct one, so
// its types aren't resolvable here — derive the server type from the helper
// that actually constructs it instead of importing `ws` directly.
type WebSocketServer = NodeWebSocket['wss'];

/**
 * `@hono/node-ws`'s `createNodeWebSocket({ app })` builds exactly one shared
 * `new WebSocketServer({ noServer: true })` for every upgrade route in the
 * app, and `NodeWebSocketInit` has no option to pass `maxPayload` through —
 * so without this module the `ws` default of 100 MiB applies to every route
 * (terminal, desktop signaling, tunnel relay, event stream, agent ingest
 * alike), and a low-privilege caller on the smallest of those routes can
 * buffer/parse a frame sized for the largest.
 *
 * Sizes below are set from each route's own app-layer contract, with
 * headroom for JSON/base64 framing overhead:
 *  - terminal `data` frames are Zod-capped at 16 KiB (`terminalWs.ts`); the
 *    desktop-ws control channel only carries small input/config messages
 *    (video/input goes over the WebRTC peer connection, not this socket);
 *    the event-stream channel only carries small subscribe/publish control
 *    messages. All three share the default tier.
 *  - tunnel-ws relays HTTP body chunks capped at ~1 MB pre-base64
 *    (`MAX_TUNNEL_FRAME_BYTES` in `tunnelWs.ts`); base64 expands that by
 *    ~4/3 plus a JSON envelope.
 *  - agent-ws carries larger batched inventory/log payloads from the agent
 *    ingest path. Its ceiling is NOT the batched-ingest size alone: #3001
 *    recorded pre-fix agents in the field sending a `command_result` up to
 *    64 MB, and `agentWs.ts`'s own graceful-rejection path (see the comment
 *    on `MAX_PRECISE_RESULT_MEASURE_BYTES` there) exists specifically to
 *    reject an oversized result without dropping the connection. A frame
 *    cap at or below that 64 MB field-observed size would have the `ws`
 *    library's protocol-level frame parser close the socket (code 1009)
 *    before that app-layer code ever runs, hard-disconnecting exactly the
 *    still-deployed agents it was written to handle gracefully. Set with
 *    headroom above the documented worst case; drop it back down once
 *    fleet adoption of the agent-side #3001 fix is confirmed.
 */
export const WS_MAX_PAYLOAD_DEFAULT_BYTES = 64 * 1024;
export const WS_MAX_PAYLOAD_TUNNEL_BYTES = 2 * 1024 * 1024;
export const WS_MAX_PAYLOAD_AGENT_BYTES = 72 * 1024 * 1024;

interface RouteMaxPayload {
  prefix: string;
  maxPayload: number;
}

// Order doesn't matter: prefixes are disjoint route mounts.
const ROUTE_MAX_PAYLOAD: RouteMaxPayload[] = [
  { prefix: '/api/v1/agent-ws', maxPayload: WS_MAX_PAYLOAD_AGENT_BYTES },
  { prefix: '/api/v1/tunnel-ws', maxPayload: WS_MAX_PAYLOAD_TUNNEL_BYTES },
];

/** Pure so the per-route sizing can be asserted directly, without a socket. */
export function resolveWsMaxPayload(pathname: string): number {
  const match = ROUTE_MAX_PAYLOAD.find((route) => pathname.startsWith(route.prefix));
  return match ? match.maxPayload : WS_MAX_PAYLOAD_DEFAULT_BYTES;
}

/**
 * Makes the shared `WebSocketServer`'s effective `maxPayload` depend on the
 * upgrade request's pathname.
 *
 * `WebSocketServer#completeUpgrade` (called synchronously, with no
 * intervening `await`, from `handleUpgrade` on this build — no
 * `verifyClient`/`perMessageDeflate` configured here) reads
 * `this.options.maxPayload` fresh at handshake time and hands it straight to
 * the new socket's frame parser. Node is single-threaded and the wrapped
 * call below sets that value and invokes the original `handleUpgrade`
 * within one synchronous turn, so concurrent upgrades for different routes
 * can never observe or leave behind each other's limit.
 */
export function installPerRouteMaxPayload(wss: WebSocketServer): void {
  const originalHandleUpgrade = wss.handleUpgrade.bind(wss);
  wss.handleUpgrade = ((
    req: IncomingMessage,
    socket: Parameters<WebSocketServer['handleUpgrade']>[1],
    head: Buffer,
    cb: Parameters<WebSocketServer['handleUpgrade']>[3],
  ) => {
    const pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
    (wss.options as { maxPayload?: number }).maxPayload = resolveWsMaxPayload(pathname);
    return originalHandleUpgrade(req, socket, head, cb);
  }) as WebSocketServer['handleUpgrade'];
}
