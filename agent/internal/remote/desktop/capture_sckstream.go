package desktop

import (
	"errors"
	"fmt"
	"image"
	"log/slog"
	"time"
)

// This file carries no build tag on purpose: the Test Agent CI job runs on
// ubuntu-latest, where the `darwin && cgo` SCStream shim (capture_darwin.go)
// compiles out. Keeping the stream policy here is what lets CI cover it.
//
// Background (#5928): the macOS 14+ capturer used to take a one-shot
// SCScreenshotManager screenshot per frame, blocking the encode ticker on a
// semaphore for every frame. Field data showed ~3.5 fps on a 6 ms LAN. The
// capturer now runs a persistent SCStream that delivers frames on its own
// dispatch queue into a latest-frame slot; Capture() only copies that slot, so
// a frame's capture latency no longer adds to the encode loop's frame time.

// sckStreamBackend is the ObjC SCStream shim, abstracted so the policy below
// is unit-testable on every platform.
type sckStreamBackend interface {
	// start creates and starts an SCStream for the capturer's display,
	// blocking until SCK reports the stream started or fails. refreshFilter
	// re-queries SCShareableContent first; false reuses the filter built at
	// init time (the first start after open()).
	start(refreshFilter bool) error
	// stop stops and releases the stream and its latest-frame slot. Safe to
	// call when nothing is running.
	stop()
	// frameSeq is the sequence number of the most recent complete frame the
	// stream delivered. It never decreases across restarts; 0 means none yet.
	frameSeq() uint64
	// copyLatest copies the latest complete frame into an RGBA image and
	// returns the sequence number it copied.
	copyLatest() (*image.RGBA, uint64, error)
	// stopError is non-nil once SCK reported stream:didStopWithError: for the
	// current stream.
	stopError() error
	// displayChanged reports whether the captured display went offline or
	// changed mode since the stream started.
	displayChanged() bool
}

const (
	// sckFirstFrameTimeout bounds how long Capture() waits for a freshly
	// started stream's first frame. SCK delivers one immediately on start,
	// even for a static screen, so a miss here is the #6105 failure (SCK
	// initialises but never produces a frame) and is reported as a
	// capture-phase error so the probe's retry + CoreGraphics fallback runs.
	sckFirstFrameTimeout = 3 * time.Second
	// sckFirstFramePoll is the poll step while waiting for the first frame.
	sckFirstFramePoll = 5 * time.Millisecond

	// sckRedeliverInterval: SCK only delivers frames when the screen changes,
	// so an unchanged latest frame is reported as (nil, nil) — "no new frame",
	// like DXGI. It is re-delivered at this interval so a consumer that has
	// not encoded it yet (the session's first encode comes after the start
	// probe consumed the only frame SCK sent for a static screen) still gets
	// it. The session's CRC differ drops the duplicates cheaply.
	sckRedeliverInterval = 200 * time.Millisecond

	// Restart backoff after the stream stops or fails to (re)start.
	sckBackoffMin = 250 * time.Millisecond
	sckBackoffMax = 4 * time.Second
	// sckMaxBackoffWait caps how long a single Capture() call blocks while
	// waiting out a backoff, which bounds both the error-log rate and how
	// long session Stop waits on the capture goroutine.
	sckMaxBackoffWait = 250 * time.Millisecond

	// sckDisplayPollInterval throttles the display-configuration check.
	sckDisplayPollInterval = time.Second

	// sckSleepJumpThreshold: when wall-clock time advances this much more
	// than monotonic time between two captures, the machine slept.
	sckSleepJumpThreshold = 2 * time.Second
)

var errSCKFirstFrameTimeout = errors.New("ScreenCaptureKit stream started but delivered no first frame within the timeout. " +
	"Causes: no display attached; Screen Recording not granted to this process; the window server is not responding")

// sckStreamController owns the SCStream lifecycle: lazy start, first-frame
// wait, restart with backoff after a stop, and proactive rebuilds on display
// change and wake from sleep. It is not safe for concurrent use; the capturer
// serialises calls.
type sckStreamController struct {
	backend sckStreamBackend

	now   func() time.Time
	sleep func(time.Duration)
	// slept reports whether the machine slept between two capture calls.
	slept func(last, now time.Time) bool

	running          bool
	everStarted      bool
	startedAt        time.Time
	startSeq         uint64 // frameSeq() at the moment the current stream started
	deliveredSeq     uint64
	deliveredAt      time.Time
	lastCall         time.Time
	lastDisplayCheck time.Time

	backoff   time.Duration
	nextStart time.Time
	lastErr   error
}

func newSCKStreamController(backend sckStreamBackend) *sckStreamController {
	return &sckStreamController{
		backend: backend,
		now:     time.Now,
		sleep:   time.Sleep,
		slept: func(last, now time.Time) bool {
			// Round(0) strips the monotonic reading; Go's monotonic clock on
			// macOS does not advance while the machine sleeps.
			return systemSlept(now.Round(0).Sub(last.Round(0)), now.Sub(last))
		},
	}
}

