package heartbeat

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/breeze-rmm/agent/internal/config"
	"github.com/breeze-rmm/agent/internal/logging"
	"github.com/breeze-rmm/agent/internal/pamdecline"
)

// #8971: the decline record is the outbox for the server withdraw. Each drain
// pass makes one attempt per due entry; a definitive answer (200, 409, 404,
// 400) is acked, anything else is retried with backoff, forever. An ack never
// clears the local refusal.

const withdrawReq = "7a1e0000-0000-4000-8000-000000008971"

type withdrawClock struct {
	mu sync.Mutex
	t  time.Time
}

func (c *withdrawClock) now() time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.t
}

func (c *withdrawClock) advance(d time.Duration) {
	c.mu.Lock()
	c.t = c.t.Add(d)
	c.mu.Unlock()
}

type capturedWithdraw struct {
	method, path, auth string
	body               map[string]any
}

type withdrawServer struct {
	ts       *httptest.Server
	mu       sync.Mutex
	statuses []int
	requests []capturedWithdraw
}

// newWithdrawServer answers with statuses in order; the last one repeats.
func newWithdrawServer(t *testing.T, statuses ...int) *withdrawServer {
	t.Helper()
	s := &withdrawServer{statuses: statuses}
	s.ts = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		raw, _ := io.ReadAll(r.Body)
		var body map[string]any
		_ = json.Unmarshal(raw, &body)
		s.mu.Lock()
		s.requests = append(s.requests, capturedWithdraw{method: r.Method, path: r.URL.Path, auth: r.Header.Get("Authorization"), body: body})
		status := s.statuses[len(s.statuses)-1]
		if len(s.requests) <= len(s.statuses) {
			status = s.statuses[len(s.requests)-1]
		}
		s.mu.Unlock()
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(status)
		switch status {
		case http.StatusOK:
			_, _ = io.WriteString(w, `{"id":"`+withdrawReq+`","status":"withdrawn","withdrawnAt":"2027-01-10T10:00:01.000Z"}`)
		case http.StatusConflict:
			_, _ = io.WriteString(w, `{"error":"not_pending","status":"approved"}`)
		case http.StatusNotFound:
			_, _ = io.WriteString(w, `{"error":"not_found"}`)
		default:
			_, _ = io.WriteString(w, `{"error":"x"}`)
		}
	}))
	t.Cleanup(s.ts.Close)
	return s
}

func (s *withdrawServer) count() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return len(s.requests)
}

func newWithdrawHeartbeat(t *testing.T, serverURL string) (*Heartbeat, *pamdecline.Store, *withdrawClock) {
	t.Helper()
	h := NewWithVersion(&config.Config{AgentID: "agent-8971", ServerURL: serverURL, AuthToken: "token-8971"}, "test", nil, nil)
	clock := &withdrawClock{t: time.Date(2027, 1, 10, 10, 0, 0, 0, time.UTC)}
	store := pamdecline.NewStore("", clock.now)
	h.pamDeclines = store
	h.pamWithdrawNow = clock.now
	return h, store, clock
}

func declinePending(t *testing.T, s *pamdecline.Store, id string) {
	t.Helper()
	if _, err := s.BeginAwaiting(id, "pending"); err != nil {
		t.Fatal(err)
	}
	if err := s.Decline(id, pamdecline.ReasonUserDenied); err != nil {
		t.Fatal(err)
	}
}

func entryOf(t *testing.T, s *pamdecline.Store, id string) pamdecline.Entry {
	t.Helper()
	for _, e := range s.Snapshot() {
		if e.RequestID == id {
			return e
		}
	}
	t.Fatalf("no entry for %s", id)
	return pamdecline.Entry{}
}

