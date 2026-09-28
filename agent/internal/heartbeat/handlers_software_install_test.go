package heartbeat

import (
	"errors"
	"reflect"
	"testing"

	"github.com/breeze-rmm/agent/internal/websocket"
)

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
