package workspaceindex

import (
	"context"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// #12727: a sustained ErrUnavailable answer stops crawls and watchers the way
// a 404 does; a single refusal leaves them running.

const (
	reasonUnavailablePrefix = "workspace index unavailable on server"
	reasonModuleAbsent      = "workspace module absent on server"
)

// indexingServer serves crawl-config with a switchable status and one
// watched local-profile source. The first crawl's batch and the first watcher
// upload block until their request is cancelled, so "still running" and
// "stopped" are both observable.
type indexingServer struct {
	t          *testing.T
	status     atomic.Int32
	retryAfter atomic.Value // string
	fetches    atomic.Int32
	runStarts  atomic.Int32
	eventPosts atomic.Int32

	firstBatchStarted   chan struct{}
	firstBatchCancelled chan struct{}
	firstEventStarted   chan struct{}
	firstEventCancelled chan struct{}
	once                [4]sync.Once
}

func newIndexingServer(t *testing.T) *indexingServer {
	s := &indexingServer{
		t:                   t,
		firstBatchStarted:   make(chan struct{}),
		firstBatchCancelled: make(chan struct{}),
		firstEventStarted:   make(chan struct{}),
		firstEventCancelled: make(chan struct{}),
	}
	s.status.Store(http.StatusOK)
	s.retryAfter.Store("")
	return s
}

func (s *indexingServer) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	const base = "/api/v1/workspace/agent/agent-1"
	switch {
	case r.Method == http.MethodGet && r.URL.Path == base+"/crawl-config":
		s.fetches.Add(1)
		status := int(s.status.Load())
		if status != http.StatusOK {
			if ra, _ := s.retryAfter.Load().(string); ra != "" {
				w.Header().Set("Retry-After", ra)
			}
			w.WriteHeader(status)
			return
		}
		writeLoopConfig(s.t, w, CrawlConfig{
			Enabled:             true,
			PollIntervalSeconds: 60,
			Limits:              ConfigLimits{MaxBatchEntries: 1, MaxBatchBytes: 1_000_000, WalkOpsPerSecond: 10_000},
			Sources:             []SourceConfig{{ID: "source-a", Kind: "local_profile", CadenceMinutes: 60, Watch: true}},
		})
	case r.Method == http.MethodPost && r.URL.Path == base+"/runs":
		n := s.runStarts.Add(1)
		_, _ = fmt.Fprintf(w, `{"runId":"run-%d","startedAt":"2026-11-26T00:00:00Z","cursor":""}`, n)
	case r.Method == http.MethodPost && r.URL.Path == base+"/runs/run-1/batch":
		s.once[0].Do(func() { close(s.firstBatchStarted) })
		<-r.Context().Done()
		s.once[1].Do(func() { close(s.firstBatchCancelled) })
	case r.Method == http.MethodPost && r.URL.Path == base+"/sources/source-a/events":
		if s.eventPosts.Add(1) == 1 {
			s.once[2].Do(func() { close(s.firstEventStarted) })
			<-r.Context().Done()
			s.once[3].Do(func() { close(s.firstEventCancelled) })
			return
		}
		w.WriteHeader(http.StatusAccepted)
	default:
		// Later batches and run completions.
		w.WriteHeader(http.StatusAccepted)
	}
}

type indexingLoop struct {
	server  *indexingServer
	clock   *clockedLoop
	audit   *recordingAuditLogger
	profile ProfileRoot
	base    time.Time
}

