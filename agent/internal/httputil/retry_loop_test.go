package httputil

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// W09 (#8148, D5): when the server's Retry-After will not fit in the caller's
// context, Do returns at once with the answer and an absolute, jittered
// RetryAt instead of sleeping into the deadline, so the caller's loop can
// defer its next cycle until then.

type fakeRetryClock struct {
	mu      sync.Mutex
	now     time.Time
	waiters []fakeRetryWaiter
	changed chan struct{}
}

type fakeRetryWaiter struct {
	deadline time.Time
	ch       chan time.Time
}

var fakeRetryEpoch = time.Date(2026, 10, 12, 0, 0, 0, 0, time.UTC)

// installFakeRetryClock swaps nowFn, afterFn and randFloat. It mutates package
// globals — tests that use it must not call t.Parallel().
func installFakeRetryClock(t *testing.T, r float64) *fakeRetryClock {
	t.Helper()
	c := &fakeRetryClock{now: fakeRetryEpoch, changed: make(chan struct{})}
	origNow, origAfter, origRand := nowFn, afterFn, randFloat
	nowFn = c.Now
	afterFn = c.After
	randFloat = func() float64 { return r }
	t.Cleanup(func() { nowFn, afterFn, randFloat = origNow, origAfter, origRand })
	return c
}

func (c *fakeRetryClock) Now() time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.now
}

func (c *fakeRetryClock) After(d time.Duration) <-chan time.Time {
	ch := make(chan time.Time, 1)
	c.mu.Lock()
	defer c.mu.Unlock()
	c.waiters = append(c.waiters, fakeRetryWaiter{deadline: c.now.Add(d), ch: ch})
	close(c.changed)
	c.changed = make(chan struct{})
	return ch
}

func (c *fakeRetryClock) pending() int {
	c.mu.Lock()
	defer c.mu.Unlock()
	return len(c.waiters)
}

// waitForWaiter blocks until a waiter is pending and returns its duration.
func (c *fakeRetryClock) waitForWaiter(t *testing.T) time.Duration {
	t.Helper()
	guard := time.After(5 * time.Second)
	for {
		c.mu.Lock()
		if len(c.waiters) > 0 {
			d := c.waiters[0].deadline.Sub(c.now)
			c.mu.Unlock()
			return d
		}
		changed := c.changed
		c.mu.Unlock()
		select {
		case <-changed:
		case <-guard:
			t.Fatal("no retry wait registered within 5s")
			return 0
		}
	}
}

func (c *fakeRetryClock) Advance(d time.Duration) {
	c.mu.Lock()
	c.now = c.now.Add(d)
	var keep []fakeRetryWaiter
	var due []fakeRetryWaiter
	for _, w := range c.waiters {
		if w.deadline.After(c.now) {
			keep = append(keep, w)
		} else {
			due = append(due, w)
		}
	}
	c.waiters = keep
	now := c.now
	c.mu.Unlock()
	for _, w := range due {
		w.ch <- now
	}
}

func overloadServer(t *testing.T, retryAfter func(attempt int) string, okFrom int) (*httptest.Server, *atomic.Int32) {
	t.Helper()
	var calls atomic.Int32
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		n := int(calls.Add(1))
		if okFrom > 0 && n >= okFrom {
			w.WriteHeader(http.StatusOK)
			return
		}
		if ra := retryAfter(n); ra != "" {
			w.Header().Set("Retry-After", ra)
		}
		w.WriteHeader(http.StatusServiceUnavailable)
	}))
	t.Cleanup(ts.Close)
	return ts, &calls
}

func constRA(v string) func(int) string { return func(int) string { return v } }

func doAsync(ctx context.Context, ts *httptest.Server, cfg RetryConfig) <-chan error {
	errCh := make(chan error, 1)
	go func() {
		resp, err := Do(ctx, ts.Client(), "PUT", ts.URL+"/api/v1/agents/a1/software", []byte("{}"), nil, cfg)
		if resp != nil {
			_ = resp.Body.Close()
		}
		errCh <- err
	}()
	return errCh
}

