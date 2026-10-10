package desktop

import (
	"errors"
	"log/slog"
	"sync"
	"time"
)

var (
	errInputClosed = errors.New("input handler closed")
	errInputReset  = errors.New("input discarded by a release")
)

const (
	safeInputQueueDepth   = 64
	safeInputCloseTimeout = 2 * time.Second
)

// SafeInput wraps a platform InputHandler so that one worker goroutine owns
// every injection for a session (spec §2):
//
//   - Windows binds SendInput to the thread's desktop. The platform handler
//     calls LockOSThread/SetThreadDesktop on whichever goroutine first injects,
//     and pion delivers each data channel's messages on its own goroutine, so
//     input, pasted text and offsets used to land on different threads (M5).
//   - The macOS handler's drag state has no lock; one goroutine needs none.
//   - It records what is held and releases it all on ReleaseAll/Close, so a
//     viewer that vanishes mid-chord cannot leave Shift down on the customer's
//     machine (K3).
//
// Discrete events are synchronous: HandleEvent returns the platform handler's
// error, as before. mouse_move is fire-and-forget and coalesced: only the
// newest pending move is injected, after every discrete event sent before it.
type SafeInput struct {
	inner InputHandler
	label string

	jobs   chan safeInputJob
	urgent chan safeInputJob
	wake   chan struct{}
	done   chan struct{}
	exited chan struct{}

	closeOnce    sync.Once
	closeTimeout time.Duration

	moveMu      sync.Mutex
	pendingMove *InputEvent

	held *heldInput // worker goroutine only
}

type safeInputJob struct {
	run    func() error
	result chan error // buffered(1); nil for fire-and-forget
}

var _ InputHandler = (*SafeInput)(nil)

func NewSafeInput(inner InputHandler, label string) *SafeInput {
	s := &SafeInput{
		inner:        inner,
		label:        label,
		jobs:         make(chan safeInputJob, safeInputQueueDepth),
		urgent:       make(chan safeInputJob, 4),
		wake:         make(chan struct{}, 1),
		done:         make(chan struct{}),
		exited:       make(chan struct{}),
		closeTimeout: safeInputCloseTimeout,
		held:         newHeldInput(),
	}
	go s.loop()
	return s
}

func (s *SafeInput) loop() {
	defer close(s.exited)
	for {
		// Releases and other urgent work never wait behind queued input.
		select {
		case j := <-s.urgent:
			s.run(j)
			continue
		default:
		}
		select {
		case <-s.done:
			s.failQueued(errInputClosed)
			return
		case j := <-s.urgent:
			s.run(j)
		case j := <-s.jobs:
			s.run(j)
		case <-s.wake:
			// Every queued discrete job is older than the pending move: a
			// discrete submit flushes the move slot into the queue first.
			s.runQueued()
			if mv := s.takeMove(); mv != nil {
				if err := s.inject(*mv); err != nil {
					slog.Debug("Mouse move injection failed", "session", s.label, "error", err.Error())
				}
			}
		}
	}
}

func (s *SafeInput) run(j safeInputJob) {
	err := j.run()
	if j.result != nil {
		j.result <- err
	}
}

func (s *SafeInput) runQueued() {
	for {
		// A release that arrives mid-drain goes first, and discards the rest.
		select {
		case j := <-s.urgent:
			s.run(j)
			continue
		default:
		}
		select {
		case j := <-s.jobs:
			s.run(j)
		default:
			return
		}
	}
}

// failQueued answers every queued job with err without running it.
func (s *SafeInput) failQueued(err error) {
	for {
		select {
		case j := <-s.jobs:
			if j.result != nil {
				j.result <- err
			}
		case j := <-s.urgent:
			if j.result != nil {
				j.result <- err
			}
		default:
			return
		}
	}
}

func (s *SafeInput) inject(ev InputEvent) error {
	ev = s.held.prepare(ev)
	err := s.inner.HandleEvent(ev)
	s.held.observe(ev, err)
	return err
}

func (s *SafeInput) takeMove() *InputEvent {
	s.moveMu.Lock()
	defer s.moveMu.Unlock()
	mv := s.pendingMove
	s.pendingMove = nil
	return mv
}

var errInputWorkerUnresponsive = errors.New("input worker did not respond")

// submit queues run and waits for its result. timeout bounds the whole call,
// queueing included: a wedged worker can leave a bounded queue full, and a
// release or Close must never wait on it forever. timeout 0 waits as long as
// the worker lives.
func (s *SafeInput) submit(urgent bool, timeout time.Duration, run func() error) error {
	select {
	case <-s.done:
		return errInputClosed
	default:
	}
	var expire <-chan time.Time
	if timeout > 0 {
		t := time.NewTimer(timeout)
		defer t.Stop()
		expire = t.C
	}
	job := safeInputJob{run: run, result: make(chan error, 1)}
	q := s.jobs
	if urgent {
		q = s.urgent
	} else if mv := s.takeMove(); mv != nil {
		// Keep pointer motion that arrived before this event ahead of it.
		move := *mv
		if err := s.enqueue(q, safeInputJob{run: func() error { return s.inject(move) }}, expire); err != nil {
			return err
		}
	}
	if err := s.enqueue(q, job, expire); err != nil {
		return err
	}
	select {
	case err := <-job.result:
		return err
	case <-s.exited:
		return errInputClosed
	case <-expire:
		return errInputWorkerUnresponsive
	}
}

