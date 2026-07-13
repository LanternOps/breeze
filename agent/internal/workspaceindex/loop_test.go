package workspaceindex

import (
	"compress/gzip"
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"os"
	"path/filepath"
	"reflect"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func TestIsSourceDue(t *testing.T) {
	now := time.Date(2026, time.July, 12, 12, 0, 0, 0, time.UTC)
	fortyNineMinutesAgo := now.Add(-49 * time.Minute)
	fiftyMinutesAgo := now.Add(-50 * time.Minute)

	tests := []struct {
		name string
		src  SourceConfig
		want bool
	}{
		{
			name: "nil last completion is due",
			src:  SourceConfig{CadenceMinutes: 50},
			want: true,
		},
		{
			name: "before cadence is not due",
			src:  SourceConfig{CadenceMinutes: 50, LastCompleteRunAt: &fortyNineMinutesAgo},
			want: false,
		},
		{
			name: "exact cadence boundary is due",
			src:  SourceConfig{CadenceMinutes: 50, LastCompleteRunAt: &fiftyMinutesAgo},
			want: true,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := isSourceDue(now, tt.src); got != tt.want {
				t.Fatalf("isSourceDue() = %v, want %v", got, tt.want)
			}
		})
	}
}

func TestStartLoopRunsDueSourcesSingleFlightFIFO(t *testing.T) {
	profile := makeLoopTestProfile(t)
	var mu sync.Mutex
	var startOrder []string
	active := 0
	maxActive := 0
	firstBatchStarted := make(chan struct{})
	releaseFirst := make(chan struct{})
	completed := make(chan string, 2)

	client := newTestClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.Method == http.MethodGet && r.URL.Path == "/api/v1/workspace/agent/crawl-config":
			writeLoopConfig(t, w, CrawlConfig{
				Enabled:             true,
				PollIntervalSeconds: 3600,
				Sources: []SourceConfig{
					{ID: "source-a", Kind: "local_profile", CadenceMinutes: 60},
					{ID: "source-b", Kind: "local_profile", CadenceMinutes: 60},
				},
			})
		case r.Method == http.MethodPost && r.URL.Path == "/api/v1/workspace/agent/runs":
			var body struct {
				SourceID string `json:"sourceId"`
			}
			if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
				t.Errorf("decode start run: %v", err)
				w.WriteHeader(http.StatusBadRequest)
				return
			}
			mu.Lock()
			startOrder = append(startOrder, body.SourceID)
			active++
			if active > maxActive {
				maxActive = active
			}
			mu.Unlock()
			_, _ = io.WriteString(w, `{"runId":"run-`+body.SourceID+`","startedAt":"2026-07-12T12:00:00Z","cursor":""}`)
		case r.Method == http.MethodPost && filepath.Base(r.URL.Path) == "batch":
			if r.URL.Path == "/api/v1/workspace/agent/runs/run-source-a/batch" {
				select {
				case <-firstBatchStarted:
				default:
					close(firstBatchStarted)
				}
				select {
				case <-releaseFirst:
				case <-r.Context().Done():
					return
				}
			}
			w.WriteHeader(http.StatusAccepted)
		case r.Method == http.MethodPost && filepath.Base(r.URL.Path) == "complete":
			runID := filepath.Base(filepath.Dir(r.URL.Path))
			mu.Lock()
			active--
			mu.Unlock()
			completed <- runID
			w.WriteHeader(http.StatusAccepted)
		default:
			t.Errorf("unexpected request: %s %s", r.Method, r.URL.Path)
			w.WriteHeader(http.StatusNotFound)
		}
	}))

	ctx, cancel := context.WithCancel(context.Background())
	done := StartLoop(ctx, Deps{
		Client:       client,
		Log:          loopTestLogger(),
		Enumerate:    func() []ProfileRoot { return []ProfileRoot{profile} },
		Now:          func() time.Time { return time.Date(2026, time.July, 12, 12, 0, 0, 0, time.UTC) },
		TickInterval: time.Millisecond,
	})
	t.Cleanup(func() {
		cancel()
		select {
		case <-done:
		case <-time.After(time.Second):
			t.Error("StartLoop did not stop")
		}
	})

	waitLoopSignal(t, firstBatchStarted, "first source batch")
	time.Sleep(20 * time.Millisecond)
	mu.Lock()
	if got := append([]string(nil), startOrder...); !reflect.DeepEqual(got, []string{"source-a"}) {
		mu.Unlock()
		t.Fatalf("starts while first crawl blocked = %#v, want only source-a", got)
	}
	mu.Unlock()
	close(releaseFirst)
	waitLoopCompletions(t, completed, 2)

	mu.Lock()
	defer mu.Unlock()
	if !reflect.DeepEqual(startOrder, []string{"source-a", "source-b"}) {
		t.Fatalf("start order = %#v, want FIFO", startOrder)
	}
	if maxActive != 1 {
		t.Fatalf("maximum concurrent crawls = %d, want 1", maxActive)
	}
}

