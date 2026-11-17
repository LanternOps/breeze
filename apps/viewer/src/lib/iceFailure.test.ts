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

  it('adds SDP candidates that stats under-report (per-type max of both sources)', async () => {
    // Stats list only the paired host candidate; the answer also carried a relay.
    const pc = fakePc({
      stats: [
        { id: 'l1', type: 'local-candidate', candidateType: 'relay' },
        { id: 'r1', type: 'remote-candidate', candidateType: 'host' },
      ],
      remoteSdp: 'v=0\r\na=candidate:1 1 udp 1 10.0.0.5 5000 typ host\r\na=candidate:2 1 udp 1 198.51.100.7 6000 typ relay raddr 0.0.0.0 rport 0\r\n',
    });
    const s = await summarizeIcePath(pc);
    expect(s.remote).toEqual({ host: 1, srflx: 0, prflx: 0, relay: 1 });
    expect(classifyIceFailure(s)).toBe('no_path');
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

  it('does not blame a network when no remote candidate was observed at all', () => {
    // Nothing read is not evidence: an engine that drops candidate stats, or an
    // SDP without them, must not produce a confident one-shot stop.
    expect(classifyIceFailure(summary({ host: 1, relay: 1 }, {}))).toBe('unknown');
  });

  it('does not blame this viewer when no local candidate was observed at all', () => {
    expect(classifyIceFailure(summary({}, { host: 1, relay: 1 }))).toBe('unknown');
  });

  it('still blames the device network for a host-only agent when local candidates are unknown', () => {
    expect(classifyIceFailure(summary({}, { host: 2 }))).toBe('device_network');
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
      iceFailureMessage('unknown'),
    ]);
    expect(msgs.size).toBe(4);
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

  it('retries a host-only agent once, then stops with the device-network message', async () => {
    // The agent's late candidates can be lost on the trickle path, so one
    // read is not enough to blame the device's firewall.
    const first = await decideNeverConnectedIceFailure(hostOnlyAgent, 1);
    expect(first.stop).toBe(false);
    expect(first.cause).toBe('device_network');
    const second = await decideNeverConnectedIceFailure(hostOnlyAgent, 2);
    expect(second.stop).toBe(true);
    expect(second.message).toBe(iceFailureMessage('device_network'));
  });

  it('decides on unknown when the stats read never settles', async () => {
    const hung = {
      getStats: () => new Promise(() => {}),
      localDescription: null,
      remoteDescription: null,
    } as unknown as RTCPeerConnection;
    const d = await decideNeverConnectedIceFailure(hung, 2, 10);
    expect(d.cause).toBe('unknown');
    expect(d.stop).toBe(true);
  });

  it('retries once when both sides reached a relay, then stops', async () => {
    expect((await decideNeverConnectedIceFailure(relayBothSides, 1)).stop).toBe(false);
    const second = await decideNeverConnectedIceFailure(relayBothSides, 2);
    expect(second.stop).toBe(true);
    expect(second.message).toBe(iceFailureMessage('no_path'));
  });
});

describe('shouldStopAfterIceFailure', () => {
  it('retries every never-connected failure once, then stops', () => {
    expect(MAX_NEVER_CONNECTED_ICE_FAILURES).toBe(2);
    for (const cause of ['device_network', 'viewer_network', 'no_path', 'unknown'] as const) {
      expect(shouldStopAfterIceFailure(cause, 1)).toBe(false);
      expect(shouldStopAfterIceFailure(cause, 2)).toBe(true);
      expect(shouldStopAfterIceFailure(cause, 3)).toBe(true);
    }
  });
});
