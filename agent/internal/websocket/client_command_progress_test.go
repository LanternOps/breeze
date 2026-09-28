package websocket

import (
	"encoding/json"
	"errors"
	"reflect"
	"strings"
	"testing"
)

// #3578: in-flight stage frames for long-running commands (software_install).

func TestSendCommandProgress_SendsFrameWhenServerAdvertisesCapability(t *testing.T) {
	c := newTestClient("http://localhost", noopHandler)
	c.setServerCapabilities(map[string]bool{CommandProgressCapability: true})

	if err := c.SendCommandProgress("cmd-sw-1", "installing"); err != nil {
		t.Fatalf("SendCommandProgress error: %v", err)
	}

	select {
	case data := <-c.sendChan:
		var parsed map[string]any
		if err := json.Unmarshal(data, &parsed); err != nil {
			t.Fatalf("unmarshal error: %v", err)
		}
		want := map[string]any{"type": "command_progress", "commandId": "cmd-sw-1", "stage": "installing"}
		if !reflect.DeepEqual(parsed, want) {
			t.Fatalf("frame = %v, want %v", parsed, want)
		}
	default:
		t.Fatal("expected a frame in sendChan")
	}
}

// An older server rejects unknown frame types with an INVALID_MESSAGE error
// frame (logged at error on both sides), so nothing may be sent unless the
// server said it understands command_progress.
func TestSendCommandProgress_SilentWithoutCapability(t *testing.T) {
	c := newTestClient("http://localhost", noopHandler)
	c.setServerCapabilities(map[string]bool{"backup_run_async": true})

	if err := c.SendCommandProgress("cmd-sw-1", "downloading"); !errors.Is(err, ErrServerLacksCapability) {
		t.Fatalf("err = %v, want ErrServerLacksCapability", err)
	}
	select {
	case data := <-c.sendChan:
		t.Fatalf("expected no frame, got %s", data)
	default:
	}
}

func TestSendCommandProgress_ChannelFullDropsInsteadOfBlocking(t *testing.T) {
	c := newTestClient("http://localhost", noopHandler)
	c.setServerCapabilities(map[string]bool{CommandProgressCapability: true})
	for i := 0; i < cap(c.sendChan); i++ {
		c.sendChan <- []byte("filler")
	}

	err := c.SendCommandProgress("cmd-sw-1", "downloading")
	if err == nil || !strings.Contains(err.Error(), "send channel full") {
		t.Fatalf("err = %v, want send channel full", err)
	}
}
