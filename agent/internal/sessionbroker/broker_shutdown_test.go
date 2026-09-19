// Shutdown must never depend on a listener's Close() returning.
//
// Untagged on purpose. The bug these tests pin is a Windows named-pipe
// deadlock, but a windows-tagged test would only ever run in the single
// `Test Agent (Windows)` CI job — which is exactly where it manifested as a
// ten-minute hang rather than a failure. Driving it through the net.Listener
// interface reproduces the shape on every platform, in the ordinary test-agent
// job, in milliseconds.
package sessionbroker

import (
	"context"
	"errors"
	"net"
	"sync"
	"testing"
	"time"
)

// stalledCloseListener is a listener whose Close() never returns until the test
// releases it. That is not a hypothetical: go-winio v0.6.2's
// (*win32PipeListener).Close blocks on l.doneCh, which its listenerRoutine only
// closes when a makeConnectedServerPipe call reports ErrPipeListenerClosed.
// makeConnectedServerPipe's close branch rewrites only nil and ErrFileClosed
// into that sentinel, so a connect that was already failing for its own reason
// when Close() cancelled it (ERROR_NO_DATA from a client that dialled and hung
// up — precisely what TestNamedPipeListenAndAccept does) leaks its own errno
// through. listenerRoutine then leaves `closed` false, loops back to its select,
// and waits for a second closeCh token that Close() will never send.
type stalledCloseListener struct {
	closeCalls  chan struct{}
	releaseOnce sync.Once
	released    chan struct{}
}

func newStalledCloseListener() *stalledCloseListener {
	return &stalledCloseListener{
		closeCalls: make(chan struct{}, 1),
		released:   make(chan struct{}),
	}
}

func (l *stalledCloseListener) Accept() (net.Conn, error) {
	<-l.released
	return nil, net.ErrClosed
}

func (l *stalledCloseListener) Close() error {
	select {
	case l.closeCalls <- struct{}{}:
	default:
	}
	<-l.released
	return nil
}

func (l *stalledCloseListener) Addr() net.Addr { return &net.UnixAddr{Name: "stalled", Net: "unix"} }

// release unblocks Close and Accept so the abandoned goroutine can exit before
// the test binary does.
func (l *stalledCloseListener) release() { l.releaseOnce.Do(func() { close(l.released) }) }

// TestStopAcceptingAndWaitAbandonsAStalledListenerClose is the regression test
// for the ten-minute Windows CI hang: the whole `Test Agent (Windows)` job died
// on `panic: test timed out after 10m0s / running tests:
// TestNamedPipeListenAndAccept (9m59s)`, with the test goroutine parked in
// win32PipeListener.Close and the listener routine parked in its own select.
// Before the fix this test does not fail — it hangs, which is the point.
func TestStopAcceptingAndWaitAbandonsAStalledListenerClose(t *testing.T) {
	b := New("stalled-close-"+t.Name(), nil)
	listener := newStalledCloseListener()
	t.Cleanup(listener.release)
	if !b.publishListener(listener) {
		t.Fatal("publishListener refused a listener on a fresh broker")
	}

	ctx, cancel := context.WithTimeout(context.Background(), 150*time.Millisecond)
	defer cancel()

	done := make(chan error, 1)
	go func() { done <- b.StopAcceptingAndWait(ctx) }()

	select {
	case err := <-done:
		if !errors.Is(err, ErrListenerCloseStalled) {
			t.Fatalf("StopAcceptingAndWait error = %v, want %v", err, ErrListenerCloseStalled)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("StopAcceptingAndWait never returned: a listener whose Close() does not return wedges broker shutdown forever")
	}

	// The listener really was asked to close — the test would pass vacuously if
	// the fix had simply stopped calling Close at all.
	select {
	case <-listener.closeCalls:
	default:
		t.Error("the stalled listener's Close() was never called")
	}

	// Abandoning the close must not weaken the guarantee the method exists for:
	// nothing new may be admitted afterwards.
	if b.publishListener(newCloseTrackingListener()) {
		t.Error("a listener was published after acceptance stopped")
	}
	if got := b.currentListener(); got != nil {
		t.Errorf("current listener = %T, want nil", got)
	}
}

// TestCloseReturnsDespiteAStalledListenerClose is the same defect one level up,
// where CI actually hit it: Broker.Close's own 5s context has to be enough to
// get the whole shutdown past a wedged listener.
func TestCloseReturnsDespiteAStalledListenerClose(t *testing.T) {
	b := New("stalled-close-broker-"+t.Name(), nil)
	listener := newStalledCloseListener()
	t.Cleanup(listener.release)
	if !b.publishListener(listener) {
		t.Fatal("publishListener refused a listener on a fresh broker")
	}

	done := make(chan struct{})
	go func() {
		b.Close()
		close(done)
	}()

	select {
	case <-done:
	case <-time.After(HandshakeTimeout + 5*time.Second):
		t.Fatal("Broker.Close never returned with a listener whose Close() hangs")
	}
}

// TestStopAcceptingAndWaitStillWaitsForAWellBehavedListener is the control: the
// bound must not turn into "fire and forget". A listener that closes promptly is
// closed before the method returns, and the method reports success.
func TestStopAcceptingAndWaitStillWaitsForAWellBehavedListener(t *testing.T) {
	b := New("prompt-close-"+t.Name(), nil)
	listener := newCloseTrackingListener()
	if !b.publishListener(listener) {
		t.Fatal("publishListener refused a listener on a fresh broker")
	}

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := b.StopAcceptingAndWait(ctx); err != nil {
		t.Fatalf("StopAcceptingAndWait: %v", err)
	}

	select {
	case <-listener.closed:
	default:
		t.Fatal("a well-behaved listener was not closed by the time StopAcceptingAndWait returned")
	}
}

// TestStopAcceptingAndWaitWithNoListenerIsNotAnError covers the second of the two
// concurrent Close calls that TestNamedPipeListenAndAccept makes (one from
// listenOn when stopChan closes, one from the test's own defer): whichever loses
// the race finds b.listener already nil and must still return cleanly.
func TestStopAcceptingAndWaitWithNoListenerIsNotAnError(t *testing.T) {
	b := New("no-listener-"+t.Name(), nil)
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	if err := b.StopAcceptingAndWait(ctx); err != nil {
		t.Fatalf("StopAcceptingAndWait with no listener: %v", err)
	}
}
