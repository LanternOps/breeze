package websocket

import (
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
	"time"

	"github.com/gorilla/websocket"
)

// Issue #8841: the reconnect loop used to back off only when connect() failed.
// A server-initiated close (any code, including 4001) re-dialled immediately,
// and the upgrade response was discarded, so Retry-After on a refused upgrade
// (W08 WS_UPGRADE_REFUSED 503, #8456) was ignored. These tests pin the policy.

func fixedRand(v float64) func() float64 { return func() float64 { return v } }

// randSamples covers the extremes and the middle of [0,1).
var randSamples = []float64{0, 0.25, 0.5, 0.75, 0.999999}

func TestClassifyDisconnect(t *testing.T) {
	tests := []struct {
		name     string
		err      error
		local    bool
		wantKind disconnectKind
		wantCode int
	}{
		{"server normal closure", &websocket.CloseError{Code: websocket.CloseNormalClosure}, false, disconnectServerNormal, 1000},
		{"server going away", &websocket.CloseError{Code: websocket.CloseGoingAway}, false, disconnectServerNormal, 1001},
		{"server reconnect-required 4040", &websocket.CloseError{Code: 4040}, false, disconnectServerNormal, 4040},
		{"credential denied 4001", &websocket.CloseError{Code: 4001}, false, disconnectAbnormal, 4001},
		{"superseded 4002", &websocket.CloseError{Code: 4002}, false, disconnectAbnormal, 4002},
		{"pong timeout 4008", &websocket.CloseError{Code: 4008}, false, disconnectAbnormal, 4008},
		{"quarantined 4041", &websocket.CloseError{Code: 4041}, false, disconnectAbnormal, 4041},
		{"policy violation 1008", &websocket.CloseError{Code: websocket.ClosePolicyViolation}, false, disconnectAbnormal, 1008},
		{"internal error 1011", &websocket.CloseError{Code: websocket.CloseInternalServerErr}, false, disconnectAbnormal, 1011},
		{"try again later 1013", &websocket.CloseError{Code: websocket.CloseTryAgainLater}, false, disconnectAbnormal, 1013},
		{"wrapped close error", fmt.Errorf("read: %w", &websocket.CloseError{Code: 4001}), false, disconnectAbnormal, 4001},
		{"no close frame (EOF)", io.ErrUnexpectedEOF, false, disconnectAbnormal, websocket.CloseAbnormalClosure},
		{"nil error (pump recovered)", nil, false, disconnectAbnormal, websocket.CloseAbnormalClosure},
		{"local ForceReconnect wins over the read error", errors.New("use of closed network connection"), true, disconnectLocal, websocket.CloseAbnormalClosure},
		{"server close frame outranks a racing local mark", &websocket.CloseError{Code: 4001}, true, disconnectAbnormal, 4001},
		{"server normal close frame outranks a racing local mark", &websocket.CloseError{Code: websocket.CloseNormalClosure}, true, disconnectServerNormal, 1000},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			kind, code := classifyDisconnect(tt.err, tt.local)
			if kind != tt.wantKind || code != tt.wantCode {
				t.Fatalf("classifyDisconnect = (%v, %d), want (%v, %d)", kind, code, tt.wantKind, tt.wantCode)
			}
		})
	}
}

func TestReconnectBackoff_ServerCloseAlwaysDelays(t *testing.T) {
	// (a)/(b) of #8841: every server-initiated close waits before re-dialling,
	// whatever the code and however long the connection lasted.
	codes := []int{1000, 1001, 1006, 1008, 1011, 4001, 4002, 4008, 4040, 4041}
	lasted := []time.Duration{0, 5 * time.Second, 31 * time.Second, time.Hour}
	for _, code := range codes {
		for _, l := range lasted {
			for _, r := range randSamples {
				t.Run(fmt.Sprintf("code=%d/lasted=%s/r=%v", code, l, r), func(t *testing.T) {
					b := newReconnectBackoff(fixedRand(r))
					kind, _ := classifyDisconnect(&websocket.CloseError{Code: code}, false)
					d := b.afterDisconnect(kind, l)
					if d < serverCloseSpreadMin {
						t.Fatalf("delay after server close %d = %v, want >= %v", code, d, serverCloseSpreadMin)
					}
				})
			}
		}
	}
}

