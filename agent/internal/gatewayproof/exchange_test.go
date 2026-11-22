package gatewayproof

import (
	"context"
	"errors"
	"net"
	"sync"
	"testing"
	"time"
)

// fakeConn scripts reads and records writes with timestamps. It honours the
// frameConn read contract: a frame that is available is returned whatever the
// deadline; otherwise it waits until the deadline and returns errReadTimeout.
type fakeConn struct {
	mu sync.Mutex
	// queued frames are available from the start, before any write.
	queued [][]byte
	// afterWrite[n] frames become available once n writes have happened.
	afterWrite map[int][][]byte
	writeErr   error
	writes     []time.Time
	closed     int
}

func (c *fakeConn) WriteFrame(frame []byte) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.writeErr != nil {
		return c.writeErr
	}
	c.writes = append(c.writes, time.Now())
	c.queued = append(c.queued, c.afterWrite[len(c.writes)]...)
	return nil
}

func (c *fakeConn) ReadFrame(deadline time.Time) ([]byte, error) {
	c.mu.Lock()
	if len(c.queued) > 0 {
		f := c.queued[0]
		c.queued = c.queued[1:]
		c.mu.Unlock()
		return f, nil
	}
	c.mu.Unlock()
	if d := time.Until(deadline); d > 0 {
		time.Sleep(d)
	}
	return nil, errReadTimeout
}

func (c *fakeConn) Close() error {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.closed++
	return nil
}

func (c *fakeConn) writeTimes() []time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	return append([]time.Time(nil), c.writes...)
}

func matchGateway(frame []byte) (net.HardwareAddr, bool) {
	return decodeReply(frame, ourMAC, src, gw)
}

func request() []byte { return encodeRequest(ourMAC, src, gw) }

func TestExchange_ReplyAfterRequest(t *testing.T) {
	other := reply(gwMAC, netip192(2), ourMAC, src) // an ARP reply from another host
	c := &fakeConn{afterWrite: map[int][][]byte{1: {other, reply(gwMAC, gw, ourMAC, src)}}}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	mac, err := exchange(ctx, c, request(), matchGateway)
	if err != nil || mac.String() != gwMAC.String() {
		t.Fatalf("exchange = %v, %v; want %v", mac, err, gwMAC)
	}
	if n := len(c.writeTimes()); n != 1 {
		t.Fatalf("writes = %d, want 1 (the non-matching frame must not end or restart the call)", n)
	}
}

func TestExchange_ReplyQueuedBeforeRequestIgnored(t *testing.T) {
	c := &fakeConn{queued: [][]byte{reply(gwMAC, gw, ourMAC, src)}}
	ctx, cancel := context.WithTimeout(context.Background(), 300*time.Millisecond)
	defer cancel()
	mac, err := exchange(ctx, c, request(), matchGateway)
	if !errors.Is(err, ErrNoAnswer) {
		t.Fatalf("exchange = %v, %v; want ErrNoAnswer (a reply queued before the request never counts)", mac, err)
	}
}

func TestExchange_Resends(t *testing.T) {
	c := &fakeConn{}
	start := time.Now()
	ctx, cancel := context.WithDeadline(context.Background(), start.Add(600*time.Millisecond))
	defer cancel()
	_, err := exchange(ctx, c, request(), matchGateway)
	if !errors.Is(err, ErrNoAnswer) {
		t.Fatalf("err = %v, want ErrNoAnswer", err)
	}
	writes := c.writeTimes()
	if len(writes) != 3 {
		t.Fatalf("writes = %d, want 3 (at 0, 250 and 500 ms)", len(writes))
	}
	// Tight lower bounds (the schedule never runs early), loose upper bounds (loaded runners).
	for i, want := range []time.Duration{0, resendInterval, 2 * resendInterval} {
		got := writes[i].Sub(start)
		if got < want || got > want+150*time.Millisecond {
			t.Errorf("write %d at %v, want %v (+150ms slack)", i, got, want)
		}
	}
}

func TestExchange_Cancelled(t *testing.T) {
	c := &fakeConn{}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	time.AfterFunc(100*time.Millisecond, cancel)
	start := time.Now()
	_, err := exchange(ctx, c, request(), matchGateway)
	if !errors.Is(err, context.Canceled) || errors.Is(err, ErrNoAnswer) {
		t.Fatalf("err = %v, want context.Canceled and not ErrNoAnswer", err)
	}
	if d := time.Since(start); d > 2*time.Second {
		t.Fatalf("cancel took %v to be noticed", d)
	}
}

func TestExchange_WriteErrorReturned(t *testing.T) {
	boom := errors.New("boom")
	c := &fakeConn{writeErr: boom}
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	_, err := exchange(ctx, c, request(), matchGateway)
	if !errors.Is(err, boom) || err == boom || errors.Is(err, ErrNoAnswer) {
		t.Fatalf("err = %v, want boom wrapped", err)
	}
}

func TestExchange_ReadErrorReturned(t *testing.T) {
	boom := errors.New("boom")
	c := &errReadConn{err: boom}
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	_, err := exchange(ctx, c, request(), matchGateway)
	if !errors.Is(err, boom) || errors.Is(err, ErrNoAnswer) {
		t.Fatalf("err = %v, want boom wrapped", err)
	}
}

// errReadConn drains cleanly, then fails the first read after the request.
type errReadConn struct {
	err    error
	writes int
}

func (c *errReadConn) WriteFrame([]byte) error { c.writes++; return nil }
func (c *errReadConn) ReadFrame(time.Time) ([]byte, error) {
	if c.writes == 0 {
		return nil, errReadTimeout
	}
	return nil, c.err
}
func (c *errReadConn) Close() error { return nil }
