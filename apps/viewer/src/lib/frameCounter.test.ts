import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { startFrameCounter, DEFAULT_WATCHDOG_MS } from './frameCounter';

// Minimal fake <video> element: just enough surface for frameCounter to
// drive (currentTime, readyState, and an optional requestVideoFrameCallback).
interface FakeVideo {
  currentTime: number;
  readyState: number;
  requestVideoFrameCallback?: (cb: () => void) => number;
  cancelVideoFrameCallback?: (handle: number) => void;
}

function makeVideo(overrides?: Partial<FakeVideo>): FakeVideo {
  return {
    currentTime: 0,
    readyState: 0,
    ...overrides,
  };
}

describe('startFrameCounter', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('counts frames via requestVideoFrameCallback when it fires normally', () => {
    let pendingCb: (() => void) | null = null;
    const video = makeVideo({
      requestVideoFrameCallback: (cb) => {
        pendingCb = cb;
        return 1;
      },
    });
    let frames = 0;
    const handle = startFrameCounter({
      video: video as unknown as HTMLVideoElement,
      onFrame: () => { frames++; },
    });

    // Simulate the browser invoking the rVFC callback on every decoded frame.
    expect(pendingCb).not.toBeNull();
    pendingCb!();
    pendingCb!();
    pendingCb!();

    // Even after the watchdog window elapses, a firing rVFC must never
    // trigger the poll fallback (it re-arms itself on every real callback).
    vi.advanceTimersByTime(DEFAULT_WATCHDOG_MS + 1000);

    expect(frames).toBe(3);
    handle.stop();
  });

  it('falls back to currentTime polling when rVFC is present but silently never fires on a live video', () => {
    // Reproduces issue #5292: WKWebView on macOS exposes
    // requestVideoFrameCallback but never invokes it for a WebRTC
    // MediaStream-driven <video>, so the naive `typeof rvfc === 'function'`
    // check picks the rVFC path and then the counter reads 0 forever.
    const video = makeVideo({
      readyState: 2, // HAVE_CURRENT_DATA — video is live
      requestVideoFrameCallback: () => {
        // Registers the callback but NEVER invokes it — this is the bug.
        return 1;
      },
    });
    let frames = 0;
    const handle = startFrameCounter({
      video: video as unknown as HTMLVideoElement,
      onFrame: () => { frames++; },
    });

    // The video keeps decoding and playing even though rVFC stays silent.
    // Advance currentTime across the watchdog window so the poll fallback
    // (once engaged) has something to detect.
    const advanceMs = 100;
    let elapsed = 0;
    while (elapsed < DEFAULT_WATCHDOG_MS + 500) {
      video.currentTime += advanceMs / 1000;
      vi.advanceTimersByTime(advanceMs);
      elapsed += advanceMs;
    }

    expect(frames).toBeGreaterThan(0);
    handle.stop();
  });

  it('falls back once a previously-working rVFC goes silent mid-session, not just at startup', () => {
    // The watchdog must be a heartbeat, not a one-shot startup check: rVFC
    // can fire normally for a while and then stop invoking its callback
    // (e.g. a transient decoder hiccup) without the WebView ever formally
    // signalling that it gave up. A one-shot watchdog that only clears
    // itself on the first callback would never recover from this.
    let pendingCb: (() => void) | null = null;
    const video = makeVideo({
      readyState: 2,
      requestVideoFrameCallback: (cb) => {
        pendingCb = cb;
        return 1;
      },
    });
    let frames = 0;
    const handle = startFrameCounter({
      video: video as unknown as HTMLVideoElement,
      onFrame: () => { frames++; },
    });

    // rVFC fires normally for a few frames.
    for (let i = 0; i < 5; i++) {
      video.currentTime += 0.016;
      pendingCb!();
      vi.advanceTimersByTime(16);
    }
    expect(frames).toBe(5);

    // Then it goes silent: pendingCb is never invoked again, but the video
    // keeps decoding/advancing underneath.
    const framesBeforeStall = frames;
    let elapsed = 0;
    while (elapsed < DEFAULT_WATCHDOG_MS + 500) {
      video.currentTime += 0.016;
      vi.advanceTimersByTime(16);
      elapsed += 16;
    }

    expect(frames).toBeGreaterThan(framesBeforeStall);
    handle.stop();
  });

  it('never engages the poll fallback while the video is not yet live (readyState 0, currentTime frozen)', () => {
    const video = makeVideo({
      readyState: 0,
      requestVideoFrameCallback: () => 1, // present, silent, but video isn't live yet
    });
    let frames = 0;
    const handle = startFrameCounter({
      video: video as unknown as HTMLVideoElement,
      onFrame: () => { frames++; },
    });

    vi.advanceTimersByTime(DEFAULT_WATCHDOG_MS * 3);

    // Nothing to count: no real rVFC callback, and the watchdog correctly
    // withheld the fallback because the video was never observably live.
    expect(frames).toBe(0);
    handle.stop();
  });

  it('uses the currentTime poll immediately when requestVideoFrameCallback is absent', () => {
    const video = makeVideo(); // no requestVideoFrameCallback at all
    let frames = 0;
    const handle = startFrameCounter({
      video: video as unknown as HTMLVideoElement,
      onFrame: () => { frames++; },
    });

    video.currentTime = 1;
    vi.advanceTimersByTime(20);
    video.currentTime = 2;
    vi.advanceTimersByTime(20);

    expect(frames).toBe(2);
    handle.stop();
  });

  it('stop() halts further counting from either strategy', () => {
    const video = makeVideo();
    let frames = 0;
    const handle = startFrameCounter({
      video: video as unknown as HTMLVideoElement,
      onFrame: () => { frames++; },
    });

    video.currentTime = 1;
    vi.advanceTimersByTime(20);
    expect(frames).toBe(1);

    handle.stop();
    video.currentTime = 2;
    vi.advanceTimersByTime(100);
    expect(frames).toBe(1);
  });

  it('logs once, at debug, when the watchdog fallback engages', () => {
    const video = makeVideo({
      readyState: 2,
      requestVideoFrameCallback: () => 1,
    });
    const log = vi.fn();
    const handle = startFrameCounter({
      video: video as unknown as HTMLVideoElement,
      onFrame: () => {},
      log,
    });

    video.currentTime = 1; // observably live before the watchdog fires
    vi.advanceTimersByTime(DEFAULT_WATCHDOG_MS + 100);
    video.currentTime = 2;
    vi.advanceTimersByTime(DEFAULT_WATCHDOG_MS + 100);

    expect(log).toHaveBeenCalledTimes(1);
    handle.stop();
  });
});
