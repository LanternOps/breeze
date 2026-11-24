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
// with a bound.

// screenshotRequestTimeout bounds how long CaptureScreenshot waits for the
// capture loop. Generous next to a normal answer (one or two loop iterations),
// because the loop can sit in a recovery sleep or a slow encode first. A var
// so tests can shorten it.
var screenshotRequestTimeout = 3 * time.Second

// screenshotMaxAttempts is how many capture-loop iterations try for a frame
// before the request fails with errScreenshotNoFrame. A static screen gives no
// DXGI frame until the repaint that each attempt triggers lands.
const screenshotMaxAttempts = 10

var (
	// None of these wrap ErrNoActiveSession: the session is still live (or
	// still tearing down), so the tools layer must not fall back to a
	// standalone capturer.
	errScreenshotTimeout        = errors.New("timed out waiting for the desktop session's capture loop")
	errScreenshotSessionStopped = errors.New("desktop session stopped before the screenshot was captured")
	errScreenshotLoopNotRunning = errors.New("desktop session is not capturing yet")
	errScreenshotNoFrame        = errors.New("desktop session produced no frame for the screenshot")
)

// screenshotRequest is one pending one-shot capture. reply has capacity 1 and
// is answered exactly once, by whoever removes the request from the queue, so
// the answer never blocks and nothing ever closes the channel.
type screenshotRequest struct {
	reply    chan screenshotResult
	deadline time.Time
	// attempts is touched only by the capture loop goroutine.
	attempts int
}

type screenshotResult struct {
	img          *image.RGBA
	w, h         int
	displayIndex int
	err          error
}

// screenshotQueue holds the requests the capture loop has yet to answer. Its
// zero value is ready to use. mu also orders the loop's start/exit against
// enqueueing, so a request is never left behind by a loop that has exited.
type screenshotQueue struct {
	mu          sync.Mutex
	loopRunning bool
	pending     []*screenshotRequest
}

// enqueue adds req, or reports that no capture loop is running to serve it.
func (q *screenshotQueue) enqueue(req *screenshotRequest) error {
	q.mu.Lock()
	defer q.mu.Unlock()
	if !q.loopRunning {
		return errScreenshotLoopNotRunning
	}
	q.pending = append(q.pending, req)
	return nil
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

// setLoopRunning marks the capture loop started or stopped. Stopping fails
// every pending request, so no caller waits out its timeout on a loop that
// will never answer.
func (q *screenshotQueue) setLoopRunning(running bool) {
	q.mu.Lock()
	defer q.mu.Unlock()
	q.loopRunning = running
	if running {
		return
	}
	for _, req := range q.pending {
		req.reply <- screenshotResult{err: errScreenshotSessionStopped}
	}
	q.pending = nil
}

// requestScreenshot asks the capture loop for one frame and waits for it.
func (s *Session) requestScreenshot() (screenshotResult, error) {
	req := &screenshotRequest{
		reply:    make(chan screenshotResult, 1),
		deadline: time.Now().Add(screenshotRequestTimeout),
	}
	if err := s.screenshots.enqueue(req); err != nil {
		return screenshotResult{}, err
	}
	timer := time.NewTimer(screenshotRequestTimeout)
	defer timer.Stop()
	select {
	case res := <-req.reply:
		return res, res.err
	case <-s.done:
		// The loop may have answered in the same instant; prefer the frame.
		select {
		case res := <-req.reply:
			return res, res.err
		default:
		}
		return screenshotResult{}, errScreenshotSessionStopped
	case <-timer.C:
		// The loop drops the request once it sees the deadline has passed.
		return screenshotResult{}, errScreenshotTimeout
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
	req := s.screenshots.head(time.Now())
	if req == nil {
		return false
	}

	s.mu.RLock()
	cap := s.capturer
	displayIndex := s.displayIndex
	s.mu.RUnlock()
	if cap == nil {
		s.screenshots.finish(req, screenshotResult{err: errScreenshotSessionStopped})
		return true
	}

	if req.attempts == 0 {
		// Give a static screen something to deliver.
		forceDesktopRepaint()
	}
	req.attempts++
	img, err := cap.Capture()
	switch {
	case err != nil:
		s.screenshots.finish(req, screenshotResult{err: err})
	case img != nil:
		w, h, boundsErr := cap.GetScreenBounds()
		if boundsErr != nil {
			w, h = img.Bounds().Dx(), img.Bounds().Dy()
		}
		s.screenshots.finish(req, screenshotResult{img: img, w: w, h: h, displayIndex: displayIndex})
	case req.attempts >= screenshotMaxAttempts:
		s.screenshots.finish(req, screenshotResult{err: errScreenshotNoFrame})
	default:
		// Still waiting for a frame; the repaint below may produce one.
	}
	// The screenshot consumed whatever frame the capturer had, so the stream
	// never encoded it. Repaint so the stream gets a current frame too (the
	// GPU and CPU paths both read the whole desktop, so any frame catches up).
	forceDesktopRepaint()
	return true
}

// captureScreenshotFromLoop serves CaptureScreenshot for capturers that are
// not a LatestFrameProvider: the capture loop takes the frame.
// sessionDisplay is the display the session was on when it was chosen.
func (s *Session) captureScreenshotFromLoop(sessionDisplay int) (*image.RGBA, int, int, error) {
	res, err := s.requestScreenshot()
	if err != nil {
		return nil, 0, 0, fmt.Errorf("capture from active session: %w", err)
	}
	if res.displayIndex != sessionDisplay {
		// A monitor switch landed between choosing this session and the
		// loop serving the request.
		slog.Warn("CaptureScreenshot: session switched display before the capture",
			"sessionDisplay", sessionDisplay, "capturedDisplay", res.displayIndex)
	}
	return res.img, res.w, res.h, nil
}