func startIndexingLoop(t *testing.T, log *slog.Logger) *indexingLoop {
	t.Helper()
	l := &indexingLoop{
		server:  newIndexingServer(t),
		clock:   &clockedLoop{},
		audit:   &recordingAuditLogger{},
		profile: makeLoopTestProfile(t),
		base:    time.Date(2026, time.November, 26, 0, 0, 0, 0, time.UTC),
	}
	if log == nil {
		log = loopTestLogger()
	}
	l.clock.Store(l.base.UnixNano())
	ctx, cancel := context.WithCancel(context.Background())
	done := StartLoop(ctx, Deps{
		Client:    newTestClient(t, l.server),
		Log:       log,
		Audit:     l.audit,
		Enumerate: func() []ProfileRoot { return []ProfileRoot{l.profile} },
		Now: func() time.Time {
			l.clock.nowCalls.Add(1)
			return time.Unix(0, l.clock.nowNanos.Load())
		},
		TickInterval:  time.Millisecond,
		WatchDebounce: time.Millisecond,
	})
	t.Cleanup(func() {
		cancel()
		waitLoopSignal(t, done, "loop shutdown")
	})

	// Indexing is active: the first crawl is mid-upload and the watcher has an
	// upload in flight.
	waitLoopCondition(t, func() bool { return l.server.fetches.Load() == 1 }, "initial fetch")
	waitLoopSignal(t, l.server.firstBatchStarted, "first crawl batch")
	l.touch(t, "first-event.txt")
	waitLoopSignal(t, l.server.firstEventStarted, "first watcher upload")
	return l
}

func (l *indexingLoop) touch(t *testing.T, name string) {
	t.Helper()
	if err := os.WriteFile(filepath.Join(l.profile.Dir, "Documents", name), []byte(name), 0o600); err != nil {
		t.Fatalf("write %s: %v", name, err)
	}
}

// fetchAt moves the clock to base+at and waits for the fetch numbered n.
func (l *indexingLoop) fetchAt(t *testing.T, at time.Duration, n int32) {
	t.Helper()
	l.clock.Store(l.base.Add(at).UnixNano())
	waitLoopCondition(t, func() bool { return l.server.fetches.Load() == n }, fmt.Sprintf("fetch %d", n))
}

// assertStillIndexing checks, after several more loop ticks, that neither
// the crawl nor the watcher was stopped and nothing was deactivated.
func (l *indexingLoop) assertStillIndexing(t *testing.T, when string) {
	t.Helper()
	start := l.clock.nowCalls.Load()
	waitLoopCondition(t, func() bool { return l.clock.nowCalls.Load() >= start+5 }, "loop ticks "+when)
	select {
	case <-l.server.firstBatchCancelled:
		t.Fatalf("crawl was stopped %s", when)
	default:
	}
	select {
	case <-l.server.firstEventCancelled:
		t.Fatalf("watcher was stopped %s", when)
	default:
	}
	if got := l.deactivationReasons(); len(got) != 0 {
		t.Fatalf("indexing deactivated %s: %v", when, got)
	}
}

func (l *indexingLoop) assertStopped(t *testing.T, when string) {
	t.Helper()
	waitLoopSignal(t, l.server.firstBatchCancelled, "crawl stop "+when)
	waitLoopSignal(t, l.server.firstEventCancelled, "watcher stop "+when)
}

func (l *indexingLoop) deactivationReasons() []string {
	types, details := l.audit.snapshot()
	var reasons []string
	for i, typ := range types {
		if typ == "workspace_index_deactivated" {
			reason, _ := details[i]["reason"].(string)
			reasons = append(reasons, reason)
		}
	}
	return reasons
}

func (l *indexingLoop) activationCount() int {
	types, _ := l.audit.snapshot()
	n := 0
	for _, typ := range types {
		if typ == "workspace_index_activated" {
			n++
		}
	}
	return n
}

