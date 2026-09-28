package heartbeat

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"

	"github.com/breeze-rmm/agent/internal/config"
)

// Issue #2773 — a staged token the confirm route answers with a bare 401 is
// discarded only once the CURRENT credential is proven to be the server's
// current one.
//
// agentAuth returns the same opaque 401 for an expired staged token and for a
// suspended device or an inactive tenant. In the second case the staged token
// may already BE the server's current credential: the promotion landed and the
// response was lost, so the staged copy on disk is the agent's only copy of it.
// Discarding it there leaves the endpoint holding only the demoted token, whose
// 5-minute grace has lapsed by the time the device or tenant is reinstated — a
// permanent 401 with nothing on disk the server accepts.
func TestConfirmRotationStagedTokenRejected(t *testing.T) {
	const stagedBearer = "Bearer brz_staged_agent"
	const currentBearer = "Bearer brz_current_agent"

	tests := []struct {
		name string
		// How the stub answers a confirm presented with the CURRENT token.
		currentStatus int
		currentBody   map[string]any
		wantDiscarded bool
	}{
		{
			// The current token is still current and nothing else is staged:
			// the staged set is provably dead.
			name:          "current credential proven current (alreadyCurrent)",
			currentStatus: http.StatusOK,
			currentBody:   map[string]any{"confirmed": true, "alreadyCurrent": true},
			wantDiscarded: true,
		},
		{
			// The current token is current and a DIFFERENT set is staged live
			// (a re-stage overwrote ours): ours is provably dead.
			name:          "current credential proven current (pending_token_required)",
			currentStatus: http.StatusConflict,
			currentBody:   map[string]any{"error": "wrong token", "code": "pending_token_required"},
			wantDiscarded: true,
		},
		{
			// Suspended device / inactive tenant: nothing authenticates. The
			// staged copy may be the server's current credential — keep it.
			name:          "current credential also rejected",
			currentStatus: http.StatusUnauthorized,
			currentBody:   map[string]any{"error": "Invalid agent credentials"},
			wantDiscarded: false,
		},
		{
			// The current token authenticates only as the superseded PREVIOUS
			// credential, so the server's current credential is something else
			// — very possibly the staged token we were about to throw away.
			name:          "current credential is only the previous one",
			currentStatus: http.StatusConflict,
			currentBody:   map[string]any{"error": "superseded", "code": "rotation_unresolvable"},
			wantDiscarded: false,
		},
		{
			name:          "probe fails with a server error",
			currentStatus: http.StatusInternalServerError,
			currentBody:   map[string]any{"error": "boom"},
			wantDiscarded: false,
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			var mu sync.Mutex
			var seen []string
			mux := http.NewServeMux()
			mux.HandleFunc("/api/v1/agents/", func(w http.ResponseWriter, r *http.Request) {
				if !pathHasSuffix(r.URL.Path, "/rotate-token/confirm") {
					w.WriteHeader(http.StatusNotFound)
					return
				}
				auth := r.Header.Get("Authorization")
				mu.Lock()
				seen = append(seen, auth)
				mu.Unlock()
				w.Header().Set("Content-Type", "application/json")
				switch auth {
				case stagedBearer:
					w.WriteHeader(http.StatusUnauthorized)
					_ = json.NewEncoder(w).Encode(map[string]any{"error": "Invalid agent credentials"})
				case currentBearer:
					w.WriteHeader(tc.currentStatus)
					_ = json.NewEncoder(w).Encode(tc.currentBody)
				default:
					w.WriteHeader(http.StatusUnauthorized)
				}
			})
			srv := httptest.NewServer(mux)
			t.Cleanup(srv.Close)

			h, _ := newRotationTestHeartbeat(t, srv.URL)
			if err := config.StagePendingCredentials("brz_staged_agent", "brz_staged_watchdog", "brz_staged_helper"); err != nil {
				t.Fatalf("StagePendingCredentials: %v", err)
			}

			h.reconcilePendingRotation()

			mu.Lock()
			calls := append([]string(nil), seen...)
			mu.Unlock()
			if len(calls) != 2 || calls[0] != stagedBearer || calls[1] != currentBearer {
				t.Fatalf("confirm calls = %v, want [staged, current] — the probe must use the current token", calls)
			}

			persisted, err := config.ReadPersistedCredentials()
			if err != nil {
				t.Fatalf("ReadPersistedCredentials: %v", err)
			}
			if tc.wantDiscarded {
				if persisted.PendingAuthToken != "" {
					t.Errorf("staged set kept (%q) although the current credential was proven current", persisted.PendingAuthToken)
				}
				if h.pendingRotationOnDisk.Load() {
					t.Error("pendingRotationOnDisk still armed after discarding the staged set")
				}
			} else {
				if persisted.PendingAuthToken != "brz_staged_agent" {
					t.Errorf("staged auth token = %q, want brz_staged_agent — discarded without proof that "+
						"the current credential is live; this is the #2773 strand", persisted.PendingAuthToken)
				}
				if !h.pendingRotationOnDisk.Load() {
					t.Error("pendingRotationOnDisk cleared while the staged set is still on disk — nothing retries it")
				}
			}
			if persisted.AuthToken != "brz_current_agent" {
				t.Errorf("current auth token = %q, want brz_current_agent", persisted.AuthToken)
			}
		})
	}
}

// The staged token IS the in-memory current token when applyRotatedCredentials
// swapped memory but the local promote write failed. There is then nothing
// else to probe with, and the staged copy must be kept.
func TestConfirmRotationStagedTokenRejectedKeepsSetWhenItIsTheOnlyToken(t *testing.T) {
	var calls int
	mux := http.NewServeMux()
	mux.HandleFunc("/api/v1/agents/", func(w http.ResponseWriter, r *http.Request) {
		calls++
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusUnauthorized)
		_ = json.NewEncoder(w).Encode(map[string]any{"error": "Invalid agent credentials"})
	})
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)

	h, _ := newRotationTestHeartbeat(t, srv.URL)
	if err := config.StagePendingCredentials("brz_staged_agent", "brz_staged_watchdog", "brz_staged_helper"); err != nil {
		t.Fatalf("StagePendingCredentials: %v", err)
	}
	h.secureToken.Replace("brz_staged_agent")

	h.reconcilePendingRotation()

	if calls != 1 {
		t.Errorf("confirm calls = %d, want 1 — probing with the very token that was just rejected proves nothing", calls)
	}
	persisted, err := config.ReadPersistedCredentials()
	if err != nil {
		t.Fatalf("ReadPersistedCredentials: %v", err)
	}
	if persisted.PendingAuthToken != "brz_staged_agent" {
		t.Errorf("staged auth token = %q, want brz_staged_agent", persisted.PendingAuthToken)
	}
}