func TestWithdrawDrainAcksDefinitiveAnswers(t *testing.T) {
	cases := []struct {
		name    string
		status  int
		outcome string
	}{
		{"200 withdrawn", http.StatusOK, "withdrawn"},
		{"409 approved", http.StatusConflict, "not_pending:approved"},
		{"404 is terminal (old server or unknown request)", http.StatusNotFound, "not_found"},
		{"400 is terminal", http.StatusBadRequest, "rejected"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			srv := newWithdrawServer(t, tc.status)
			h, store, _ := newWithdrawHeartbeat(t, srv.ts.URL)
			declinePending(t, store, withdrawReq)

			h.drainPamWithdrawals(context.Background())

			e := entryOf(t, store, withdrawReq)
			if e.AckedAt.IsZero() || e.AckOutcome != tc.outcome {
				t.Fatalf("entry = %+v, want acked %q", e, tc.outcome)
			}
			if len(store.Due()) != 0 {
				t.Fatal("an acked entry is still due")
			}
			// The ack never clears the local refusal.
			if refuse, code := store.Check(withdrawReq); !refuse || code != pamdecline.CodeUserDeclined {
				t.Fatalf("Check after ack = (%v, %q), want refuse user_declined", refuse, code)
			}
			h.drainPamWithdrawals(context.Background())
			if n := srv.count(); n != 1 {
				t.Fatalf("server saw %d requests, want 1 (no resend after the ack)", n)
			}
		})
	}
}

func TestWithdrawDrainRetriesTransientAnswers(t *testing.T) {
	for _, status := range []int{http.StatusInternalServerError, http.StatusBadGateway, http.StatusUnauthorized, http.StatusForbidden, http.StatusTooManyRequests} {
		t.Run(http.StatusText(status), func(t *testing.T) {
			srv := newWithdrawServer(t, status)
			h, store, clock := newWithdrawHeartbeat(t, srv.ts.URL)
			declinePending(t, store, withdrawReq)

			h.drainPamWithdrawals(context.Background())

			e := entryOf(t, store, withdrawReq)
			if !e.AckedAt.IsZero() {
				t.Fatalf("a %d was acked: %+v", status, e)
			}
			if e.Attempts != 1 || !e.NextAttemptAt.Equal(clock.now().Add(pamWithdrawBackoff(0))) {
				t.Fatalf("entry = %+v, want 1 attempt and next at +%v", e, pamWithdrawBackoff(0))
			}
			// Not due before the backoff: no request.
			h.drainPamWithdrawals(context.Background())
			if n := srv.count(); n != 1 {
				t.Fatalf("server saw %d requests before the backoff ran out, want 1", n)
			}
			clock.advance(pamWithdrawBackoff(0))
			h.drainPamWithdrawals(context.Background())
			if e := entryOf(t, store, withdrawReq); e.Attempts != 2 {
				t.Fatalf("attempts = %d after the second pass, want 2", e.Attempts)
			}
		})
	}
}

func TestWithdrawDrainNetworkErrorRetries(t *testing.T) {
	srv := newWithdrawServer(t, http.StatusOK)
	url := srv.ts.URL
	srv.ts.Close() // nothing listening
	h, store, _ := newWithdrawHeartbeat(t, url)
	declinePending(t, store, withdrawReq)

	h.drainPamWithdrawals(context.Background())

	if e := entryOf(t, store, withdrawReq); !e.AckedAt.IsZero() || e.Attempts != 1 {
		t.Fatalf("entry = %+v, want un-acked with 1 attempt", e)
	}
}

func TestWithdrawDrainOfflineThenOnline(t *testing.T) {
	srv := newWithdrawServer(t, http.StatusServiceUnavailable, http.StatusServiceUnavailable, http.StatusOK)
	h, store, clock := newWithdrawHeartbeat(t, srv.ts.URL)
	declinePending(t, store, withdrawReq)

	for pass := 0; pass < 3; pass++ {
		h.drainPamWithdrawals(context.Background())
		clock.advance(pamWithdrawMaxBackoff)
	}

	e := entryOf(t, store, withdrawReq)
	if e.AckOutcome != "withdrawn" {
		t.Fatalf("entry = %+v, want acked withdrawn on the third pass", e)
	}
	if refuse, _ := store.Check(withdrawReq); !refuse {
		t.Fatal("the local refusal was cleared by the ack")
	}
}