func TestReconnectBackoff_AbnormalCloseAtLeastAsHardAsDialFailure(t *testing.T) {
	// 4001 and the other abnormal closes must back off at least as hard as a
	// failed dial at the same step, and must advance the step the same way.
	for _, code := range []int{4001, 4002, 4008, 4041, 1008, 1011, 1006} {
		for _, r := range randSamples {
			t.Run(fmt.Sprintf("code=%d/r=%v", code, r), func(t *testing.T) {
				closeB := newReconnectBackoff(fixedRand(r))
				dialB := newReconnectBackoff(fixedRand(r))
				for i := 0; i < 10; i++ {
					closeDelay := closeB.afterDisconnect(disconnectAbnormal, time.Second)
					dialDelay := dialB.afterDialFailure(errors.New("dial tcp: connection refused"))
					if closeDelay < dialDelay {
						t.Fatalf("attempt %d: close delay %v < dial-failure delay %v", i, closeDelay, dialDelay)
					}
					if closeB.step != dialB.step {
						t.Fatalf("attempt %d: close step %v != dial step %v", i, closeB.step, dialB.step)
					}
				}
				if closeB.step != maxBackoff {
					t.Fatalf("step after 10 short-lived abnormal closes = %v, want %v", closeB.step, maxBackoff)
				}
			})
		}
	}
}

func TestReconnectBackoff_NormalCloseAfterHealthyConnection(t *testing.T) {
	for _, r := range randSamples {
		b := newReconnectBackoff(fixedRand(r))
		b.step = maxBackoff // left over from earlier failures
		d := b.afterDisconnect(disconnectServerNormal, time.Minute)
		if d < serverCloseSpreadMin || d > serverCloseSpreadMax {
			t.Fatalf("r=%v: delay = %v, want within [%v, %v]", r, d, serverCloseSpreadMin, serverCloseSpreadMax)
		}
		if b.step != initialBackoff {
			t.Fatalf("r=%v: step after healthy normal close = %v, want reset to %v", r, b.step, initialBackoff)
		}
	}
}

func TestReconnectBackoff_NormalCloseFlappingEscalates(t *testing.T) {
	// A server that accepts and immediately closes with 1000 must not hold the
	// agent in a 1–5 s loop forever: short-lived connections escalate.
	b := newReconnectBackoff(fixedRand(0.5))
	var d time.Duration
	for i := 0; i < 10; i++ {
		d = b.afterDisconnect(disconnectServerNormal, time.Second)
	}
	if d < maxBackoff/2 {
		t.Fatalf("delay after 10 short-lived normal closes = %v, want it escalated toward %v", d, maxBackoff)
	}
}

func TestReconnectBackoff_HealthyConnectionResetsStep(t *testing.T) {
	// (d) of #8841: the "reset after a healthy connection" rule is unchanged —
	// a connection that lasted past the threshold resets the step; a shorter
	// one does not.
	tests := []struct {
		name     string
		lasted   time.Duration
		kind     disconnectKind
		wantStep time.Duration
	}{
		{"healthy abnormal close resets then advances once", stableConnectionThreshold + time.Second, disconnectAbnormal, 2 * initialBackoff},
		{"healthy normal close resets", stableConnectionThreshold + time.Second, disconnectServerNormal, initialBackoff},
		{"healthy local close resets", stableConnectionThreshold + time.Second, disconnectLocal, initialBackoff},
		{"short abnormal close keeps the cap", time.Second, disconnectAbnormal, maxBackoff},
		{"exactly the threshold is not healthy", stableConnectionThreshold, disconnectAbnormal, maxBackoff},
		{"short local close keeps the step", time.Second, disconnectLocal, maxBackoff},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			b := newReconnectBackoff(fixedRand(0.5))
			b.step = maxBackoff
			b.afterDisconnect(tt.kind, tt.lasted)
			if b.step != tt.wantStep {
				t.Fatalf("step = %v, want %v", b.step, tt.wantStep)
			}
		})
	}
}

