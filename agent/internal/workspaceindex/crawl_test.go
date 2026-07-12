package workspaceindex

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

type crawlCompletion struct {
	Complete bool   `json:"complete"`
	Stats    Stats  `json:"stats"`
	Error    string `json:"error"`
}

func TestRunCrawlLocalProfileUploadsBatchesAndCompletesWithStats(t *testing.T) {
	profileDir := filepath.Join(t.TempDir(), "alice")
	documentsDir := filepath.Join(profileDir, "Documents")
	if err := os.MkdirAll(filepath.Join(documentsDir, "projects"), 0o755); err != nil {
		t.Fatalf("MkdirAll: %v", err)
	}
	if err := os.WriteFile(filepath.Join(documentsDir, "notes.txt"), []byte("notes"), 0o600); err != nil {
		t.Fatalf("WriteFile notes: %v", err)
	}
	if err := os.WriteFile(filepath.Join(documentsDir, "projects", "plan.md"), []byte("plan"), 0o600); err != nil {
		t.Fatalf("WriteFile plan: %v", err)
	}

	var requests []string
	var batches []receivedBatch
	var completion crawlCompletion
	client := newTestClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests = append(requests, r.URL.Path)
		switch r.URL.Path {
		case "/api/v1/workspace/agent/runs":
			w.Header().Set("Content-Type", "application/json")
			_, _ = io.WriteString(w, `{"runId":"run-happy","cursor":""}`)
		case "/api/v1/workspace/agent/runs/run-happy/batch":
			batches = append(batches, decodeReceivedBatch(t, r))
			w.WriteHeader(http.StatusAccepted)
		case "/api/v1/workspace/agent/runs/run-happy/complete":
			if err := json.NewDecoder(r.Body).Decode(&completion); err != nil {
				t.Errorf("decode completion: %v", err)
			}
			w.WriteHeader(http.StatusAccepted)
		default:
			t.Errorf("unexpected request: %s %s", r.Method, r.URL.Path)
			w.WriteHeader(http.StatusNotFound)
		}
	}))

	deps := Deps{
		Client: client,
		Log:    slog.New(slog.NewTextHandler(io.Discard, nil)),
		Enumerate: func() []ProfileRoot {
			return []ProfileRoot{{Username: "alice", Dir: profileDir}}
		},
	}
	err := runCrawl(context.Background(), deps, SourceConfig{
		ID: "local-1", Kind: "local_profile",
	}, ConfigLimits{MaxBatchEntries: 2, MaxBatchBytes: 1_000_000, WalkOpsPerSecond: 10_000})
	if err != nil {
		t.Fatalf("runCrawl: %v", err)
	}

	if want := []string{
		"/api/v1/workspace/agent/runs",
		"/api/v1/workspace/agent/runs/run-happy/batch",
		"/api/v1/workspace/agent/runs/run-happy/batch",
		"/api/v1/workspace/agent/runs/run-happy/complete",
	}; !reflect.DeepEqual(requests, want) {
		t.Fatalf("request order = %#v, want %#v", requests, want)
	}
	var paths []string
	for _, batch := range batches {
		paths = append(paths, entryRelPaths(batch.Entries)...)
	}
	wantPaths := []string{
		"alice/Documents/notes.txt",
		"alice/Documents/projects",
		"alice/Documents/projects/plan.md",
	}
	if !reflect.DeepEqual(paths, wantPaths) {
		t.Fatalf("uploaded paths = %#v, want %#v", paths, wantPaths)
	}
	if !completion.Complete || completion.Error != "" {
		t.Fatalf("completion = %+v, want successful completion", completion)
	}
	if want := (Stats{Seen: len(wantPaths), Errors: 0}); completion.Stats != want {
		t.Fatalf("completion stats = %+v, want %+v", completion.Stats, want)
	}
}

func TestRunCrawlSMBDialFailureCompletesWithoutBatchOrCredentialLeak(t *testing.T) {
	const password = "dont-log-this-password"
	var (
		batchRequests int
		completion    crawlCompletion
		dialedCred    *Credential
	)
	client := newTestClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/v1/workspace/agent/runs":
			w.Header().Set("Content-Type", "application/json")
			_, _ = io.WriteString(w, `{"runId":"run-smb","cursor":""}`)
		case "/api/v1/workspace/agent/sources/smb-1/credential":
			w.Header().Set("Content-Type", "application/json")
			_, _ = io.WriteString(w, `{"username":"svc-crawler","password":"`+password+`"}`)
		case "/api/v1/workspace/agent/runs/run-smb/batch":
			batchRequests++
			w.WriteHeader(http.StatusAccepted)
		case "/api/v1/workspace/agent/runs/run-smb/complete":
			if err := json.NewDecoder(r.Body).Decode(&completion); err != nil {
				t.Errorf("decode completion: %v", err)
			}
			w.WriteHeader(http.StatusAccepted)
		default:
			t.Errorf("unexpected request: %s %s", r.Method, r.URL.Path)
			w.WriteHeader(http.StatusNotFound)
		}
	}))

	var logs bytes.Buffer
	deps := Deps{
		Client: client,
		Log:    slog.New(slog.NewTextHandler(&logs, nil)),
		DialSMB: func(_ context.Context, _ string, cred *Credential) (SourceFS, io.Closer, error) {
			dialedCred = cred
			return nil, nil, errors.New("NTLM rejected password " + cred.Password)
		},
	}
	err := runCrawl(context.Background(), deps, SourceConfig{
		ID: "smb-1", Kind: "smb_share", RootPath: `\\fileserver\workspace`, HasCredential: true,
	}, ConfigLimits{WalkOpsPerSecond: 10_000})
	if err == nil {
		t.Fatal("runCrawl error = nil, want SMB dial failure")
	}
	if batchRequests != 0 {
		t.Fatalf("batch requests = %d, want 0", batchRequests)
	}
	if completion.Complete || completion.Error == "" {
		t.Fatalf("completion = %+v, want failed completion with a reason", completion)
	}
	if strings.Contains(completion.Error, password) {
		t.Fatalf("completion reason leaked password: %q", completion.Error)
	}
	if strings.Contains(logs.String(), password) {
		t.Fatalf("captured slog output leaked password: %q", logs.String())
	}
	for cause := err; cause != nil; cause = errors.Unwrap(cause) {
		if strings.Contains(cause.Error(), password) {
			t.Fatalf("returned error chain retained password: %q", cause.Error())
		}
	}
	if dialedCred == nil {
		t.Fatal("DialSMB did not receive a credential")
	}
	if dialedCred.Username != "" || dialedCred.Password != "" || dialedCred.Domain != nil {
		t.Fatalf("credential retained after dial: %#v", dialedCred)
	}
}

