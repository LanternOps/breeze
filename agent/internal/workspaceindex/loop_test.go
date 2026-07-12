package workspaceindex

import (
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