func TestReconnectBackoff_LocalCloseIsShortAndJittered(t *testing.T) {
	for _, r := range randSamples {
		b := newReconnectBackoff(fixedRand(r))
		d := b.afterDisconnect(disconnectLocal, time.Second)
		if d < minReconnectDelay || d > localCloseSpreadMax {
			t.Fatalf("r=%v: local-close delay = %v, want within [%v, %v]", r, d, minReconnectDelay, localCloseSpreadMax)
		}
		if b.step != initialBackoff {
			t.Fatalf("r=%v: local close advanced the step to %v", r, b.step)
		}
	}
}

func TestReconnectBackoff_DialFailureHonoursRetryAfter(t *testing.T) {
	// (c) of #8841: a refused upgrade's Retry-After is a floor, with positive
	// jitter only (never sooner than the server asked), capped defensively.
	tests := []struct {
		name       string
		retryAfter time.Duration
		step       time.Duration
		wantMin    time.Duration
		wantMax    time.Duration
	}{
		{"retry-after above backoff", 30 * time.Second, initialBackoff, 30 * time.Second, 39 * time.Second},
		{"retry-after below backoff keeps backoff", 2 * time.Second, maxBackoff, 2 * time.Second, maxBackoff + maxBackoff*3/10},
		{"retry-after at the cap stays capped", retryAfterCeiling, initialBackoff, retryAfterCeiling, retryAfterCeiling},
	}
	for _, tt := range tests {
		for _, r := range randSamples {
			t.Run(fmt.Sprintf("%s/r=%v", tt.name, r), func(t *testing.T) {
				b := newReconnectBackoff(fixedRand(r))
				b.step = tt.step
				err := fmt.Errorf("failed to connect: %w", &upgradeRefusedError{StatusCode: http.StatusServiceUnavailable, RetryAfter: tt.retryAfter})
				d := b.afterDialFailure(err)
				if d < tt.wantMin || d > tt.wantMax {
					t.Fatalf("delay = %v, want within [%v, %v]", d, tt.wantMin, tt.wantMax)
				}
			})
		}
	}
}

func TestReconnectBackoff_DialFailureWithoutRetryAfterUsesJitteredStep(t *testing.T) {
	b := newReconnectBackoff(fixedRand(0))
	if d := b.afterDialFailure(errors.New("boom")); d != 700*time.Millisecond {
		t.Fatalf("first dial-failure delay at r=0 = %v, want 700ms (1s - 30%%)", d)
	}
	if b.step != 2*time.Second {
		t.Fatalf("step after one failure = %v, want 2s", b.step)
	}
}

func TestReconnectBackoff_NeverBelowFloor(t *testing.T) {
	kinds := []disconnectKind{disconnectLocal, disconnectServerNormal, disconnectAbnormal}
	for _, r := range randSamples {
		b := newReconnectBackoff(fixedRand(r))
		if d := b.afterDialFailure(errors.New("x")); d < minReconnectDelay {
			t.Fatalf("r=%v: dial-failure delay %v below floor %v", r, d, minReconnectDelay)
		}
		for _, k := range kinds {
			if d := b.afterDisconnect(k, 0); d < minReconnectDelay {
				t.Fatalf("r=%v kind=%v: delay %v below floor %v", r, k, d, minReconnectDelay)
			}
		}
	}
}

// ---------- connect(): the upgrade response is kept ----------

