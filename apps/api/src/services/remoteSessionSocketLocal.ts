/**
 * Role-safe boundary for closing a terminal or tunnel browser socket held by
 * THIS process (#4142 W2).
 *
 * `routes/terminalWs.ts` and `routes/tunnelWs.ts` hold the live terminal and
 * tunnel WebSocket maps, and both reach `routes/agentWs.ts`. A teardown that
 * imported them, even lazily, pinned every worker that reaches it to the
 * socket-owner placement. This module is the only door to them from services:
 * each route module is loaded by its own loader, only behind a
 * `breezeRole() !== 'worker'` guard, so a worker-role process never loads
 * either. A worker answers `false` ("nothing closed here"), which is the
 * truthful answer: it holds no browser sockets, and the caller then signals
 * the agent through the relay facade.
 *
 * Like services/agentCommandRelay.ts, it is listed in the closure resolver's
 * ROLE_SAFE_BOUNDARY_MODULES (services/workerClosure/closureGraph.ts), and the
 * worker-entrypoint closure contract test checks that it keeps this shape: no
 * static route edge, exactly these two dynamic edges, each inside its loader,
 * and every loader call role-guarded.
 *
 * Both functions pass the route module's result through unchanged: `true`
 * when a live socket was closed on this instance (that close also signals the
 * agent; see the route module).
 */
import { breezeRole } from '../config/env';

async function terminalWsLocal(): Promise<{ closeTerminalSession: (sessionId: string) => Promise<boolean> }> {
  return import('../routes/terminalWs');
}

async function tunnelWsLocal(): Promise<{ closeTunnelSession: (tunnelId: string) => Promise<boolean> }> {
  return import('../routes/tunnelWs');
}

/** Close the live terminal socket for `sessionId` if this process holds it; false on the worker role. */
export async function closeLocalTerminalSession(sessionId: string): Promise<boolean> {
  if (breezeRole() !== 'worker') return (await terminalWsLocal()).closeTerminalSession(sessionId);
  return false;
}

/** Close the live tunnel socket for `tunnelId` if this process holds it; false on the worker role. */
export async function closeLocalTunnelSession(tunnelId: string): Promise<boolean> {
  if (breezeRole() !== 'worker') return (await tunnelWsLocal()).closeTunnelSession(tunnelId);
  return false;
}
