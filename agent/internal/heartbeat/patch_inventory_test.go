package heartbeat

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
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
