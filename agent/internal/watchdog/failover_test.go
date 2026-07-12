package watchdog

import (
	"encoding/json"
	"io"
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

	resp, err := client.SendHeartbeat("0.1.0", StateFailover, RestartStats{})
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

func TestSendHeartbeatIncludesRestartStats(t *testing.T) {
	var captured map[string]any
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		if err := json.Unmarshal(body, &captured); err != nil {
			t.Fatalf("server: unmarshal body: %v", err)
		}
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`{}`)) //nolint:errcheck
	}))
	defer server.Close()

	fc := NewFailoverClient(server.URL, "agent-xyz", "token", nil)
	stats := RestartStats{
		Count24h:      4,
		LastRestartAt: time.Date(2026, 5, 22, 12, 0, 0, 0, time.UTC),
		FlapDetected:  false,
	}
	if _, err := fc.SendHeartbeat("0.65.20", "RECOVERING", stats); err != nil {
		t.Fatalf("SendHeartbeat: %v", err)
	}

	if _, ok := captured["journalExcerpt"]; ok {
		t.Errorf("heartbeat body should not include journalExcerpt (dead wire data), got %v", captured["journalExcerpt"])
	}

	if got := captured["mainAgentRestartCount24h"]; got != float64(4) {
		t.Errorf("mainAgentRestartCount24h: want 4, got %v", got)
	}
	if got, _ := captured["mainAgentLastRestartAt"].(string); got != "2026-05-22T12:00:00Z" {
		t.Errorf("mainAgentLastRestartAt: want 2026-05-22T12:00:00Z, got %v", got)
	}
	if got := captured["flapDetected"]; got != false {
		t.Errorf("flapDetected: want false, got %v", got)
	}
}

// TestShipLogsMarshalsAPIContract verifies ShipLogs POSTs the API's required
// `{ logs: [...] }` wrapper with the watchdog JournalEntry fields translated to
// the endpoint's schema (time→timestamp, event→message, fixed component,
// data→fields), and that non-200 2xx codes (201/207) count as success.
func TestShipLogsMarshalsAPIContract(t *testing.T) {
	t.Parallel()

	fixedTime := time.Date(2026, 5, 1, 12, 30, 0, 0, time.UTC)

	tests := []struct {
		name        string
		statusCode  int
		entries     []JournalEntry
		wantShipped int
		wantErr     bool
	}{
		{
			name:       "201 created is success",
			statusCode: http.StatusCreated,
			entries: []JournalEntry{
				{Time: fixedTime, Level: LevelWarn, Event: "agent.crash", Data: map[string]any{"pid": 42}},
			},
			wantShipped: 1,
		},
		{
			name:        "207 partial insert is success",
			statusCode:  http.StatusMultiStatus,
			entries:     []JournalEntry{{Time: fixedTime, Level: LevelInfo, Event: "startup"}},
			wantShipped: 1,
		},
		{
			name:        "200 ok is success",
			statusCode:  http.StatusOK,
			entries:     []JournalEntry{{Time: fixedTime, Level: LevelError, Event: "boom"}},
			wantShipped: 1,
		},
		{
			name:        "500 is failure with zero shipped",
			statusCode:  http.StatusInternalServerError,
			entries:     []JournalEntry{{Time: fixedTime, Level: LevelInfo, Event: "startup"}},
			wantShipped: 0,
			wantErr:     true,
		},
	}

	for _, tt := range tests {
		tt := tt
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()

			var body apiLogBatch
			var decodeErr error
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				decodeErr = json.NewDecoder(r.Body).Decode(&body)
				w.WriteHeader(tt.statusCode)
				w.Write([]byte(`{}`)) //nolint:errcheck
			}))
			defer srv.Close()

			client := NewFailoverClient(srv.URL, "device-logs", "tok", nil)
			shipped, err := client.ShipLogs(tt.entries)

			if decodeErr != nil {
				t.Fatalf("server failed to decode { logs: [...] } wrapper: %v", decodeErr)
			}
			if (err != nil) != tt.wantErr {
				t.Fatalf("ShipLogs err = %v, wantErr = %v", err, tt.wantErr)
			}
			if shipped != tt.wantShipped {
				t.Errorf("shipped = %d, want %d", shipped, tt.wantShipped)
			}

			if len(body.Logs) != len(tt.entries) {
				t.Fatalf("server received %d logs, want %d", len(body.Logs), len(tt.entries))
			}
			for i, got := range body.Logs {
				src := tt.entries[i]
				if got.Component != "watchdog" {
					t.Errorf("logs[%d].component = %q, want watchdog", i, got.Component)
				}
				if got.Message != src.Event {
					t.Errorf("logs[%d].message = %q, want %q (event)", i, got.Message, src.Event)
				}
				if got.Timestamp != src.Time.UTC().Format(time.RFC3339) {
					t.Errorf("logs[%d].timestamp = %q, want %q", i, got.Timestamp, src.Time.UTC().Format(time.RFC3339))
				}
				if got.Level != src.Level {
					t.Errorf("logs[%d].level = %q, want %q", i, got.Level, src.Level)
				}
			}
		})
	}
}