func awaitErr(t *testing.T, errCh <-chan error) error {
	t.Helper()
	select {
	case err := <-errCh:
		return err
	case <-time.After(5 * time.Second):
		t.Fatal("Do did not return within 5s")
		return nil
	}
}

func TestDoReturnsRetryAtWhenHintOutlivesContext(t *testing.T) {
	clk := installFakeRetryClock(t, 0.5)
	ts, calls := overloadServer(t, constRA("120"), 0)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	err := awaitErr(t, doAsync(ctx, ts, DefaultRetryConfig()))
	if n := calls.Load(); n != 1 {
		t.Fatalf("requests = %d, want 1 (no retry into the deadline)", n)
	}
	if clk.pending() != 0 {
		t.Fatal("Do registered a wait; want an immediate return")
	}
	var rse *RetryableStatusError
	if !errors.As(err, &rse) || rse.StatusCode != http.StatusServiceUnavailable {
		t.Fatalf("err = %v, want *RetryableStatusError 503", err)
	}
	if want := fakeRetryEpoch.Add(138 * time.Second); !rse.RetryAt.Equal(want) {
		t.Fatalf("RetryAt = %v, want %v (120 s × 1.15)", rse.RetryAt, want)
	}
	if at, ok := RetryAtFrom(err); !ok || !at.Equal(rse.RetryAt) {
		t.Fatalf("RetryAtFrom = (%v, %v), want (%v, true)", at, ok, rse.RetryAt)
	}
}

func TestDoEarlyReturnKeepsOverloadAnswer(t *testing.T) {
	installFakeRetryClock(t, 0.5)
	ts, _ := overloadServer(t, constRA("60"), 0)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	err := awaitErr(t, doAsync(ctx, ts, DefaultRetryConfig()))
	if ctx.Err() != nil {
		t.Fatalf("Do returned only after the context ended (%v)", ctx.Err())
	}
	var rse *RetryableStatusError
	if !errors.As(err, &rse) || rse.StatusCode != http.StatusServiceUnavailable || rse.RetryAt.IsZero() {
		t.Fatalf("err = %v, want a 503 answer with a RetryAt", err)
	}
}

func TestDoStillRetriesShortHints(t *testing.T) {
	clk := installFakeRetryClock(t, 0.5)
	ts, calls := overloadServer(t, constRA("2"), 2)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	errCh := doAsync(ctx, ts, DefaultRetryConfig())
	if d := clk.waitForWaiter(t); d != 2300*time.Millisecond {
		t.Fatalf("in-request wait = %v, want 2.3s (2 s × 1.15, jittered once)", d)
	}
	clk.Advance(2300 * time.Millisecond)
	if err := awaitErr(t, errCh); err != nil {
		t.Fatalf("Do = %v, want the 200 on the second attempt", err)
	}
	if n := calls.Load(); n != 2 {
		t.Fatalf("requests = %d, want 2", n)
	}
}

func TestRetryAtBounds(t *testing.T) {
	cases := []struct {
		name string
		ra   func(now time.Time) string
		rnd  float64
		want time.Duration
	}{
		{"300 s at the top of the jitter stays at the cap", func(time.Time) string { return "300" }, 0.999, retryAfterMaxCap},
		{"an absurd value is parsed to the cap", func(time.Time) string { return "99999" }, 0.5, retryAfterMaxCap},
		{"an HTTP-date an hour ahead is parsed to the cap", func(now time.Time) string { return now.Add(time.Hour).Format(http.TimeFormat) }, 0, retryAfterMaxCap},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			installFakeRetryClock(t, tc.rnd)
			ts, _ := overloadServer(t, func(int) string { return tc.ra(fakeRetryEpoch) }, 0)
			ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
			defer cancel()
			at, ok := RetryAtFrom(awaitErr(t, doAsync(ctx, ts, DefaultRetryConfig())))
			if !ok {
				t.Fatal("no RetryAt")
			}
			if got := at.Sub(fakeRetryEpoch); got != tc.want {
				t.Fatalf("RetryAt - now = %v, want %v", got, tc.want)
			}
		})
	}
}

