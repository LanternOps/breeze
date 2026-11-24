package desktop

import (
	"fmt"
	"log/slog"
	"runtime"
	"sort"
	"strings"
	"sync"
	"time"
)

// Bounded session teardown (#12624).
//
// Stop waits for the session's goroutines before it releases the encoder and
// the capturer, because those are COM objects the capture loop may be inside.
// That wait used to have no bound: a loop stuck in a driver call kept the stop
// from ever returning, so the API never heard that the session ended. Now the
// wait is bounded. When it expires the session is stopped in every way that
// does not touch the capture pipeline, and the pipeline is left to whichever
// goroutine is stuck in it: releasing COM objects under a running call, or
// taking the capturer's mutex a stuck call may hold, is exactly what must not
// happen. If the stuck goroutine does return, the pipeline is released then.

// Bounds on the two halves of a stop. Vars so tests can shrink them. Together
// they must stay under the shortest desktop_stop IPC wait (5s, the macOS
// handoff; the service waits 10s), or the stop is reported as failed anyway.
var (
	sessionLoopExitBound = 3 * time.Second
	sessionCleanupBound  = 1500 * time.Millisecond
)

// loopTracker names the session goroutines that are still running.
type loopTracker struct {
	mu      sync.Mutex
	next    int
	running map[int]trackedLoop
}

type trackedLoop struct {
	name string
	goid uint64
}

func (t *loopTracker) enter(name string) int {
	id := currentGoroutineID()
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.running == nil {
		t.running = make(map[int]trackedLoop)
	}
	t.next++
	t.running[t.next] = trackedLoop{name: name, goid: id}
	return t.next
}

func (t *loopTracker) exit(token int) {
	t.mu.Lock()
	defer t.mu.Unlock()
	delete(t.running, token)
}

// describe names each running loop and the call it is in.
func (t *loopTracker) describe() string {
	t.mu.Lock()
	loops := make([]trackedLoop, 0, len(t.running))
	for _, l := range t.running {
		loops = append(loops, l)
	}
	t.mu.Unlock()
	if len(loops) == 0 {
		return "unknown"
	}
	dump := allGoroutineStacks()
	parts := make([]string, 0, len(loops))
	for _, l := range loops {
		if stage := goroutineStage(dump, l.goid); stage != "" {
			parts = append(parts, fmt.Sprintf("%s [%s]", l.name, stage))
		} else {
			parts = append(parts, l.name)
		}
	}
	sort.Strings(parts)
	return strings.Join(parts, "; ")
}

// runLoop runs fn as one of the session's goroutines: stop waits for it, and
// names it if it does not exit.
func (s *Session) runLoop(name string, fn func()) {
	s.wg.Add(1)
	go func() {
		defer s.wg.Done()
		token := s.loops.enter(name)
		defer s.loops.exit(token)
		fn()
	}()
}

// setCleanupStage records what cleanup is doing, for the stuck-cleanup Warn.
func (s *Session) setCleanupStage(stage string) { s.cleanupStage.Store(&stage) }

func (s *Session) currentCleanupStage() string {
	if p := s.cleanupStage.Load(); p != nil {
		return *p
	}
	return "unknown"
}

// teardown waits for the session's goroutines and releases what it holds, in
// bounded time. Called once, from StopWithReason.
func (s *Session) teardown() {
	health := captureHealth
	health.beginTeardown()
	defer health.endTeardown()

	loopsDone := make(chan struct{})
	go func() {
		s.wg.Wait()
		close(loopsDone)
	}()
	// Close the peer connection early to unblock any RTCP reads. Off this
	// goroutine: pion waits for its callbacks, and one may be waiting on the
	// goroutine that is stuck.
	peerDone := make(chan struct{})
	go func() {
		defer close(peerDone)
		if s.peerConn != nil {
			_ = s.peerConn.Close()
		}
	}()

	timer := time.NewTimer(sessionLoopExitBound)
	defer timer.Stop()
	for _, done := range []<-chan struct{}{peerDone, loopsDone} {
		select {
		case <-done:
		case <-timer.C:
			timer.Reset(0)
		}
	}

	if isClosed(loopsDone) {
		if !isClosed(peerDone) {
			slog.Warn("Desktop session stop: peer connection close is stuck; continuing",
				"session", s.id, "waited", sessionLoopExitBound.String())
		}
		s.cleanupBounded(health, true)
		return
	}

	stuck := s.loops.describe()
	slog.Warn("Desktop session stop timed out; abandoning its capture pipeline",
		"session", s.id, "stuck", stuck, "waited", sessionLoopExitBound.String())
	health.noteAbandoned(s, stuck)
	s.cleanupBounded(health, false)
	go func() {
		<-loopsDone
		s.releasePipeline()
		health.clearAbandoned(s)
		slog.Info("Stuck desktop session loop exited; its capture pipeline is released", "session", s.id)
	}()
}

