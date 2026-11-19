import { describe, expect, it } from 'vitest';
import {
  IceFailureBudget,
  MAX_NEVER_CONNECTED_ICE_FAILURES,
  classifyIceFailure,
  decideNeverConnectedIceFailure,
  iceFailureMessage,
  neverConnectedStopStep,
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

describe('iceFailureMessage states only what was observed (#11838 review)', () => {
  const causes = ['device_network', 'viewer_network', 'no_path', 'unknown'] as const;

  it('says the device addresses were received, not that the device sent only those', () => {
    const msg = iceFailureMessage('device_network');
    expect(msg).toMatch(/received only local network addresses from the device/i);
    // A trickled candidate can be lost on the way, so what the device sent is
    // not known.
    expect(msg).not.toMatch(/device sent only/i);
  });

  it('keeps the cause an inference in every message', () => {
    for (const cause of causes) {
      expect(iceFailureMessage(cause), cause).toMatch(/\blikely\b/i);
      expect(iceFailureMessage(cause), cause).not.toMatch(/\bthe device sent\b/i);
      expect(iceFailureMessage(cause), cause).not.toMatch(/\busually means\b/i);
    }
  });
});

describe('IceFailureBudget drives the reconnect path at the session level (#11838 review)', () => {
  const hostOnlyAgent = fakePc({
    stats: [
      { id: 'l1', type: 'local-candidate', candidateType: 'relay' },
      { id: 'r1', type: 'remote-candidate', candidateType: 'host' },
    ],
  });

  type Step = 'reconnect' | 'stop';

  /** One failed peer, routed through the same call DesktopViewer's onFailed makes. */
  async function failPeer(budget: IceFailureBudget, isCurrent: () => boolean = () => true): Promise<Step | 'none'> {
    let step: Step | 'none' = 'none';
    await budget.peerFailed(hostOnlyAgent, isCurrent, {
      reconnect: () => { step = 'reconnect'; },
      stop: () => { step = 'stop'; },
    });
    return step;
  }

  it('keeps re-offering a session that connected once, however many reconnect peers fail', async () => {
    const budget = new IceFailureBudget();
    budget.peerConnected();
    // The live peer drops: it connected, so it reconnects.
    expect(await failPeer(budget)).toBe('reconnect');
    // Three reconnect peers in a row never reach 'connected'.
    expect(await failPeer(budget)).toBe('reconnect');
    expect(await failPeer(budget)).toBe('reconnect');
    expect(await failPeer(budget)).toBe('reconnect');
    expect(budget.failures).toBe(0);
  });

  it('routes a connected session straight to reconnect, without reading the candidates', () => {
    const budget = new IceFailureBudget();
    budget.peerConnected();
    let reconnected = false;
    const noStats = { getStats: () => { throw new Error('must not read stats'); } } as unknown as RTCPeerConnection;
    void budget.peerFailed(noStats, () => true, { reconnect: () => { reconnected = true; }, stop: () => {} });
    // Synchronous, as before this fix.
    expect(reconnected).toBe(true);
  });

  it('stops a session that never connected on its second failure', async () => {
    const budget = new IceFailureBudget();
    expect(await failPeer(budget)).toBe('reconnect');
    expect(await failPeer(budget)).toBe('stop');
  });

  it('gives a new session (fresh connect or reused window) the never-connected rule again', async () => {
    const budget = new IceFailureBudget();
    budget.peerConnected();
    budget.newSession();
    expect(budget.sessionConnected).toBe(false);
    expect(await failPeer(budget)).toBe('reconnect');
    expect(await failPeer(budget)).toBe('stop');
  });

  it('gives a transport switch (or Retry) a full budget: a leftover count does not stop the next failure', async () => {
    const budget = new IceFailureBudget();
    expect(await failPeer(budget)).toBe('reconnect');
    expect(budget.failures).toBe(1);
    budget.resetFailures();
    expect(await failPeer(budget)).toBe('reconnect');
    expect(await failPeer(budget)).toBe('stop');
  });

  it('does not count a failure whose peer was superseded during the candidate read', async () => {
    const budget = new IceFailureBudget();
    expect(await failPeer(budget, () => false)).toBe('none');
    expect(budget.failures).toBe(0);
  });

  it('does not let a read that straddles a reset spend the new budget', async () => {
    const budget = new IceFailureBudget();
    expect(await failPeer(budget)).toBe('reconnect');
    let step: Step | 'none' = 'none';
    const pending = budget.peerFailed(hostOnlyAgent, () => true, {
      reconnect: () => { step = 'reconnect'; },
      stop: () => { step = 'stop'; },
    });
    budget.resetFailures();
    await pending;
    expect(step).toBe('none');
    expect(budget.failures).toBe(0);
  });
});

describe('IceFailureBudget after a VNC handoff (#11838 review)', () => {
  const hostOnlyAgent = fakePc({
    stats: [{ id: 'r1', type: 'remote-candidate', candidateType: 'host' }],
  });
  const fail = async (budget: IceFailureBudget) => {
    let step = 'none';
    await budget.peerFailed(hostOnlyAgent, () => true, {
      reconnect: () => { step = 'reconnect'; },
      stop: () => { step = 'stop'; },
    });
    return step;
  };

  it('does not let the automatic VNC→WebRTC handoff bring back a path that never connected', async () => {
    const budget = new IceFailureBudget();
    expect(budget.autoWebRTCHandoffAllowed).toBe(true);
    expect(await fail(budget)).toBe('reconnect');
    expect(await fail(budget)).toBe('stop');
    budget.handedOffToVnc();
    // The VNC session's first poll sees user_session; without this the viewer
    // would switch back to WebRTC, fail twice, hand off again, and cycle.
    expect(budget.autoWebRTCHandoffAllowed).toBe(false);
    // An automatic switch (or Retry) resets the count but not the suppression.
    budget.resetFailures();
    expect(budget.autoWebRTCHandoffAllowed).toBe(false);
  });

  it('lifts the suppression on a manual transport choice or a new session', () => {
    const budget = new IceFailureBudget();
    budget.handedOffToVnc();
    budget.userChoseTransport();
    expect(budget.autoWebRTCHandoffAllowed).toBe(true);
    budget.handedOffToVnc();
    budget.newSession();
    expect(budget.autoWebRTCHandoffAllowed).toBe(true);
  });

  it('gives a manual transport choice a full failure budget', async () => {
    const budget = new IceFailureBudget();
    expect(await fail(budget)).toBe('reconnect');
    budget.userChoseTransport();
    expect(budget.failures).toBe(0);
    expect(await fail(budget)).toBe('reconnect');
  });
});

describe('neverConnectedStopStep (#11838 review)', () => {
  const base = { deviceId: 'dev-1', currentTransport: 'webrtc' as const, userJustSwitchedAt: 0 };

  it('hands a macOS device off to VNC instead of showing the error card', () => {
    expect(neverConnectedStopStep({ ...base, remoteOs: 'macos' })).toBe('handoff_to_vnc');
  });

  it('shows the error card for other platforms', () => {
    expect(neverConnectedStopStep({ ...base, remoteOs: 'windows' })).toBe('error_card');
    expect(neverConnectedStopStep({ ...base, remoteOs: null })).toBe('error_card');
  });

  it('respects the manual-choice cooldown and a missing device id, like the reconnect deadline path', () => {
    expect(neverConnectedStopStep({ ...base, remoteOs: 'macos', userJustSwitchedAt: Date.now() })).toBe('error_card');
    expect(neverConnectedStopStep({ ...base, remoteOs: 'macos', deviceId: undefined })).toBe('error_card');
  });
});
