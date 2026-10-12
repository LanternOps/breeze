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

	errInputDropped = errors.New("input dropped by the ordering layer")
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

	// orderMu guards order. The worker judges events under it; Task 4's resets
	// bump the epochs under it from the trigger's own goroutine. Lock order:
	// moveMu, then orderMu. Never held while injecting or waiting.
	orderMu sync.Mutex
	order   *inputOrder
	drops   map[string]uint64 // worker goroutine only; keyed by drop reason
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
		order:        newInputOrder(),
		drops:        map[string]uint64{},
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
			// A legacy pending move is older than every queued discrete job,
			// because a legacy submit flushes the move slot into the queue first.
			// A sequenced move is injected only once its barrier is met.
			s.runQueued()
			s.flushMove()
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

// takeLegacyMove takes the pending move only if it is unsequenced. A sequenced
// move is ordered by its seq/after on the worker, never by arrival.
func (s *SafeInput) takeLegacyMove() *InputEvent {
	s.moveMu.Lock()
	defer s.moveMu.Unlock()
	mv := s.pendingMove
	if mv == nil || mv.Seq != 0 {
		return nil
	}
	s.pendingMove = nil
	return mv
}

// offerMove puts ev in the one-move slot. A newer move replaces an older one
// (coalescing). A sequenced move older than the one already held is ignored.
func (s *SafeInput) offerMove(ev InputEvent) {
	s.moveMu.Lock()
	defer s.moveMu.Unlock()
	if ev.Seq > 0 && s.pendingMove != nil && s.pendingMove.Seq >= ev.Seq {
		return
	}
	s.pendingMove = &ev
}

// flushMove injects the pending move if it is ready, drops it if stale, and
// leaves it in the slot while it waits for its barrier. Worker goroutine only.
func (s *SafeInput) flushMove() {
	s.moveMu.Lock()
	mv := s.pendingMove
	if mv == nil {
		s.moveMu.Unlock()
		return
	}
	verdict, reason := s.judgeMove(*mv)
	if verdict == moveWait {
		s.moveMu.Unlock()
		return
	}
	s.pendingMove = nil
	s.moveMu.Unlock()
	if verdict == moveStale {
		s.noteDrop(reason)
		return
	}
	if err := s.inject(*mv); err != nil {
		slog.Debug("Mouse move injection failed", "session", s.label, "error", err.Error())
	}
}

// noteDrop counts an event the ordering layer dropped. Worker goroutine only.
func (s *SafeInput) noteDrop(reason string) {
	s.drops[reason]++
	slog.Debug("Dropped input event", "session", s.label, "reason", reason)
}

// droppedCount reports how many events were dropped for reason. For tests.
func (s *SafeInput) droppedCount(reason string) uint64 {
	var n uint64
	_ = s.submit(false, 0, func() error { n = s.drops[reason]; return nil })
	return n
}

func (s *SafeInput) judgeDiscrete(ev InputEvent) (orderVerdict, string) {
	s.orderMu.Lock()
	defer s.orderMu.Unlock()
	return s.order.discrete(ev)
}

func (s *SafeInput) judgeMove(ev InputEvent) (moveVerdict, string) {
	s.orderMu.Lock()
	defer s.orderMu.Unlock()
	return s.order.move(ev)
}

func (s *SafeInput) skipOrder(seq uint64) {
	s.orderMu.Lock()
	defer s.orderMu.Unlock()
	s.order.skip(seq)
}

var errInputWorkerUnresponsive = errors.New("input worker did not respond")

// submit queues run and waits for its result. timeout bounds the whole call,
// queueing included: a wedged worker can leave a bounded queue full, and a
// release or Close must never wait on it forever. timeout 0 waits as long as
// the worker lives.
func (s *SafeInput) submit(urgent bool, timeout time.Duration, run func() error) error {
	return s.submitJob(urgent, !urgent, timeout, run)
}

