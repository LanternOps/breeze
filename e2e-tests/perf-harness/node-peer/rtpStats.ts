/**
 * Derives streaming-quality metrics from the raw inbound H264 RTP stream.
 *
 * We do NOT decode the video (a headless peer has no decoder / render loop), so
 * unlike a browser's getStats() there is no framesDropped/decode-fps. Instead we
 * measure everything a receiver can see at the packet layer:
 *
 *   - frames        : count of RTP marker bits (H264 sets the marker on the last
 *                     packet of each access unit / frame)
 *   - fps           : frames completed per sampling interval
 *   - bitrate       : bytesReceived delta over wall time
 *   - freeze proxy  : inter-frame gaps > FREEZE_GAP_MS (default 250ms)
 *   - jitter        : RFC 3550 interarrival jitter (seconds), from RTP timestamps
 *   - packetsLost   : from RTP sequence-number gaps (16-bit, wrap-aware)
 *
 * The per-sample output is shaped as the harness's StatsSample so the existing
 * summarize.ts / compare.ts consume it unchanged.
 */
import { performance } from 'node:perf_hooks';
import type { StatsSample, FrameArrival } from '../types';

const H264_CLOCK_RATE = 90000; // RTP clock for video
export const DEFAULT_FREEZE_GAP_MS = 250;

interface RtpLike {
  header: { sequenceNumber: number; timestamp: number; marker: boolean };
  payload: { length: number };
  serializeSize?: number;
}

export class RtpStatsAccumulator {
  private readonly freezeGapMs: number;
  private readonly startMs: number;

  // Cumulative counters
  private bytesReceived = 0;
  private packetsReceived = 0;
  private framesCompleted = 0; // marker-bit count
  private packetsLost = 0;
  private freezeCount = 0;
  private totalFreezeSec = 0;

  // Sequence-number tracking (extended, wrap-aware)
  private baseSeq: number | null = null;
  private maxExtSeq = 0;
  private prevSeq: number | null = null;
  private seqCycles = 0;

  // RFC 3550 jitter state (in RTP timestamp units)
  private jitter = 0;
  private prevTransit: number | null = null;

  // Freeze / fps state
  private lastFrameMs: number | null = null;

  // Per-frame (marker-bit) arrival series for RTP media-clock pacing analysis.
  // Arrival is a monotonic clock (performance.now()) so wall-clock adjustments
  // can't corrupt the drift/pacing math.
  private readonly frameArrivals: FrameArrival[] = [];

  // Snapshot bookkeeping for instantaneous fps
  private lastSampleMs: number;
  private lastSampleFrames = 0;

  constructor(freezeGapMs = DEFAULT_FREEZE_GAP_MS) {
    this.freezeGapMs = freezeGapMs;
    this.startMs = Date.now();
    this.lastSampleMs = this.startMs;
  }

  /** Feed one inbound RTP packet. */
  onPacket(rtp: RtpLike): void {
    const nowMs = Date.now();
    const { sequenceNumber, timestamp, marker } = rtp.header;

    // Bytes: prefer full serialized size, fall back to payload + 12B header.
    this.bytesReceived += rtp.serializeSize ?? rtp.payload.length + 12;
    this.packetsReceived += 1;

    // ── Sequence tracking / loss ──────────────────────────────────────────
    if (this.baseSeq === null) {
      this.baseSeq = sequenceNumber;
      this.maxExtSeq = sequenceNumber;
    } else {
      if (this.prevSeq !== null && sequenceNumber < this.prevSeq - 0x7fff) {
        // 16-bit wraparound
        this.seqCycles += 0x10000;
      }
      const ext = this.seqCycles + sequenceNumber;
      if (ext > this.maxExtSeq) this.maxExtSeq = ext;
    }
    this.prevSeq = sequenceNumber;
    const expected = this.maxExtSeq - this.baseSeq + 1;
    this.packetsLost = Math.max(0, expected - this.packetsReceived);

    // ── RFC 3550 interarrival jitter ─────────────────────────────────────
    // transit = arrival (in RTP units) - rtp timestamp
    const arrivalRtp = (nowMs / 1000) * H264_CLOCK_RATE;
    const transit = arrivalRtp - timestamp;
    if (this.prevTransit !== null) {
      const d = Math.abs(transit - this.prevTransit);
      this.jitter += (d - this.jitter) / 16;
    }
    this.prevTransit = transit;

    // ── Frame completion (marker bit) -> fps + freeze proxy ──────────────
    if (marker) {
      this.framesCompleted += 1;
      // Record the frame boundary for media-clock drift/pacing analysis: raw
      // 32-bit RTP timestamp + monotonic arrival time.
      this.frameArrivals.push({ arrivalMs: performance.now(), rtpTs: timestamp });
      if (this.lastFrameMs !== null) {
        const gap = nowMs - this.lastFrameMs;
        if (gap > this.freezeGapMs) {
          this.freezeCount += 1;
          this.totalFreezeSec += gap / 1000;
        }
      }
      this.lastFrameMs = nowMs;
    }
  }

  /** True once at least one inbound video packet has arrived. */
  hasVideo(): boolean {
    return this.packetsReceived > 0;
  }

  get frames(): number {
    return this.framesCompleted;
  }

  get bytes(): number {
    return this.bytesReceived;
  }

  /**
   * Per-frame (marker-bit) arrival series for RTP media-clock pacing analysis.
   * Fed to summarize() alongside the 1Hz samples.
   */
  frameArrivalSeries(): FrameArrival[] {
    return this.frameArrivals;
  }

  /**
   * Take a ~1Hz snapshot. `rttSec` is the current selected-candidate-pair RTT
   * (seconds) pulled from getStats, or null when unavailable.
   */
  sample(rttSec: number | null): StatsSample {
    const nowMs = Date.now();
    const dtMs = nowMs - this.lastSampleMs;
    const dFrames = this.framesCompleted - this.lastSampleFrames;
    const fps = dtMs > 0 ? (dFrames * 1000) / dtMs : 0;

    this.lastSampleMs = nowMs;
    this.lastSampleFrames = this.framesCompleted;

    return {
      tMs: nowMs - this.startMs,
      pcCount: 1,
      hasInboundVideo: this.hasVideo(),
      framesPerSecond: this.hasVideo() ? fps : null,
      framesReceived: this.framesCompleted,
      // No decoder in a headless peer -> decode-drop count is not observable.
      framesDropped: null,
      freezeCount: this.freezeCount,
      totalFreezesDuration: this.totalFreezeSec,
      jitter: this.jitter / H264_CLOCK_RATE, // seconds
      packetsLost: this.packetsLost,
      bytesReceived: this.bytesReceived,
      currentRoundTripTime: rttSec,
    };
  }

  /** Packets lost as a percentage of expected packets over the whole run. */
  packetsLostPct(): number | null {
    if (this.baseSeq === null) return null;
    const expected = this.maxExtSeq - this.baseSeq + 1;
    if (expected <= 0) return null;
    return (this.packetsLost / expected) * 100;
  }
}
