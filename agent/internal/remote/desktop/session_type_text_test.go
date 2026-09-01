package desktop

import (
	"strings"
	"testing"
)

// typeTextStubHandler records literal text injection and key presses, and can
// pretend input injection is unavailable (the macOS login-window case).
type typeTextStubHandler struct {
	stubInputHandler
	texts     []string
	keys      []string
	available bool
}

func (h *typeTextStubHandler) InputAvailable() bool { return h.available }

func (h *typeTextStubHandler) TypeText(text string) error {
	h.texts = append(h.texts, text)
	return nil
}

func (h *typeTextStubHandler) SendKeyPress(key string, _ []string) error {
	h.keys = append(h.keys, key)
	return nil
}

func newTypeTextSession() (*Session, *typeTextStubHandler) {
	handler := &typeTextStubHandler{available: true}
	return &Session{id: "session-1", inputHandler: handler}, handler
}

// The point of the whole fix: the literal string reaches the platform's text
// injector untouched, instead of being replayed as US-layout keystrokes.
func TestHandleControlMessageRoutesTypeTextToLiteralInjection(t *testing.T) {
	session, handler := newTypeTextSession()

	session.handleControlMessage([]byte(`{"type":"type_text","text":"ls /usr/local/bin | grep \"A=B\""}`))

	if want := []string{`ls /usr/local/bin | grep "A=B"`}; len(handler.texts) != 1 || handler.texts[0] != want[0] {
		t.Fatalf("injected text: got %q want %q", handler.texts, want)
	}
	if len(handler.keys) != 0 {
		t.Fatalf("expected no synthesised key presses, got %q", handler.keys)
	}
}

// Newlines must arrive as real Return presses or a pasted shell block never
// executes — see splitTextSegments.
func TestHandleTypeTextSplitsNewlinesIntoReturnPresses(t *testing.T) {
	session, handler := newTypeTextSession()

	session.handleControlMessage([]byte(`{"type":"type_text","text":"id -u\r\nwhoami"}`))

	if want := []string{"id -u", "whoami"}; len(handler.texts) != 2 || handler.texts[0] != want[0] || handler.texts[1] != want[1] {
		t.Fatalf("literal runs: got %q want %q", handler.texts, want)
	}
	if len(handler.keys) != 1 || handler.keys[0] != "return" {
		t.Fatalf("expected a single return key press, got %q", handler.keys)
	}
}

// A paste is genuine operator input even though it rides the control channel,
// so it must stamp the idle watchdog and wake the capture loop.
func TestHandleTypeTextMarksOperatorActivity(t *testing.T) {
	session, _ := newTypeTextSession()

	session.handleControlMessage([]byte(`{"type":"type_text","text":"hello"}`))

	if !session.inputActive.Load() {
		t.Fatal("expected type_text to mark the session input-active")
	}
	if session.lastInputUnixNano.Load() == 0 {
		t.Fatal("expected type_text to stamp the idle watchdog")
	}
}

// Same early drop handleInputMessage applies: nothing can be injected at the
// macOS login window without IOHIDSystem.
func TestHandleTypeTextDroppedWhenInputUnavailable(t *testing.T) {
	session, handler := newTypeTextSession()
	handler.available = false

	session.handleControlMessage([]byte(`{"type":"type_text","text":"hello"}`))

	if len(handler.texts) != 0 || len(handler.keys) != 0 {
		t.Fatalf("expected nothing to be injected, got texts=%q keys=%q", handler.texts, handler.keys)
	}
	if session.inputActive.Load() {
		t.Fatal("expected a dropped type_text not to mark the session active")
	}
}

func TestHandleTypeTextIgnoresEmptyAndMalformedPayloads(t *testing.T) {
	for _, payload := range []string{
		`{"type":"type_text"}`,
		`{"type":"type_text","text":""}`,
		`{"type":"type_text","text":123}`,
	} {
		session, handler := newTypeTextSession()
		session.handleControlMessage([]byte(payload))
		if len(handler.texts) != 0 || len(handler.keys) != 0 {
			t.Fatalf("payload %s: expected nothing injected, got texts=%q keys=%q", payload, handler.texts, handler.keys)
		}
		if session.inputActive.Load() {
			t.Fatalf("payload %s: expected the session not to be marked active", payload)
		}
	}
}

// The control-message size cap applies to type_text like every other control
// message, so an oversized paste is rejected rather than injected in part.
func TestHandleTypeTextRejectsOversizedPayload(t *testing.T) {
	session, handler := newTypeTextSession()

	payload := `{"type":"type_text","text":"` + strings.Repeat("a", maxControlMessageBytes) + `"}`
	session.handleControlMessage([]byte(payload))

	if len(handler.texts) != 0 {
		t.Fatalf("expected oversized type_text to be ignored, got %d injections", len(handler.texts))
	}
}

// The handshake must not panic before the viewer has attached a control
// channel — the reply is simply dropped and the viewer falls back.
func TestSendInputCapabilitiesWithoutControlChannel(t *testing.T) {
	session, _ := newTypeTextSession()
	session.handleControlMessage([]byte(`{"type":"input_capabilities"}`))
}
