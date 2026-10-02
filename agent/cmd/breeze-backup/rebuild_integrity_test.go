package main

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

	"github.com/breeze-rmm/agent/internal/backup/integrity"
)

const rebuildIntegrityManifest = `{"id":"snap-1","files":[]}`

func attestedJSON(snapshotID string, manifest []byte) string {
	return fmt.Sprintf(`{"v":1,"mode":"attested","trust":"server_verified","snapshotId":%q,"objects":[{"role":"manifest","key":"snapshots/%s/manifest.json","sha256":%q,"size":%d}]}`,
		snapshotID, snapshotID, integrity.DigestBytes(manifest), len(manifest))
}

// newIntegrityTokenServer serves a token-mode bootstrap whose snapshot
// carries bootstrapIntegrity (omitted when ""), a self-contained manifest,
// and records progress statuses and the number of authenticate calls.
func newIntegrityTokenServer(t *testing.T, bootstrapIntegrity string) (url string, authCalls *int32, statuses func() []string) {
	t.Helper()
	var calls int32
	var mu sync.Mutex
	var posted []string
	integrityField := ""
	if bootstrapIntegrity != "" {
		integrityField = `, "integrity": ` + bootstrapIntegrity
	}
	mux := http.NewServeMux()
	mux.HandleFunc("/api/v1/backup/bmr/recover/authenticate", func(w http.ResponseWriter, r *http.Request) {
		atomic.AddInt32(&calls, 1)
		w.Header().Set("Content-Type", "application/json")
		_, _ = fmt.Fprintf(w, `{"bootstrap": {
			"version": 1, "tokenId": "tok-1", "deviceId": "dev-1", "snapshotId": "snap-1",
			"snapshot": {"id": "snap-1", "snapshotId": "snap-1"%s},
			"download": {"type": "breeze_proxy", "method": "GET", "url": %q, "pathQueryParam": "path",
				"tokenHeaderName": "authorization", "tokenHeaderFormat": "Bearer <recovery-token>",
				"requiresAuthentication": true, "pathPrefix": "snapshots/snap-1", "expiresAt": ""},
			"recovery": {"id": "rec-1", "identity": "new", "deviceId": "dev-1", "snapshotId": "snap-1"}
		}}`, integrityField, "http://"+r.Host+"/download")
	})
	mux.HandleFunc("/download", func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Query().Get("path") == "snapshots/snap-1/manifest.json" {
			_, _ = w.Write([]byte(rebuildIntegrityManifest))
			return
		}
		w.WriteHeader(http.StatusNotFound)
	})
	mux.HandleFunc("/api/v1/backup/bmr/recover/progress", func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			Status string `json:"status"`
		}
		_ = json.NewDecoder(r.Body).Decode(&body)
		mu.Lock()
		posted = append(posted, body.Status)
		mu.Unlock()
		_, _ = fmt.Fprintf(w, `{"id":"rec-1","status":%q}`, body.Status)
	})
	server := httptest.NewServer(mux)
	t.Cleanup(server.Close)
	return server.URL, &calls, func() []string {
		mu.Lock()
		defer mu.Unlock()
		return append([]string(nil), posted...)
	}
}

func rebuildPayloadWithIntegrity(server, integrityJSON string) json.RawMessage {
	extra := ""
	if integrityJSON != "" {
		extra = `, "integrity": ` + integrityJSON
	}
	return json.RawMessage(fmt.Sprintf(`{"recoveryId": "rec-1", "token": "brz_rec_test", "server": %q,
		"target": {"kind": "vhdx", "path": "/srv/rebuild/dev-1.vhdx", "imageSizeBytes": 42949672960}%s}`, server, extra))
}

func TestExecBareMetalRebuild_Integrity(t *testing.T) {
	attested := attestedJSON("snap-1", []byte(rebuildIntegrityManifest))
	differs := attestedJSON("snap-1", []byte(strings.Repeat("x", len(rebuildIntegrityManifest))))
	cases := []struct {
		name            string
		payload         string
		bootstrap       string
		wantRun         bool
		wantAttested    bool
		wantAuth        bool
		wantRefusedPost bool
	}{
		{name: "absent everywhere", wantRun: true, wantAuth: true},
		{name: "attested in the payload", payload: attested, wantRun: true, wantAttested: true, wantAuth: true},
		{name: "attested in the bootstrap", bootstrap: attested, wantRun: true, wantAttested: true, wantAuth: true},
		{name: "invalid payload block", payload: `{"v":3,"mode":"attested","snapshotId":"snap-1"}`},
		{name: "payload block for another snapshot", payload: attestedJSON("snap-9", []byte(rebuildIntegrityManifest)), wantAuth: true, wantRefusedPost: true},
		{name: "manifest bytes differ from attestation", bootstrap: differs, wantAuth: true, wantRefusedPost: true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			url, authCalls, statuses := newIntegrityTokenServer(t, tc.bootstrap)
			fake := &fakeRebuild{}
			res := execBareMetalRebuild(context.Background(), rebuildPayloadWithIntegrity(url, tc.payload), fake.fn)
			if (atomic.LoadInt32(authCalls) > 0) != tc.wantAuth {
				t.Fatalf("authenticate called %d time(s), want called=%v", *authCalls, tc.wantAuth)
			}
			if !tc.wantRun {
				if res.Success || len(fake.calls) != 0 {
					t.Fatalf("rebuild ran (success=%v calls=%d) stderr=%q", res.Success, len(fake.calls), res.Stderr)
				}
				if !strings.Contains(res.Stderr, "integrity") {
					t.Fatalf("stderr %q does not name the integrity check", res.Stderr)
				}
				if tc.wantRefusedPost && !strings.Contains(strings.Join(statuses(), ","), "refused") {
					t.Fatalf("no refused progress post: %v", statuses())
				}
				return
			}
			if !res.Success || len(fake.calls) == 0 {
				t.Fatalf("rebuild did not run: %q", res.Stderr)
			}
			for _, opts := range fake.calls {
				if opts.Integrity.Attested() != tc.wantAttested {
					t.Fatalf("opts.Integrity attested = %v, want %v", opts.Integrity.Attested(), tc.wantAttested)
				}
			}
		})
	}
}
