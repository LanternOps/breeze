import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createStatsReporter, type StatsConnection } from './statsReporter';

// Minimal fake RTCStatsReport: the reporter only relies on Map-style forEach.
function makeStats(reports: Record<string, unknown>[]): { forEach: (cb: (r: Record<string, unknown>) => void) => void } {
  return {
    forEach: (cb: (r: Record<string, unknown>) => void) => {
      for (const r of reports) cb(r);
    },
  };
}

function makeConnection(overrides?: {
  readyState?: RTCDataChannelState;
  reports?: Record<string, unknown>[];
}): { conn: StatsConnection; sent: string[]; setReports: (r: Record<string, unknown>[]) => void } {
  const sent: string[] = [];
  let reports = overrides?.reports ?? [];
  const conn: StatsConnection = {
    pc: {
      getStats: async () => makeStats(reports),
    } as unknown as RTCPeerConnection,
    controlChannel: {
      readyState: overrides?.readyState ?? 'open',
      send: (data: string) => {
        sent.push(data);
      },
    } as unknown as RTCDataChannel,
  };
  return { conn, sent, setReports: (r) => { reports = r; } };
}

function inboundRtp(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: 'inbound-rtp',
    kind: 'video',
    bytesReceived: 1000,
    timestamp: 1000,
    framesReceived: 10,
    framesDecoded: 10,
    framesDropped: 0,
    jitter: 0.003,
    packetsLost: 0,
    packetsReceived: 100,
    ...over,
  };
}

async function tick(ms: number) {
  await vi.advanceTimersByTimeAsync(ms);
}

