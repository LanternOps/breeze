package desktop

import (
	"encoding/json"
	"strings"
	"sync"
	"testing"
	"time"
)

type stubInputHandler struct {
	events []InputEvent
}

func (h *stubInputHandler) InputAvailable() bool                              { return true }
func (h *stubInputHandler) SetDisplayOffset(x, y int)                         {}
func (h *stubInputHandler) SendMouseMove(x, y int) error                      { return nil }
func (h *stubInputHandler) SendMouseClick(x, y int, button string) error      { return nil }
func (h *stubInputHandler) SendMouseDown(x, y int, button string) error       { return nil }
func (h *stubInputHandler) SendMouseUp(x, y int, button string) error         { return nil }
func (h *stubInputHandler) SendMouseScroll(x, y int, delta int) error         { return nil }
func (h *stubInputHandler) SendKeyPress(key string, modifiers []string) error { return nil }
func (h *stubInputHandler) SendKeyDown(key string) error                      { return nil }
func (h *stubInputHandler) SendKeyUp(key string) error                        { return nil }
func (h *stubInputHandler) SetAtLoginWindow(atLoginWindow bool)               {}
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

// installStubInputBlockManager replaces the package-level InputBlockManager
// singleton with one backed by a controllable stub, then resets the singleton
// via t.Cleanup so a later GetInputBlockManager() lazily rebuilds the real one.
// This lets the control-message wiring tests exercise both the supported and
// unsupported platforms deterministically regardless of the host OS.
//
// These tests must not run in parallel — they share the package-level singleton.
func installStubInputBlockManager(t *testing.T, supported bool) *stubInputBlockBackend {
	t.Helper()
	backend := &stubInputBlockBackend{supported: supported}

	inputBlockMgrInstance = &InputBlockManager{
		backend:     backend,
		now:         time.Now,
		maxDuration: time.Hour,
	}
	// Consume the Once in place (no copy) so GetInputBlockManager returns our
	// instance instead of constructing a fresh one.
	inputBlockMgrOnce.Do(func() {})

	t.Cleanup(func() {
		// Reset to pristine lazy-init state for any later caller.
		inputBlockMgrInstance = nil
		inputBlockMgrOnce = sync.Once{}
	})
	return backend
}

func TestHandleControlMessage_BlockLocalInput_Supported(t *testing.T) {
	backend := installStubInputBlockManager(t, true)
	session := &Session{id: "session-block"}

	// Engage.
	session.handleControlMessage([]byte(`{"type":"block_local_input","value":1}`))
	if !session.localInputBlocked.Load() {
		t.Fatal("expected session to record localInputBlocked after engage")
	}
	if b, _ := backend.counts(); b != 1 {
		t.Fatalf("expected 1 backend Block call, got %d", b)
	}
	if !GetInputBlockManager().IsEngaged() {
		t.Fatal("expected manager engaged after block_local_input value=1")
	}

	// Toggling on again must be idempotent (no second Block).
	session.handleControlMessage([]byte(`{"type":"block_local_input","value":1}`))
	if b, _ := backend.counts(); b != 1 {
		t.Fatalf("expected Block to remain at 1 on repeat engage, got %d", b)
	}

	// Release.
	session.handleControlMessage([]byte(`{"type":"block_local_input","value":0}`))
	if session.localInputBlocked.Load() {
		t.Fatal("expected session to clear localInputBlocked after release")
	}
	if _, u := backend.counts(); u != 1 {
		t.Fatalf("expected 1 backend Unblock call, got %d", u)
	}
	if GetInputBlockManager().IsEngaged() {
		t.Fatal("expected manager not engaged after block_local_input value=0")
	}
}

func TestHandleControlMessage_BlockLocalInput_Unsupported(t *testing.T) {
	backend := installStubInputBlockManager(t, false)
	session := &Session{id: "session-block-unsupported"}

	session.handleControlMessage([]byte(`{"type":"block_local_input","value":1}`))

	if session.localInputBlocked.Load() {
		t.Fatal("unsupported platform must not record localInputBlocked")
	}
	if b, _ := backend.counts(); b != 0 {
		t.Fatalf("unsupported platform must not call backend.Block, got %d", b)
	}
	if GetInputBlockManager().IsEngaged() {
		t.Fatal("unsupported platform must not engage the manager")
	}
}