func TestStartLoopModuleAbsentSleepsForSixHours(t *testing.T) {
	base := time.Date(2026, time.July, 12, 0, 0, 0, 0, time.UTC)
	var nowNanos atomic.Int64
	nowNanos.Store(base.UnixNano())
	var fetches atomic.Int32

	client := newTestClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet || r.URL.Path != "/api/v1/workspace/agent/crawl-config" {
			t.Errorf("unexpected request: %s %s", r.Method, r.URL.Path)
			w.WriteHeader(http.StatusNotFound)
			return
		}
		fetches.Add(1)
		w.WriteHeader(http.StatusNotFound)
	}))

	ctx, cancel := context.WithCancel(context.Background())
	done := StartLoop(ctx, Deps{
		Client:       client,
		Log:          loopTestLogger(),
		Now:          func() time.Time { return time.Unix(0, nowNanos.Load()) },
		TickInterval: time.Millisecond,
	})
	defer func() {
		cancel()
		waitLoopSignal(t, done, "loop shutdown")
	}()

	waitLoopCondition(t, func() bool { return fetches.Load() == 1 }, "initial absent-module fetch")
	nowNanos.Store(base.Add(6*time.Hour - time.Minute).UnixNano())
	time.Sleep(20 * time.Millisecond)
	if got := fetches.Load(); got != 1 {
		t.Fatalf("fetches before six-hour backoff = %d, want 1", got)
	}

	nowNanos.Store(base.Add(6*time.Hour + time.Minute).UnixNano())
	waitLoopCondition(t, func() bool { return fetches.Load() >= 2 }, "fetch after six-hour backoff")
	if got := fetches.Load(); got != 2 {
		t.Fatalf("fetches after backoff = %d, want 2", got)
	}
}

func TestStartLoopCancelsCrawlRemovedByConfig(t *testing.T) {
	profile := makeLoopTestProfile(t)
	var configFetches atomic.Int32
	batchStarted := make(chan struct{})
	batchCancelled := make(chan struct{})

	client := newTestClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.Method == http.MethodGet && r.URL.Path == "/api/v1/workspace/agent/crawl-config":
			fetch := configFetches.Add(1)
			config := CrawlConfig{Enabled: true, PollIntervalSeconds: 1}
			if fetch == 1 {
				config.Sources = []SourceConfig{{ID: "removed-source", Kind: "local_profile", CadenceMinutes: 60}}
			} else {
				select {
				case <-batchStarted:
				case <-r.Context().Done():
					return
				}
			}
			writeLoopConfig(t, w, config)
		case r.Method == http.MethodPost && r.URL.Path == "/api/v1/workspace/agent/runs":
			_, _ = io.WriteString(w, `{"runId":"removed-run","startedAt":"2026-07-12T12:00:00Z","cursor":""}`)
		case r.Method == http.MethodPost && r.URL.Path == "/api/v1/workspace/agent/runs/removed-run/batch":
			close(batchStarted)
			<-r.Context().Done()
			close(batchCancelled)
		default:
			w.WriteHeader(http.StatusAccepted)
		}
	}))

	base := time.Date(2026, time.July, 12, 12, 0, 0, 0, time.UTC)
	var nowCalls atomic.Int64
	ctx, cancel := context.WithCancel(context.Background())
	done := StartLoop(ctx, Deps{
		Client:    client,
		Log:       loopTestLogger(),
		Enumerate: func() []ProfileRoot { return []ProfileRoot{profile} },
		Now: func() time.Time {
			return base.Add(time.Duration(nowCalls.Add(1)) * time.Second)
		},
		TickInterval: time.Millisecond,
	})
	defer func() {
		cancel()
		waitLoopSignal(t, done, "loop shutdown")
	}()

	waitLoopSignal(t, batchStarted, "crawl batch")
	waitLoopCondition(t, func() bool { return configFetches.Load() >= 2 }, "configuration reconciliation")
	waitLoopSignal(t, batchCancelled, "removed crawl cancellation")
}