func TestConnect_UpgradeRefusalCarriesStatusAndRetryAfter(t *testing.T) {
	tests := []struct {
		name           string
		status         int
		retryAfter     string
		wantRetryAfter time.Duration
	}{
		{"W08 503 with Retry-After", http.StatusServiceUnavailable, "7", 7 * time.Second},
		{"429 with Retry-After", http.StatusTooManyRequests, "3", 3 * time.Second},
		{"401 Retry-After is not a back-pressure signal", http.StatusUnauthorized, "9", 0},
		{"503 without Retry-After", http.StatusServiceUnavailable, "", 0},
		{"503 with absurd Retry-After is clamped", http.StatusServiceUnavailable, "99999", retryAfterCeiling},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if tt.retryAfter != "" {
					w.Header().Set("Retry-After", tt.retryAfter)
				}
				w.Header().Set("Content-Type", "application/json")
				w.WriteHeader(tt.status)
				_, _ = w.Write([]byte(`{"code":"WS_UPGRADE_REFUSED"}`))
			}))
			defer srv.Close()

			c := newTestClient(srv.URL, noopHandler)
			err := c.connect()
			var refused *upgradeRefusedError
			if !errors.As(err, &refused) {
				t.Fatalf("connect error %v (%T) is not an *upgradeRefusedError", err, err)
			}
			if refused.StatusCode != tt.status {
				t.Fatalf("StatusCode = %d, want %d", refused.StatusCode, tt.status)
			}
			if refused.RetryAfter != tt.wantRetryAfter {
				t.Fatalf("RetryAfter = %v, want %v", refused.RetryAfter, tt.wantRetryAfter)
			}
		})
	}
}

// ---------- reconnectLoop end to end ----------

// recordDialTimes starts a test server that records the time of every agent
// WS upgrade attempt and lets handle decide what to do with it.
func recordDialTimes(t *testing.T, handle func(attempt int, w http.ResponseWriter, r *http.Request)) (*httptest.Server, func() []time.Time) {
	t.Helper()
	var mu sync.Mutex
	var times []time.Time
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		times = append(times, time.Now())
		attempt := len(times)
		mu.Unlock()
		handle(attempt, w, r)
	}))
	return srv, func() []time.Time {
		mu.Lock()
		defer mu.Unlock()
		return append([]time.Time(nil), times...)
	}
}