// TestShipLogsBatchesOverCap verifies ShipLogs splits >200 entries into multiple
// POSTs, each honoring the API's 200-entry cap, and sums the shipped count.
func TestShipLogsBatchesOverCap(t *testing.T) {
	t.Parallel()

	var batchSizes []int
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body apiLogBatch
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			http.Error(w, "bad body", http.StatusBadRequest)
			return
		}
		batchSizes = append(batchSizes, len(body.Logs))
		w.WriteHeader(http.StatusCreated)
		w.Write([]byte(`{}`)) //nolint:errcheck
	}))
	defer srv.Close()

	entries := make([]JournalEntry, 450)
	for i := range entries {
		entries[i] = JournalEntry{Time: time.Now().UTC(), Level: LevelInfo, Event: "e"}
	}

	client := NewFailoverClient(srv.URL, "device-logs", "tok", nil)
	shipped, err := client.ShipLogs(entries)
	if err != nil {
		t.Fatalf("ShipLogs: %v", err)
	}
	if shipped != 450 {
		t.Errorf("shipped = %d, want 450", shipped)
	}
	if len(batchSizes) != 3 {
		t.Fatalf("got %d batches, want 3 (200+200+50)", len(batchSizes))
	}
	for i, n := range batchSizes {
		if n > shipLogsMaxBatchEntries {
			t.Errorf("batch[%d] size = %d exceeds cap %d", i, n, shipLogsMaxBatchEntries)
		}
	}
}

// TestJournalEntryToAPITranslation asserts the JournalEntry→apiLogEntry field
// mapping directly (not just end-to-end through ShipLogs): event→message,
// time→RFC3339 timestamp (in UTC), data→fields, fixed component="watchdog",
// and normalizeLogLevel folding an unknown level to "info".
func TestJournalEntryToAPITranslation(t *testing.T) {
	t.Parallel()

	// A non-UTC zone proves the translation normalizes to UTC.
	loc := time.FixedZone("UTC+2", 2*60*60)
	entryTime := time.Date(2026, 5, 1, 14, 30, 0, 0, loc)

	entry := JournalEntry{
		Time:  entryTime,
		Level: "verbose", // unknown level → must fold to "info"
		Event: "agent.crash",
		Data:  map[string]any{"pid": 42},
	}

	got := journalEntryToAPI(entry)

	if got.Component != "watchdog" {
		t.Errorf("component = %q, want watchdog", got.Component)
	}
	if got.Message != "agent.crash" {
		t.Errorf("message = %q, want agent.crash (from event)", got.Message)
	}
	if want := entryTime.UTC().Format(time.RFC3339); got.Timestamp != want {
		t.Errorf("timestamp = %q, want %q (RFC3339 UTC)", got.Timestamp, want)
	}
	if got.Level != LevelInfo {
		t.Errorf("level = %q, want %q (unknown level folds to info)", got.Level, LevelInfo)
	}
	if got.Fields == nil {
		t.Fatal("fields = nil, want data carried into fields")
	}
	if got.Fields["pid"] != 42 {
		t.Errorf("fields[pid] = %v, want 42", got.Fields["pid"])
	}

	// Every known level passes through unchanged.
	for _, lvl := range []string{"debug", LevelInfo, LevelWarn, LevelError} {
		if got := normalizeLogLevel(lvl); got != lvl {
			t.Errorf("normalizeLogLevel(%q) = %q, want unchanged", lvl, got)
		}
	}
}