func TestStartLoopDisabledStopsCrawlAndWatcherAndDropsSourceState(t *testing.T) {
	profile := makeLoopTestProfile(t)
	if err := os.WriteFile(filepath.Join(profile.Dir, "Documents", "second.txt"), []byte("second"), 0o600); err != nil {
		t.Fatalf("write second crawl entry: %v", err)
	}
	var configFetches atomic.Int32
	var sourceAStarts atomic.Int32
	var sourceBStarts atomic.Int32
	var reenabled atomic.Bool
	batchStarted := make(chan struct{})
	batchCancelled := make(chan struct{})
	watchRequestStarted := make(chan struct{})
	watchRequestCancelled := make(chan struct{})
	sourceBFirstBatchEntries := make(chan int, 1)
	var batchStartedOnce sync.Once
	var batchCancelledOnce sync.Once
	var watchRequestStartedOnce sync.Once
	var watchRequestCancelledOnce sync.Once
	var sourceBFirstBatchOnce sync.Once

	client := newTestClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.Method == http.MethodGet && r.URL.Path == "/api/v1/workspace/agent/crawl-config":
			fetch := configFetches.Add(1)
			if fetch == 2 {
				select {
				case <-batchStarted:
				case <-r.Context().Done():
					return
				}
				select {
				case <-watchRequestStarted:
				case <-r.Context().Done():
					return
				}
			}
			config := CrawlConfig{PollIntervalSeconds: 1}
			switch {
			case fetch == 1:
				config.Enabled = true
				config.Limits = ConfigLimits{MaxBatchEntries: 1, MaxBatchBytes: 1_000_000, WalkOpsPerSecond: 10_000}
				config.Sources = []SourceConfig{
					{ID: "source-a", Kind: "local_profile", CadenceMinutes: 60, Watch: true},
					{ID: "source-b", Kind: "local_profile", CadenceMinutes: 60},
				}
			case reenabled.Load():
				config.Enabled = true
				config.Limits = ConfigLimits{MaxBatchEntries: 10, MaxBatchBytes: 1_000_000, WalkOpsPerSecond: 10_000}
				config.Sources = []SourceConfig{{ID: "source-b", Kind: "local_profile", CadenceMinutes: 60}}
			}
			writeLoopConfig(t, w, config)
		case r.Method == http.MethodPost && r.URL.Path == "/api/v1/workspace/agent/runs":
			var body struct {
				SourceID string `json:"sourceId"`
			}
			if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
				t.Errorf("decode start run: %v", err)
				w.WriteHeader(http.StatusBadRequest)
				return
			}
			switch body.SourceID {
			case "source-a":
				sourceAStarts.Add(1)
				_, _ = io.WriteString(w, `{"runId":"source-a-run","startedAt":"2026-07-12T12:00:00Z","cursor":""}`)
			case "source-b":
				sourceBStarts.Add(1)
				_, _ = io.WriteString(w, `{"runId":"source-b-run","startedAt":"2026-07-12T12:00:00Z","cursor":""}`)
			default:
				t.Errorf("unexpected crawl source: %q", body.SourceID)
				w.WriteHeader(http.StatusBadRequest)
			}
		case r.Method == http.MethodPost && r.URL.Path == "/api/v1/workspace/agent/runs/source-a-run/batch":
			batchStartedOnce.Do(func() { close(batchStarted) })
			<-r.Context().Done()
			batchCancelledOnce.Do(func() { close(batchCancelled) })
		case r.Method == http.MethodPost && r.URL.Path == "/api/v1/workspace/agent/runs/source-b-run/batch":
			zr, err := gzip.NewReader(r.Body)
			if err != nil {
				t.Errorf("open source B batch: %v", err)
				w.WriteHeader(http.StatusBadRequest)
				return
			}
			defer zr.Close()
			var batch struct {
				Entries []Entry `json:"entries"`
			}
			if err := json.NewDecoder(zr).Decode(&batch); err != nil {
				t.Errorf("decode source B batch: %v", err)
				w.WriteHeader(http.StatusBadRequest)
				return
			}
			sourceBFirstBatchOnce.Do(func() { sourceBFirstBatchEntries <- len(batch.Entries) })
			<-r.Context().Done()
		case r.Method == http.MethodPost && r.URL.Path == "/api/v1/workspace/agent/sources/source-a/events":
			watchRequestStartedOnce.Do(func() { close(watchRequestStarted) })
			<-r.Context().Done()
			watchRequestCancelledOnce.Do(func() { close(watchRequestCancelled) })
		default:
			w.WriteHeader(http.StatusAccepted)
		}
	}))

	base := time.Date(2026, time.July, 12, 12, 0, 0, 0, time.UTC)
	var nowCalls atomic.Int64
	ctx, cancel := context.WithCancel(context.Background())
	done := StartLoop(ctx, Deps{
		Client:        client,
		Log:           loopTestLogger(),
		Enumerate:     func() []ProfileRoot { return []ProfileRoot{profile} },
		Now:           func() time.Time { return base.Add(time.Duration(nowCalls.Add(2)) * time.Second) },
		TickInterval:  time.Millisecond,
		WatchDebounce: time.Millisecond,
	})
	defer func() {
		cancel()
		waitLoopSignal(t, done, "loop shutdown")
	}()

	waitLoopSignal(t, batchStarted, "initial crawl batch")
	if err := os.WriteFile(filepath.Join(profile.Dir, "Documents", "watch-event.txt"), []byte("event"), 0o600); err != nil {
		t.Fatalf("write watcher event: %v", err)
	}
	waitLoopSignal(t, watchRequestStarted, "watcher event request")
	waitLoopSignal(t, batchCancelled, "disabled crawl cancellation")
	waitLoopSignal(t, watchRequestCancelled, "disabled watcher cancellation")

	// A fetch after the disabled reconciliation proves watcher.stop returned;
	// stop blocks until the real fsnotify watcher goroutine has exited.
	waitLoopCondition(t, func() bool { return configFetches.Load() >= 5 }, "entry into third post-stop disabled fetch")
	if got := sourceAStarts.Load(); got != 1 {
		t.Fatalf("source A crawl starts across disabled ticks = %d, want 1", got)
	}
	if got := sourceBStarts.Load(); got != 0 {
		t.Fatalf("queued source B starts across disabled ticks = %d, want 0", got)
	}

	reenabled.Store(true)
	waitLoopCondition(t, func() bool { return sourceBStarts.Load() >= 1 }, "fresh queued-source crawl after re-enabling")
	if got := sourceBStarts.Load(); got != 1 {
		t.Fatalf("source B crawl starts after re-enable = %d, want 1", got)
	}
	select {
	case got := <-sourceBFirstBatchEntries:
		if got <= 1 {
			t.Fatalf("source B first batch entries = %d, want more than 1 from fresh limits", got)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("timed out waiting for source B first batch")
	}
}

