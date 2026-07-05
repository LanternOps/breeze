package heartbeat

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/breeze-rmm/agent/internal/config"
	"github.com/breeze-rmm/agent/internal/httputil"
)

type patchInventoryRequest struct {
	path string
	body []byte
}

func TestSendPatchInventoryDataSendsPendingThenInstalled(t *testing.T) {
	var requests []patchInventoryRequest
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, err := io.ReadAll(r.Body)
		if err != nil {
			t.Fatalf("ReadAll() error = %v", err)
		}
		requests = append(requests, patchInventoryRequest{path: r.URL.Path, body: body})
		if got, want := r.Header.Get("Authorization"), "Bearer token"; got != want {
			t.Fatalf("Authorization = %q, want %q", got, want)
		}
		w.WriteHeader(http.StatusOK)
	}))
	defer ts.Close()

	h := New(&config.Config{AgentID: "agent-1", ServerURL: ts.URL, AuthToken: "token"})
	h.retryCfg = httputil.RetryConfig{MaxRetries: 0}

	installed := make([]map[string]any, 251)
	for i := range installed {
		installed[i] = map[string]any{"name": "KB5000001", "source": "microsoft"}
	}

	pendingErr, installedErr := h.sendPatchInventoryData(
		[]map[string]any{{"name": "KB5000001", "source": "microsoft"}},
		installed,
		"microsoft",
		false,
		nil,
	)
	if pendingErr != nil {
		t.Fatalf("pendingErr = %v", pendingErr)
	}
	if installedErr != nil {
		t.Fatalf("installedErr = %v", installedErr)
	}

	if len(requests) != 2 {
		t.Fatalf("expected 2 requests, got %d: %#v", len(requests), requests)
	}
	if requests[0].path != "/api/v1/agents/agent-1/patches/pending" {
		t.Fatalf("pending path = %q", requests[0].path)
	}
	var pendingPayload map[string]any
	if err := json.Unmarshal(requests[0].body, &pendingPayload); err != nil {
		t.Fatalf("pending JSON error = %v", err)
	}
	if pendingPayload["source"] != "microsoft" {
		t.Fatalf("pending source = %#v", pendingPayload["source"])
	}
	if _, ok := pendingPayload["full"]; ok {
		t.Fatal("targeted pending payload should not include full=true")
	}

	if requests[1].path != "/api/v1/agents/agent-1/patches/installed" {
		t.Fatalf("installed path = %q", requests[1].path)
	}

	var installedPayload struct {
		Installed []map[string]any `json:"installed"`
	}
	if err := json.Unmarshal(requests[1].body, &installedPayload); err != nil {
		t.Fatalf("installed JSON error = %v", err)
	}
	if len(installedPayload.Installed) != len(installed) {
		t.Fatalf("installed payload size = %d", len(installedPayload.Installed))
	}
}

func TestSendPatchInventoryDataSkipsLinuxInstalledPackageInventory(t *testing.T) {
	var requests []patchInventoryRequest
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, err := io.ReadAll(r.Body)
		if err != nil {
			t.Fatalf("ReadAll() error = %v", err)
		}
		requests = append(requests, patchInventoryRequest{path: r.URL.Path, body: body})
		w.WriteHeader(http.StatusOK)
	}))
	defer ts.Close()

	h := New(&config.Config{AgentID: "agent-1", ServerURL: ts.URL, AuthToken: "token"})
	h.retryCfg = httputil.RetryConfig{MaxRetries: 0}

	pendingErr, installedErr := h.sendPatchInventoryData(
		[]map[string]any{{"name": "openssl", "source": "linux"}},
		[]map[string]any{{"name": "openssl", "source": "linux"}},
		"linux",
		false,
		nil,
	)
	if pendingErr != nil {
		t.Fatalf("pendingErr = %v", pendingErr)
	}
	if installedErr != nil {
		t.Fatalf("installedErr = %v", installedErr)
	}
	if len(requests) != 1 {
		t.Fatalf("expected only pending request, got %d: %#v", len(requests), requests)
	}
	if requests[0].path != "/api/v1/agents/agent-1/patches/pending" {
		t.Fatalf("path = %q", requests[0].path)
	}
}

func TestSendPatchInventoryDataStopsWhenPendingUploadFails(t *testing.T) {
	var requests []patchInventoryRequest
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, err := io.ReadAll(r.Body)
		if err != nil {
			t.Fatalf("ReadAll() error = %v", err)
		}
		requests = append(requests, patchInventoryRequest{path: r.URL.Path, body: body})
		http.Error(w, "too large", http.StatusRequestEntityTooLarge)
	}))
	defer ts.Close()

	h := New(&config.Config{AgentID: "agent-1", ServerURL: ts.URL, AuthToken: "token"})
	h.retryCfg = httputil.RetryConfig{MaxRetries: 0}

	pendingErr, installedErr := h.sendPatchInventoryData(
		[]map[string]any{{"name": "openssl", "source": "linux"}},
		[]map[string]any{{"name": "pkg", "source": "linux"}},
		"linux",
		false,
		nil,
	)
	if pendingErr == nil {
		t.Fatal("expected pendingErr")
	}
	if installedErr != nil {
		t.Fatalf("installedErr = %v", installedErr)
	}
	if len(requests) != 1 {
		t.Fatalf("expected only pending request, got %d", len(requests))
	}
	if requests[0].path != "/api/v1/agents/agent-1/patches/pending" {
		t.Fatalf("path = %q", requests[0].path)
	}
}