// TestJournalEntryToAPILimits covers the two size-guard branches: an oversized
// fields object (>32KB) is dropped rather than shipped, and an over-length
// message (>10000 chars) is truncated rather than allowed to 400 the batch.
func TestJournalEntryToAPILimits(t *testing.T) {
	t.Parallel()

	t.Run("oversized fields dropped", func(t *testing.T) {
		t.Parallel()
		// Marshals to >shipLogsMaxFieldsBytes (32000), so fields must be dropped.
		entry := JournalEntry{
			Time:  time.Now(),
			Level: LevelInfo,
			Event: "big.data",
			Data:  map[string]any{"blob": strings.Repeat("x", shipLogsMaxFieldsBytes+1000)},
		}
		got := journalEntryToAPI(entry)
		if got.Fields != nil {
			t.Errorf("fields = %v, want nil (oversized data dropped)", got.Fields)
		}
	})

	t.Run("message truncated", func(t *testing.T) {
		t.Parallel()
		entry := JournalEntry{
			Time:  time.Now(),
			Level: LevelInfo,
			Event: strings.Repeat("a", shipLogsMaxMessageLen+500),
		}
		got := journalEntryToAPI(entry)
		if len(got.Message) != shipLogsMaxMessageLen {
			t.Errorf("message len = %d, want %d (truncated)", len(got.Message), shipLogsMaxMessageLen)
		}
	})
}

// TestShipLogsSplitsOnByteCap verifies the BYTE cap (not the 200-entry count
// cap) forces a batch split: a handful of near-maximal entries (~40KB each)
// exceed shipLogsMaxBatchBytes long before the count cap, so ShipLogs must
// emit multiple POSTs — each body under the API's 256KB bodyLimit (no 413).
func TestShipLogsSplitsOnByteCap(t *testing.T) {
	t.Parallel()

	const apiBodyLimit = 256 * 1024

	var batchSizes []int
	var bodyBytes []int
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		raw, _ := io.ReadAll(r.Body)
		bodyBytes = append(bodyBytes, len(raw))
		var body apiLogBatch
		if err := json.Unmarshal(raw, &body); err != nil {
			http.Error(w, "bad body", http.StatusBadRequest)
			return
		}
		batchSizes = append(batchSizes, len(body.Logs))
		w.WriteHeader(http.StatusCreated)
		w.Write([]byte(`{}`)) //nolint:errcheck
	}))
	defer srv.Close()

	// Each entry maxes message (10000) + fields (~31KB) ≈ 40KB translated, so a
	// few entries blow past the 240KB byte cap while staying well under the
	// 200-entry count cap.
	const n = 14
	entries := make([]JournalEntry, n)
	for i := range entries {
		entries[i] = JournalEntry{
			Time:  time.Now().UTC(),
			Level: LevelInfo,
			Event: strings.Repeat("m", shipLogsMaxMessageLen),
			Data:  map[string]any{"blob": strings.Repeat("d", shipLogsMaxFieldsBytes-100)},
		}
	}

	client := NewFailoverClient(srv.URL, "device-logs", "tok", nil)
	shipped, err := client.ShipLogs(entries)
	if err != nil {
		t.Fatalf("ShipLogs: %v", err)
	}
	if shipped != n {
		t.Errorf("shipped = %d, want %d", shipped, n)
	}
	if len(batchSizes) < 2 {
		t.Fatalf("got %d batch(es), want >=2 (byte cap must force a split)", len(batchSizes))
	}
	for i, size := range batchSizes {
		// Prove the split was byte-driven, not count-driven.
		if size >= shipLogsMaxBatchEntries {
			t.Errorf("batch[%d] size = %d hit the count cap; split was not byte-driven", i, size)
		}
	}
	for i, b := range bodyBytes {
		if b > apiBodyLimit {
			t.Errorf("batch[%d] body = %d bytes exceeds API bodyLimit %d (would 413)", i, b, apiBodyLimit)
		}
	}
}

// TestShipLogsPartialFailure verifies that when a later batch fails, ShipLogs
// returns the count of entries from the batches that succeeded plus an error,
// so the caller can report a partial (not falsely "completed") result.
func TestShipLogsPartialFailure(t *testing.T) {
	t.Parallel()

	var calls int
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		if calls == 1 {
			w.WriteHeader(http.StatusCreated)
		} else {
			w.WriteHeader(http.StatusInternalServerError)
		}
		w.Write([]byte(`{}`)) //nolint:errcheck
	}))
	defer srv.Close()

	entries := make([]JournalEntry, 250) // forces 2 batches (200 + 50)
	for i := range entries {
		entries[i] = JournalEntry{Time: time.Now().UTC(), Level: LevelInfo, Event: "e"}
	}

	client := NewFailoverClient(srv.URL, "device-logs", "tok", nil)
	shipped, err := client.ShipLogs(entries)
	if err == nil {
		t.Fatal("expected error from failed second batch, got nil")
	}
	if shipped != 200 {
		t.Errorf("shipped = %d, want 200 (only first batch succeeded)", shipped)
	}
}
