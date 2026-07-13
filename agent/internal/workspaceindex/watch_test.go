package workspaceindex

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"os"
	"path"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

type watchEventsPayload struct {
	Upserts []Entry  `json:"upserts"`
	Deletes []string `json:"deletes"`
}

func TestExcludedWalkPathHelperCoversHiddenAndGlobbedPaths(t *testing.T) {
	globs := append(append([]string(nil), defaultExcludeGlobs...), "ignored/**")
	tests := []struct {
		path string
		want bool
	}{
		{path: ".hidden", want: true},
		{path: "ignored/child.txt", want: true},
		{path: "visible.txt", want: false},
	}
	for _, tt := range tests {
		t.Run(tt.path, func(t *testing.T) {
			if got := excludedWalkPath(tt.path, globs); got != tt.want {
				t.Fatalf("excludedWalkPath(%q) = %v, want %v", tt.path, got, tt.want)
			}
		})
	}
}

func TestStartWatchDebouncesAndCoalescesEventsIntoOnePost(t *testing.T) {
	const debounce = 250 * time.Millisecond
	profileDir := filepath.Join(t.TempDir(), "alice")
	documentsDir := filepath.Join(profileDir, "Documents")
	if err := os.MkdirAll(documentsDir, 0o755); err != nil {
		t.Fatalf("MkdirAll: %v", err)
	}
	doomedPath := filepath.Join(documentsDir, "doomed.txt")
	if err := os.WriteFile(doomedPath, []byte("remove me"), 0o600); err != nil {
		t.Fatalf("seed doomed file: %v", err)
	}

	payloads := make(chan watchEventsPayload, 4)
	client := newTestClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || r.URL.Path != "/api/v1/workspace/agent/sources/source-watch/events" {
			w.WriteHeader(http.StatusNotFound)
			return
		}
		var payload watchEventsPayload
		if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		payloads <- payload
		w.WriteHeader(http.StatusNoContent)
	}))

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	stop := startWatch(ctx, Deps{
		Client:        client,
		Log:           slog.New(slog.NewTextHandler(io.Discard, nil)),
		Enumerate:     func() []ProfileRoot { return []ProfileRoot{{Username: "alice", Dir: profileDir}} },
		WatchDebounce: debounce,
		WatchDirCap:   16,
	}, SourceConfig{ID: "source-watch", Kind: "local_profile", Watch: true})
	defer stop()

	keepPath := filepath.Join(documentsDir, "keep.txt")
	if err := os.WriteFile(keepPath, []byte("first"), 0o600); err != nil {
		t.Fatalf("create keep file: %v", err)
	}
	if err := os.WriteFile(keepPath, []byte("final contents"), 0o600); err != nil {
		t.Fatalf("rewrite keep file: %v", err)
	}
	if err := os.Remove(doomedPath); err != nil {
		t.Fatalf("remove doomed file: %v", err)
	}

	var payload watchEventsPayload
	select {
	case payload = <-payloads:
	case <-time.After(3 * time.Second):
		t.Fatal("timed out waiting for debounced events request")
	}

	if len(payload.Upserts) != 1 {
		t.Fatalf("upserts = %+v, want one coalesced entry", payload.Upserts)
	}
	upsert := payload.Upserts[0]
	if upsert.RelPath != "alice/Documents/keep.txt" || upsert.Name != "keep.txt" || upsert.IsDir {
		t.Fatalf("upsert = %+v, want alice/Documents/keep.txt file", upsert)
	}
	if upsert.Size != int64(len("final contents")) {
		t.Fatalf("upsert size = %d, want %d", upsert.Size, len("final contents"))
	}
	if len(payload.Deletes) != 1 || payload.Deletes[0] != "alice/Documents/doomed.txt" {
		t.Fatalf("deletes = %v, want alice/Documents/doomed.txt", payload.Deletes)
	}

	select {
	case extra := <-payloads:
		t.Fatalf("received second PostEvents payload after coalescing: %+v", extra)
	case <-time.After(4 * debounce):
	}
}

func TestStartWatchDegradesToCrawlOnlyWhenDirectoryCapExceeded(t *testing.T) {
	profileDir := filepath.Join(t.TempDir(), "alice")
	documentsDir := filepath.Join(profileDir, "Documents")
	if err := os.MkdirAll(filepath.Join(documentsDir, "nested"), 0o755); err != nil {
		t.Fatalf("MkdirAll: %v", err)
	}

	var eventPosts atomic.Int32
	client := newTestClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodPost && r.URL.Path == "/api/v1/workspace/agent/sources/source-capped/events" {
			eventPosts.Add(1)
		}
		w.WriteHeader(http.StatusNoContent)
	}))

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	stop := startWatch(ctx, Deps{
		Client:        client,
		Log:           slog.New(slog.NewTextHandler(io.Discard, nil)),
		Enumerate:     func() []ProfileRoot { return []ProfileRoot{{Username: "alice", Dir: profileDir}} },
		WatchDebounce: 25 * time.Millisecond,
		WatchDirCap:   1,
	}, SourceConfig{ID: "source-capped", Kind: "local_profile", Watch: true})
	defer stop()

	if err := os.WriteFile(filepath.Join(documentsDir, "after-cap.txt"), []byte("ignored"), 0o600); err != nil {
		t.Fatalf("write after cap exceeded: %v", err)
	}
	time.Sleep(6 * 25 * time.Millisecond)

	if got := eventPosts.Load(); got != 0 {
		t.Fatalf("PostEvents calls = %d, want 0 after watcher degraded to crawl-only", got)
	}
}

