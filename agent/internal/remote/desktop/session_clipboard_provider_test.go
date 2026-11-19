package desktop

import (
	"os"
	"strings"
	"testing"

	"github.com/breeze-rmm/agent/internal/remote/clipboard"
)

type markerClipboard struct{ id string }

func (markerClipboard) GetContent() (clipboard.Content, error) { return clipboard.Content{}, nil }
func (markerClipboard) SetContent(clipboard.Content) error     { return nil }

func TestClipboardProviderForDefaultsToSystemClipboard(t *testing.T) {
	m := &SessionManager{}
	if _, ok := m.clipboardProviderFor("s1").(*clipboard.SystemClipboard); !ok {
		t.Fatalf("provider = %T, want *clipboard.SystemClipboard", m.clipboardProviderFor("s1"))
	}

	// A hook that has nothing for this session falls back too.
	m.ClipboardProvider = func(string) clipboard.Provider { return nil }
	if _, ok := m.clipboardProviderFor("s1").(*clipboard.SystemClipboard); !ok {
		t.Fatalf("nil hook result: provider = %T, want *clipboard.SystemClipboard", m.clipboardProviderFor("s1"))
	}
}

// StartSession needs a live WebRTC offer, so this guards its clipboard line
// directly: built from the hook, not a hard-coded system clipboard. Reverting
// it would bring #8393 back with every other test green.
func TestStartSessionBuildsClipboardFromProviderHook(t *testing.T) {
	src, err := os.ReadFile("session_webrtc.go")
	if err != nil {
		t.Fatal(err)
	}
	body := string(src)
	if !strings.Contains(body, "clipboard.NewClipboardSync(clipboardDC, m.clipboardProviderFor(sessionID),") {
		t.Fatal("StartSession no longer builds the session clipboard from m.clipboardProviderFor")
	}
	if strings.Contains(body, "NewSystemClipboard()") {
		t.Fatal("session_webrtc.go constructs the system clipboard directly; use m.clipboardProviderFor")
	}
}

func TestClipboardProviderForUsesHookPerSession(t *testing.T) {
	m := &SessionManager{}
	m.ClipboardProvider = func(sessionID string) clipboard.Provider { return markerClipboard{id: sessionID} }

	got, ok := m.clipboardProviderFor("desk-42").(markerClipboard)
	if !ok || got.id != "desk-42" {
		t.Fatalf("provider = %#v, want the hook's provider for desk-42", m.clipboardProviderFor("desk-42"))
	}
}
