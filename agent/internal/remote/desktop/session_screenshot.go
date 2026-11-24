package desktop

import (
	"errors"
	"fmt"
	"image"
	"log/slog"
	"sync"
	"time"
)

// One-shot screenshots during a live session (#12624).
//
// AI tools (take_screenshot, computer_action) used to borrow the session's
// capturer and call Capture() on the tool command's goroutine. On Windows that
// races the capture loop: the GPU path holds a DXGI frame between
// CaptureTexture and ReleaseTexture while the encoder reads it, with the
// capturer mutex released, so a Capture() in that window reaches
// AcquireNextFrame with a frame outstanding (DXGI_ERROR_INVALID_CALL). The
// capturer then tears the device down under the encoder and re-initialises
// DXGI and the thread desktop on the tool's OS thread, not the pinned capture
// thread. Video stops and the duplication can be left behind.
//
// Now the capture loop serves the request itself, between frames, on its own
// thread: at that point it holds no frame, and any recovery Capture() needs
// runs where the loop's own recovery would. The caller waits for the answer
// with a bound. Before the loop has started (the peer is still connecting)
// nothing else drives the capturer, so the caller captures directly, holding
// the queue lock so the loop cannot start mid-capture.

// screenshotRequestTimeout bounds how long CaptureScreenshot waits for the
// capture loop. Generous next to a normal answer (one or two loop iterations),
// because the loop can sit in a recovery sleep or a slow encode first. A var
// so tests can shorten it.
var screenshotRequestTimeout = 3 * time.Second

// The capture loop gives up on a request that has produced no frame after
// screenshotMaxAttempts iterations or screenshotNoFrameBudget, whichever comes
// first. A static screen gives no DXGI frame until the repaint that each
// attempt triggers lands; the time budget keeps a slow ticker loop (low FPS)
// answering "no frame" before the caller's timeout instead of "timed out".
const (
	screenshotMaxAttempts   = 10
	screenshotNoFrameBudget = 1500 * time.Millisecond
)

// Before the capture loop starts, the caller captures directly: up to
// screenshotDirectAttempts tries, screenshotDirectRetryDelay apart (the
// pre-#12624 behaviour).
const (
	screenshotDirectAttempts   = 8
	screenshotDirectRetryDelay = 30 * time.Millisecond
)

var (
	// None of these wrap ErrNoActiveSession: the session is still live (or
	// still tearing down), so the tools layer must not fall back to a
	// standalone capturer.
	errScreenshotTimeout        = errors.New("timed out waiting for the desktop session's capture loop")
	errScreenshotSessionStopped = errors.New("desktop session stopped before the screenshot was captured")
	errScreenshotNoFrame        = errors.New("desktop session produced no frame for the screenshot")
)

// screenshotRequest is one pending one-shot capture. reply has capacity 1 and
// is answered exactly once, by whoever removes the request from the queue, so
// the answer never blocks and nothing ever closes the channel.
type screenshotRequest struct {
	reply    chan screenshotResult
	deadline time.Time
	// attempts and firstAttempt are touched only by the capture loop goroutine.
	attempts     int
	firstAttempt time.Time
}

type screenshotResult struct {
	img          *image.RGBA
	w, h         int
	displayIndex int
	err          error
}

// screenshotQueue holds the requests the capture loop has yet to answer. Its
// zero value is ready to use. mu also orders the loop's start and exit against
// callers: a caller that finds no loop started captures while holding it, and
// a request is never left behind by a loop that has exited.
type screenshotQueue struct {
	mu          sync.Mutex
	loopStarted bool
	loopExited  bool
	pending     []*screenshotRequest
}

// submit queues req for the capture loop. Before the loop has started it
// instead runs direct with the queue locked and returns its result (queued
// false). After the loop has exited it fails at once.
func (q *screenshotQueue) submit(req *screenshotRequest, direct func() screenshotResult) (res screenshotResult, queued bool) {
	q.mu.Lock()
	defer q.mu.Unlock()
	switch {
	case q.loopExited:
		return screenshotResult{err: errScreenshotSessionStopped}, false
	case !q.loopStarted:
		return direct(), false
	}
	q.pending = append(q.pending, req)
	return screenshotResult{}, true
}