func TestRunCrawlLocalProfileResumeCursorUsesPrefixedCursorSpace(t *testing.T) {
	profileDir := filepath.Join(t.TempDir(), "alice")
	documentsDir := filepath.Join(profileDir, "Documents")
	downloadsDir := filepath.Join(profileDir, "Downloads")
	for _, dir := range []string{documentsDir, downloadsDir} {
		if err := os.MkdirAll(dir, 0o755); err != nil {
			t.Fatalf("MkdirAll %s: %v", dir, err)
		}
	}
	for path, contents := range map[string]string{
		filepath.Join(documentsDir, "before-prefix.txt"): "old",
		filepath.Join(downloadsDir, "a.txt"):             "at cursor",
		filepath.Join(downloadsDir, "b.txt"):             "after cursor",
	} {
		if err := os.WriteFile(path, []byte(contents), 0o600); err != nil {
			t.Fatalf("WriteFile %s: %v", path, err)
		}
	}

	var uploaded []string
	client := newTestClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/v1/workspace/agent/runs":
			w.Header().Set("Content-Type", "application/json")
			_, _ = io.WriteString(w, `{"runId":"run-resume","cursor":"alice/Downloads/a.txt"}`)
		case "/api/v1/workspace/agent/runs/run-resume/batch":
			uploaded = append(uploaded, entryRelPaths(decodeReceivedBatch(t, r).Entries)...)
			w.WriteHeader(http.StatusAccepted)
		case "/api/v1/workspace/agent/runs/run-resume/complete":
			w.WriteHeader(http.StatusAccepted)
		default:
			t.Errorf("unexpected request: %s %s", r.Method, r.URL.Path)
			w.WriteHeader(http.StatusNotFound)
		}
	}))

	deps := Deps{
		Client: client,
		Log:    slog.New(slog.NewTextHandler(io.Discard, nil)),
		Enumerate: func() []ProfileRoot {
			return []ProfileRoot{{Username: "alice", Dir: profileDir}}
		},
	}
	src := SourceConfig{
		ID:   "local-resume",
		Kind: "local_profile",
		ActiveRun: &ActiveRun{
			RunID:  "run-resume",
			Cursor: "alice/Downloads/a.txt",
		},
	}
	if err := runCrawl(context.Background(), deps, src, ConfigLimits{
		MaxBatchEntries: 10, MaxBatchBytes: 1_000_000, WalkOpsPerSecond: 10_000,
	}); err != nil {
		t.Fatalf("runCrawl: %v", err)
	}

	want := []string{"alice/Downloads/b.txt"}
	if !reflect.DeepEqual(uploaded, want) {
		t.Fatalf("uploaded paths after %q = %#v, want %#v; earlier directory prefixes and entries through the cursor must be skipped", src.ActiveRun.Cursor, uploaded, want)
	}
}

func TestRunCrawlZeroesCredentialWhenSMBDialPanics(t *testing.T) {
	var dialedCred *Credential
	client := newTestClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/v1/workspace/agent/runs":
			_, _ = io.WriteString(w, `{"runId":"run-panic","cursor":""}`)
		case "/api/v1/workspace/agent/sources/smb-panic/credential":
			_, _ = io.WriteString(w, `{"username":"panic-user","password":"panic-secret"}`)
		default:
			w.WriteHeader(http.StatusAccepted)
		}
	}))

	defer func() {
		if recover() == nil {
			t.Fatal("runCrawl did not propagate dial panic")
		}
		if dialedCred == nil || dialedCred.Username != "" || dialedCred.Password != "" || dialedCred.Domain != nil {
			t.Fatalf("credential retained after dial panic: %#v", dialedCred)
		}
	}()

	_ = runCrawl(context.Background(), Deps{
		Client: client,
		Log:    slog.New(slog.NewTextHandler(io.Discard, nil)),
		DialSMB: func(_ context.Context, _ string, cred *Credential) (SourceFS, io.Closer, error) {
			dialedCred = cred
			panic("dial panic")
		},
	}, SourceConfig{ID: "smb-panic", Kind: "smb_share", RootPath: `\\server\share`}, ConfigLimits{})
}
