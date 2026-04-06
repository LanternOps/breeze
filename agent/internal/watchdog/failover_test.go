package watchdog

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

// TestFailoverHeartbeat verifies that SendHeartbeat sets X-Breeze-Role: watchdog,
// sends role="watchdog" in the request body, and returns a non-nil response.
func TestFailoverHeartbeat(t *testing.T) {
	t.Parallel()

	var gotRole string
	var gotBody map[string]any

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotRole = r.Header.Get("X-Breeze-Role")

		if err := json.NewDecoder(r.Body).Decode(&gotBody); err != nil {
			http.Error(w, "bad body", http.StatusBadRequest)
			return
		}

		resp := HeartbeatResponse{
			Commands: []FailoverCommand{
				{ID: "cmd-1", Type: "ping"},
			},
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(resp) //nolint:errcheck
	}))
	defer srv.Close()

	client := NewFailoverClient(srv.URL, "device-abc", "tok-test", nil)

	entries := []JournalEntry{
		{Time: time.Now(), Level: LevelInfo, Event: "startup"},
	}

	resp, err := client.SendHeartbeat("0.1.0", StateFailover, entries)
	if err != nil {
		t.Fatalf("SendHeartbeat returned error: %v", err)
	}
	if resp == nil {
		t.Fatal("SendHeartbeat returned nil response")
	}

	if gotRole != "watchdog" {
		t.Errorf("X-Breeze-Role = %q, want %q", gotRole, "watchdog")
	}

	roleField, _ := gotBody["role"].(string)
	if roleField != "watchdog" {
		t.Errorf("body role = %q, want %q", roleField, "watchdog")
	}
}

// TestFailoverPollCommands verifies that PollCommands sends role=watchdog as a
// query parameter and correctly decodes the commands array from the response.
func TestFailoverPollCommands(t *testing.T) {
	t.Parallel()

	var gotQuery string

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotQuery = r.URL.RawQuery

		payload := struct {
			Commands []FailoverCommand `json:"commands"`
		}{
			Commands: []FailoverCommand{
				{ID: "cmd-2", Type: "restart_agent"},
				{ID: "cmd-3", Type: "collect_logs"},
			},
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(payload) //nolint:errcheck
	}))
	defer srv.Close()

	client := NewFailoverClient(srv.URL, "device-xyz", "tok-poll", nil)

	cmds, err := client.PollCommands()
	if err != nil {
		t.Fatalf("PollCommands returned error: %v", err)
	}

	if !strings.Contains(gotQuery, "role=watchdog") {
		t.Errorf("query string = %q, want it to contain role=watchdog", gotQuery)
	}

	if len(cmds) != 2 {
		t.Fatalf("got %d commands, want 2", len(cmds))
	}
	if cmds[0].ID != "cmd-2" {
		t.Errorf("cmds[0].ID = %q, want cmd-2", cmds[0].ID)
	}
	if cmds[1].Type != "collect_logs" {
		t.Errorf("cmds[1].Type = %q, want collect_logs", cmds[1].Type)
	}
}

// TestFailoverSubmitResult verifies that SubmitCommandResult sends a request body
// that contains the status field.
func TestFailoverSubmitResult(t *testing.T) {
	t.Parallel()

	var gotBody map[string]any

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if err := json.NewDecoder(r.Body).Decode(&gotBody); err != nil {
			http.Error(w, "bad body", http.StatusBadRequest)
			return
		}
		w.WriteHeader(http.StatusOK)
	}))
	defer srv.Close()

	client := NewFailoverClient(srv.URL, "device-def", "tok-result", nil)

	err := client.SubmitCommandResult("cmd-99", "success", map[string]any{"output": "ok"}, "")
	if err != nil {
		t.Fatalf("SubmitCommandResult returned error: %v", err)
	}

	statusField, _ := gotBody["status"].(string)
	if statusField != "success" {
		t.Errorf("body status = %q, want success", statusField)
	}
}