// head returns the oldest live request, answering and dropping any whose
// caller has already given up.
func (q *screenshotQueue) head(now time.Time) *screenshotRequest {
	q.mu.Lock()
	defer q.mu.Unlock()
	for len(q.pending) > 0 {
		req := q.pending[0]
		if now.Before(req.deadline) {
			return req
		}
		q.pending = q.pending[1:]
		req.reply <- screenshotResult{err: errScreenshotTimeout}
	}
	return nil
}

// finish removes req from the queue and answers it. A request that is no
// longer queued was already answered, so it is left alone.
func (q *screenshotQueue) finish(req *screenshotRequest, res screenshotResult) {
	q.mu.Lock()
	defer q.mu.Unlock()
	for i, p := range q.pending {
		if p == req {
			q.pending = append(q.pending[:i], q.pending[i+1:]...)
			req.reply <- res
			return
		}
	}
}

// markLoopStarted is called by the capture loop before its first iteration.
// It waits for any caller capturing directly to finish.
func (q *screenshotQueue) markLoopStarted() {
	q.mu.Lock()
	defer q.mu.Unlock()
	q.loopStarted = true
}

// markLoopExited is called when the capture loop returns (or panics). It fails
// every pending request, so no caller waits out its timeout on a loop that
// will never answer, and makes later requests fail at once.
func (q *screenshotQueue) markLoopExited() {
	q.mu.Lock()
	defer q.mu.Unlock()
	q.loopExited = true
	for _, req := range q.pending {
		req.reply <- screenshotResult{err: errScreenshotSessionStopped}
	}
	q.pending = nil
}

func (q *screenshotQueue) loopRunning() bool {
	q.mu.Lock()
	defer q.mu.Unlock()
	return q.loopStarted && !q.loopExited
}

// requestScreenshot asks the capture loop for one frame and waits for it.
func (s *Session) requestScreenshot() screenshotResult {
	req := &screenshotRequest{
		reply:    make(chan screenshotResult, 1),
		deadline: time.Now().Add(screenshotRequestTimeout),
	}
	res, queued := s.screenshots.submit(req, s.captureScreenshotBeforeLoop)
	if !queued {
		return res
	}
	timer := time.NewTimer(screenshotRequestTimeout)
	defer timer.Stop()
	select {
	case res := <-req.reply:
		return res
	case <-s.done:
		// The loop may have answered in the same instant; prefer the frame.
		select {
		case res := <-req.reply:
			return res
		default:
		}
		return screenshotResult{err: errScreenshotSessionStopped}
	case <-timer.C:
		// The loop drops the request once it sees the deadline has passed.
		var sinceVideo time.Duration = -1
		if last := s.lastVideoWriteUnixNano.Load(); last != 0 {
			sinceVideo = time.Since(time.Unix(0, last)).Round(time.Millisecond)
		}
		slog.Warn("Screenshot request timed out waiting for the capture loop",
			"session", s.id, "timeout", screenshotRequestTimeout,
			"loopRunning", s.screenshots.loopRunning(), "sinceLastVideoWrite", sinceVideo)
		return screenshotResult{err: errScreenshotTimeout}
	}
}

// captureScreenshotBeforeLoop captures on the caller's goroutine. It runs only
// while the capture loop has not started, with the queue locked, so nothing
// else is driving the capturer and no frame is held.
func (s *Session) captureScreenshotBeforeLoop() screenshotResult {
	s.mu.RLock()
	cap := s.capturer
	displayIndex := s.displayIndex
	s.mu.RUnlock()
	if cap == nil {
		return screenshotResult{err: errScreenshotSessionStopped}
	}
	forceDesktopRepaint()
	for attempt := 1; ; attempt++ {
		// A session stopped before its loop ever started is being torn
		// down; do not drive a capturer that is about to be closed.
		select {
		case <-s.done:
			return screenshotResult{err: errScreenshotSessionStopped}
		default:
		}
		img, err := cap.Capture()
		if err != nil {
			return screenshotResult{err: err}
		}
		if img != nil {
			w, h := screenshotBounds(cap, img)
			return screenshotResult{img: img, w: w, h: h, displayIndex: displayIndex}
		}
		if attempt >= screenshotDirectAttempts {
			return screenshotResult{err: noFrameError(cap, attempt)}
		}
		time.Sleep(screenshotDirectRetryDelay)
	}
}