func waitForDials(t *testing.T, dials func() []time.Time, n int, within time.Duration) []time.Time {
	t.Helper()
	deadline := time.Now().Add(within)
	for time.Now().Before(deadline) {
		if got := dials(); len(got) >= n {
			return got
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatalf("saw %d dial attempts in %v, want %d", len(dials()), within, n)
	return nil
}

func runClient(t *testing.T, c *Client) {
	t.Helper()
	done := make(chan struct{})
	go func() {
		c.Start()
		close(done)
	}()
	t.Cleanup(func() {
		c.Stop()
		select {
		case <-done:
		case <-time.After(5 * time.Second):
			t.Error("reconnectLoop did not exit after Stop")
		}
	})
}

func TestReconnectLoop_WaitsAfterServerClose4001(t *testing.T) {
	srv, dials := recordDialTimes(t, func(attempt int, w http.ResponseWriter, r *http.Request) {
		conn, err := testUpgrader.Upgrade(w, r, nil)
		if err != nil {
			return
		}
		defer func() { _ = conn.Close() }()
		if attempt == 1 {
			_ = conn.WriteControl(websocket.CloseMessage,
				websocket.FormatCloseMessage(4001, "credential check failed"), time.Now().Add(time.Second))
			return
		}
		// Hold the connection until the client goes away.
		for {
			if _, _, err := conn.ReadMessage(); err != nil {
				return
			}
		}
	})
	defer srv.Close()

	runClient(t, newTestClient(srv.URL, noopHandler))
	got := waitForDials(t, dials, 2, 10*time.Second)
	if gap := got[1].Sub(got[0]); gap < serverCloseSpreadMin {
		t.Fatalf("re-dialled %v after a 4001 close, want >= %v", gap, serverCloseSpreadMin)
	}
}

func TestReconnectLoop_HonoursRetryAfterOnRefusedUpgrade(t *testing.T) {
	srv, dials := recordDialTimes(t, func(attempt int, w http.ResponseWriter, r *http.Request) {
		if attempt == 1 {
			w.Header().Set("Retry-After", "2")
			w.WriteHeader(http.StatusServiceUnavailable)
			return
		}
		conn, err := testUpgrader.Upgrade(w, r, nil)
		if err != nil {
			return
		}
		defer func() { _ = conn.Close() }()
		// Hold the connection until the client goes away.
		for {
			if _, _, err := conn.ReadMessage(); err != nil {
				return
			}
		}
	})
	defer srv.Close()

	runClient(t, newTestClient(srv.URL, noopHandler))
	got := waitForDials(t, dials, 2, 10*time.Second)
	if gap := got[1].Sub(got[0]); gap < 2*time.Second {
		t.Fatalf("re-dialled %v after a 503 with Retry-After: 2, want >= 2s", gap)
	}
}

func TestForceReconnect_MarksDropAsLocal(t *testing.T) {
	srv := newTestServer(t, func(conn *websocket.Conn) {
		defer func() { _ = conn.Close() }()
		for {
			if _, _, err := conn.ReadMessage(); err != nil {
				return
			}
		}
	})
	defer srv.Close()

	c := newTestClient(srv.URL, noopHandler)

	// No live connection: nothing to mark, so a later server close is not
	// mistaken for an agent-initiated one.
	c.ForceReconnect()
	if c.localClose.Load() {
		t.Fatal("ForceReconnect with no connection marked a local close")
	}

	if err := c.connect(); err != nil {
		t.Fatalf("connect: %v", err)
	}
	c.ForceReconnect()
	kind, _ := classifyDisconnect(errors.New("use of closed network connection"), c.localClose.Swap(false))
	if kind != disconnectLocal {
		t.Fatalf("drop after ForceReconnect classified as %v, want local", kind)
	}
	if c.localClose.Load() {
		t.Fatal("local-close mark not consumed")
	}
}

func TestReconnectLoop_StopInterruptsRetryAfterWait(t *testing.T) {
	// The post-failure wait can be up to 300 s; Stop must cut it short.
	srv, dials := recordDialTimes(t, func(attempt int, w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Retry-After", "30")
		w.WriteHeader(http.StatusServiceUnavailable)
	})
	defer srv.Close()

	c := newTestClient(srv.URL, noopHandler)
	done := make(chan struct{})
	go func() {
		c.Start()
		close(done)
	}()
	waitForDials(t, dials, 1, 5*time.Second)
	time.Sleep(100 * time.Millisecond) // let the loop enter its wait

	c.Stop()
	select {
	case <-done:
	case <-time.After(3 * time.Second):
		t.Fatal("reconnectLoop did not exit within 3s of Stop during a Retry-After wait")
	}
	if n := len(dials()); n != 1 {
		t.Fatalf("saw %d dial attempts, want 1 (the 30s Retry-After was not honoured)", n)
	}
}

// TestStop_DuringDial_ExitsPromptly pins the Stop-during-connect race seen
// as "reconnectLoop did not exit after Stop" in TestReconnectLoop_WaitsAfterServerClose4001
// under -race on loaded runners: Stop closed nothing (c.conn was still nil
// while the dial was in flight), connect then stored the new socket, and
// readPump sat on it for up to pongWait.
func TestStop_DuringDial_ExitsPromptly(t *testing.T) {
	handshakeStarted := make(chan struct{}, 1)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		select {
		case handshakeStarted <- struct{}{}:
		default:
		}
		time.Sleep(300 * time.Millisecond) // keep the dial in flight while Stop runs
		conn, err := testUpgrader.Upgrade(w, r, nil)
		if err != nil {
			return
		}
		defer func() { _ = conn.Close() }()
		for { // hold the connection until the client goes away
			if _, _, err := conn.ReadMessage(); err != nil {
				return
			}
		}
	}))
	defer srv.Close()

	c := newTestClient(srv.URL, noopHandler)
	t.Cleanup(c.Stop) // also covers the failure path so the loop never outlives the test
	done := make(chan struct{})
	go func() {
		c.Start()
		close(done)
	}()
	select {
	case <-handshakeStarted:
	case <-time.After(5 * time.Second):
		t.Fatal("dial never reached the server")
	}
	c.Stop()
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("reconnectLoop did not exit within 2s of a Stop issued mid-dial")
	}
}