func TestWithdrawBodyAndPath(t *testing.T) {
	srv := newWithdrawServer(t, http.StatusOK)
	h, store, clock := newWithdrawHeartbeat(t, srv.ts.URL)
	declinePending(t, store, withdrawReq)

	h.drainPamWithdrawals(context.Background())

	if srv.count() != 1 {
		t.Fatalf("server saw %d requests", srv.count())
	}
	got := srv.requests[0]
	if got.method != http.MethodPost || got.path != "/api/v1/agents/agent-8971/elevation-requests/"+withdrawReq+"/withdraw" {
		t.Fatalf("request = %s %s", got.method, got.path)
	}
	if got.auth != "Bearer token-8971" {
		t.Fatalf("Authorization = %q", got.auth)
	}
	want := map[string]any{"reason": "user_denied", "declinedAt": clock.now().Format(time.RFC3339Nano)}
	if len(got.body) != 2 || got.body["reason"] != want["reason"] || got.body["declinedAt"] != want["declinedAt"] {
		t.Fatalf("body = %v, want %v", got.body, want)
	}
}

func TestWithdrawSkipsAutoApproved(t *testing.T) {
	srv := newWithdrawServer(t, http.StatusOK)
	h, store, _ := newWithdrawHeartbeat(t, srv.ts.URL)
	if _, err := store.BeginAwaiting(withdrawReq, "auto_approved"); err != nil {
		t.Fatal(err)
	}
	if err := store.Decline(withdrawReq, pamdecline.ReasonUserDenied); err != nil {
		t.Fatal(err)
	}

	h.drainPamWithdrawals(context.Background())

	if srv.count() != 0 {
		t.Fatalf("an auto_approved decline was sent to the server (%d requests)", srv.count())
	}
	if refuse, _ := store.Check(withdrawReq); !refuse {
		t.Fatal("the auto_approved decline must still refuse locally")
	}
}

func TestWithdrawDrainPrunesAcked(t *testing.T) {
	srv := newWithdrawServer(t, http.StatusOK)
	h, store, clock := newWithdrawHeartbeat(t, srv.ts.URL)
	declinePending(t, store, withdrawReq)
	h.drainPamWithdrawals(context.Background())

	clock.advance(pamdecline.AckedRetention + time.Minute)
	h.drainPamWithdrawals(context.Background())

	if store.Len() != 0 {
		t.Fatalf("store has %d entries, want the acked one pruned", store.Len())
	}
}

func TestPamWithdrawBackoff(t *testing.T) {
	cases := map[int]time.Duration{0: 5 * time.Second, 1: 10 * time.Second, 2: 20 * time.Second, 5: 160 * time.Second, 6: 5 * time.Minute, 40: 5 * time.Minute, 1000: 5 * time.Minute}
	for attempts, want := range cases {
		if got := pamWithdrawBackoff(attempts); got != want {
			t.Errorf("pamWithdrawBackoff(%d) = %v, want %v", attempts, got, want)
		}
	}
}

func TestRunPamWithdrawDrainWakesOnKickAndStops(t *testing.T) {
	srv := newWithdrawServer(t, http.StatusOK)
	h, store, _ := newWithdrawHeartbeat(t, srv.ts.URL)
	done := make(chan struct{})
	go func() {
		h.runPamWithdrawDrain()
		close(done)
	}()

	declinePending(t, store, withdrawReq)
	h.kickPamWithdrawDrain()
	deadline := time.Now().Add(5 * time.Second)
	for srv.count() == 0 && time.Now().Before(deadline) {
		time.Sleep(10 * time.Millisecond)
	}
	if srv.count() != 1 {
		t.Fatalf("server saw %d requests after a kick, want 1", srv.count())
	}

	// Stop closes pamUnableStop first; the drain leaves on it.
	close(h.pamUnableStop)
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("drain did not stop with the heartbeat")
	}
}

// capturePamLog sends the agent log to a buffer at debug level for one test.
func capturePamLog(t *testing.T) *syncBuffer {
	t.Helper()
	buf := &syncBuffer{}
	logging.Init("text", "debug", buf)
	t.Cleanup(func() { logging.Init("text", "info", nil) })
	return buf
}

// logLines returns the captured lines that contain every one of parts.
func logLines(buf *syncBuffer, parts ...string) []string {
	var out []string
	for _, line := range strings.Split(buf.String(), "\n") {
		ok := line != ""
		for _, p := range parts {
			ok = ok && strings.Contains(line, p)
		}
		if ok {
			out = append(out, line)
		}
	}
	return out
}

