package gatewayproof

import (
	"context"
	"errors"
	"net"
	"strings"
	"sync"
	"testing"
	"time"
)

// fakeOps records the order of neighbour operations and scripts their results.
type fakeOps struct {
	mu       sync.Mutex
	calls    []string
	state    neighborState
	found    bool
	getErr   error
	result   neighborResult
	callErr  error
	block    chan struct{} // when set, resolve/sendARP wait on it
	finished chan struct{} // closed when a blocked call returns
}

func (f *fakeOps) record(name string) {
	f.mu.Lock()
	f.calls = append(f.calls, name)
	f.mu.Unlock()
}

func (f *fakeOps) sequence() string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return strings.Join(f.calls, " ")
}

func (f *fakeOps) getEntry() (neighborState, bool, error) {
	f.record("get")
	return f.state, f.found, f.getErr
}
func (f *fakeOps) deleteEntry() error    { f.record("delete"); return nil }
func (f *fakeOps) flushInterface() error { f.record("flush"); return nil }
func (f *fakeOps) blocking(name string) (neighborResult, error) {
	f.record(name)
	if f.block != nil {
		<-f.block
		defer close(f.finished)
	}
	return f.result, f.callErr
}
func (f *fakeOps) resolve() (neighborResult, error) { return f.blocking("resolve") }
func (f *fakeOps) sendARP() (neighborResult, error) { return f.blocking("sendarp") }

func okResult() neighborResult {
	return neighborResult{mac: []byte(gwMAC), state: nlnsReachable, hasState: true}
}

func runFake(t *testing.T, ops *fakeOps, m windowsMethod, timeout time.Duration) (net.HardwareAddr, string, error) {
	t.Helper()
	ctx, tr := withTrace(context.Background())
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	mac, err := runMethod(ctx, ops, m)
	return mac, tr.String(), err
}

func TestRunMethod_Sequences(t *testing.T) {
	for _, tc := range []struct {
		name  string
		m     windowsMethod
		state neighborState
		found bool
		want  string
	}{
		{"W1 resolves only", methodResolve, nlnsStale, true, "resolve"},
		{"W2 deletes a dynamic entry first", methodDeleteResolve, nlnsStale, true, "get delete resolve"},
		{"W2 without an entry skips the delete", methodDeleteResolve, 0, false, "get resolve"},
		{"W3 deletes then SendARP", methodDeleteSendARP, nlnsReachable, true, "get delete sendarp"},
		{"W4 flushes then resolves", methodFlushResolve, nlnsStale, true, "get flush resolve"},
	} {
		ops := &fakeOps{state: tc.state, found: tc.found, result: okResult()}
		mac, _, err := runFake(t, ops, tc.m, time.Second)
		if err != nil || mac.String() != gwMAC.String() {
			t.Errorf("%s: %v, %v", tc.name, mac, err)
		}
		if got := ops.sequence(); got != tc.want {
			t.Errorf("%s: calls %q, want %q", tc.name, got, tc.want)
		}
	}
}

// A permanent (static) entry is never deleted or flushed: the OS will not ask
// the gateway, so there is no fresh answer.
func TestRunMethod_PermanentEntryIsNeverTouched(t *testing.T) {
	for _, m := range []windowsMethod{methodDeleteResolve, methodDeleteSendARP, methodFlushResolve} {
		ops := &fakeOps{state: nlnsPermanent, found: true, result: okResult()}
		_, trace, err := runFake(t, ops, m, time.Second)
		if !errors.Is(err, ErrNoAnswer) {
			t.Errorf("%v: err = %v, want ErrNoAnswer", m, err)
		}
		if got := ops.sequence(); got != "get" {
			t.Errorf("%v: calls %q, want only the state read", m, got)
		}
		if !strings.Contains(trace, "permanent") {
			t.Errorf("%v: trace %q does not record the permanent entry", m, trace)
		}
	}
}