func TestDoCleanup_ReleasesLocalInputBlock(t *testing.T) {
	backend := installStubInputBlockManager(t, true)
	// doCleanup is fully nil-guarded, so a bare session is enough to exercise the
	// local-input-block release path without standing up encoder/capturer state.
	session := &Session{id: "session-cleanup"}

	// Engage a block for this session.
	session.handleControlMessage([]byte(`{"type":"block_local_input","value":1}`))
	if !GetInputBlockManager().IsEngaged() {
		t.Fatal("precondition: manager should be engaged")
	}

	// Session teardown must release the block so the local user is never left
	// locked out.
	session.doCleanup()

	if session.localInputBlocked.Load() {
		t.Fatal("doCleanup must clear localInputBlocked")
	}
	if _, u := backend.counts(); u != 1 {
		t.Fatalf("expected doCleanup to release the block (1 Unblock), got %d", u)
	}
	if GetInputBlockManager().IsEngaged() {
		t.Fatal("manager must not be engaged after doCleanup")
	}
}

func TestHandleBlockLocalInput_ResultMessageShape(t *testing.T) {
	// Drive the REAL handleBlockLocalInput on an unsupported platform stub and
	// verify the wire shape the viewer receives. A nil controlDC is safe — the
	// handler guards the SendText — so the full handler body still runs and
	// computes the result via the shared blockLocalInputResultBody builder.
	installStubInputBlockManager(t, false)
	session := &Session{id: "session-msg"} // controlDC nil

	// Engaging on an unsupported platform must not record a block, must report
	// supported=false, and must still produce a well-formed result body.
	session.handleBlockLocalInput(true)

	if session.localInputBlocked.Load() {
		t.Fatal("unsupported platform must not record localInputBlocked")
	}

	// Reconstruct the exact body the handler marshaled, via the same builder it
	// uses, and assert the wire shape end-to-end through JSON.
	body := blockLocalInputResultBody(
		GetInputBlockManager().Supported(),
		session.localInputBlocked.Load(),
		true,
		"",
	)
	raw, err := json.Marshal(body)
	if err != nil {
		t.Fatalf("marshal result: %v", err)
	}
	var decoded map[string]any
	if err := json.Unmarshal(raw, &decoded); err != nil {
		t.Fatalf("unmarshal result: %v", err)
	}
	if decoded["type"] != "block_local_input_result" {
		t.Fatalf("unexpected type: %v", decoded["type"])
	}
	if decoded["supported"] != false {
		t.Fatalf("expected supported=false from stub, got %v", decoded["supported"])
	}
	if decoded["blocked"] != false {
		t.Fatalf("expected blocked=false on unsupported platform, got %v", decoded["blocked"])
	}
	if decoded["ok"] != true {
		t.Fatalf("expected ok=true (unsupported is not an error), got %v", decoded["ok"])
	}
	if _, hasErr := decoded["error"]; hasErr {
		t.Fatalf("unsupported (non-error) result must omit the error field, got %v", decoded["error"])
	}
}

func TestHandleBlockLocalInput_SupportedEngageAndRelease(t *testing.T) {
	// Drive the REAL handleBlockLocalInput on a supported stub and verify it
	// engages and releases the manager and tracks per-session state. controlDC
	// is nil; the handler must still perform the engage/release side effects.
	backend := installStubInputBlockManager(t, true)
	session := &Session{id: "session-real-handler"}

	session.handleBlockLocalInput(true)
	if !session.localInputBlocked.Load() {
		t.Fatal("expected handleBlockLocalInput(true) to record localInputBlocked")
	}
	if b, _ := backend.counts(); b != 1 {
		t.Fatalf("expected exactly 1 backend Block, got %d", b)
	}

	session.handleBlockLocalInput(false)
	if session.localInputBlocked.Load() {
		t.Fatal("expected handleBlockLocalInput(false) to clear localInputBlocked")
	}
	if _, u := backend.counts(); u != 1 {
		t.Fatalf("expected exactly 1 backend Unblock, got %d", u)
	}
}

func TestBlockLocalInputResultBody_CarriesError(t *testing.T) {
	// A failed engage must surface ok=false plus the error string so the viewer
	// can show why the block did not take.
	body := blockLocalInputResultBody(true, false, false, "BlockInput(TRUE): access denied")
	if body["ok"] != false {
		t.Fatalf("expected ok=false, got %v", body["ok"])
	}
	if body["error"] != "BlockInput(TRUE): access denied" {
		t.Fatalf("expected error string to be carried, got %v", body["error"])
	}
}