func TestRetryAtHTTPDateForms(t *testing.T) {
	cfg := DefaultRetryConfig()
	cfg.MaxRetries = 0 // one attempt: the last attempt still carries RetryAt
	t.Run("90 s ahead", func(t *testing.T) {
		installFakeRetryClock(t, 0.5)
		ts, _ := overloadServer(t, constRA(fakeRetryEpoch.Add(90*time.Second).Format(http.TimeFormat)), 0)
		at, ok := RetryAtFrom(awaitErr(t, doAsync(context.Background(), ts, cfg)))
		if got := at.Sub(fakeRetryEpoch); !ok || got < 103500*time.Millisecond-time.Microsecond || got > 103500*time.Millisecond {
			t.Fatalf("RetryAt = (%v, %v), want now + 103.5s (90 s × 1.15)", at, ok)
		}
	})
	t.Run("in the past", func(t *testing.T) {
		installFakeRetryClock(t, 0.5)
		ts, _ := overloadServer(t, constRA(fakeRetryEpoch.Add(-90*time.Second).Format(http.TimeFormat)), 0)
		if at, ok := RetryAtFrom(awaitErr(t, doAsync(context.Background(), ts, cfg))); ok {
			t.Fatalf("RetryAt = %v from a past date, want none", at)
		}
	})
}

func TestDoWithoutHintUnchanged(t *testing.T) {
	clk := installFakeRetryClock(t, 0.5)
	ts, calls := overloadServer(t, constRA(""), 0)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	errCh := doAsync(ctx, ts, DefaultRetryConfig())
	for i, want := range []time.Duration{time.Second, 2 * time.Second, 4 * time.Second} {
		if d := clk.waitForWaiter(t); d != want {
			t.Fatalf("backoff %d = %v, want %v (rand 0.5 → no jitter)", i, d, want)
		}
		clk.Advance(want)
	}
	err := awaitErr(t, errCh)
	if n := calls.Load(); n != 4 {
		t.Fatalf("requests = %d, want 4", n)
	}
	var rse *RetryableStatusError
	if !errors.As(err, &rse) || !rse.RetryAt.IsZero() {
		t.Fatalf("err = %v, want a 503 answer with no RetryAt", err)
	}
	if _, ok := RetryAtFrom(err); ok {
		t.Fatal("RetryAtFrom reported a hint the server never sent")
	}
}

func TestDoLoopRetryAfterDisabled(t *testing.T) {
	clk := installFakeRetryClock(t, 0.5)
	SetLoopRetryAfter(false)
	t.Cleanup(func() { SetLoopRetryAfter(true) })
	ts, calls := overloadServer(t, constRA("120"), 0)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	errCh := doAsync(ctx, ts, DefaultRetryConfig())
	if d := clk.waitForWaiter(t); d != 138*time.Second {
		t.Fatalf("wait with loop Retry-After off = %v, want today's in-request 138s", d)
	}
	cancel()
	err := awaitErr(t, errCh)
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("err = %v, want context.Canceled (today's behaviour)", err)
	}
	if _, ok := RetryAtFrom(err); ok {
		t.Fatal("RetryAt set with loop Retry-After off")
	}
	if n := calls.Load(); n != 1 {
		t.Fatalf("requests = %d, want 1", n)
	}
}

func TestRetryAtFromNonRetryErrors(t *testing.T) {
	for _, err := range []error{nil, errors.New("boom"), context.DeadlineExceeded, &RetryableStatusError{StatusCode: 503}} {
		if _, ok := RetryAtFrom(err); ok {
			t.Fatalf("RetryAtFrom(%v) = ok, want no hint", err)
		}
	}
}