func TestRunMethod_DeadlineWhileBlocked(t *testing.T) {
	ops := &fakeOps{result: okResult(), block: make(chan struct{}), finished: make(chan struct{})}
	start := time.Now()
	_, _, err := runFake(t, ops, methodResolve, 150*time.Millisecond)
	if !errors.Is(err, ErrNoAnswer) {
		t.Fatalf("err = %v, want ErrNoAnswer", err)
	}
	if d := time.Since(start); d > 600*time.Millisecond {
		t.Fatalf("returned after %v; it must not wait for the blocked call", d)
	}
	close(ops.block) // the call finishes in the background
	<-ops.finished
}

func TestRunMethod_CancelWhileBlocked(t *testing.T) {
	ops := &fakeOps{result: okResult(), block: make(chan struct{}), finished: make(chan struct{})}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	time.AfterFunc(50*time.Millisecond, cancel)
	_, err := runMethod(ctx, ops, methodResolve)
	cancel()
	if !errors.Is(err, context.Canceled) || errors.Is(err, ErrNoAnswer) {
		t.Fatalf("err = %v, want context.Canceled", err)
	}
	close(ops.block)
	<-ops.finished
}

func TestRunMethod_ResultCodes(t *testing.T) {
	for _, tc := range []struct {
		name       string
		m          windowsMethod
		err        error
		res        neighborResult
		noAnswer   bool
		traceNeeds string
	}{
		{"resolve no-answer code", methodResolve, &iphlpError{call: "resolve", code: errBadNetName}, neighborResult{}, true, "resolve=67"},
		{"SendARP no-answer code", methodDeleteSendARP, &iphlpError{call: "sendarp", code: errGenFailure}, neighborResult{}, true, "sendarp=31"},
		{"other code is an error", methodResolve, &iphlpError{call: "resolve", code: 5}, neighborResult{}, false, "resolve=5"},
		{"short address is an error", methodResolve, nil, neighborResult{mac: []byte{1, 2, 3, 4}}, false, "len=4"},
		{"broadcast address is an error", methodResolve, nil, neighborResult{mac: []byte(mustMAC("ff:ff:ff:ff:ff:ff"))}, false, "len=6"},
	} {
		ops := &fakeOps{callErr: tc.err, result: tc.res}
		mac, trace, err := runFake(t, ops, tc.m, time.Second)
		if mac != nil || err == nil {
			t.Errorf("%s: got %v, %v; want an error", tc.name, mac, err)
		}
		if errors.Is(err, ErrNoAnswer) != tc.noAnswer {
			t.Errorf("%s: errors.Is(err, ErrNoAnswer) = %v, want %v (err %v)", tc.name, !tc.noAnswer, tc.noAnswer, err)
		}
		if !strings.Contains(trace, tc.traceNeeds) {
			t.Errorf("%s: trace %q lacks %q", tc.name, trace, tc.traceNeeds)
		}
	}
}

func TestRunMethod_TraceRecordsRowState(t *testing.T) {
	ops := &fakeOps{result: neighborResult{mac: []byte(gwMAC), state: nlnsReachable, hasState: true, lastReachable: 1234}}
	_, trace, err := runFake(t, ops, methodResolve, time.Second)
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{"method=W1-resolve", "resolve=0", "row_state=5", "reach_ms=1234"} {
		if !strings.Contains(trace, want) {
			t.Errorf("trace %q lacks %q", trace, want)
		}
	}
	if strings.Contains(trace, "a4:2b") || strings.Contains(trace, "192.168") {
		t.Errorf("trace %q carries an address", trace)
	}
}

func TestParseWindowsMethod(t *testing.T) {
	for in, want := range map[string]windowsMethod{
		"": methodResolve, "W1": methodResolve, "w2": methodDeleteResolve, "resolve": methodResolve,
		"delete-resolve": methodDeleteResolve, "W3": methodDeleteSendARP, "delete-sendarp": methodDeleteSendARP,
		"W4": methodFlushResolve, "flush-resolve": methodFlushResolve, " W2 ": methodDeleteResolve,
	} {
		if got, err := parseWindowsMethod(in); err != nil || got != want {
			t.Errorf("parseWindowsMethod(%q) = %v, %v; want %v", in, got, err, want)
		}
	}
	for _, bad := range []string{"W5", "sendarp", "0"} {
		if _, err := parseWindowsMethod(bad); err == nil {
			t.Errorf("parseWindowsMethod(%q) accepted", bad)
		}
	}
}
