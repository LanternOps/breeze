package workspaceindex

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"io/fs"
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

type failingCrawlFS struct {
	err error
}

func (f failingCrawlFS) ReadDir(string) ([]fs.DirEntry, error) { return nil, f.err }
func (f failingCrawlFS) Stat(string) (fs.FileInfo, error)      { return nil, f.err }

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

func TestRunCrawlSMBWalkFailureRedactsCredentialFromCompletionAndReturn(t *testing.T) {
	const (
		username = "svc-workspace"
		password = "walk-secret-password"
		domain   = "CORP-SECRET"
	)
	var (
		completion crawlCompletion
		dialedCred *Credential
	)
	client := newTestClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/v1/workspace/agent/runs":
			w.Header().Set("Content-Type", "application/json")
			_, _ = io.WriteString(w, `{"runId":"run-smb-walk","cursor":""}`)
		case "/api/v1/workspace/agent/sources/smb-walk/credential":
			w.Header().Set("Content-Type", "application/json")
			_, _ = io.WriteString(w, `{"username":"`+username+`","password":"`+password+`","domain":"`+domain+`"}`)
		case "/api/v1/workspace/agent/runs/run-smb-walk/complete":
			if err := json.NewDecoder(r.Body).Decode(&completion); err != nil {
				t.Errorf("decode completion: %v", err)
			}
			w.WriteHeader(http.StatusAccepted)
		default:
			t.Errorf("unexpected request: %s %s", r.Method, r.URL.Path)
			w.WriteHeader(http.StatusNotFound)
		}
	}))

	walkErr := errors.New("SMB access denied for " + domain + `\` + username + " using " + password)
	err := runCrawl(context.Background(), Deps{
		Client: client,
		Log:    slog.New(slog.NewTextHandler(io.Discard, nil)),
		DialSMB: func(_ context.Context, _ string, cred *Credential) (SourceFS, io.Closer, error) {
			dialedCred = cred
			return failingCrawlFS{err: walkErr}, nil, nil
		},
	}, SourceConfig{
		ID: "smb-walk", Kind: "smb_share", RootPath: `\\server\share`, HasCredential: true,
	}, ConfigLimits{WalkOpsPerSecond: 10_000})
	if err == nil {
		t.Fatal("runCrawl error = nil, want SMB walk failure")
	}
	if completion.Complete || completion.Error == "" {
		t.Fatalf("completion = %+v, want failed completion with a reason", completion)
	}
	for _, surface := range []struct {
		name  string
		value string
	}{
		{name: "completion reason", value: completion.Error},
		{name: "returned error", value: err.Error()},
	} {
		for _, secret := range []string{username, password, domain} {
			if strings.Contains(surface.value, secret) {
				t.Errorf("%s leaked credential value %q: %q", surface.name, secret, surface.value)
			}
		}
	}
	if dialedCred == nil {
		t.Fatal("DialSMB did not receive a credential")
	}
	if dialedCred.Username != "" || dialedCred.Password != "" || dialedCred.Domain != nil {
		t.Fatalf("credential retained after successful dial: %#v", dialedCred)
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

func TestRunCrawlLocalProfileOrdersUsersAndResumesAcrossMultipleRoots(t *testing.T) {
	profilesBase := t.TempDir()
	aliceDir := filepath.Join(profilesBase, "alice")
	bobDir := filepath.Join(profilesBase, "bob")
	for _, profileDir := range []string{aliceDir, bobDir} {
		for _, crawlDir := range []string{"Documents", "Downloads"} {
			if err := os.MkdirAll(filepath.Join(profileDir, crawlDir), 0o755); err != nil {
				t.Fatalf("MkdirAll %s/%s: %v", profileDir, crawlDir, err)
			}
		}
	}

	files := map[string]string{
		filepath.Join(aliceDir, "Documents", "01-alice-document.txt"): "alice document one",
		filepath.Join(aliceDir, "Documents", "02-alice-document.txt"): "alice document two",
		filepath.Join(aliceDir, "Downloads", "01-alice-download.txt"): "alice download",
		filepath.Join(bobDir, "Documents", "01-cursor.txt"):           "bob cursor",
		filepath.Join(bobDir, "Documents", "02-after-cursor.txt"):     "bob after cursor",
		filepath.Join(bobDir, "Documents", "03-last-document.txt"):    "bob last document",
		filepath.Join(bobDir, "Downloads", "01-later-folder.txt"):     "bob later folder",
	}
	for file, contents := range files {
		if err := os.WriteFile(file, []byte(contents), 0o600); err != nil {
			t.Fatalf("WriteFile %s: %v", file, err)
		}
	}

	// Return profiles in the opposite order to prove crawl ordering does not
	// depend on the platform enumerator's result order.
	enumerate := func() []ProfileRoot {
		return []ProfileRoot{
			{Username: "bob", Dir: bobDir},
			{Username: "alice", Dir: aliceDir},
		}
	}
	limits := ConfigLimits{MaxBatchEntries: 2, MaxBatchBytes: 1_000_000, WalkOpsPerSecond: 10_000}

	run := func(runID, cursor string) []string {
		t.Helper()
		var uploaded []string
		client := newTestClient(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			switch r.URL.Path {
			case "/api/v1/workspace/agent/runs":
				w.Header().Set("Content-Type", "application/json")
				_, _ = io.WriteString(w, `{"runId":"`+runID+`","cursor":"`+cursor+`"}`)
			case "/api/v1/workspace/agent/runs/" + runID + "/batch":
				uploaded = append(uploaded, entryRelPaths(decodeReceivedBatch(t, r).Entries)...)
				w.WriteHeader(http.StatusAccepted)
			case "/api/v1/workspace/agent/runs/" + runID + "/complete":
				w.WriteHeader(http.StatusAccepted)
			default:
				t.Errorf("unexpected request: %s %s", r.Method, r.URL.Path)
				w.WriteHeader(http.StatusNotFound)
			}
		}))
		src := SourceConfig{ID: "local-multi-user", Kind: "local_profile"}
		if cursor != "" {
			src.ActiveRun = &ActiveRun{RunID: runID, Cursor: cursor}
		}
		if err := runCrawl(context.Background(), Deps{
			Client:    client,
			Log:       slog.New(slog.NewTextHandler(io.Discard, nil)),
			Enumerate: enumerate,
		}, src, limits); err != nil {
			t.Fatalf("runCrawl(%q, %q): %v", runID, cursor, err)
		}
		return uploaded
	}

	full := run("run-multi-user-full", "")
	wantFull := []string{
		"alice/Documents/01-alice-document.txt",
		"alice/Documents/02-alice-document.txt",
		"alice/Downloads/01-alice-download.txt",
		"bob/Documents/01-cursor.txt",
		"bob/Documents/02-after-cursor.txt",
		"bob/Documents/03-last-document.txt",
		"bob/Downloads/01-later-folder.txt",
	}
	if !reflect.DeepEqual(full, wantFull) {
		t.Fatalf("full uploaded paths = %#v, want %#v; all alice roots must precede all bob roots", full, wantFull)
	}
	firstBob := -1
	for i, relPath := range full {
		if strings.HasPrefix(relPath, "bob/") {
			firstBob = i
			break
		}
	}
	if firstBob < 0 {
		t.Fatalf("full uploaded paths contain no bob entry: %#v", full)
	}
	for i, relPath := range full {
		if strings.HasPrefix(relPath, "alice/") && i >= firstBob {
			t.Fatalf("alice entry %q at index %d followed first bob entry at index %d: %#v", relPath, i, firstBob, full)
		}
	}

	const resumeCursor = "bob/Documents/01-cursor.txt"
	resumed := run("run-multi-user-resume", resumeCursor)
	wantResumed := []string{
		"bob/Documents/02-after-cursor.txt",
		"bob/Documents/03-last-document.txt",
		"bob/Downloads/01-later-folder.txt",
	}
	if !reflect.DeepEqual(resumed, wantResumed) {
		t.Fatalf("uploaded paths after %q = %#v, want %#v; resume must continue bob/Documents mid-stream and walk bob's later root", resumeCursor, resumed, wantResumed)
	}
	for _, relPath := range resumed {
		if strings.HasPrefix(relPath, "alice/") {
			t.Fatalf("resume after %q re-emitted alice path %q: %#v", resumeCursor, relPath, resumed)
		}
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
