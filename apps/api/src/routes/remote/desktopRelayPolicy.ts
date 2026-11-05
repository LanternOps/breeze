import { isResolvedTerminalIsolationState } from '@breeze/shared';
import { db } from '../../db';
import { getIceServers, type TurnCredentialScope } from './helpers';

type DesktopIcePlan =
  | { ok: true; relayOnly: boolean; iceServers: ReturnType<typeof getIceServers> }
  | {
    ok: false;
    code: 'isolation_relay_unavailable' | 'isolation_relay_not_permitted';
    error: string;
  };

/**
 * OD9: resolve inside the caller's DB access context; unreadable isolation fails closed.
 *
 * Relay-only holds for every episode outside the shared resolved-terminal set, so a state
 * this build has never heard of is relay-only too. `applying` and `release_requested` can
 * have live firewall rules, and `requested`/`dispatched` can be applied before the plan's
 * session starts. Never replace this with a list of "active" states: that list fails open.
 */
export async function resolveDesktopIcePlan(
  deviceId: string,
  scope: TurnCredentialScope,
): Promise<DesktopIcePlan> {
  // Loaded lazily: episodeStore derives its column set from the schema at
  // module load, and remote/sessions.ts + desktopWs.ts are imported by most of
  // the API (and its tests). A static import would make every importer pay for,
  // and depend on, the network-isolation schema just to mount the routes.
  const { findUnresolvedEpisode } = await import('../../services/networkIsolation/episodeStore');
  const episode = await db.transaction((tx) => findUnresolvedEpisode(tx, deviceId));
  if (!episode || isResolvedTerminalIsolationState(episode.state)) {
    return { ok: true, relayOnly: false, iceServers: getIceServers(scope) };
  }
  if (!episode.remoteRelay) {
    return {
      ok: false,
      code: 'isolation_relay_not_permitted',
      error: 'Remote desktop over WebRTC is unavailable: this device was isolated without permitting the TURN relay',
    };
  }
  const iceServers = getIceServers(scope, { relayOnly: true });
  if (iceServers.length === 0) {
    return {
      ok: false,
      code: 'isolation_relay_unavailable',
      error: 'Remote desktop needs the TURN relay while this device is isolated',
    };
  }
  return { ok: true, relayOnly: true, iceServers };
}
