package heartbeat

import (
	"errors"
	"reflect"
	"testing"

	"github.com/breeze-rmm/agent/internal/remote/tools"
	"github.com/breeze-rmm/agent/internal/websocket"
)

// TestHandleSoftwareInstall_WiresCommandIDToWebSocketProgress proves the
// handler itself hands the install a reporter bound to THIS command's id and
// the heartbeat's WebSocket client — the one line every other test here goes
// around. Not parallel: it swaps package-level seams.
func TestHandleSoftwareInstall_WiresCommandIDToWebSocketProgress(t *testing.T) {
	origInstall, origSend := installSoftwareWithProgress, sendCommandProgress
	t.Cleanup(func() { installSoftwareWithProgress, sendCommandProgress = origInstall, origSend })

	ws := websocket.New(&websocket.Config{ServerURL: "http://127.0.0.1:0"}, nil)
	h := &Heartbeat{}
	h.SetWebSocketClient(ws)

	type sent struct {
		client    *websocket.Client
		id, stage string
	}
	var got []sent
	sendCommandProgress = func(c *websocket.Client, id, stage string) error {
		got = append(got, sent{c, id, stage})
		return nil
	}
	var gotPayload map[string]any
	installSoftwareWithProgress = func(payload map[string]any, progress tools.ProgressReporter) tools.CommandResult {
		gotPayload = payload
		if progress == nil {
			t.Fatal("handler passed a nil progress reporter despite a WebSocket client")
		}
		progress(tools.ProgressStageDownloading)
		progress(tools.ProgressStageInstalling)
		return tools.CommandResult{Status: "completed"}
	}

	payload := map[string]any{"deploymentId": "dep-1"}
	result := handleSoftwareInstall(h, Command{ID: "cmd-row-uuid", Type: tools.CmdSoftwareInstall, Payload: payload})

	if result.Status != "completed" {
		t.Fatalf("status = %q, want the install's own result", result.Status)
	}
	if !reflect.DeepEqual(gotPayload, payload) {
		t.Fatalf("install got payload %v, want %v", gotPayload, payload)
	}
	want := []sent{
		{ws, "cmd-row-uuid", tools.ProgressStageDownloading},
		{ws, "cmd-row-uuid", tools.ProgressStageInstalling},
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("sent = %+v, want %+v", got, want)
	}
}

func TestCommandProgressReporter_ForwardsCommandIDAndStage(t *testing.T) {
	type sent struct{ id, stage string }
	var got []sent
	report := newCommandProgressReporter("cmd-sw-1", func(id, stage string) error {
		got = append(got, sent{id, stage})
		return nil
	})

	report("downloading")
	report("installing")

	want := []sent{{"cmd-sw-1", "downloading"}, {"cmd-sw-1", "installing"}}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("sent = %v, want %v", got, want)
	}
}

// A progress send can fail (old server, full channel, stopped client); the
// install must carry on regardless, so the reporter swallows every error.
func TestCommandProgressReporter_SwallowsSendErrors(t *testing.T) {
	for _, sendErr := range []error{websocket.ErrServerLacksCapability, errors.New("send channel full")} {
		report := newCommandProgressReporter("cmd-sw-1", func(string, string) error { return sendErr })
		report("downloading") // must not panic
	}
}

func TestHeartbeatCommandProgressReporter_NilWithoutWebSocket(t *testing.T) {
	var nilHeartbeat *Heartbeat
	if nilHeartbeat.commandProgressReporter("cmd-sw-1") != nil {
		t.Fatal("nil heartbeat must yield a nil reporter")
	}
	if (&Heartbeat{}).commandProgressReporter("cmd-sw-1") != nil {
		t.Fatal("heartbeat without a websocket client must yield a nil reporter")
	}
}
