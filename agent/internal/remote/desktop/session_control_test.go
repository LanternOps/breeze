package desktop

import (
	"strings"
	"testing"
)

type stubInputHandler struct {
	events []InputEvent
}

func (h *stubInputHandler) SetDisplayOffset(x, y int)                         {}
func (h *stubInputHandler) SendMouseMove(x, y int) error                      { return nil }
func (h *stubInputHandler) SendMouseClick(x, y int, button string) error      { return nil }
func (h *stubInputHandler) SendMouseDown(x, y int, button string) error       { return nil }
func (h *stubInputHandler) SendMouseUp(x, y int, button string) error         { return nil }
func (h *stubInputHandler) SendMouseScroll(x, y int, delta int) error         { return nil }
func (h *stubInputHandler) SendKeyPress(key string, modifiers []string) error { return nil }
func (h *stubInputHandler) SendKeyDown(key string) error                      { return nil }
func (h *stubInputHandler) SendKeyUp(key string) error                        { return nil }
func (h *stubInputHandler) HandleEvent(event InputEvent) error {
	h.events = append(h.events, event)
	return nil
}

func TestHandleInputMessageRejectsOversizedPayload(t *testing.T) {
	handler := &stubInputHandler{}
	session := &Session{
		id:           "session-1",
		inputHandler: handler,
	}

	payload := `{"type":"mouse_move","x":1,"y":2,"pad":"` + strings.Repeat("a", maxInputMessageBytes) + `"}`
	session.handleInputMessage([]byte(payload))

	if len(handler.events) != 0 {
		t.Fatalf("expected oversized input payload to be ignored, got %d events", len(handler.events))
	}
	if session.inputActive.Load() {
		t.Fatal("expected oversized input payload not to mark the session active")
	}
}

func TestHandleControlMessageRejectsOversizedPayload(t *testing.T) {
	session := &Session{
		id: "session-1",
	}

	payload := `{"type":"set_fps","value":15,"pad":"` + strings.Repeat("a", maxControlMessageBytes) + `"}`
	session.handleControlMessage([]byte(payload))

	session.mu.RLock()
	fps := session.fps
	session.mu.RUnlock()
	if fps != 0 {
		t.Fatalf("expected oversized control payload to be ignored, got fps=%d", fps)
	}
}