// systemSlept reports whether a wall-clock delta outran the monotonic delta by
// more than sckSleepJumpThreshold, i.e. the process was suspended by sleep.
func systemSlept(wallDelta, monoDelta time.Duration) bool {
	return wallDelta-monoDelta > sckSleepJumpThreshold
}

// capture returns the latest frame, (nil, nil) when the screen has not changed
// since the last delivered frame, or an error while the stream is down. It
// never returns (nil, nil) during an outage: the session treats a nil frame as
// a live static screen and would keep its no-video watchdog quiet.
func (c *sckStreamController) capture() (*image.RGBA, error) {
	return c.acquire(false)
}

// latest always returns the most recent frame (or an error), whether or not
// it changed, and does not mark it delivered. It serves one-shot consumers
// that share the capturer with the stream loop — screenshots taken during a
// live session — without stealing a changed frame from the loop.
func (c *sckStreamController) latest() (*image.RGBA, error) {
	return c.acquire(true)
}

func (c *sckStreamController) acquire(force bool) (*image.RGBA, error) {
	now := c.now()
	if c.running && !c.lastCall.IsZero() && c.slept(c.lastCall, now) {
		c.restart("system woke from sleep", false)
	}
	c.lastCall = now

	if c.running {
		if err := c.backend.stopError(); err != nil {
			c.fail(err)
		} else if now.Sub(c.lastDisplayCheck) >= sckDisplayPollInterval {
			c.lastDisplayCheck = now
			if c.backend.displayChanged() {
				c.restart("display configuration changed", false)
			}
		}
	}

	if !c.running {
		if err := c.startStream(); err != nil {
			return nil, err
		}
	}

	seq := c.backend.frameSeq()
	if seq <= c.startSeq {
		deadline := c.startedAt.Add(sckFirstFrameTimeout)
		for seq <= c.startSeq && c.now().Before(deadline) {
			c.sleep(sckFirstFramePoll)
			seq = c.backend.frameSeq()
		}
		if seq <= c.startSeq {
			c.fail(errSCKFirstFrameTimeout)
			return nil, errSCKFirstFrameTimeout
		}
	}

	if !force && seq == c.deliveredSeq && c.now().Sub(c.deliveredAt) < sckRedeliverInterval {
		return nil, nil
	}

	img, got, err := c.backend.copyLatest()
	if err != nil {
		c.fail(err)
		return nil, err
	}
	if !force {
		c.deliveredSeq = got
		c.deliveredAt = c.now()
	}
	if c.backoff != 0 || c.lastErr != nil {
		slog.Info("ScreenCaptureKit stream recovered", "previousError", errString(c.lastErr))
	}
	c.backoff = 0
	c.lastErr = nil
	return img, nil
}

// startStream (re)starts the stream once any backoff has elapsed.
func (c *sckStreamController) startStream() error {
	if wait := c.nextStart.Sub(c.now()); wait > 0 {
		if wait > sckMaxBackoffWait {
			wait = sckMaxBackoffWait
		}
		c.sleep(wait)
		if c.now().Before(c.nextStart) {
			return c.outageError()
		}
	}
	// Baseline before start: SCK can deliver the first frame on its own queue
	// before start() returns, and that frame must count as the new stream's.
	// stop() has already fenced off callbacks from any previous stream.
	baseline := c.backend.frameSeq()
	if err := c.backend.start(c.everStarted); err != nil {
		c.fail(err)
		return c.lastErr
	}
	c.running = true
	c.everStarted = true
	c.startedAt = c.now()
	c.startSeq = baseline
	c.lastDisplayCheck = c.startedAt
	return nil
}

// fail tears the stream down and arms the restart backoff.
func (c *sckStreamController) fail(err error) {
	if c.running {
		slog.Warn("ScreenCaptureKit stream failed; restarting with backoff",
			"error", err.Error())
	}
	c.backend.stop()
	c.running = false
	if c.backoff == 0 {
		c.backoff = sckBackoffMin
	} else {
		c.backoff *= 2
		if c.backoff > sckBackoffMax {
			c.backoff = sckBackoffMax
		}
	}
	c.nextStart = c.now().Add(c.backoff)
	c.lastErr = err
}

// restart tears the stream down for an immediate rebuild (no backoff). When
// resetBackoff is false an existing backoff is left armed for the next failure.
func (c *sckStreamController) restart(reason string, resetBackoff bool) {
	slog.Info("Rebuilding ScreenCaptureKit stream", "reason", reason)
	c.backend.stop()
	c.running = false
	c.nextStart = time.Time{}
	if resetBackoff {
		c.backoff = 0
	}
}

// forceRestart rebuilds the stream on the next capture, skipping any backoff.
// Called by the session's no-video watchdog.
func (c *sckStreamController) forceRestart() {
	c.restart("no-video watchdog", true)
}

func (c *sckStreamController) close() {
	c.backend.stop()
	c.running = false
}

func (c *sckStreamController) outageError() error {
	if c.lastErr == nil {
		return fmt.Errorf("ScreenCaptureKit stream restarting")
	}
	return fmt.Errorf("ScreenCaptureKit stream restarting after: %w", c.lastErr)
}

func errString(err error) string {
	if err == nil {
		return ""
	}
	return err.Error()
}