func makeLoopTestProfile(t *testing.T) ProfileRoot {
	t.Helper()
	profileDir := filepath.Join(t.TempDir(), "alice")
	documents := filepath.Join(profileDir, "Documents")
	if err := os.MkdirAll(documents, 0o755); err != nil {
		t.Fatalf("MkdirAll: %v", err)
	}
	if err := os.WriteFile(filepath.Join(documents, "report.txt"), []byte("report"), 0o600); err != nil {
		t.Fatalf("WriteFile: %v", err)
	}
	return ProfileRoot{Username: "alice", Dir: profileDir}
}

func writeLoopConfig(t *testing.T, w http.ResponseWriter, config CrawlConfig) {
	t.Helper()
	w.Header().Set("Content-Type", "application/json")
	if err := json.NewEncoder(w).Encode(config); err != nil {
		t.Errorf("encode config: %v", err)
	}
}

func loopTestLogger() *slog.Logger {
	return slog.New(slog.NewTextHandler(io.Discard, nil))
}

func waitLoopSignal(t *testing.T, signal <-chan struct{}, description string) {
	t.Helper()
	select {
	case <-signal:
	case <-time.After(2 * time.Second):
		t.Fatalf("timed out waiting for %s", description)
	}
}

func waitLoopCompletions(t *testing.T, completed <-chan string, count int) {
	t.Helper()
	for range count {
		select {
		case <-completed:
		case <-time.After(2 * time.Second):
			t.Fatalf("timed out waiting for completion %d of %d", count, count)
		}
	}
}

