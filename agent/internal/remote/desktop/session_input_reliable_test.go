package desktop

import (
	"testing"
	"time"
)

func sendR(s *Session, raw string)     { s.onViewerDataChannelMessage("input-r", []byte(raw)) }
func sendLossy(s *Session, raw string) { s.onViewerDataChannelMessage("input", []byte(raw)) }

const rHandshake = `{"type":"input_reset","seq":1,"epoch":1}`

func TestInputRCarriesSequencedKeys(t *testing.T) {
	s, inner := newSafeSession(t)
	sendR(s, rHandshake)
	sendR(s, `{"type":"key_down","key":"a","seq":2,"epoch":1}`)
	if got := lastCall(inner); got != "key_down:a" {
		t.Fatalf("last call = %q (all: %v)", got, inner.snapshot())
	}
}

func TestInputRTrafficResetsIdleWatchdog(t *testing.T) {
	s, _ := newSafeSession(t)
	sendR(s, rHandshake)
	s.lastInputUnixNano.Store(time.Now().Add(-time.Hour).UnixNano())

	sendR(s, `{"type":"key_down","key":"a","seq":2,"epoch":1}`)

	if idlePolicyStops(s) {
		t.Fatal("keyboard input on input-r must reset the idle watchdog")
	}
}

// input_reset is protocol housekeeping the viewer sends on its own (focus
// loss, handshakes), not operator presence.
func TestInputResetDoesNotResetIdleWatchdog(t *testing.T) {
	s, _ := newSafeSession(t)
	s.lastInputUnixNano.Store(time.Now().Add(-time.Hour).UnixNano())

	sendR(s, rHandshake)

	if !idlePolicyStops(s) {
		t.Fatal("input_reset must not reset the idle watchdog")
	}
}

func TestInputChannelRules(t *testing.T) {
	cases := []struct {
		label string
		ev    InputEvent
		want  string
	}{
		{"input", InputEvent{Type: "key_down", Key: "a"}, ""},
		{"input", InputEvent{Type: "mouse_move", Seq: 2, After: 1}, ""},
		{"input", InputEvent{Type: "key_down", Key: "a", Seq: 2}, "sequenced_discrete_on_lossy_channel"},
		{"input", InputEvent{Type: "input_reset", Seq: 2, Epoch: 1}, "input_reset_on_lossy_channel"},
		{"input-r", InputEvent{Type: "key_down", Key: "a", Seq: 2}, ""},
		{"input-r", InputEvent{Type: "mouse_move", Seq: 2, After: 1}, ""},
		{"input-r", InputEvent{Type: "input_reset", Seq: 2, Epoch: 1}, ""},
		{"input-r", InputEvent{Type: "key_down", Key: "a"}, "unsequenced_on_input_r"},
	}
	for _, tc := range cases {
		if got := inputChannelRejects(tc.label, tc.ev); got != tc.want {
			t.Errorf("inputChannelRejects(%q, %+v) = %q, want %q", tc.label, tc.ev, got, tc.want)
		}
	}
}

func TestWrongChannelEventsAreNotInjected(t *testing.T) {
	s, inner := newSafeSession(t)
	sendR(s, `{"type":"key_down","key":"a"}`)                       // legacy on input-r
	sendLossy(s, `{"type":"key_down","key":"b","seq":2,"epoch":1}`) // sequenced key on the lossy channel
	sendLossy(s, `{"type":"input_reset","seq":3,"epoch":1}`)        // handshake on the lossy channel
	s.safeInput().sync()
	if c := inner.snapshot(); len(c) != 0 {
		t.Fatalf("wrong-channel events reached the platform handler: %v", c)
	}
	// The lossy input_reset did not open the gate.
	sendR(s, `{"type":"key_down","key":"c","seq":4,"epoch":1}`)
	if c := inner.snapshot(); len(c) != 0 {
		t.Fatalf("gate opened by an input_reset on the lossy channel: %v", c)
	}
}

func TestRejectedInputREventDoesNotFreezeThePointer(t *testing.T) {
	for name, bad := range map[string]string{
		"validation": `{"type":"mouse_scroll","x":1,"y":1,"delta":100000,"seq":2,"epoch":1,"geoEpoch":1}`,
		"type error": `{"type":"key_down","key":"a","x":"oops","seq":2,"epoch":1}`,
	} {
		t.Run(name, func(t *testing.T) {
			s, inner := newSafeSession(t)
			sendR(s, rHandshake)
			sendLossy(s, `{"type":"mouse_move","x":7,"y":7,"seq":3,"after":2,"epoch":1,"geoEpoch":1}`)
			sendR(s, bad)
			s.safeInput().sync()
			if got := lastCall(inner); got != "mouse_move:7,7:" {
				t.Fatalf("pointer frozen behind a rejected event: %v", inner.snapshot())
			}
		})
	}
}

func TestInputCapabilitiesAdvertiseReliableInput(t *testing.T) {
	s, _ := newSafeSession(t)
	body := s.inputCapabilities()
	if body["reliableInput"] != true || body["inputEpoch"] != uint32(1) || body["geoEpoch"] != uint32(1) {
		t.Fatalf("capabilities = %v", body)
	}
	if body["typeText"] != true || body["releasesHeldInput"] != true {
		t.Fatalf("W2a keys missing: %v", body)
	}
	plain := &Session{id: "p", inputHandler: &stubInputHandler{}}
	if _, ok := plain.inputCapabilities()["reliableInput"]; ok {
		t.Fatal("advertised reliableInput without an input worker to honour it")
	}
}
