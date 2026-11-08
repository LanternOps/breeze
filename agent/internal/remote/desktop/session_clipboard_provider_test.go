package desktop

import (
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

func TestClipboardProviderForUsesHookPerSession(t *testing.T) {
	m := &SessionManager{}
	m.ClipboardProvider = func(sessionID string) clipboard.Provider { return markerClipboard{id: sessionID} }

	got, ok := m.clipboardProviderFor("desk-42").(markerClipboard)
	if !ok || got.id != "desk-42" {
		t.Fatalf("provider = %#v, want the hook's provider for desk-42", m.clipboardProviderFor("desk-42"))
	}
}
