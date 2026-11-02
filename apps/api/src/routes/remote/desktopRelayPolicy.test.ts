import { beforeEach, describe, expect, it, vi } from 'vitest';

const { findEpisode, iceServers, transaction, tx } = vi.hoisted(() => {
  const tx = { marker: 'request-context transaction' };
  return {
    tx, findEpisode: vi.fn(), iceServers: vi.fn(),
    transaction: vi.fn(async (fn: (handle: typeof tx) => unknown) => fn(tx)),
  };
});
vi.mock('../../db', () => ({ db: { transaction } }));
vi.mock('../../services/networkIsolation/episodeStore', () => ({ findUnresolvedEpisode: findEpisode }));
vi.mock('./helpers', () => ({ getIceServers: iceServers }));
import { resolveDesktopIcePlan } from './desktopRelayPolicy';

const scope = { sessionId: 'session', userId: 'user', deviceId: 'device' };
const turn = [{ urls: 'turn:relay.example.test:3478', username: 'user', credential: 'credential' }];
const legacy = [{ urls: 'stun:relay.example.test:3478' }, ...turn];
describe('resolveDesktopIcePlan', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    findEpisode.mockResolvedValue(null);
    iceServers.mockImplementation((_scope, opts) => opts?.relayOnly ? turn : legacy);
  });
  it.each(['applied', 'verified'])('requires TURN for %s episodes', async (state) => {
    findEpisode.mockResolvedValue({ state, remoteRelay: true });
    expect(await resolveDesktopIcePlan('device', scope)).toEqual({ ok: true, relayOnly: true, iceServers: turn });
    expect(findEpisode).toHaveBeenCalledWith(tx, 'device');
    expect(iceServers).toHaveBeenCalledWith(scope, { relayOnly: true });
  });
  it.each([null, 'applying', 'release_requested', 'released_locally', 'self_released', 'failed'])('preserves legacy ICE for %s', async (state) => {
    findEpisode.mockResolvedValue(state ? { state, remoteRelay: false } : null);
    expect(await resolveDesktopIcePlan('device', scope)).toEqual({ ok: true, relayOnly: false, iceServers: legacy });
    expect(iceServers).toHaveBeenCalledWith(scope);
  });
  it.each(['applied', 'verified'])('refuses %s without relay permission before minting credentials', async (state) => {
    findEpisode.mockResolvedValue({ state, remoteRelay: false });
    expect(await resolveDesktopIcePlan('device', scope)).toEqual({ ok: false, code: 'isolation_relay_not_permitted', error: 'Remote desktop over WebRTC is unavailable: this device was isolated without permitting the TURN relay' });
    expect(iceServers).not.toHaveBeenCalled();
  });
  it('refuses active isolation without TURN', async () => {
    findEpisode.mockResolvedValue({ state: 'applied', remoteRelay: true });
    iceServers.mockReturnValue([]);
    expect(await resolveDesktopIcePlan('device', scope)).toEqual({ ok: false, code: 'isolation_relay_unavailable', error: 'Remote desktop needs the TURN relay while this device is isolated' });
  });
  it('propagates database failures without minting ICE credentials', async () => {
    findEpisode.mockRejectedValue(new Error('database unavailable'));
    await expect(resolveDesktopIcePlan('device', scope)).rejects.toThrow('database unavailable');
    expect(iceServers).not.toHaveBeenCalled();
  });
});