func TestStartLoopSustainedUnavailableStopsCrawlsAndWatchers(t *testing.T) {
	for _, tt := range []struct {
		name          string
		first, second int
	}{
		{name: "503 twice", first: http.StatusServiceUnavailable, second: http.StatusServiceUnavailable},
		{name: "403 twice", first: http.StatusForbidden, second: http.StatusForbidden},
		{name: "503 then 403", first: http.StatusServiceUnavailable, second: http.StatusForbidden},
	} {
		t.Run(tt.name, func(t *testing.T) {
			l := startIndexingLoop(t, nil)

			// First refusal: back off, keep indexing.
			l.server.status.Store(int32(tt.first))
			l.fetchAt(t, 2*time.Minute, 2)
			l.assertStillIndexing(t, "after one refused poll")

			// The poll after the back-off is refused too: stop.
			l.server.status.Store(int32(tt.second))
			l.fetchAt(t, 2*time.Minute+unavailableBackoffMax+time.Second, 3)
			l.assertStopped(t, "after the second consecutive refused poll")

			wantReason := fmt.Sprintf("%s (HTTP %d)", reasonUnavailablePrefix, tt.second)
			waitLoopCondition(t, func() bool { return len(l.deactivationReasons()) == 1 }, "deactivation audit")
			if got := l.deactivationReasons(); !slices.Equal(got, []string{wantReason}) {
				t.Fatalf("deactivation reasons = %q, want [%q]", got, wantReason)
			}
			if strings.Contains(l.deactivationReasons()[0], "absent") {
				t.Fatalf("unavailable stop recorded as module absent: %q", l.deactivationReasons()[0])
			}

			// A further refusal keeps backing off and does not record again.
			l.fetchAt(t, 2*time.Minute+2*(unavailableBackoffMax+time.Second), 4)
			l.clock.Store(l.base.Add(2*time.Minute + 2*(unavailableBackoffMax+time.Second) + 2*time.Minute).UnixNano())
			assertFetchCountHolds(t, l.clock, &l.server.fetches, 4, "two minutes after a third refusal")
			if got := len(l.deactivationReasons()); got != 1 {
				t.Fatalf("deactivation records after a third refusal = %d, want 1", got)
			}
		})
	}
}

// Recovery needs no restart: the next 200 restores the normal cadence and
// starts the crawl and the watcher again under the config it returns.
func TestStartLoopRestartsIndexingAfterSustainedUnavailable(t *testing.T) {
	l := startIndexingLoop(t, nil)

	l.server.status.Store(http.StatusServiceUnavailable)
	l.fetchAt(t, 2*time.Minute, 2)
	stoppedAt := 2*time.Minute + unavailableBackoffMax + time.Second
	l.fetchAt(t, stoppedAt, 3)
	l.assertStopped(t, "after the second consecutive refused poll")

	l.server.status.Store(http.StatusOK)
	recoveredAt := stoppedAt + unavailableBackoffMax + time.Second
	l.fetchAt(t, recoveredAt, 4)
	waitLoopCondition(t, func() bool { return l.server.runStarts.Load() == 2 }, "crawl restart after recovery")
	waitLoopCondition(t, func() bool { return l.activationCount() == 2 }, "re-activation audit after recovery")

	if got := l.deactivationReasons(); len(got) != 1 {
		t.Fatalf("deactivation records after recovery = %q, want exactly one", got)
	}

	posts := l.server.eventPosts.Load()
	l.touch(t, "after-recovery.txt")
	waitLoopCondition(t, func() bool { return l.server.eventPosts.Load() > posts }, "watcher upload after recovery")

	// Normal cadence: the server's 60 s poll interval (±10%), not a back-off.
	l.fetchAt(t, recoveredAt+67*time.Second, 5)
}

// Recovery resets both what the loop remembers about the refusal (the status
// it last logged and the refusal count): 503 → 200 → 503 is a fresh entry into
// the unavailable state, so it warns again and does not stop indexing.
func TestStartLoopRecoveryResetsUnavailableState(t *testing.T) {
	recorder := &levelRecorder{message: "workspace index unavailable; backing off config poll"}
	l := startIndexingLoop(t, slog.New(recorder))

	l.server.status.Store(http.StatusServiceUnavailable)
	l.fetchAt(t, 2*time.Minute, 2)
	l.server.status.Store(http.StatusOK)
	recoveredAt := 2*time.Minute + unavailableBackoffMax + time.Second
	l.fetchAt(t, recoveredAt, 3)
	l.server.status.Store(http.StatusServiceUnavailable)
	l.fetchAt(t, recoveredAt+67*time.Second, 4)

	l.assertStillIndexing(t, "after 503 → 200 → 503")
	want := []slog.Level{slog.LevelWarn, slog.LevelWarn}
	if got := recorder.snapshot(); !slices.Equal(got, want) {
		t.Fatalf("back-off log levels after 503 → 200 → 503 = %v, want %v", got, want)
	}
}

