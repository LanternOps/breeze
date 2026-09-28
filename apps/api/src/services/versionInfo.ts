import { API_VERSION } from '../version';
import { getBinariesVersion } from './binarySource';

/**
 * The server's own version and the agent-binaries release it serves. They are
 * equal for a full release; a server-only release image reports its server
 * version alongside the older full release whose binaries it carries.
 */
export function getVersionInfo(): { version: string; binariesVersion: string } {
  return { version: API_VERSION, binariesVersion: getBinariesVersion() };
}

/** GET /health body: basic liveness with both versions and uptime. */
export function buildHealthPayload(
  startedAt: number,
  now: number = Date.now(),
): { status: 'ok'; version: string; binariesVersion: string; uptime: number } {
  return {
    status: 'ok',
    ...getVersionInfo(),
    uptime: Math.floor((now - startedAt) / 1000),
  };
}
