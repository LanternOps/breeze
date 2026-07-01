/**
 * Reduce a StatsSample series into a comparable PerfSummary.
 * Pure functions, no I/O — unit-testable and reused by run-perf.ts + compare.ts.
 */
import type { StatsSample, PerfSummary, FrameArrival } from './types';

/** RTP video clock is 90kHz → 90 ticks per millisecond. */
const RTP_TICKS_PER_MS = 90;

function mean(values: number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

/** Linear-interpolated percentile (p in [0,100]). */
function percentile(values: number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  if (sorted.length === 1) return sorted[0]!;
  const rank = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  const frac = rank - lo;
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * frac;
}

function nums(samples: StatsSample[], key: keyof StatsSample): number[] {
  const out: number[] = [];
  for (const s of samples) {
    const v = s[key];
    if (typeof v === 'number' && Number.isFinite(v)) out.push(v);
  }
  return out;
}

function lastNum(samples: StatsSample[], key: keyof StatsSample): number | null {
  for (let i = samples.length - 1; i >= 0; i--) {
    const v = samples[i]![key];
    if (typeof v === 'number' && Number.isFinite(v)) return v;
  }
  return null;
}

function firstNum(samples: StatsSample[], key: keyof StatsSample): number | null {
  for (const s of samples) {
    const v = s[key];
    if (typeof v === 'number' && Number.isFinite(v)) return v;
  }
  return null;
}

const round = (v: number | null, dp = 2): number | null =>
  v == null ? null : Math.round(v * 10 ** dp) / 10 ** dp;

/**
 * RTP media-clock pacing, derived from per-frame (marker-bit) arrival + timestamp
 * pairs. Independent of the 1Hz sample series because the pacing bug lives in the
 * relationship between consecutive frames, not in any single snapshot.
 *
 *   rtpTsDelta   = signed-32-bit (rtpTs[n] − rtpTs[n−1]) / 90   (ms of media time)
 *   arrivalDelta = arrivalMs[n] − arrivalMs[n−1]                (ms of wall time)
 *
 * The RTP timestamp is an unsigned 32-bit counter. Consecutive deltas are
 * normalized to the SIGNED 32-bit range: a genuine wrap (delta ≈ ±2^32) is
 * corrected, while a small backwards delta from RTP packet reordering stays a
 * small negative rather than being misread as a ~2^32 forward jump. (Do NOT use
 * `>>> 0` here — it turns any reordered/backwards delta into +4.29e9 ticks, which,
 * accumulated per frame, blows the drift and pacing-error metrics up to
 * ±hundreds of millions. A 30s span at 90kHz is only 2.7M ticks and never wraps.)
 */
const RTP_WRAP = 0x1_0000_0000;
function signedRtpDelta(cur: number, prev: number): number {
  let d = cur - prev;
  if (d > RTP_WRAP / 2) d -= RTP_WRAP;
  else if (d < -RTP_WRAP / 2) d += RTP_WRAP;
  return d;
}
function mediaClockMetrics(frames: FrameArrival[]): Pick<
  PerfSummary,
  'mediaClockDriftMs' | 'meanFramePacingErrorMs' | 'p95FramePacingErrorMs'
> {
  if (frames.length < 2) {
    return {
      mediaClockDriftMs: null,
      meanFramePacingErrorMs: null,
      p95FramePacingErrorMs: null,
    };
  }
  let rtpElapsedMs = 0;
  const pacingErrors: number[] = [];
  for (let i = 1; i < frames.length; i++) {
    const arrivalDelta = frames[i]!.arrivalMs - frames[i - 1]!.arrivalMs;
    const rtpTsDelta = signedRtpDelta(frames[i]!.rtpTs, frames[i - 1]!.rtpTs) / RTP_TICKS_PER_MS;
    rtpElapsedMs += rtpTsDelta;
    // Reordered frames (negative rtpTsDelta) would inflate the pacing error with
    // a spurious spike; skip those pairs from the pacing-error series (they still
    // net out of rtpElapsedMs via the following forward delta).
    if (rtpTsDelta >= 0) pacingErrors.push(Math.abs(arrivalDelta - rtpTsDelta));
  }
  const wallClockElapsedMs = frames[frames.length - 1]!.arrivalMs - frames[0]!.arrivalMs;
  return {
    mediaClockDriftMs: round(wallClockElapsedMs - rtpElapsedMs),
    meanFramePacingErrorMs: round(mean(pacingErrors)),
    p95FramePacingErrorMs: round(percentile(pacingErrors, 95)),
  };
}

export function summarize(samples: StatsSample[], frames: FrameArrival[] = []): PerfSummary {
  const inbound = samples.filter((s) => s.hasInboundVideo);

  // Bitrate from first→last bytesReceived over the elapsed wall time.
  let meanBitrateKbps: number | null = null;
  const firstBytesSample = inbound.find((s) => typeof s.bytesReceived === 'number');
  const lastBytes = lastNum(inbound, 'bytesReceived');
  if (firstBytesSample && lastBytes != null) {
    const lastBytesSample = [...inbound].reverse().find((s) => typeof s.bytesReceived === 'number');
    const dtMs = (lastBytesSample!.tMs - firstBytesSample.tMs);
    const dBytes = lastBytes - (firstBytesSample.bytesReceived as number);
    if (dtMs > 0 && dBytes >= 0) {
      meanBitrateKbps = (dBytes * 8) / (dtMs / 1000) / 1000;
    }
  }

  // framesDroppedPct from cumulative deltas over the run.
  let framesDroppedPct: number | null = null;
  const droppedFirst = firstNum(inbound, 'framesDropped');
  const droppedLast = lastNum(inbound, 'framesDropped');
  const receivedFirst = firstNum(inbound, 'framesReceived');
  const receivedLast = lastNum(inbound, 'framesReceived');
  if (
    droppedFirst != null && droppedLast != null &&
    receivedFirst != null && receivedLast != null
  ) {
    const dDropped = droppedLast - droppedFirst;
    const dReceived = receivedLast - receivedFirst;
    const denom = dDropped + dReceived;
    if (denom > 0) framesDroppedPct = (dDropped / denom) * 100;
  }

  const rttMs = nums(inbound, 'currentRoundTripTime').map((v) => v * 1000);
  const jitterMs = nums(inbound, 'jitter').map((v) => v * 1000);

  return {
    inboundSamples: inbound.length,
    meanFps: round(mean(nums(inbound, 'framesPerSecond'))),
    p5Fps: round(percentile(nums(inbound, 'framesPerSecond'), 5)),
    meanBitrateKbps: round(meanBitrateKbps),
    freezeCount: lastNum(inbound, 'freezeCount'),
    totalFreezeSec: round(lastNum(inbound, 'totalFreezesDuration')),
    meanRttMs: round(mean(rttMs)),
    meanJitterMs: round(mean(jitterMs), 3),
    framesDroppedPct: round(framesDroppedPct),
    packetsLost: lastNum(inbound, 'packetsLost'),
    ...mediaClockMetrics(frames),
  };
}