// Review fix (#10420): one panicking pass must not end the drain. The panic is
// logged at Error and the next kick delivers.
func TestRunPamWithdrawDrainSurvivesAPanickingPass(t *testing.T) {
	buf := capturePamLog(t)
	srv := newWithdrawServer(t, http.StatusServiceUnavailable, http.StatusOK)
	h, store, clock := newWithdrawHeartbeat(t, srv.ts.URL)
	var panicked sync.Once
	h.pamWithdrawNow = func() time.Time {
		panicked.Do(func() { panic("withdraw clock exploded") })
		return clock.now()
	}
	declinePending(t, store, withdrawReq)
	done := make(chan struct{})
	go func() {
		h.runPamWithdrawDrain()
		close(done)
	}()
	t.Cleanup(func() {
		close(h.pamUnableStop)
		<-done
	})

	waitFor := func(what string, cond func() bool) {
		t.Helper()
		deadline := time.Now().Add(5 * time.Second)
		for !cond() {
			if time.Now().After(deadline) {
				t.Fatalf("timed out waiting for %s", what)
			}
			time.Sleep(10 * time.Millisecond)
		}
	}
	waitFor("the panicking pass", func() bool { return len(logLines(buf, "level=ERROR", "withdraw clock exploded")) > 0 })
	h.kickPamWithdrawDrain()
	waitFor("the next pass to deliver", func() bool { return entryOf(t, store, withdrawReq).AckOutcome == "withdrawn" })
	if n := srv.count(); n != 2 {
		t.Fatalf("server saw %d requests, want 2", n)
	}
}

// Review fix (#10420): a 403 (drain_restricted, an agent-id mismatch) can never
// succeed on retry, so it is logged at Warn with the server's body.
func TestWithdraw403LogsWarnWithBody(t *testing.T) {
	buf := capturePamLog(t)
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusForbidden)
		_, _ = io.WriteString(w, `{"error":"drain_restricted"}`)
	}))
	t.Cleanup(ts.Close)
	h, store, _ := newWithdrawHeartbeat(t, ts.URL)
	declinePending(t, store, withdrawReq)

	h.drainPamWithdrawals(context.Background())

	if got := logLines(buf, "level=WARN", withdrawReq, "drain_restricted"); len(got) != 1 {
		t.Fatalf("want one Warn line with the 403 body, got %q\nlog:\n%s", got, buf.String())
	}
	if e := entryOf(t, store, withdrawReq); !e.AckedAt.IsZero() || e.Attempts != 1 {
		t.Fatalf("entry = %+v, want a retry", e)
	}
}

// Review fix (#10420): a withdraw that keeps failing escalates from Debug to
// Warn at 5 attempts and then every 20.
func TestWithdrawRetryEscalatesToWarn(t *testing.T) {
	buf := capturePamLog(t)
	srv := newWithdrawServer(t, http.StatusServiceUnavailable)
	h, store, clock := newWithdrawHeartbeat(t, srv.ts.URL)
	declinePending(t, store, withdrawReq)

	warnedAt := []int{}
	for attempt := 1; attempt <= 45; attempt++ {
		before := len(logLines(buf, "level=WARN", "still not delivered", withdrawReq))
		h.drainPamWithdrawals(context.Background())
		if e := entryOf(t, store, withdrawReq); e.Attempts != attempt {
			t.Fatalf("attempts = %d after pass %d", e.Attempts, attempt)
		}
		if len(logLines(buf, "level=WARN", "still not delivered", withdrawReq)) > before {
			warnedAt = append(warnedAt, attempt)
		}
		clock.advance(pamWithdrawMaxBackoff)
	}
	if want := []int{5, 25, 45}; len(warnedAt) != len(want) || warnedAt[0] != 5 || warnedAt[1] != 25 || warnedAt[2] != 45 {
		t.Fatalf("Warn at attempts %v, want %v", warnedAt, want)
	}
	if got := logLines(buf, "level=WARN", "still not delivered", "Service Unavailable"); len(got) != 3 {
		t.Fatalf("escalated lines carry no status: %q\nlog:\n%s", got, buf.String())
	}
}