func TestSendPatchInventoryDataFullIncludesCoveredSources(t *testing.T) {
	var requests []patchInventoryRequest
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, err := io.ReadAll(r.Body)
		if err != nil {
			t.Fatalf("ReadAll() error = %v", err)
		}
		requests = append(requests, patchInventoryRequest{path: r.URL.Path, body: body})
		w.WriteHeader(http.StatusOK)
	}))
	defer ts.Close()

	h := New(&config.Config{AgentID: "agent-1", ServerURL: ts.URL, AuthToken: "token"})
	h.retryCfg = httputil.RetryConfig{MaxRetries: 0}

	pendingErr, installedErr := h.sendPatchInventoryData(
		[]map[string]any{{"name": "KB5000001", "source": "microsoft"}},
		nil,
		"",
		true,
		[]string{"microsoft"},
	)
	if pendingErr != nil {
		t.Fatalf("pendingErr = %v", pendingErr)
	}
	if installedErr != nil {
		t.Fatalf("installedErr = %v", installedErr)
	}
	if len(requests) != 1 {
		t.Fatalf("expected 1 request, got %d", len(requests))
	}

	var payload map[string]any
	if err := json.Unmarshal(requests[0].body, &payload); err != nil {
		t.Fatalf("pending JSON error = %v", err)
	}
	if payload["full"] != true {
		t.Fatalf("full = %#v, want true", payload["full"])
	}
	covered, ok := payload["coveredSources"].([]any)
	if !ok {
		t.Fatalf("coveredSources = %#v, want array", payload["coveredSources"])
	}
	if len(covered) != 1 || covered[0] != "microsoft" {
		t.Fatalf("coveredSources = %#v, want [microsoft]", covered)
	}
}

func TestSendPatchInventoryDataFullOmitsNilCoveredSources(t *testing.T) {
	// Legacy collector path has no coverage info (nil): the payload must omit
	// coveredSources entirely so the API keeps the legacy full sweep.
	var requests []patchInventoryRequest
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, err := io.ReadAll(r.Body)
		if err != nil {
			t.Fatalf("ReadAll() error = %v", err)
		}
		requests = append(requests, patchInventoryRequest{path: r.URL.Path, body: body})
		w.WriteHeader(http.StatusOK)
	}))
	defer ts.Close()

	h := New(&config.Config{AgentID: "agent-1", ServerURL: ts.URL, AuthToken: "token"})
	h.retryCfg = httputil.RetryConfig{MaxRetries: 0}

	pendingErr, installedErr := h.sendPatchInventoryData(
		[]map[string]any{{"name": "KB5000001", "source": "microsoft"}},
		nil,
		"",
		true,
		nil,
	)
	if pendingErr != nil {
		t.Fatalf("pendingErr = %v", pendingErr)
	}
	if installedErr != nil {
		t.Fatalf("installedErr = %v", installedErr)
	}
	if len(requests) != 1 {
		t.Fatalf("expected 1 request, got %d", len(requests))
	}

	var payload map[string]any
	if err := json.Unmarshal(requests[0].body, &payload); err != nil {
		t.Fatalf("pending JSON error = %v", err)
	}
	if payload["full"] != true {
		t.Fatalf("full = %#v, want true", payload["full"])
	}
	if _, ok := payload["coveredSources"]; ok {
		t.Fatalf("coveredSources should be omitted for nil coverage, got %#v", payload["coveredSources"])
	}
}