// cleanupBounded runs doCleanup off this goroutine and waits at most
// sessionCleanupBound for it. A cleanup that is stuck before the pipeline is
// released leaves the process holding it.
func (s *Session) cleanupBounded(health *captureProcessHealth, releasePipeline bool) {
	done := make(chan struct{})
	go func() {
		defer close(done)
		defer func() {
			if r := recover(); r != nil {
				buf := make([]byte, 4096)
				n := runtime.Stack(buf, false)
				slog.Error("desktop session cleanup panic", "session", s.id, "stage", s.currentCleanupStage(),
					"panic", fmt.Sprintf("%v", r), "stack", string(buf[:n]))
			}
		}()
		s.cleanup(releasePipeline)
	}()

	timer := time.NewTimer(sessionCleanupBound)
	defer timer.Stop()
	select {
	case <-done:
		if releasePipeline && !s.pipelineReleased.Load() {
			// Cleanup panicked part-way: what it left held is unknown.
			health.noteAbandoned(s, "cleanup: "+s.currentCleanupStage())
		}
		return
	case <-timer.C:
	}

	stage := s.currentCleanupStage()
	slog.Warn("Desktop session cleanup is stuck; reporting the session stopped without it",
		"session", s.id, "stuck", stage, "waited", sessionCleanupBound.String())
	if !releasePipeline || s.pipelineReleased.Load() {
		return
	}
	health.noteAbandoned(s, "cleanup: "+stage)
	go func() {
		<-done
		if s.pipelineReleased.Load() {
			health.clearAbandoned(s)
			slog.Info("Stuck desktop session cleanup finished; its capture pipeline is released", "session", s.id)
		}
	}()
}

func isClosed(ch <-chan struct{}) bool {
	select {
	case <-ch:
		return true
	default:
		return false
	}
}

// releasePipeline closes the encoder, every capturer and the backend session.
// Only when no goroutine of the session can still be inside them.
func (s *Session) releasePipeline() {
	s.pipelineOnce.Do(func() {
		s.setCleanupStage("close encoder")
		if enc := s.encoder.Load(); enc != nil {
			enc.Close()
		}
		s.mu.Lock()
		s.captureClosed = true
		old, current := s.oldCapturers, s.capturer
		s.oldCapturers = nil
		s.mu.Unlock()
		s.setCleanupStage("close capturer")
		for _, oc := range old {
			oc.Close()
		}
		if current != nil {
			current.Close()
		}
		// The backend session owns the capturer and the input sink; it is
		// released after both are done with.
		s.setCleanupStage("close capture session")
		if s.backend != nil {
			if err := s.backend.Close(); err != nil {
				slog.Warn("Failed to close the capture session", "session", s.id, "error", err.Error())
			}
		}
		s.pipelineReleased.Store(true)
	})
}

// installCapturer gives a starting session its capturer. If the session was
// stopped while the capturer was being opened, nothing would ever close it:
// it is closed here and false is returned.
func (s *Session) installCapturer(c ScreenCapturer) bool {
	s.mu.Lock()
	closed := s.captureClosed
	if !closed {
		s.capturer = c
	}
	s.mu.Unlock()
	if closed {
		_ = c.Close()
	}
	return !closed
}

// swapCapturer moves the session to a capturer for another display. The old
// one is NOT closed here: the capture loop closes it after detecting the swap,
// so Close never runs while a frame is in flight on it. If the session was
// stopped meanwhile the new capturer is closed and false is returned.
func (s *Session) swapCapturer(c ScreenCapturer, display int, cfg CaptureConfig) bool {
	s.mu.Lock()
	closed := s.captureClosed
	if !closed {
		s.oldCapturers = append(s.oldCapturers, s.capturer)
		s.capturer = c
		s.displayIndex = display
		s.captureConfig = cfg
	}
	s.mu.Unlock()
	if closed {
		_ = c.Close()
	}
	return !closed
}