func waitLoopCondition(t *testing.T, condition func() bool, description string) {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for !condition() {
		if time.Now().After(deadline) {
			t.Fatalf("timed out waiting for %s", description)
		}
		time.Sleep(time.Millisecond)
	}
}

type recordingAuditLogger struct {
	mu      sync.Mutex
	types   []string
	details []map[string]any
}

func (r *recordingAuditLogger) Log(eventType string, _ string, details map[string]any) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.types = append(r.types, eventType)
	r.details = append(r.details, details)
}

func (r *recordingAuditLogger) snapshot() ([]string, []map[string]any) {
	r.mu.Lock()
	defer r.mu.Unlock()
	return append([]string(nil), r.types...), append([]map[string]any(nil), r.details...)
}

// TestStartLoopAuditsActivationTransitions pins #2425: workspace indexing is
// enabled purely by a server-side config flip, so each off→on transition must
// emit a device-audit event (and only transitions — not every poll).
func TestStartLoopAuditsActivationTransitions(t *testing.T) {
	// Far-future completion keeps every source not-due so no crawl machinery
	// runs; activation is keyed on enabled sources, not on crawls starting.
	farFuture := time.Now().Add(100_000 * time.Hour)
	var reqCount atomic.Int32
	client := newTestClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet || r.URL.Path != "/api/v1/workspace/agent/crawl-config" {
			t.Errorf("unexpected request: %s %s", r.Method, r.URL.Path)
			w.WriteHeader(http.StatusNotFound)
			return
		}
		// Fetch 1-2: enabled (one activation event, no duplicate).
		// Fetch 3: disabled (deactivation). Fetch 4+: enabled again (second event).
		n := reqCount.Add(1)
		config := CrawlConfig{Enabled: n != 3, PollIntervalSeconds: 1}
		if config.Enabled {
			config.Sources = []SourceConfig{{
				ID:                "source-docs",
				Kind:              "local_profile",
				RootPath:          "/home",
				CadenceMinutes:    60,
				LastCompleteRunAt: &farFuture,
			}}
		}
		writeLoopConfig(t, w, config)
	}))

	// Fake clock: each fetch attempt observes time advanced far past the poll
	// interval, so every ticker tick performs a real fetch.
	base := time.Now()
	var step atomic.Int64
	audit := &recordingAuditLogger{}

	ctx, cancel := context.WithCancel(context.Background())
	done := StartLoop(ctx, Deps{
		Client:       client,
		Log:          loopTestLogger(),
		Audit:        audit,
		Now:          func() time.Time { return base.Add(time.Duration(step.Add(1)) * time.Hour) },
		TickInterval: 5 * time.Millisecond,
	})

	// Expected trail: activated (fetch 1), deactivated (fetch 3), activated
	// (fetch 4). Fetch 2 repeats the identical scope and must NOT duplicate.
	waitForAuditEvents(t, audit, 3)
	cancel()
	<-done

	types, details := audit.snapshot()
	wantTypes := []string{
		"workspace_index_activated",
		"workspace_index_deactivated",
		"workspace_index_activated",
	}
	if !reflect.DeepEqual(types, wantTypes) {
		t.Fatalf("audit events = %v, want %v (transitions only, no per-poll duplicates)", types, wantTypes)
	}
	sources, ok := details[0]["sources"].([]map[string]any)
	if !ok || len(sources) != 1 {
		t.Fatalf("first activation details = %#v, want one source summary", details[0])
	}
	if sources[0]["id"] != "source-docs" || sources[0]["rootPath"] != "/home" || sources[0]["kind"] != "local_profile" {
		t.Fatalf("source summary = %#v", sources[0])
	}
	if details[0]["scopeChange"] != false {
		t.Fatalf("first activation scopeChange = %v, want false", details[0]["scopeChange"])
	}
	if details[1]["reason"] == "" || details[1]["reason"] == nil {
		t.Fatalf("deactivation details = %#v, want a reason", details[1])
	}
}