describe('createStatsReporter', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('sends viewer_stats on each interval tick', async () => {
    const { conn, sent } = makeConnection({ reports: [inboundRtp()] });
    const stop = createStatsReporter({ getConnection: () => conn, intervalMs: 1000 });

    await tick(1000);
    await tick(1000);

    expect(sent.length).toBe(2);
    const msg = JSON.parse(sent[0]);
    expect(msg.type).toBe('viewer_stats');
    expect(msg.packetsReceived).toBe(100);
    stop();
  });

  it('computes per-interval deltas across ticks', async () => {
    const { conn, sent, setReports } = makeConnection({
      reports: [inboundRtp({ packetsReceived: 100, packetsLost: 0, framesDropped: 0 })],
    });
    const stop = createStatsReporter({ getConnection: () => conn, intervalMs: 1000 });

    await tick(1000);
    setReports([inboundRtp({ packetsReceived: 160, packetsLost: 3, framesDropped: 2, framesDecoded: 40 })]);
    await tick(1000);

    const second = JSON.parse(sent[1]);
    expect(second.packetsReceivedDelta).toBe(60);
    expect(second.packetsLostDelta).toBe(3);
    expect(second.framesDroppedDelta).toBe(2);
    stop();
  });

  it('keeps reporting after the connection is replaced (reconnect)', async () => {
    // Regression: the old inline effect captured pc/channel once, so after an
    // auto-reconnect viewer_stats stopped forever and the agent adaptive
    // bitrate controller stayed frozen at its initial bitrate.
    const first = makeConnection({ reports: [inboundRtp()] });
    const second = makeConnection({ reports: [inboundRtp({ packetsReceived: 500 })] });
    let current = first;
    const stop = createStatsReporter({ getConnection: () => current.conn, intervalMs: 1000 });

    await tick(1000);
    expect(first.sent.length).toBe(1);

    current = second; // viewer auto-reconnected: brand-new pc + channels
    await tick(1000);
    await tick(1000);

    expect(second.sent.length).toBe(2);
    const msg = JSON.parse(second.sent[0]);
    expect(msg.type).toBe('viewer_stats');
    expect(msg.packetsReceived).toBe(500);
    stop();
  });

  it('resets delta baselines when the connection is replaced', async () => {
    const first = makeConnection({ reports: [inboundRtp({ packetsReceived: 10_000, packetsLost: 50 })] });
    const second = makeConnection({ reports: [inboundRtp({ packetsReceived: 20, packetsLost: 0 })] });
    let current = first;
    const stop = createStatsReporter({ getConnection: () => current.conn, intervalMs: 1000 });

    await tick(1000);
    current = second;
    await tick(1000);

    // New pc starts counters from scratch; deltas must not go negative or
    // carry over the old connection's counts.
    const msg = JSON.parse(second.sent[0]);
    expect(msg.packetsReceivedDelta).toBeGreaterThanOrEqual(0);
    expect(msg.packetsLostDelta).toBeGreaterThanOrEqual(0);
    stop();
  });

  it('skips sending when the control channel is not open, without stopping', async () => {
    const closed = makeConnection({ readyState: 'closed', reports: [inboundRtp()] });
    const open = makeConnection({ reports: [inboundRtp()] });
    let current = closed;
    const stop = createStatsReporter({ getConnection: () => current.conn, intervalMs: 1000 });

    await tick(2000);
    expect(closed.sent.length).toBe(0);

    current = open;
    await tick(1000);
    expect(open.sent.length).toBe(1);
    stop();
  });

  it('survives getStats rejections and a null connection', async () => {
    const broken: StatsConnection = {
      pc: { getStats: async () => { throw new Error('pc closed'); } } as unknown as RTCPeerConnection,
      controlChannel: { readyState: 'open', send: () => {} } as unknown as RTCDataChannel,
    };
    const good = makeConnection({ reports: [inboundRtp()] });
    let current: StatsConnection | null = broken;
    const stop = createStatsReporter({ getConnection: () => current, intervalMs: 1000 });

    await tick(1000); // throws internally, swallowed
    current = null;
    await tick(1000); // no connection, no-op
    current = good.conn;
    await tick(1000);

    expect(good.sent.length).toBe(1);
    stop();
  });

  it('stop() clears the interval', async () => {
    const { conn, sent } = makeConnection({ reports: [inboundRtp()] });
    const stop = createStatsReporter({ getConnection: () => conn, intervalMs: 1000 });
    await tick(1000);
    stop();
    await tick(5000);
    expect(sent.length).toBe(1);
  });

  describe('onSample (stats overlay, #8241)', () => {
    function pairReports(): Record<string, unknown>[] {
      return [
        { type: 'candidate-pair', state: 'succeeded', currentRoundTripTime: 0.042, localCandidateId: 'L', remoteCandidateId: 'R' },
        { id: 'L', candidateType: 'relay', protocol: 'udp' },
        { id: 'R', candidateType: 'srflx' },
        { id: 'C1', type: 'codec', mimeType: 'video/H264' },
      ];
    }

    it('hands the overlay RTT, bitrate, loss, codec, decoder and ICE path each tick', async () => {
      const { conn, setReports } = makeConnection({
        reports: [...pairReports(), inboundRtp({ codecId: 'C1', decoderImplementation: 'VideoToolbox', packetsReceived: 100, packetsLost: 0 })],
      });
      const samples: unknown[] = [];
      const stop = createStatsReporter({ getConnection: () => conn, intervalMs: 1000, onSample: (s) => samples.push(s) });
      await tick(1000);
      setReports([...pairReports(), inboundRtp({
        codecId: 'C1', decoderImplementation: 'VideoToolbox',
        bytesReceived: 251000, timestamp: 2000, packetsReceived: 190, packetsLost: 10,
      })]);
      await tick(1000);
      expect(samples).toHaveLength(2);
      expect(samples[1]).toEqual({
        rttMs: 42,
        kbps: 2000,
        lossPct: 10,
        codec: 'H264',
        decoder: 'VideoToolbox',
        iceLocal: 'relay/udp',
        iceRemote: 'srflx',
      });
      stop();
    });

    it('reports loss as null until there is an interval to measure it over', async () => {
      const { conn } = makeConnection({ reports: [inboundRtp()] });
      const samples: Array<{ lossPct: number | null }> = [];
      const stop = createStatsReporter({ getConnection: () => conn, intervalMs: 1000, onSample: (s) => samples.push(s) });
      await tick(1000);
      expect(samples[0].lossPct).toBeNull();
      stop();
    });

    it('still samples when the control channel is closed (the overlay is local)', async () => {
      const { conn, sent } = makeConnection({ readyState: 'closed', reports: [inboundRtp()] });
      const onSample = vi.fn();
      const stop = createStatsReporter({ getConnection: () => conn, intervalMs: 1000, onSample });
      await tick(1000);
      expect(sent).toHaveLength(0);
      expect(onSample).toHaveBeenCalledTimes(1);
      stop();
    });
  });
});
