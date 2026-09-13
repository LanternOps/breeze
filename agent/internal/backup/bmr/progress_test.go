package bmr

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
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