// serveScreenshotRequest runs on the capture loop goroutine, at a point in
// the iteration where the loop holds no capture frame. It makes one capture
// attempt for the oldest pending screenshot request and reports whether it
// did; when it did, the caller skips its own capture for this iteration, so
// the next CaptureTexture/Capture runs only after the loop's top-of-iteration
// checks (desktop switch, capturer swap, watchdog) have seen any recovery the
// attempt performed.
func (s *Session) serveScreenshotRequest() bool {
	now := time.Now()
	req := s.screenshots.head(now)
	if req == nil {
		return false
	}

	s.mu.RLock()
	cap := s.capturer
	displayIndex := s.displayIndex
	s.mu.RUnlock()
	if cap == nil {
		s.finishScreenshot(req, screenshotResult{err: errScreenshotSessionStopped})
		return true
	}

	if req.attempts == 0 {
		req.firstAttempt = now
		// Give a static screen something to deliver.
		forceDesktopRepaint()
	}
	req.attempts++
	img, err := cap.Capture()
	switch {
	case err != nil:
		s.finishScreenshot(req, screenshotResult{err: err})
	case img != nil:
		w, h := screenshotBounds(cap, img)
		s.finishScreenshot(req, screenshotResult{img: img, w: w, h: h, displayIndex: displayIndex})
	case req.attempts >= screenshotMaxAttempts || time.Since(req.firstAttempt) >= screenshotNoFrameBudget:
		s.finishScreenshot(req, screenshotResult{err: noFrameError(cap, req.attempts)})
	default:
		// Still waiting for a frame; the repaint below may produce one.
	}
	// The screenshot consumed whatever frame the capturer had, so the stream
	// never encoded it. Repaint so the stream gets a current frame too (the
	// GPU and CPU paths both read the whole desktop, so any frame catches up).
	forceDesktopRepaint()
	return true
}

// finishScreenshot answers req and logs the outcome: a failure at warn (one
// line per failed tool call), a success at debug.
func (s *Session) finishScreenshot(req *screenshotRequest, res screenshotResult) {
	elapsed := time.Since(req.firstAttempt).Round(time.Millisecond)
	if req.firstAttempt.IsZero() {
		elapsed = 0
	}
	if res.err != nil {
		slog.Warn("Capture loop could not serve the screenshot request",
			"session", s.id, "attempts", req.attempts, "elapsed", elapsed, "error", res.err.Error())
	} else {
		slog.Debug("Capture loop served the screenshot request",
			"session", s.id, "attempts", req.attempts, "elapsed", elapsed)
	}
	s.screenshots.finish(req, res)
}

func screenshotBounds(cap ScreenCapturer, img *image.RGBA) (int, int) {
	w, h, err := cap.GetScreenBounds()
	if err != nil {
		return img.Bounds().Dx(), img.Bounds().Dy()
	}
	return w, h
}

// noFrameError names the last failure the capturer swallowed as a nil frame
// (GDI on a secure desktop, for example), when there is one.
func noFrameError(cap ScreenCapturer, attempts int) error {
	if reason := swallowedCaptureError(cap); reason != "" {
		return fmt.Errorf("%w after %d attempts: %s", errScreenshotNoFrame, attempts, reason)
	}
	return fmt.Errorf("%w after %d attempts", errScreenshotNoFrame, attempts)
}

// captureScreenshotFromLoop serves CaptureScreenshot for capturers that are
// not a LatestFrameProvider. sessionDisplay is the display the session was on
// when it was chosen.
func (s *Session) captureScreenshotFromLoop(sessionDisplay int) (*image.RGBA, int, int, error) {
	res := s.requestScreenshot()
	if res.err != nil {
		if errors.Is(res.err, ErrNoActiveSession) {
			// A capturer can report its own lost connection as
			// ErrNoActiveSession (the Linux X11 capturer does). The session
			// is still live, so do not let the tools layer read it as "no
			// session" and open a standalone capturer.
			return nil, 0, 0, fmt.Errorf("capture from active session: %v", res.err)
		}
		return nil, 0, 0, fmt.Errorf("capture from active session: %w", res.err)
	}
	if res.displayIndex != sessionDisplay {
		// A monitor switch landed between choosing this session and the
		// loop serving the request.
		slog.Warn("CaptureScreenshot: session switched display before the capture",
			"sessionDisplay", sessionDisplay, "capturedDisplay", res.displayIndex)
	}
	return res.img, res.w, res.h, nil
}
