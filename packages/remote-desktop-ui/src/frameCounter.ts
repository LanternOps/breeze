/**
 * Frame-arrival counter for the WebRTC remote-desktop `<video>` element.
 *
 * Primary source is `HTMLVideoElement.requestVideoFrameCallback` (rVFC) — it
 * fires once per decoded/presented frame and is cheap. Some WebViews expose
 * the API but never invoke it for a WebRTC `MediaStream`-driven `<video>`
 * (confirmed for WKWebView on macOS — see issue #5292): a bare
 * `typeof rvfc === 'function'` check can't distinguish "supported and
 * working" from "supported and silently dead", so the FPS readout stuck at a
 * permanent 0 while the picture was visibly updating and sent operators
 * chasing a network problem that didn't exist.
 *
 * This module treats rVFC as advisory rather than authoritative: it starts
 * on rVFC when available, but arms a heartbeat watchdog that is re-armed on
 * every real rVFC callback. If the video is demonstrably live
 * (`readyState >= HAVE_CURRENT_DATA` and `currentTime` has advanced since
 * the watchdog last armed) yet no rVFC callback has arrived within
 * `watchdogMs`, it gives up on rVFC for the rest of this session and
 * switches permanently to a `currentTime`-poll fallback — the same
 * approximation used when rVFC isn't present at all. Re-arming on every
 * callback (rather than only once at startup) means this also recovers from
 * rVFC going silent mid-session, not just from it never firing at all.
 *
 * A `getStats()`-based `framesDecoded` counter would be more transport-truthful,
 * but is not used here: it needs a live `RTCPeerConnection` threaded into this
 * module (not just the `<video>` element), duplicates the polling
 * `statsReporter.ts` already does for the agent's adaptive-bitrate loop, and
 * adds an async race surface for what is a P2/small-effort readout fix. The
 * watchdog approach fixes the reported defect (false 0 FPS on a live stream)
 * with a small, synchronous, easily-tested change; a getStats()-based FPS
 * source is a reasonable follow-up if wanted.
 */

export const DEFAULT_WATCHDOG_MS = 1500;

/** Fixed poll cadence for the currentTime-advance fallback, in ms. Matches
 * typical requestAnimationFrame cadence (~60Hz) without depending on rAF,
 * which some environments throttle or suspend when the window loses focus. */
const POLL_INTERVAL_MS = 16;

/** `HTMLVideoElement.readyState` value for "has current frame data". */
const HAVE_CURRENT_DATA = 2;

type RvfcCapableVideo = HTMLVideoElement & {
  requestVideoFrameCallback?: (callback: () => void) => number;
};

export interface FrameCounterOptions {
  video: HTMLVideoElement;
  /** Called once per frame counted, by whichever strategy is currently active. */
  onFrame: () => void;
  /** How long to wait for the first rVFC callback, on a live video, before falling back. */
  watchdogMs?: number;
  /** Debug logger. Called at most once, only when the watchdog fallback engages. */
  log?: (message: string) => void;
}

export interface FrameCounterHandle {
  stop: () => void;
}

export function startFrameCounter(options: FrameCounterOptions): FrameCounterHandle {
  const { video, onFrame, watchdogMs = DEFAULT_WATCHDOG_MS, log } = options;

  let stopped = false;
  let usingPoll = false;
  let pollTimer: ReturnType<typeof setInterval> | null = null;
  let watchdogTimer: ReturnType<typeof setTimeout> | null = null;

  const rvfcVideo = video as RvfcCapableVideo;
  const rvfc = rvfcVideo.requestVideoFrameCallback?.bind(rvfcVideo);

  function clearWatchdog() {
    if (watchdogTimer !== null) {
      clearTimeout(watchdogTimer);
      watchdogTimer = null;
    }
  }

  function startPoll() {
    if (usingPoll || stopped) return;
    usingPoll = true;
    clearWatchdog();
    let lastTime = video.currentTime;
    pollTimer = setInterval(() => {
      const t = video.currentTime;
      if (t !== lastTime) {
        lastTime = t;
        onFrame();
      }
    }, POLL_INTERVAL_MS);
  }

  function stop() {
    if (stopped) return;
    stopped = true;
    clearWatchdog();
    if (pollTimer !== null) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
  }

  if (!rvfc) {
    // No rVFC support at all (or not implemented in this environment) — go
    // straight to the poll fallback.
    startPoll();
    return { stop };
  }

  // Heartbeat watchdog: (re-)armed on every real rVFC callback, not just
  // once at startup. This is what lets it catch BOTH failure modes: rVFC
  // never fires at all (issue #5292), and rVFC fires normally for a while
  // then goes silent mid-session (e.g. a transient decoder hiccup) without
  // ever formally unregistering. Each check snapshots `currentTime` at arm
  // time and compares it `watchdogMs` later — if the video has demonstrably
  // kept playing in that window but rVFC stayed silent, the failure is
  // rVFC's, not the stream's.
  const armWatchdog = () => {
    if (stopped || usingPoll) return;
    const referenceTime = video.currentTime;
    watchdogTimer = setTimeout(() => {
      if (stopped || usingPoll) return;
      const isLive = video.readyState >= HAVE_CURRENT_DATA && video.currentTime !== referenceTime;
      if (isLive) {
        // Engage the fallback BEFORE the caller-supplied log callback, so a
        // throwing logger can never prevent recovery — that would silently
        // reintroduce the exact bug this module exists to fix.
        startPoll();
        log?.(
          'requestVideoFrameCallback is supported but stopped firing while the video was ' +
            'live; falling back to currentTime polling for frame counting (see issue #5292).',
        );
        return;
      }
      // Video isn't clearly live yet (still buffering/paused) — give it
      // another window rather than giving up prematurely.
      armWatchdog();
    }, watchdogMs);
  };

  const onRvfcFrame = () => {
    if (stopped || usingPoll) return;
    onFrame();
    rvfc(onRvfcFrame);
    // A real callback just fired — rVFC is alive right now. Reset the
    // watchdog's clock instead of clearing it for good, so a later stall
    // still gets caught.
    clearWatchdog();
    armWatchdog();
  };
  rvfc(onRvfcFrame);
  armWatchdog();

  return { stop };
}
