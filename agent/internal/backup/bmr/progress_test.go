package bmr

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func setProgressRetryDelayForTest(d time.Duration) {
	progressRetryDelay = d
}

func TestPostRecoveryProgress_SendsExpectedBody(t *testing.T) {
	var mu sync.Mutex
	var gotPath string
	var gotBody map[string]any

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		gotPath = r.URL.Path
		_ = json.NewDecoder(r.Body).Decode(&gotBody)
		mu.Unlock()
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{"id": "rec-1", "status": "restoring"})
	}))
	defer server.Close()

	err := PostRecoveryProgress(context.Background(), server.URL, "brz_rec_test", ProgressUpdate{Status: "restoring"})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	mu.Lock()
	defer mu.Unlock()
	if gotPath != "/api/v1/backup/bmr/recover/progress" {
		t.Fatalf("unexpected path: %s", gotPath)
	}
	if gotBody["token"] != "brz_rec_test" || gotBody["status"] != "restoring" {
		t.Fatalf("unexpected body: %+v", gotBody)
	}
}

func TestPostRecoveryProgress_ConflictReturnsTypedError(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusConflict)
		_ = json.NewEncoder(w).Encode(map[string]any{"error": "invalid_transition", "from": "restoring", "to": "planned"})
	}))
	defer server.Close()

	err := PostRecoveryProgress(context.Background(), server.URL, "brz_rec_test", ProgressUpdate{Status: "planned"})
	if err == nil {
		t.Fatal("expected an error")
	}
	var conflictErr *ProgressConflictError
	if !asProgressConflictError(err, &conflictErr) {
		t.Fatalf("expected *ProgressConflictError, got %T: %v", err, err)
	}
	if conflictErr.From != "restoring" || conflictErr.To != "planned" {
		t.Fatalf("unexpected conflict fields: %+v", conflictErr)
	}
}

func asProgressConflictError(err error, target **ProgressConflictError) bool {
	if ce, ok := err.(*ProgressConflictError); ok {
		*target = ce
		return true
	}
	return false
}

func TestPostRecoveryProgress_RetriesOnServerErrorThenSucceeds(t *testing.T) {
	origDelay := progressRetryDelay
	setProgressRetryDelayForTest(0)
	t.Cleanup(func() { setProgressRetryDelayForTest(origDelay) })

	var calls int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		n := atomic.AddInt32(&calls, 1)
		if n <= 2 {
			w.WriteHeader(http.StatusServiceUnavailable)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{"id": "rec-1", "status": "restoring"})
	}))
	defer server.Close()

	err := PostRecoveryProgress(context.Background(), server.URL, "brz_rec_test", ProgressUpdate{Status: "restoring"})
	if err != nil {
		t.Fatalf("unexpected error after retries: %v", err)
	}
	if got := atomic.LoadInt32(&calls); got != 3 {
		t.Fatalf("expected 3 calls (2 failures + 1 success), got %d", got)
	}
}

func TestBoundProgressUpdate_TruncatesWarningsAndFailedFilesSample(t *testing.T) {
	sample := make([]string, 200)
	for i := range sample {
		sample[i] = fmt.Sprintf("/src/%d", i)
	}
	warnings := make([]string, 100)
	for i := range warnings {
		warnings[i] = strings.Repeat("w", 3000)
	}
	u := ProgressUpdate{
		Status:   "failed",
		Reason:   strings.Repeat("r", 5000),
		Warnings: warnings,
		Result:   map[string]any{"failedFilesSample": sample, "filesFailed": 98411},
	}
	bounded := BoundProgressUpdate(u)

	if got := len([]rune(bounded.Reason)); got > 2000 {
		t.Errorf("Reason = %d runes, want <= 2000", got)
	}
	if got := len(bounded.Warnings); got > 64 {
		t.Errorf("len(Warnings) = %d, want <= 64", got)
	}
	for i, w := range bounded.Warnings {
		if got := len([]rune(w)); got > 2000 {
			t.Errorf("Warnings[%d] = %d runes, want <= 2000", i, got)
		}
	}
	body, err := json.Marshal(bounded)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	if len(body) >= 768*1024 {
		t.Errorf("serialized body = %d bytes, want < 768 KiB", len(body))
	}

	// The original u must not be mutated.
	if len(u.Warnings) != 100 || len([]rune(u.Reason)) != 5000 {
		t.Fatalf("BoundProgressUpdate mutated its input: warnings=%d reasonRunes=%d", len(u.Warnings), len([]rune(u.Reason)))
	}
}

func TestBoundProgressUpdate_ExtremeBodyFallsBackToTruncatedSummary(t *testing.T) {
	// 50 entries of ~20 KiB each — the sample trim to 50 entries runs
	// BEFORE the size check, so a naive huge-count sample never reaches
	// the fallback branch. Making each of the (already-trimmed) 50
	// entries individually large is what pushes the serialized body over
	// 768 KiB (50 x 20 KiB > 768 KiB) and forces the fallback to fire
	// deterministically.
	sample := make([]string, 50)
	for i := range sample {
		sample[i] = strings.Repeat("x", 20*1024)
	}
	u := ProgressUpdate{Status: "failed", Result: map[string]any{"failedFilesSample": sample, "filesFailed": 200000}}
	bounded := BoundProgressUpdate(u)
	body, err := json.Marshal(bounded)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	if len(body) >= 768*1024 {
		t.Errorf("serialized body = %d bytes, want < 768 KiB", len(body))
	}
	m, ok := bounded.Result.(map[string]any)
	if !ok {
		t.Fatalf("Result = %T, want map[string]any", bounded.Result)
	}
	if m["truncated"] != true {
		t.Errorf(`Result["truncated"] = %v, want true`, m["truncated"])
	}
}