// submitJob is submit with explicit control of the move flush.
// flushLegacyMove keeps an unsequenced move that arrived before this job ahead
// of it (one ordered channel: arrival order is send order).
func (s *SafeInput) submitJob(urgent, flushLegacyMove bool, timeout time.Duration, run func() error) error {
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
	} else if flushLegacyMove {
		if mv := s.takeLegacyMove(); mv != nil {
			move := *mv
			if err := s.enqueue(q, safeInputJob{run: func() error { s.injectMoveNow(move); return nil }}, expire); err != nil {
				return err
			}
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

// injectMoveNow injects a move taken out of the slot, if the ordering layer
// still allows it. Worker goroutine only.
func (s *SafeInput) injectMoveNow(mv InputEvent) {
	verdict, reason := s.judgeMove(mv)
	if verdict != moveReady {
		s.noteDrop(reason)
		return
	}
	if err := s.inject(mv); err != nil {
		slog.Debug("Mouse move injection failed", "session", s.label, "error", err.Error())
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
func (s *SafeInput) sync() {
	_ = s.submit(false, 0, func() error { s.flushMove(); return nil })
}

// HandleEvent injects ev on the worker. Discrete events wait for the platform
// handler and return its error (errInputDropped when the ordering layer
// refused them); mouse_move returns immediately.
func (s *SafeInput) HandleEvent(ev InputEvent) error {
	if ev.Type == "mouse_move" {
		select {
		case <-s.done:
			return errInputClosed
		default:
		}
		s.offerMove(ev)
		select {
		case s.wake <- struct{}{}:
		default:
		}
		return nil
	}
	if ev.Seq == 0 {
		return s.submit(false, 0, func() error { return s.injectDiscrete(ev) })
	}
	return s.submitJob(false, false, 0, func() error { return s.injectDiscrete(ev) })
}

// injectDiscrete runs a discrete event through the ordering layer. A sequenced
// event flushes the move slot before and after it: before, a move whose barrier
// is the previous discrete event (sent before ev); after, a move that was
// waiting for ev itself. Legacy events never flush here: on one ordered
// channel, a move still in the slot arrived (and was sent) after them.
func (s *SafeInput) injectDiscrete(ev InputEvent) error {
	sequenced := ev.Seq > 0
	if sequenced {
		s.flushMove()
	}
	err := s.applyDiscrete(ev)
	if sequenced {
		s.flushMove()
	}
	return err
}

func (s *SafeInput) applyDiscrete(ev InputEvent) error {
	verdict, reason := s.judgeDiscrete(ev)
	switch verdict {
	case orderAcceptReset:
		s.releaseHeld("input_reset")
		return nil
	case orderDrop:
		s.noteDrop(reason)
		return errInputDropped
	}
	return s.inject(ev)
}

// SkipSeq moves the ordering barrier past a discrete seq that was rejected
// before it reached the worker (malformed, failed validation, wrong channel),
// in order with the jobs queued before it. Without this, a move that depends
// on the rejected event waits until the next key or click.
func (s *SafeInput) SkipSeq(seq uint64) {
	_ = s.submitJob(false, false, 0, func() error {
		s.flushMove()
		s.skipOrder(seq)
		s.flushMove()
		return nil
	})
}

// ReleaseAll releases every key and button the agent holds on the remote and
// discards input queued before it, which would otherwise press keys again
// right after they were released. Safe to call at any time, including after
// Close; it never blocks longer than the close timeout.
func (s *SafeInput) ReleaseAll(reason string) {
	err := s.submit(true, s.closeTimeout, func() error {
		s.discardQueued()
		s.takeMove()
		s.releaseHeld(reason)
		return nil
	})
	if err != nil && !errors.Is(err, errInputClosed) {
		slog.Warn("Releasing held remote input failed", "session", s.label, "reason", reason, "error", err.Error())
	}
}

// releaseHeld injects a release for everything held. Worker goroutine only.
func (s *SafeInput) releaseHeld(reason string) {
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
