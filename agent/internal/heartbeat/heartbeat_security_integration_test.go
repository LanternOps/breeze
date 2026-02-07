package heartbeat

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"

	"github.com/breeze-rmm/agent/internal/config"
	"github.com/breeze-rmm/agent/internal/remote/tools"
)

func TestProcessCommandSecurityThreatRemoveSubmitsCompletedResult(t *testing.T) {
	t.Parallel()

	var (
		mu             sync.Mutex
		receivedStatus string
		receivedError  string
		receivedPath   string
	)

	testFile := filepath.Join(t.TempDir(), "threat.bin")
	if err := os.WriteFile(testFile, []byte("test"), 0600); err != nil {
		t.Fatalf("failed to create test file: %v", err)
	}

	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			w.WriteHeader(http.StatusMethodNotAllowed)
			return
		}

		if !strings.Contains(r.URL.Path, "/api/v1/agents/agent-1/commands/cmd-1/result") {
			w.WriteHeader(http.StatusNotFound)
			return
		}

		var payload map[string]any
		if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
			w.WriteHeader(http.StatusBadRequest)
			return
		}

		mu.Lock()
		receivedStatus, _ = payload["status"].(string)
		receivedError, _ = payload["error"].(string)
		if stdout, ok := payload["stdout"].(string); ok {
			var stdoutPayload map[string]any
			if json.Unmarshal([]byte(stdout), &stdoutPayload) == nil {
				receivedPath, _ = stdoutPayload["path"].(string)
			}
		}
		mu.Unlock()

		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"success":true}`))
	}))
	defer ts.Close()

	h := NewWithVersion(&config.Config{
		AgentID:   "agent-1",
		ServerURL: ts.URL,
		AuthToken: "token",
	}, "test")

	h.processCommand(Command{
		ID:   "cmd-1",
		Type: tools.CmdSecurityThreatRemove,
		Payload: map[string]any{
			"path":     testFile,
			"name":     "test-threat",
			"severity": "medium",
		},
	})

	mu.Lock()
	defer mu.Unlock()

	if receivedStatus != "completed" {
		t.Fatalf("expected completed status, got %q (error=%q)", receivedStatus, receivedError)
	}
	if receivedPath != testFile {
		t.Fatalf("expected submitted path %q, got %q", testFile, receivedPath)
	}

	if _, err := os.Stat(testFile); !os.IsNotExist(err) {
		t.Fatalf("expected test file to be removed, stat err=%v", err)
	}
}

func TestProcessCommandSecurityThreatRestoreSubmitsFailedResult(t *testing.T) {
	t.Parallel()

	var (
		mu             sync.Mutex
		receivedStatus string
		receivedError  string
	)

	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			w.WriteHeader(http.StatusMethodNotAllowed)
			return
		}

		var payload map[string]any
		if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
			w.WriteHeader(http.StatusBadRequest)
			return
		}

		mu.Lock()
		receivedStatus, _ = payload["status"].(string)
		receivedError, _ = payload["error"].(string)
		mu.Unlock()

		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"success":true}`))
	}))
	defer ts.Close()

	h := NewWithVersion(&config.Config{
		AgentID:   "agent-1",
		ServerURL: ts.URL,
		AuthToken: "token",
	}, "test")

	h.processCommand(Command{
		ID:      "cmd-2",
		Type:    tools.CmdSecurityThreatRestore,
		Payload: map[string]any{},
	})

	mu.Lock()
	defer mu.Unlock()

	if receivedStatus != "failed" {
		t.Fatalf("expected failed status, got %q", receivedStatus)
	}
	if !strings.Contains(receivedError, "required") {
		t.Fatalf("expected validation error to be reported, got %q", receivedError)
	}
}
