import { describe, expect, it } from 'vitest';
import {
  MAX_NEVER_CONNECTED_ICE_FAILURES,
  classifyIceFailure,
  decideNeverConnectedIceFailure,
  iceFailureMessage,
  shouldStopAfterIceFailure,
  summarizeIcePath,
  type IcePathSummary,
} from './iceFailure';

function statsOf(entries: Array<Record<string, unknown>>): RTCStatsReport {
  const map = new Map(entries.map((e, i) => [String(e.id ?? i), e]));
  return map as unknown as RTCStatsReport;
}

function fakePc(opts: {
  stats?: Array<Record<string, unknown>>;
  statsThrows?: boolean;
  localSdp?: string;
  remoteSdp?: string;
}): RTCPeerConnection {
  return {
    getStats: async () => {
      if (opts.statsThrows) throw new Error('closed');
      return statsOf(opts.stats ?? []);
    },
    localDescription: opts.localSdp ? { type: 'offer', sdp: opts.localSdp } : null,
    remoteDescription: opts.remoteSdp ? { type: 'answer', sdp: opts.remoteSdp } : null,
  } as unknown as RTCPeerConnection;
}

const summary = (local: Partial<IcePathSummary['local']>, remote: Partial<IcePathSummary['remote']>): IcePathSummary => ({
  local: { host: 0, srflx: 0, prflx: 0, relay: 0, ...local },
  remote: { host: 0, srflx: 0, prflx: 0, relay: 0, ...remote },
});

describe('summarizeIcePath', () => {
  it('counts local and remote candidate types from getStats', async () => {
    const pc = fakePc({
      stats: [
        { id: 'l1', type: 'local-candidate', candidateType: 'host' },
        { id: 'l2', type: 'local-candidate', candidateType: 'srflx' },
        { id: 'l3', type: 'local-candidate', candidateType: 'relay' },
        { id: 'r1', type: 'remote-candidate', candidateType: 'host' },
        { id: 'r2', type: 'remote-candidate', candidateType: 'host' },
        { id: 'x', type: 'candidate-pair', state: 'failed' },
      ],
    });
    expect(await summarizeIcePath(pc)).toEqual(summary({ host: 1, srflx: 1, relay: 1 }, { host: 2 }));
  });

  it('falls back to the SDP candidate lines when getStats has none (or throws)', async () => {
    const remoteSdp = [
      'v=0',
      'a=candidate:1 1 udp 2130706431 10.0.0.5 50000 typ host',
      'a=candidate:2 1 udp 2130706431 192.168.1.5 50001 typ host',
      'a=end-of-candidates',
    ].join('\r\n');
    const localSdp = 'v=0\r\na=candidate:3 1 udp 1 203.0.113.9 3478 typ relay raddr 0.0.0.0 rport 0\r\n';
    for (const pc of [fakePc({ stats: [], localSdp, remoteSdp }), fakePc({ statsThrows: true, localSdp, remoteSdp })]) {
      expect(await summarizeIcePath(pc)).toEqual(summary({ relay: 1 }, { host: 2 }));
    }
  });
});

describe('classifyIceFailure', () => {
  it('blames the device network when the agent offered only local addresses', () => {
    expect(classifyIceFailure(summary({ host: 1, srflx: 1, relay: 1 }, { host: 3 }))).toBe('device_network');
  });

  it('blames the device network when the agent offered no candidates at all', () => {
    expect(classifyIceFailure(summary({ host: 1, relay: 1 }, {}))).toBe('device_network');
  });

  it('blames this viewer network when only the agent reached a server', () => {
    expect(classifyIceFailure(summary({ host: 2 }, { host: 1, srflx: 1, relay: 1 }))).toBe('viewer_network');
  });

  it('reports no usable path when both sides reached a server', () => {
    expect(classifyIceFailure(summary({ host: 1, relay: 1 }, { host: 1, relay: 1 }))).toBe('no_path');
  });

  it('treats a peer-reflexive remote candidate as the agent getting out', () => {
    expect(classifyIceFailure(summary({ host: 1, relay: 1 }, { host: 1, prflx: 1 }))).toBe('no_path');
  });
});

describe('iceFailureMessage', () => {
  it('names the device network as the cause for a host-only agent', () => {
    const msg = iceFailureMessage('device_network');
    expect(msg).toMatch(/this device's network/i);
    expect(msg).toMatch(/UDP/);
    expect(msg).toMatch(/relay/i);
  });

  it('names this viewer network for a viewer-side block', () => {
    expect(iceFailureMessage('viewer_network')).toMatch(/this computer's network/i);
  });

  it('gives a distinct message for every cause', () => {
    const msgs = new Set([
      iceFailureMessage('device_network'),
      iceFailureMessage('viewer_network'),
      iceFailureMessage('no_path'),
    ]);
    expect(msgs.size).toBe(3);
  });
});

describe('decideNeverConnectedIceFailure', () => {
  const hostOnlyAgent = fakePc({
    stats: [
      { id: 'l1', type: 'local-candidate', candidateType: 'relay' },
      { id: 'r1', type: 'remote-candidate', candidateType: 'host' },
    ],
  });
  const relayBothSides = fakePc({
    stats: [
      { id: 'l1', type: 'local-candidate', candidateType: 'relay' },
      { id: 'r1', type: 'remote-candidate', candidateType: 'relay' },
    ],
  });

  it('stops on the first failure of a host-only agent with the device-network message', async () => {
    const d = await decideNeverConnectedIceFailure(hostOnlyAgent, 1);
    expect(d.stop).toBe(true);
    expect(d.cause).toBe('device_network');
    expect(d.message).toBe(iceFailureMessage('device_network'));
  });

  it('retries once when both sides reached a relay, then stops', async () => {
    expect((await decideNeverConnectedIceFailure(relayBothSides, 1)).stop).toBe(false);
    const second = await decideNeverConnectedIceFailure(relayBothSides, 2);
    expect(second.stop).toBe(true);
    expect(second.message).toBe(iceFailureMessage('no_path'));
  });
});

describe('shouldStopAfterIceFailure', () => {
  it('stops at once when the agent could reach no server: re-offering cannot change that', () => {
    expect(shouldStopAfterIceFailure('device_network', 1)).toBe(true);
  });

  it('retries other never-connected failures until the cap, then stops', () => {
    expect(MAX_NEVER_CONNECTED_ICE_FAILURES).toBe(2);
    for (const cause of ['viewer_network', 'no_path'] as const) {
      expect(shouldStopAfterIceFailure(cause, 1)).toBe(false);
      expect(shouldStopAfterIceFailure(cause, 2)).toBe(true);
      expect(shouldStopAfterIceFailure(cause, 3)).toBe(true);
    }
  });
});