// Only consecutive refusals count: an error outside the unavailable set
// between two 503s (here a 500, retried on the next tick) resets the count.
func TestStartLoopOtherErrorBetweenRefusalsResetsTheCount(t *testing.T) {
	l := startIndexingLoop(t, nil)

	l.server.status.Store(http.StatusServiceUnavailable)
	l.fetchAt(t, 2*time.Minute, 2)
	l.server.status.Store(http.StatusInternalServerError)
	erroredAt := 2*time.Minute + unavailableBackoffMax + time.Second
	l.fetchAt(t, erroredAt, 3)
	l.server.status.Store(http.StatusServiceUnavailable)
	l.fetchAt(t, erroredAt+2*time.Second, 4)

	l.assertStillIndexing(t, "after 503 → 500 → 503")
}

// A 404 after a 503 takes the 404 path: stop, record "module absent", and
// wait the six-hour module-absent back-off.
func TestStartLoopModuleAbsentAfterUnavailableTakesTheAbsentPath(t *testing.T) {
	l := startIndexingLoop(t, nil)

	l.server.status.Store(http.StatusServiceUnavailable)
	l.fetchAt(t, 2*time.Minute, 2)
	l.assertStillIndexing(t, "after one refused poll")

	l.server.status.Store(http.StatusNotFound)
	absentAt := 2*time.Minute + unavailableBackoffMax + time.Second
	l.fetchAt(t, absentAt, 3)
	l.assertStopped(t, "after a 404")
	waitLoopCondition(t, func() bool { return len(l.deactivationReasons()) == 1 }, "deactivation audit")
	if got := l.deactivationReasons(); !slices.Equal(got, []string{reasonModuleAbsent}) {
		t.Fatalf("deactivation reasons = %q, want [%q]", got, reasonModuleAbsent)
	}

	l.clock.Store(l.base.Add(absentAt + moduleAbsentBackoff - time.Minute).UnixNano())
	assertFetchCountHolds(t, l.clock, &l.server.fetches, 3, "inside the module-absent back-off")
	l.fetchAt(t, absentAt+moduleAbsentBackoff+time.Minute, 4)
}

// Retry-After: 0 is the shortest hint a server can send, so it means "retry at
// the floor" (one minute, plus jitter), the same as a one-second hint.
func TestStartLoopUnavailableRetryAfterZeroRetriesAtTheFloor(t *testing.T) {
	base := time.Date(2026, time.November, 26, 0, 0, 0, 0, time.UTC)
	responder := newCrawlConfigResponder(t, http.StatusServiceUnavailable, "0")
	now := startClockedLoop(t, responder, base)

	waitLoopCondition(t, func() bool { return responder.fetches.Load() == 1 }, "initial fetch")
	now.Store(base.Add(unavailableRetryAfterFloor - time.Second).UnixNano())
	assertFetchCountHolds(t, now, &responder.fetches, 1, "before the floor")
	// The floor plus its at-most-10% jitter, well short of unavailableBackoffMin.
	now.Store(base.Add(unavailableRetryAfterFloor + 7*time.Second).UnixNano())
	waitLoopCondition(t, func() bool { return responder.fetches.Load() == 2 }, "fetch at the floor")
}

func TestConfigPollRetryAfterZeroIsTheFloor(t *testing.T) {
	for _, tt := range []struct {
		header string
		want   time.Duration
	}{
		{header: "0", want: unavailableRetryAfterFloor},
		{header: "", want: 0},
		{header: "-1", want: 0},
		{header: "soon", want: 0},
		{header: "30", want: 30 * time.Second},
	} {
		h := http.Header{}
		if tt.header != "" {
			h.Set("Retry-After", tt.header)
		}
		if got := ConfigPollRetryAfter(h); got != tt.want {
			t.Fatalf("ConfigPollRetryAfter(%q) = %v, want %v", tt.header, got, tt.want)
		}
	}
}

// With no Retry-After the second refusal comes at least unavailableBackoffMin
// after the first, so it must always be old enough to stop: the grace may not
// outlast the shortest default back-off.
func TestUnavailableStopGraceFitsInsideTheDefaultBackoff(t *testing.T) {
	if unavailableStopGrace > unavailableBackoffMin {
		t.Fatalf("unavailableStopGrace %v > unavailableBackoffMin %v: the default back-off would no longer stop on the second refusal",
			unavailableStopGrace, unavailableBackoffMin)
	}
	for range 1000 {
		if wait := unavailableBackoff(0); wait < unavailableStopGrace {
			t.Fatalf("default back-off %v is shorter than unavailableStopGrace %v", wait, unavailableStopGrace)
		}
	}
}

