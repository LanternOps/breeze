package tools

import (
	"bytes"
	"encoding/json"
	"log/slog"
	"strings"
	"testing"
)

// TestCommandResultExitZeroIsWireVisible guards the HTTP result leg against
// the #2474 symptom: the server persists `result.exitCode ?? null`, so a
// successful (exit-0) run must serialize an explicit "exitCode":0 — an
// omitempty tag here would silently re-NULL exit_code for every completed row
// whenever the HTTP leg wins the write race.
func TestCommandResultExitZeroIsWireVisible(t *testing.T) {
	raw, err := json.Marshal(CommandResult{
		Status:   "completed",
		ExitCode: 0,
		Stdout:   "ok",
	})
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}

	var wire map[string]any
	if err := json.Unmarshal(raw, &wire); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}

	ec, ok := wire["exitCode"]
	if !ok {
		t.Fatalf("exitCode absent from wire result %s; a completed command must send exitCode:0, not omit it", raw)
	}
	if ec.(float64) != 0 {
		t.Errorf("exitCode = %v, want 0", ec)
	}
}

func TestGetPayloadObjectSlice_WarnsOnDroppedEntries(t *testing.T) {
	var logs bytes.Buffer
	previous := slog.Default()
	slog.SetDefault(slog.New(slog.NewTextHandler(&logs, nil)))
	defer slog.SetDefault(previous)
	got := GetPayloadObjectSlice(map[string]any{"oidSpecs": []any{nil, "bad", map[string]any{"oid": "1.3.6"}}}, "oidSpecs")
	if len(got) != 1 || got[0]["oid"] != "1.3.6" {
		t.Fatalf("objects = %v, want one valid object", got)
	}
	for _, want := range []string{"level=WARN", "dropped malformed payload object entries", "key=oidSpecs", "dropped=2"} {
		if !strings.Contains(logs.String(), want) {
			t.Errorf("logs = %q, want %q", logs.String(), want)
		}
	}
}