func TestStartWatchExcludedDirectoriesDoNotConsumeCap(t *testing.T) {
	profileDir := filepath.Join(t.TempDir(), "alice")
	documentsDir := filepath.Join(profileDir, "Documents")
	if err := os.MkdirAll(filepath.Join(documentsDir, "ignored", "nested"), 0o755); err != nil {
		t.Fatalf("MkdirAll: %v", err)
	}

	payloads := make(chan watchEventsPayload, 1)
	client := newTestClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var payload watchEventsPayload
		if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		payloads <- payload
		w.WriteHeader(http.StatusNoContent)
	}))

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	stop := startWatch(ctx, Deps{
		Client:        client,
		Log:           slog.New(slog.NewTextHandler(io.Discard, nil)),
		Enumerate:     func() []ProfileRoot { return []ProfileRoot{{Username: "alice", Dir: profileDir}} },
		WatchDebounce: 50 * time.Millisecond,
		WatchDirCap:   1,
	}, SourceConfig{
		ID: "source-exclusions", Kind: "local_profile", Watch: true,
		ExcludeGlobs: []string{"ignored/**"},
	})
	defer stop()

	if err := os.WriteFile(filepath.Join(documentsDir, "visible.txt"), []byte("visible"), 0o600); err != nil {
		t.Fatalf("write visible file: %v", err)
	}
	select {
	case payload := <-payloads:
		if len(payload.Upserts) != 1 || payload.Upserts[0].RelPath != "alice/Documents/visible.txt" {
			t.Fatalf("payload = %+v, want visible file only", payload)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("excluded directory consumed watch cap and degraded watcher")
	}
}

// TestStartWatchExcludesHiddenFilesFromUpserts drives the real fsnotify handler
// to pin the #2425 privacy hole at the exact place it bit: the create/write
// branch, where isDir is known. The old watch.go called the exclusion helper
// with isDir=false for a hidden FILE, which skipped the dot-segment check
// entirely, so .env — matched by none of the default globs — was uploaded via
// PostEvents. A helper-level unit test cannot catch a re-introduced isDir gate
// at this call site; only driving the watcher can.
func TestStartWatchExcludesHiddenFilesFromUpserts(t *testing.T) {
	const debounce = 250 * time.Millisecond
	profileDir := filepath.Join(t.TempDir(), "alice")
	documentsDir := filepath.Join(profileDir, "Documents")
	if err := os.MkdirAll(documentsDir, 0o755); err != nil {
		t.Fatalf("MkdirAll: %v", err)
	}

	payloads := make(chan watchEventsPayload, 4)
	client := newTestClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || r.URL.Path != "/api/v1/workspace/agent/sources/source-watch/events" {
			w.WriteHeader(http.StatusNotFound)
			return
		}
		var payload watchEventsPayload
		if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		payloads <- payload
		w.WriteHeader(http.StatusNoContent)
	}))

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	stop := startWatch(ctx, Deps{
		Client:        client,
		Log:           slog.New(slog.NewTextHandler(io.Discard, nil)),
		Enumerate:     func() []ProfileRoot { return []ProfileRoot{{Username: "alice", Dir: profileDir}} },
		WatchDebounce: debounce,
		WatchDirCap:   16,
	}, SourceConfig{ID: "source-watch", Kind: "local_profile", Watch: true})
	defer stop()

	// Credential-bearing dotfiles, none of which any default glob matches.
	for _, hidden := range []string{".env", ".npmrc", ".pgpass"} {
		if err := os.WriteFile(filepath.Join(documentsDir, hidden), []byte("SECRET=1"), 0o600); err != nil {
			t.Fatalf("create %s: %v", hidden, err)
		}
	}
	// A visible file guarantees the watcher really is delivering events — without
	// it, an exclusion assertion would pass vacuously on a dead watcher.
	if err := os.WriteFile(filepath.Join(documentsDir, "visible.txt"), []byte("ok"), 0o600); err != nil {
		t.Fatalf("create visible file: %v", err)
	}

	var payload watchEventsPayload
	select {
	case payload = <-payloads:
	case <-time.After(3 * time.Second):
		t.Fatal("timed out waiting for debounced events request")
	}

	if len(payload.Upserts) != 1 {
		t.Fatalf("upserts = %+v, want only the visible file (hidden files must not be indexed)", payload.Upserts)
	}
	if got := payload.Upserts[0].RelPath; got != "alice/Documents/visible.txt" {
		t.Fatalf("upsert relPath = %q, want alice/Documents/visible.txt", got)
	}
	for _, upsert := range payload.Upserts {
		if strings.HasPrefix(path.Base(upsert.RelPath), ".") {
			t.Fatalf("hidden file %q was indexed and uploaded (#2425)", upsert.RelPath)
		}
	}
}
