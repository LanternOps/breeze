package desktop

import "github.com/breeze-rmm/agent/internal/remote/clipboard"

// clipboardProviderFor is the clipboard a new session syncs: the
// ClipboardProvider hook's, when it has one for this session, else the local
// system clipboard.
func (m *SessionManager) clipboardProviderFor(sessionID string) clipboard.Provider {
	if m.ClipboardProvider != nil {
		if p := m.ClipboardProvider(sessionID); p != nil {
			return p
		}
	}
	return clipboard.NewSystemClipboard()
}
