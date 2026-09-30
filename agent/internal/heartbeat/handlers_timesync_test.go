package heartbeat

import (
	"encoding/json"
	"errors"
	"testing"

	"github.com/breeze-rmm/agent/internal/collectors/timesync"
	"github.com/breeze-rmm/agent/internal/remote/tools"
)

func TestTimeHandlersRegistryAndResults(t *testing.T) {
	for _, tc := range []struct {
		kind    string
		payload map[string]any
		data    any
	}{
		{"time_resync", map[string]any{}, timesync.ResyncResult{ExitCode: 0}},
		{"time_set_timezone", map[string]any{"windowsId": "UTC"}, timesync.SetTimezoneResult{}},
		{"time_apply_policy", map[string]any{}, timesync.ManagementReport{}},
	} {
		for _, failed := range []bool{false, true} {
			f := &fakeTimeManager{result: tc.data}
			if failed {
				f.err = errors.New("readback failed")
			}
			h := newTimeHeartbeat(f)
			got, handled := h.dispatchCommand(Command{ID: "time-fixture", Type: tc.kind, Payload: tc.payload})
			if !handled || len(f.commands) != 1 || f.commands[0] != tc.kind {
				t.Fatal(handled, f.commands)
			}
			if got.Result == nil {
				t.Fatal("structured result absent")
			}
			if failed && (got.Status != "failed" || got.ExitCode == 0 || got.Error == "") {
				t.Fatal(got)
			}
			if !failed && got.Status != "completed" {
				t.Fatal(got)
			}
			// Transport must carry exact F.4 JSON even when Error disables stdout reparsing.
			want, e := json.Marshal(tc.data)
			if e != nil {
				t.Fatal(e)
			}
			actual, e := json.Marshal(got.Result)
			if e != nil {
				t.Fatal(e)
			}
			if string(actual) != string(want) {
				t.Fatal(string(actual), string(want))
			}
			ws := toWSCommandResult("time-fixture", got)
			wire, e := json.Marshal(ws.Result)
			if e != nil {
				t.Fatal(e)
			}
			if string(wire) != string(want) {
				t.Fatal("WebSocket lost structured failure", string(wire))
			}
			if tc.kind == "time_set_timezone" && f.payload["windowsId"] != "UTC" {
				t.Fatal(f.payload)
			}
			h.stopTimeSync()
		}
	}
}
func TestTimeHandlerPreservesResyncExitCode(t *testing.T) {
	message := "resync failed"
	f := &fakeTimeManager{result: timesync.ResyncResult{ExitCode: 7, Error: &message}, err: errors.New(message)}
	h := newTimeHeartbeat(f)
	defer h.stopTimeSync()
	got := handleTimeResync(h, Command{Type: tools.CmdTimeResync, Payload: map[string]any{}})
	if got.ExitCode != 7 || got.Result.(timesync.ResyncResult).ExitCode != 7 {
		t.Fatal(got)
	}
}
func TestTimeHandlerUnsupported(t *testing.T) {
	h := &Heartbeat{}
	for _, kind := range []string{"time_resync", "time_set_timezone", "time_apply_policy"} {
		got, handled := h.dispatchCommand(Command{Type: kind, Payload: map[string]any{}})
		if !handled || got.Status != "failed" || got.Result == nil {
			t.Fatal(kind, got)
		}
	}
}
