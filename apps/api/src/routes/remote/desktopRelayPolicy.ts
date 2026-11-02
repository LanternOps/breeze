import { db } from '../../db';
import { findUnresolvedEpisode } from '../../services/networkIsolation/episodeStore';
import { getIceServers, type TurnCredentialScope } from './helpers';

type DesktopIcePlan =
  | { ok: true; relayOnly: boolean; iceServers: ReturnType<typeof getIceServers> }
  | {
    ok: false;
    code: 'isolation_relay_unavailable' | 'isolation_relay_not_permitted';
    error: string;
  };

/** OD9: resolve inside the caller's DB access context; unreadable isolation fails closed. */
export async function resolveDesktopIcePlan(
  deviceId: string,
  scope: TurnCredentialScope,
): Promise<DesktopIcePlan> {
  const episode = await db.transaction((tx) => findUnresolvedEpisode(tx, deviceId));
  if (!episode || (episode.state !== 'applied' && episode.state !== 'verified')) {
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
