package desktop

import (
	"errors"
	"reflect"
	"strings"
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

func TestReplacingAViewerChannelReleasesHeldInput(t *testing.T) {
	s, inner := newSafeSession(t)
	a, b := new(int), new(int)
	s.onViewerChannelAttached("input-r", a)
	sendR(s, rHandshake)
	sendR(s, `{"type":"key_down","key":"shift","seq":2,"epoch":1}`)

	s.onViewerChannelAttached("input-r", b)

	waitFor(t, "the replacement to release shift", func() bool { return lastCall(inner) == "key_up:shift" })
	if e, _ := s.safeInput().Epochs(); e != 2 {
		t.Fatalf("epoch = %d, want 2", e)
	}
}

func TestSupersededChannelClosingLateDoesNotResetAgain(t *testing.T) {
	s, inner := newSafeSession(t)
	a, b := new(int), new(int)
	s.onViewerChannelAttached("input-r", a)
	s.onViewerChannelAttached("input-r", b)
	waitFor(t, "the replacement reset", func() bool { e, _ := s.safeInput().Epochs(); return e == 2 })
	sendR(s, `{"type":"input_reset","seq":1,"epoch":2}`)

	s.onViewerChannelClosed("input-r", a) // the old channel's close arrives late
	sendR(s, `{"type":"key_down","key":"a","seq":2,"epoch":2}`)
	if got := lastCall(inner); got != "key_down:a" {
		t.Fatalf("late close of a superseded channel re-gated input: %v", inner.snapshot())
	}

	s.onViewerChannelClosed("input-r", b) // the current one closing does reset
	if e, _ := s.safeInput().Epochs(); e != 3 {
		t.Fatalf("epoch after the current channel closed = %d, want 3", e)
	}
}

func TestSupersededChannelMessagesAreIgnored(t *testing.T) {
	s, inner := newSafeSession(t)
	a, b := new(int), new(int)
	s.onViewerChannelAttached("input", a)
	s.onViewerChannelAttached("input", b)
	waitFor(t, "the replacement reset", func() bool { e, _ := s.safeInput().Epochs(); return e == 2 })

	s.viewerChannelMessage("input", a, []byte(`{"type":"key_down","key":"a"}`))
	s.viewerChannelMessage("input", b, []byte(`{"type":"key_down","key":"b"}`))

	if got := inner.snapshot(); !reflect.DeepEqual(got, []string{"key_down:b"}) {
		t.Fatalf("calls = %v, want only the current channel's key", got)
	}
}

func TestUnreliableInputRIsRefused(t *testing.T) {
	s, inner := newSafeSession(t)
	bad := new(int)
	if s.acceptViewerChannel("input-r", bad, false) {
		t.Fatal("accepted an input-r without reliable ordered delivery")
	}
	if s.inputRAttached.Load() {
		t.Fatal("a refused input-r marked the viewer as W2b")
	}
	s.viewerChannelMessage("input-r", bad, []byte(rHandshake))
	s.viewerChannelMessage("input-r", bad, []byte(`{"type":"key_down","key":"a","seq":2,"epoch":1}`))
	if c := inner.snapshot(); len(c) != 0 {
		t.Fatalf("a refused input-r carried input: %v", c)
	}
	if !s.acceptViewerChannel("input", new(int), false) {
		t.Fatal("the lossy input channel is unreliable by design and must be accepted")
	}
}

func TestInputEpochIsAnnouncedOnlyToViewersThatOpenedInputR(t *testing.T) {
	s, _ := newSafeSession(t)
	if _, ok := s.inputEpochAnnouncement("peer_disconnected"); ok {
		t.Fatal("announced input_epoch to a viewer that never opened input-r")
	}
	s.onViewerChannelAttached("input-r", new(int))
	body, ok := s.inputEpochAnnouncement("peer_disconnected")
	want := map[string]any{"type": "input_epoch", "epoch": uint32(1), "reason": "peer_disconnected"}
	if !ok || !reflect.DeepEqual(body, want) {
		t.Fatalf("announcement = %v (ok=%v), want %v", body, ok, want)
	}
}

func TestMonitorSwitchedMessageCarriesTheNewEpochs(t *testing.T) {
	s, _ := newSafeSession(t)
	s.resetInputGeometry("monitor_switch")
	got := s.monitorSwitchedMessage(1, 1920, 1080)
	want := map[string]any{
		"type": "monitor_switched", "index": 1, "width": 1920, "height": 1080,
		"inputEpoch": uint32(2), "geoEpoch": uint32(2),
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("monitor_switched = %v, want %v", got, want)
	}
}

// R8: announcing must never make a reset, or the worker, wait on Session.mu.
// The test holds s.mu, so a synchronous announcement would block inside
// sendControlJSON and the test would time out. Verify it can fail by removing
// the `go` from either hook in wireInputEpochHooks.
func TestInputEpochAnnouncementsNeverWaitOnTheSession(t *testing.T) {
	s, _ := newSafeSession(t)
	s.onViewerChannelAttached("input-r", new(int))
	s.wireInputEpochHooks()
	si := s.safeInput()
	deadline := safeInputCloseTimeout / 2 // shorter than every internal timeout

	s.mu.Lock()
	defer s.mu.Unlock()

	reset := make(chan struct{})
	go func() { si.ReleaseAll("peer_disconnected"); si.sync(); close(reset) }()
	select {
	case <-reset:
	case <-time.After(deadline):
		t.Fatal("onReset made the reset wait on Session.mu")
	}

	// onResync runs on the worker: gated sequenced input asks for a resync.
	resync := make(chan error, 1)
	go func() { resync <- si.HandleEvent(seqKey("key_down", "a", 1)) }()
	select {
	case err := <-resync:
		if !errors.Is(err, errInputDropped) {
			t.Fatalf("gated key: err=%v, want errInputDropped", err)
		}
	case <-time.After(deadline):
		t.Fatal("onResync made the worker wait on Session.mu")
	}
}

func TestIsReliableOrdered(t *testing.T) {
	zero := uint16(0)
	if !isReliableOrdered(true, nil, nil) {
		t.Fatal("ordered + no limits is reliable")
	}
	for _, c := range []struct {
		ordered    bool
		retx, life *uint16
	}{{false, nil, nil}, {true, &zero, nil}, {true, nil, &zero}} {
		if isReliableOrdered(c.ordered, c.retx, c.life) {
			t.Fatalf("isReliableOrdered(%v,%v,%v) = true", c.ordered, c.retx, c.life)
		}
	}
}

// StartSession and switchMonitor need a real capturer and cannot run in CI.
// This source contract (precedent: session_filedrop_boundary_test.go) pins the
// wiring the unit tests above rely on.
func TestWebRTCSessionWiresTheReliableInputChannel(t *testing.T) {
	read := func(name string) string {
		b, err := desktopSources.ReadFile(name)
		if err != nil {
			t.Fatalf("read %s: %v", name, err)
		}
		return string(b)
	}
	// inOrder requires each needle to appear after the previous one; a needle
	// may repeat.
	inOrder := func(file, src string, needles ...string) {
		t.Helper()
		from := 0
		for _, n := range needles {
			i := strings.Index(src[from:], n)
			if i < 0 {
				t.Fatalf("%s: %q missing or out of order (want order %q)", file, n, needles)
			}
			from += i + len(n)
		}
	}
	webrtcSrc := read("session_webrtc.go")
	for _, want := range []string{
		`case "input", "input-r":`,
		"session.acceptViewerChannel(label, dc, reliable)",
		"session.viewerChannelMessage(label, dc, msg.Data)",
		"session.onViewerChannelClosed(label, dc)",
		`session.viewerChannelMessage("control", dc, msg.Data)`,
		`session.onViewerChannelClosed("control", dc)`,
		"session.wireInputEpochHooks()",
	} {
		if !strings.Contains(webrtcSrc, want) {
			t.Errorf("session_webrtc.go is missing %q", want)
		}
	}
	ctl := read("session_control.go")
	inOrder("session_control.go", ctl[strings.Index(ctl, "func (s *Session) switchMonitor("):],
		"s.geometryMu.Lock()",
		`s.resetInputGeometry("monitor_switch")`,
		"NewScreenCapturer(cfg)",
		"s.announceCurrentMonitor()",
		"applyDisplayOffset(s.inputHandler, index",
		"s.monitorSwitchedMessage(index, w, h)",
	)
	capture := read("session_capture.go")
	inOrder("session_capture.go", capture[strings.Index(capture, "func (s *Session) handleDesktopSwitch("):],
		"s.geometryMu.Lock()",
		`s.resetInputGeometry("desktop_switch")`,
		"s.announceCurrentMonitor()",
		"applyDisplayOffset(s.inputHandler, s.currentDisplayIndex()",
		"s.announceCurrentMonitor()",
	)
}