func (s *SafeInput) enqueue(q chan safeInputJob, j safeInputJob, expire <-chan time.Time) error {
	select {
	case q <- j:
		return nil
	case <-s.done:
		return errInputClosed
	case <-expire:
		return errInputWorkerUnresponsive
	}
}

// sync waits until every job submitted so far, and any pending move, has run.
// Tests use it to observe asynchronous moves.
func (s *SafeInput) sync() { _ = s.submit(false, 0, func() error { return nil }) }

// HandleEvent injects ev on the worker. Discrete events wait for the platform
// handler and return its error; mouse_move returns immediately.
func (s *SafeInput) HandleEvent(ev InputEvent) error {
	if ev.Type == "mouse_move" {
		select {
		case <-s.done:
			return errInputClosed
		default:
		}
		s.moveMu.Lock()
		s.pendingMove = &ev
		s.moveMu.Unlock()
		select {
		case s.wake <- struct{}{}:
		default:
		}
		return nil
	}
	return s.submit(false, 0, func() error { return s.inject(ev) })
}

// ReleaseAll releases every key and button the agent holds on the remote and
// discards input queued before it, which would otherwise press keys again
// right after they were released. Safe to call at any time, including after
// Close; it never blocks longer than the close timeout.
func (s *SafeInput) ReleaseAll(reason string) {
	err := s.submit(true, s.closeTimeout, func() error {
		s.discardQueued()
		s.takeMove()
		releases := s.held.releases()
		failed := 0
		for _, ev := range releases {
			if err := s.inner.HandleEvent(ev); err != nil {
				// A release that did not land may leave a key down on the
				// customer's machine: the failure this worker exists to prevent.
				failed++
				slog.Warn("Release injection failed", "session", s.label, "type", ev.Type, "key", ev.Key, "button", ev.Button, "error", err.Error())
			}
		}
		if len(releases) > 0 {
			slog.Info("Released held remote input", "session", s.label, "reason", reason, "count", len(releases)-failed, "failed", failed)
		}
		return nil
	})
	if err != nil && !errors.Is(err, errInputClosed) {
		slog.Warn("Releasing held remote input failed", "session", s.label, "reason", reason, "error", err.Error())
	}
}

func (s *SafeInput) discardQueued() {
	for {
		select {
		case j := <-s.jobs:
			if j.result != nil {
				j.result <- errInputReset
			}
		default:
			return
		}
	}
}

// InjectText types text on the worker, so it never interleaves with keys.
func (s *SafeInput) InjectText(text string) error {
	return s.submit(false, 0, func() error { return InjectText(s.inner, text) })
}

// Close releases everything held and stops the worker. Idempotent, and
// bounded by twice the close timeout (release, then worker exit) even if the
// platform handler is wedged; a release that timed out still runs when the
// handler returns.
func (s *SafeInput) Close() {
	s.closeOnce.Do(func() {
		s.ReleaseAll("closed")
		close(s.done)
		select {
		case <-s.exited:
		case <-time.After(s.closeTimeout):
			slog.Warn("Input worker did not exit", "session", s.label)
		}
	})
}

// SetDisplayOffset goes straight to the platform handler, which guards its
// offset with its own lock, rather than through the worker. Its callers include
// the capture goroutine on a desktop switch, and session teardown waits for
// that goroutine: queueing behind a wedged worker would hang Stop for good.
// Ordering against input is kept where it matters by releasing held input
// first (monitor and desktop switch both do).
func (s *SafeInput) SetDisplayOffset(x, y int) {
	s.inner.SetDisplayOffset(x, y)
}

func (s *SafeInput) SetAtLoginWindow(atLoginWindow bool) {
	_ = s.submit(true, s.closeTimeout, func() error { s.inner.SetAtLoginWindow(atLoginWindow); return nil })
}

func (s *SafeInput) InputAvailable() bool { return s.inner.InputAvailable() }

func (s *SafeInput) SendMouseMove(x, y int) error {
	return s.HandleEvent(InputEvent{Type: "mouse_move", X: x, Y: y})
}
func (s *SafeInput) SendMouseClick(x, y int, button string) error {
	return s.HandleEvent(InputEvent{Type: "mouse_click", X: x, Y: y, Button: button})
}
func (s *SafeInput) SendMouseDown(x, y int, button string) error {
	return s.HandleEvent(InputEvent{Type: "mouse_down", X: x, Y: y, Button: button})
}
func (s *SafeInput) SendMouseUp(x, y int, button string) error {
	return s.HandleEvent(InputEvent{Type: "mouse_up", X: x, Y: y, Button: button})
}
func (s *SafeInput) SendMouseScroll(x, y int, delta int) error {
	return s.HandleEvent(InputEvent{Type: "mouse_scroll", X: x, Y: y, Delta: delta})
}
func (s *SafeInput) SendKeyPress(key string, modifiers []string) error {
	return s.HandleEvent(InputEvent{Type: "key_press", Key: key, Modifiers: modifiers})
}
func (s *SafeInput) SendKeyDown(key string) error {
	return s.HandleEvent(InputEvent{Type: "key_down", Key: key})
}
func (s *SafeInput) SendKeyUp(key string) error {
	return s.HandleEvent(InputEvent{Type: "key_up", Key: key})
}
