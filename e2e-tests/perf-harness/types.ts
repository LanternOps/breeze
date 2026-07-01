/**
 * Shared types for the remote-desktop WebRTC performance harness.
 *
 * A "run" produces one PerfResult JSON file. Two PerfResult files (baseline vs
 * a code change) are fed to compare.ts to diff the summary metrics.
 */

/** One ~1Hz snapshot of the viewer's inbound-rtp video + candidate-pair stats. */
export interface StatsSample {
  /** Milliseconds since capture start. */
  tMs: number;
  /** Number of RTCPeerConnection instances the wrapper has observed. */
  pcCount: number;
  /** True when an inbound-rtp video report with a decoder was found this tick. */
  hasInboundVideo: boolean;

  // ── inbound-rtp (video) — cumulative unless noted ──────────────────────
  /** Instantaneous decode frame rate reported by the browser. */
  framesPerSecond: number | null;
  /** Cumulative frames handed to the decoder. */
  framesReceived: number | null;
  /** Cumulative frames dropped before/at decode. */
  framesDropped: number | null;
  /** Cumulative freeze events (Chrome freeze detection). */
  freezeCount: number | null;
  /** Cumulative seconds spent frozen. */
  totalFreezesDuration: number | null;
  /** Inter-arrival jitter, seconds. */
  jitter: number | null;
  /** Cumulative RTP packets lost. */
  packetsLost: number | null;
  /** Cumulative payload+header bytes received (used to derive bitrate). */
  bytesReceived: number | null;

  // ── candidate-pair (selected) ──────────────────────────────────────────
  /** Current round-trip time, seconds. */
  currentRoundTripTime: number | null;
}

/**
 * One completed video frame observed at the RTP layer (marker-bit boundary),
 * used to measure RTP media-clock pacing independent of the 1Hz sample series.
 */
export interface FrameArrival {
  /** Monotonic wall-clock arrival time (performance.now(), ms) of the frame's marker packet. */
  arrivalMs: number;
  /** Raw 32-bit RTP timestamp (90kHz clock) from the marker packet's header. */
  rtpTs: number;
}

/** Reduced, comparable metrics computed from the sample series. */
export interface PerfSummary {
  /** Count of samples where an inbound-rtp video track was present. */
  inboundSamples: number;
  /** Mean instantaneous FPS across inbound samples. */
  meanFps: number | null;
  /** 5th-percentile FPS (captures the worst stalls). */
  p5Fps: number | null;
  /** Mean received bitrate (kbit/s) derived from bytesReceived deltas. */
  meanBitrateKbps: number | null;
  /** Total freeze events over the run (last cumulative value). */
  freezeCount: number | null;
  /** Total time frozen over the run, seconds. */
  totalFreezeSec: number | null;
  /** Mean candidate-pair RTT, milliseconds. */
  meanRttMs: number | null;
  /** Mean jitter, milliseconds. */
  meanJitterMs: number | null;
  /** Frames dropped as a percentage of (dropped + received). */
  framesDroppedPct: number | null;
  /** Cumulative packets lost over the run (last value). */
  packetsLost: number | null;

  // ── RTP media-clock pacing (measured at the frame/marker-bit layer) ─────
  /**
   * Total drift of the RTP media clock vs wall-clock over the session, ms:
   * (wallClockElapsedMs) − (rtpElapsedMs), measured between the first and last
   * completed frames. Positive = the media clock lags real time — the symptom of
   * an encoder that stamps each frame with a fixed 1/fps increment and never
   * accounts for the real elapsed time of SKIPPED (static-screen) frames. Near 0
   * when sample durations track real elapsed time.
   */
  mediaClockDriftMs: number | null;
  /** Mean per-frame |arrivalDelta − rtpTsDelta|, ms — average pacing error. */
  meanFramePacingErrorMs: number | null;
  /** 95th-percentile per-frame |arrivalDelta − rtpTsDelta|, ms — worst pacing error. */
  p95FramePacingErrorMs: number | null;
}

export interface PerfResult {
  /** Machine identifier (env RD_MACHINE, default os.hostname()). */
  machine: string;
  /** Run label, e.g. "baseline" or a change name (env RD_LABEL). */
  label: string;
  /** ISO timestamp when the run started. */
  timestamp: string;
  /** Configured capture duration, seconds. */
  durationSec: number;
  /** The device id the run targeted (env RD_DEVICE_ID), if any. */
  deviceId: string | null;
  /** URL of the page that hosted (or was expected to host) the RTCPeerConnection. */
  viewerUrl: string;
  /**
   * True when at least one inbound-rtp video sample was captured. When false,
   * the run is scaffolding-only (no live agent / no PC) and the summary metrics
   * are null — this is the expected state until a real device is connected.
   */
  capturedLiveVideo: boolean;
  /** Free-form notes (e.g. why capturedLiveVideo is false). */
  notes: string[];
  samples: StatsSample[];
  summary: PerfSummary;
}
