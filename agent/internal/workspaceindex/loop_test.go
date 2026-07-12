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
