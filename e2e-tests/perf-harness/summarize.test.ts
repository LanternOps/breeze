import { describe, it, expect } from 'vitest';
import { summarize } from './summarize';
import type { StatsSample, FrameArrival } from './types';

function inbound(tMs: number, over: Partial<StatsSample>): StatsSample {
  return {
    tMs,
    pcCount: 1,
    hasInboundVideo: true,
    framesPerSecond: 30,
    framesReceived: 0,
    framesDropped: 0,
    freezeCount: 0,
    totalFreezesDuration: 0,
    jitter: 0.01,
    packetsLost: 0,
    bytesReceived: 0,
    currentRoundTripTime: 0.02,
    ...over,
  };
}

describe('summarize', () => {
  it('returns all-null summary for an empty / no-PC series', () => {
    const s = summarize([]);
    expect(s.inboundSamples).toBe(0);
    expect(s.meanFps).toBeNull();
    expect(s.meanBitrateKbps).toBeNull();
    expect(s.framesDroppedPct).toBeNull();
  });

  it('ignores samples without inbound video', () => {
    const noVideo: StatsSample = { ...inbound(0, {}), hasInboundVideo: false };
    expect(summarize([noVideo]).inboundSamples).toBe(0);
  });

  it('derives bitrate from bytesReceived over elapsed time', () => {
    // 0 → 125_000 bytes over 1000ms = 1_000_000 bits/s = 1000 kbps.
    const series = [
      inbound(0, { bytesReceived: 0 }),
      inbound(1000, { bytesReceived: 125_000 }),
    ];
    expect(summarize(series).meanBitrateKbps).toBe(1000);
  });

  it('computes framesDroppedPct from cumulative deltas', () => {
    const series = [
      inbound(0, { framesReceived: 0, framesDropped: 0 }),
      inbound(1000, { framesReceived: 90, framesDropped: 10 }),
    ];
    // 10 dropped / (10 + 90) = 10%.
    expect(summarize(series).framesDroppedPct).toBe(10);
  });

  it('reports mean + p5 fps, last freezeCount, and ms-scaled rtt/jitter', () => {
    const series = [
      inbound(0, { framesPerSecond: 30, freezeCount: 0, currentRoundTripTime: 0.02, jitter: 0.005 }),
      inbound(1000, { framesPerSecond: 10, freezeCount: 2, currentRoundTripTime: 0.04, jitter: 0.015 }),
    ];
    const s = summarize(series);
    expect(s.meanFps).toBe(20);
    expect(s.p5Fps).toBeCloseTo(11, 0); // interpolated near the low end
    expect(s.freezeCount).toBe(2);
    expect(s.meanRttMs).toBe(30);
    expect(s.meanJitterMs).toBe(10);
  });

  it('leaves media-clock metrics null without frame arrivals', () => {
    const s = summarize([inbound(0, {})]);
    expect(s.mediaClockDriftMs).toBeNull();
    expect(s.meanFramePacingErrorMs).toBeNull();
    expect(s.p95FramePacingErrorMs).toBeNull();
  });

  it('reports ~0 drift when RTP timestamps track wall-clock arrival', () => {
    // 30fps, perfectly paced: 33.33ms wall / 3000 ticks (=33.33ms) per frame.
    const frames: FrameArrival[] = [];
    for (let i = 0; i < 10; i++) {
      frames.push({ arrivalMs: 1000 + i * (1000 / 30), rtpTs: 500_000 + i * 3000 });
    }
    const s = summarize([inbound(0, {})], frames);
    expect(s.mediaClockDriftMs).toBeCloseTo(0, 1);
    expect(s.meanFramePacingErrorMs).toBeCloseTo(0, 1);
  });

  it('measures positive drift when frames are skipped (fixed 1/fps rtp increment)', () => {
    // The bug: encoder always adds 3000 ticks (1/30s) per SENT frame, but the
    // wall-clock gap during a static screen is far larger (frames were skipped).
    const frames: FrameArrival[] = [
      { arrivalMs: 0, rtpTs: 0 },
      { arrivalMs: 33.33, rtpTs: 3000 }, // normal frame
      { arrivalMs: 2033.33, rtpTs: 6000 }, // 2s static gap, but rtp only +3000 (33ms)
      { arrivalMs: 2066.66, rtpTs: 9000 },
    ];
    const s = summarize([inbound(0, {})], frames);
    // wall elapsed ~2066.66ms; rtp elapsed = 9000/90 = 100ms → drift ~1966ms.
    expect(s.mediaClockDriftMs).toBeGreaterThan(1900);
    expect(s.p95FramePacingErrorMs).toBeGreaterThan(1700);
  });

  it('handles 32-bit RTP timestamp wraparound in the per-frame delta', () => {
    const frames: FrameArrival[] = [
      { arrivalMs: 0, rtpTs: 0xffffff00 },
      { arrivalMs: 33.33, rtpTs: (0xffffff00 + 3000) >>> 0 }, // wraps past 2^32
    ];
    const s = summarize([inbound(0, {})], frames);
    // Wrap-safe: rtp delta is 3000 ticks (33.33ms), matching arrival → ~0 drift.
    expect(s.mediaClockDriftMs).toBeCloseTo(0, 1);
  });
});