func TestSendPatchInventoryDataFullIncludesEmptyCoveredSources(t *testing.T) {
	// A scan where every provider was skipped yields a non-nil but empty covered
	// set. It MUST serialize as coveredSources: [] (present, empty) so the API
	// scopes the sweep to nothing — distinct from nil/omitted, which the API
	// treats as a legacy sweep-all. This is the exact schema-contract distinction
	// the coverage mechanism depends on (#2217).
	var requests []patchInventoryRequest
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, err := io.ReadAll(r.Body)
		if err != nil {
			t.Fatalf("ReadAll() error = %v", err)
		}
		requests = append(requests, patchInventoryRequest{path: r.URL.Path, body: body})
		w.WriteHeader(http.StatusOK)
	}))
	defer ts.Close()

	h := New(&config.Config{AgentID: "agent-1", ServerURL: ts.URL, AuthToken: "token"})
	h.retryCfg = httputil.RetryConfig{MaxRetries: 0}

	pendingErr, installedErr := h.sendPatchInventoryData(
		nil,
		nil,
		"",
		true,
		[]string{}, // non-nil, empty: every provider skipped
	)
	if pendingErr != nil {
		t.Fatalf("pendingErr = %v", pendingErr)
	}
	if installedErr != nil {
		t.Fatalf("installedErr = %v", installedErr)
	}
	if len(requests) != 1 {
		t.Fatalf("expected 1 request, got %d", len(requests))
	}

	// Assert the raw JSON carries "coveredSources":[] — not omitted, not null.
	if !strings.Contains(string(requests[0].body), `"coveredSources":[]`) {
		t.Fatalf("payload should contain empty coveredSources array, got %s", requests[0].body)
	}

	var payload map[string]any
	if err := json.Unmarshal(requests[0].body, &payload); err != nil {
		t.Fatalf("pending JSON error = %v", err)
	}
	covered, ok := payload["coveredSources"].([]any)
	if !ok {
		t.Fatalf("coveredSources = %#v, want present empty array", payload["coveredSources"])
	}
	if len(covered) != 0 {
		t.Fatalf("coveredSources = %#v, want empty", covered)
	}
}

func TestCoveredPatchSources(t *testing.T) {
	h := &Heartbeat{}

	tests := []struct {
		name        string
		providerIDs []string
		covered     []string
		want        []string
	}{
		{
			name:        "all providers ran",
			providerIDs: []string{"windows-update", "winget"},
			covered:     []string{"windows-update", "winget"},
			want:        []string{"microsoft", "third_party"},
		},
		{
			name:        "skipped winget removes third_party coverage",
			providerIDs: []string{"windows-update", "winget"},
			covered:     []string{"windows-update"},
			want:        []string{"microsoft"},
		},
		{
			name:        "shared bucket only covered when every provider ran",
			providerIDs: []string{"windows-update", "chocolatey", "winget"},
			covered:     []string{"windows-update", "chocolatey"},
			want:        []string{"microsoft"},
		},
		{
			name:        "shared bucket covered when both providers ran",
			providerIDs: []string{"chocolatey", "winget"},
			covered:     []string{"chocolatey", "winget"},
			want:        []string{"third_party"},
		},
		{
			name:        "nothing ran yields empty (not nil) coverage",
			providerIDs: []string{"winget"},
			covered:     nil,
			want:        []string{},
		},
		{
			name:        "linux providers map to linux bucket",
			providerIDs: []string{"apt"},
			covered:     []string{"apt"},
			want:        []string{"linux"},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := h.coveredPatchSources(tt.providerIDs, tt.covered)
			if got == nil {
				t.Fatal("coveredPatchSources returned nil, want non-nil slice")
			}
			if len(got) != len(tt.want) {
				t.Fatalf("coveredPatchSources = %v, want %v", got, tt.want)
			}
			for i := range tt.want {
				if got[i] != tt.want[i] {
					t.Fatalf("coveredPatchSources = %v, want %v", got, tt.want)
				}
			}
		})
	}
}

func TestUncoveredPatchSources(t *testing.T) {
	h := &Heartbeat{}

	tests := []struct {
		name        string
		providerIDs []string
		covered     []string
		want        []string
	}{
		{
			name:        "full coverage yields no uncovered buckets",
			providerIDs: []string{"windows-update", "winget"},
			covered:     []string{"microsoft", "third_party"},
			want:        []string{},
		},
		{
			name:        "skipped winget leaves third_party uncovered",
			providerIDs: []string{"windows-update", "winget"},
			covered:     []string{"microsoft"},
			want:        []string{"third_party"},
		},
		{
			name:        "nothing covered reports every mapped bucket once",
			providerIDs: []string{"windows-update", "winget", "chocolatey"},
			covered:     []string{},
			want:        []string{"microsoft", "third_party"},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := h.uncoveredPatchSources(tt.providerIDs, tt.covered)
			if len(got) != len(tt.want) {
				t.Fatalf("uncoveredPatchSources = %v, want %v", got, tt.want)
			}
			for i := range tt.want {
				if got[i] != tt.want[i] {
					t.Fatalf("uncoveredPatchSources = %v, want %v", got, tt.want)
				}
			}
		})
	}
}

func TestFilterPatchInventoryItemsBySource(t *testing.T) {
	items := []map[string]any{
		{"name": "openssl", "source": "linux"},
		{"name": "Firefox", "source": "third_party"},
		{"name": "unknown"},
	}

	filtered := filterPatchInventoryItemsBySource(items, "linux")
	if len(filtered) != 1 {
		t.Fatalf("expected 1 linux item, got %d", len(filtered))
	}
	if filtered[0]["name"] != "openssl" {
		t.Fatalf("filtered item = %#v", filtered[0])
	}
}