// shortRetryAfterStep is one poll interval under "Retry-After: 60": the
// one-minute hint plus its at-most-10% jitter.
const shortRetryAfterStep = 67 * time.Second

// refuseWithRetryAfter makes every crawl-config poll answer 503 with the given
// Retry-After.
func (l *indexingLoop) refuseWithRetryAfter(retryAfter string) {
	l.server.retryAfter.Store(retryAfter)
	l.server.status.Store(http.StatusServiceUnavailable)
}

// A short Retry-After brings the next poll round in about a minute, and that
// alone must not tear indexing down: the stop also waits until the refusal
// streak is unavailableStopGrace old (#12727).
func TestStartLoopShortRetryAfterDoesNotStopIndexingEarly(t *testing.T) {
	l := startIndexingLoop(t, nil)
	l.refuseWithRetryAfter("60")

	l.fetchAt(t, 2*time.Minute, 2)
	l.fetchAt(t, 2*time.Minute+shortRetryAfterStep, 3)
	l.assertStillIndexing(t, "after two refusals about a minute apart")
}

// Under a short Retry-After the agent keeps polling at that cadence and stops
// at the first refused poll that is unavailableStopGrace or more after the
// streak began (the first refusal, here at two minutes).
func TestStartLoopShortRetryAfterStopsOnceTheStreakIsOldEnough(t *testing.T) {
	l := startIndexingLoop(t, nil)
	l.refuseWithRetryAfter("60")

	const streakStart = 2 * time.Minute
	l.fetchAt(t, streakStart, 2)
	l.fetchAt(t, streakStart+shortRetryAfterStep, 3)
	// 70 s short of the grace: still running.
	l.fetchAt(t, streakStart+unavailableStopGrace-70*time.Second, 4)
	l.assertStillIndexing(t, "70 s before the stop grace ends")

	// Exactly at the grace: stop. The previous poll's back-off (at most 66 s)
	// has run out by then, so this poll is due.
	stopAt := streakStart + unavailableStopGrace
	l.fetchAt(t, stopAt, 5)
	l.assertStopped(t, "at the first refused poll at the stop grace")
	wantReason := fmt.Sprintf("%s (HTTP %d)", reasonUnavailablePrefix, http.StatusServiceUnavailable)
	waitLoopCondition(t, func() bool { return len(l.deactivationReasons()) == 1 }, "deactivation audit")

	// Further refusals keep the cadence and do not record again.
	l.fetchAt(t, stopAt+shortRetryAfterStep, 6)
	l.fetchAt(t, stopAt+2*shortRetryAfterStep, 7)
	if got := l.deactivationReasons(); !slices.Equal(got, []string{wantReason}) {
		t.Fatalf("deactivation reasons = %q, want [%q]", got, wantReason)
	}
}

// Any outcome other than a refusal ends the streak, so the next refusal starts
// a new one and the grace is measured from it, not from the old streak.
func TestStartLoopNonRefusalResetsTheStreakStart(t *testing.T) {
	for _, tt := range []struct {
		name   string
		status int
	}{
		{name: "200", status: http.StatusOK},
		{name: "500", status: http.StatusInternalServerError},
	} {
		t.Run(tt.name, func(t *testing.T) {
			l := startIndexingLoop(t, nil)
			l.refuseWithRetryAfter("60")

			l.fetchAt(t, 2*time.Minute, 2)
			l.server.status.Store(int32(tt.status))
			l.fetchAt(t, 2*time.Minute+shortRetryAfterStep, 3)

			// A new streak starts well past the old one's grace...
			newStreak := 2*time.Minute + unavailableStopGrace + 5*time.Minute
			l.server.status.Store(http.StatusServiceUnavailable)
			l.fetchAt(t, newStreak, 4)
			// ...and its second refusal, about a minute later, is inside its
			// own grace.
			l.fetchAt(t, newStreak+shortRetryAfterStep, 5)
			l.assertStillIndexing(t, fmt.Sprintf("a minute into a streak that began after a %d", tt.status))
		})
	}
}