// TestStartLoopAuditsScopeWideningWhileActive pins the harder half of #2425:
// the consent trace must also fire when the server WIDENS indexing while it is
// already active (adds a source / repoints a rootPath). A plain on/off latch
// would let the new location be enumerated under the first activation's trace,
// silently — which is the most privacy-significant case.
func TestStartLoopAuditsScopeWideningWhileActive(t *testing.T) {
	farFuture := time.Now().Add(100_000 * time.Hour)
	var reqCount atomic.Int32
	client := newTestClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet || r.URL.Path != "/api/v1/workspace/agent/crawl-config" {
			t.Errorf("unexpected request: %s %s", r.Method, r.URL.Path)
			w.WriteHeader(http.StatusNotFound)
			return
		}
		docs := SourceConfig{
			ID: "source-docs", Kind: "local_profile", RootPath: "/home",
			CadenceMinutes: 60, LastCompleteRunAt: &farFuture,
		}
		config := CrawlConfig{Enabled: true, PollIntervalSeconds: 1, Sources: []SourceConfig{docs}}
		// From the 3rd fetch on, the server also indexes an SMB share —
		// indexing never went inactive, so a boolean latch would say nothing.
		if reqCount.Add(1) >= 3 {
			config.Sources = append(config.Sources, SourceConfig{
				ID: "source-share", Kind: "smb_share", RootPath: `\\fileserver\finance`,
				CadenceMinutes: 60, LastCompleteRunAt: &farFuture,
			})
		}
		writeLoopConfig(t, w, config)
	}))

	base := time.Now()
	var step atomic.Int64
	audit := &recordingAuditLogger{}

	ctx, cancel := context.WithCancel(context.Background())
	done := StartLoop(ctx, Deps{
		Client:       client,
		Log:          loopTestLogger(),
		Audit:        audit,
		Now:          func() time.Time { return base.Add(time.Duration(step.Add(1)) * time.Hour) },
		TickInterval: 5 * time.Millisecond,
	})

	waitForAuditEvents(t, audit, 2)
	cancel()
	<-done

	types, details := audit.snapshot()
	if len(types) != 2 || types[0] != "workspace_index_activated" || types[1] != "workspace_index_activated" {
		t.Fatalf("audit events = %v, want exactly 2 activation events (initial + scope widening)", types)
	}
	if details[0]["scopeChange"] != false {
		t.Fatalf("initial activation scopeChange = %v, want false", details[0]["scopeChange"])
	}
	if details[1]["scopeChange"] != true {
		t.Fatalf("widening event scopeChange = %v, want true", details[1]["scopeChange"])
	}
	sources, ok := details[1]["sources"].([]map[string]any)
	if !ok || len(sources) != 2 {
		t.Fatalf("widening details = %#v, want two source summaries", details[1])
	}
	// Summaries are ordered by source ID: source-docs, source-share.
	if sources[1]["id"] != "source-share" || sources[1]["rootPath"] != `\\fileserver\finance` {
		t.Fatalf("newly added source summary = %#v, want the SMB share named", sources[1])
	}
}

func waitForAuditEvents(t *testing.T, audit *recordingAuditLogger, count int) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for {
		types, _ := audit.snapshot()
		if len(types) >= count {
			return
		}
		if time.Now().After(deadline) {
			t.Fatalf("timed out waiting for %d audit events, got %d (%v)", count, len(types), types)
		}
		time.Sleep(5 * time.Millisecond)
	}
}
