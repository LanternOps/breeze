package bmr

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/breeze-rmm/agent/internal/backup/providers"
)

// #12650: the token's targetPaths must be an object. Helpers before this one
// ignored any other shape and restored everything in place.
func TestTargetPathsFromConfig(t *testing.T) {
	tests := []struct {
		name   string
		config string
		want   map[string]string
		errHas string
	}{
		{name: "absent", config: `{}`},
		{name: "null", config: `{"targetPaths":null}`},
		{name: "empty object", config: `{"targetPaths":{}}`},
		{name: "object", config: `{"targetPaths":{"/home":"/restore/home"}}`, want: map[string]string{"/home": "/restore/home"}},
		{name: "nested under providerConfig", config: `{"providerConfig":{"targetPaths":{"/a":"/b"}}}`, want: map[string]string{"/a": "/b"}},
		{name: "top level wins over nested", config: `{"targetPaths":{"/a":"/top"},"providerConfig":{"targetPaths":{"/a":"/nested"}}}`, want: map[string]string{"/a": "/top"}},
		{name: "empty top level falls back to nested", config: `{"targetPaths":{},"providerConfig":{"targetPaths":{"/a":"/nested"}}}`, want: map[string]string{"/a": "/nested"}},
		{name: "list (the old placeholder's shape)", config: `{"targetPaths":["/mnt/recovery"]}`, errHas: "got a list"},
		{name: "string", config: `{"targetPaths":"/mnt/recovery"}`, errHas: "got a string"},
		{name: "non-string target", config: `{"targetPaths":{"/a":1}}`, errHas: `"/a"`},
		{name: "empty target", config: `{"targetPaths":{"/a":" "}}`, errHas: `"/a"`},
		{name: "empty source", config: `{"targetPaths":{"":"/b"}}`, errHas: "non-empty"},
		{name: "nested list", config: `{"providerConfig":{"targetPaths":["/x"]}}`, errHas: "providerConfig.targetPaths"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			var cfg map[string]any
			if err := json.Unmarshal([]byte(tt.config), &cfg); err != nil {
				t.Fatal(err)
			}
			got, err := targetPathsFromConfig(cfg)
			if tt.errHas != "" {
				if err == nil || !strings.Contains(err.Error(), tt.errHas) {
					t.Fatalf("err = %v, want one containing %q", err, tt.errHas)
				}
				return
			}
			if err != nil {
				t.Fatalf("err = %v", err)
			}
			if len(got) != len(tt.want) {
				t.Fatalf("got %v, want %v", got, tt.want)
			}
			for k, v := range tt.want {
				if got[k] != v {
					t.Fatalf("got %v, want %v", got, tt.want)
				}
			}
		})
	}
}

// tokenServer answers authenticate with targetConfig and records the
// completion status it is sent.
func tokenServer(t *testing.T, targetConfig map[string]any, completeStatus *atomic.Value, completeError *atomic.Value) *httptest.Server {
	t.Helper()
	var server *httptest.Server
	server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/v1/backup/bmr/recover/authenticate":
			_ = json.NewEncoder(w).Encode(map[string]any{
				"bootstrap": BootstrapResponse{
					Version:      BootstrapResponseVersion,
					TokenID:      "token-1",
					DeviceID:     "device-1",
					SnapshotID:   "snap-1",
					TargetConfig: targetConfig,
					Download: &AuthenticatedDownloadDescriptor{
						Type: "breeze_proxy", Method: "GET",
						URL:            server.URL + "/api/v1/backup/bmr/recover/download",
						PathQueryParam: "path", PathPrefix: "snapshots/snap-1",
					},
					Snapshot: &AuthenticatedSnapshot{ID: "snap-db-1", SnapshotID: "snap-1"},
				},
			})
		case "/api/v1/backup/bmr/recover/complete":
			var body map[string]any
			_ = json.NewDecoder(r.Body).Decode(&body)
			res := body["result"].(map[string]any)
			completeStatus.Store(res["status"].(string))
			if e, ok := res["error"].(string); ok {
				completeError.Store(e)
			}
			_ = json.NewEncoder(w).Encode(map[string]any{"status": "ok"})
		default:
			http.NotFound(w, r)
		}
	}))
	t.Cleanup(server.Close)
	return server
}

func TestRunRecoveryWithToken_RefusesUnreadableTargetPaths(t *testing.T) {
	origRunRecovery := runRecovery
	t.Cleanup(func() { runRecovery = origRunRecovery })
	ran := false
	runRecovery = func(context.Context, RecoveryConfig, providers.BackupProvider) (*RecoveryResult, error) {
		ran = true
		return &RecoveryResult{Status: "completed"}, nil
	}
	var status, errText atomic.Value
	server := tokenServer(t, map[string]any{"targetPaths": []any{"/mnt/recovery"}}, &status, &errText)

	result, err := RunRecoveryWithToken(RecoveryConfig{RecoveryToken: "brz_rec_test", ServerURL: server.URL})
	if err == nil || !strings.Contains(err.Error(), "targetPaths") {
		t.Fatalf("err = %v, want a targetPaths refusal", err)
	}
	if ran {
		t.Fatal("the recovery ran with an unreadable targetPaths")
	}
	if result == nil || result.Status != "failed" {
		t.Fatalf("result = %+v, want failed", result)
	}
	if s, _ := status.Load().(string); s != "failed" {
		t.Fatalf("completion status = %q, want failed", s)
	}
	if e, _ := errText.Load().(string); !strings.Contains(e, "targetPaths") {
		t.Fatalf("completion error = %q, want it to name targetPaths", e)
	}
}

// Mappings given to the run replace the token's, as before; the result now
// says so instead of dropping the token's silently.
func TestRunRecoveryWithToken_RunMappingsReplaceTokenMappings(t *testing.T) {
	origRunRecovery := runRecovery
	t.Cleanup(func() { runRecovery = origRunRecovery })
	var got map[string]string
	runRecovery = func(_ context.Context, cfg RecoveryConfig, _ providers.BackupProvider) (*RecoveryResult, error) {
		got = cfg.TargetPaths
		return &RecoveryResult{Status: "completed"}, nil
	}
	var status, errText atomic.Value
	server := tokenServer(t, map[string]any{"targetPaths": map[string]any{"/home": "/token"}}, &status, &errText)

	result, err := RunRecoveryWithToken(RecoveryConfig{RecoveryToken: "brz_rec_test", ServerURL: server.URL, TargetPaths: map[string]string{"/srv": "/flag"}})
	if err != nil {
		t.Fatalf("err = %v", err)
	}
	if len(got) != 1 || got["/srv"] != "/flag" {
		t.Fatalf("TargetPaths = %v, want only the run's", got)
	}
	if !strings.Contains(strings.Join(result.Warnings, "\n"), "token's targetPaths were not used") {
		t.Fatalf("warnings = %v", result.Warnings)
	}
}
