package desktop

import "log/slog"

type clipboardOpener interface {
	SendStatus() error
	Watch()
}

// onClipboardChannelOpen tells the viewer what the channel allows, under any
// policy, then starts streaming the host clipboard if that direction is
// allowed. Watch is itself a no-op when it is not; the check keeps the intent
// visible here.
func onClipboardChannelOpen(cs clipboardOpener, hostToViewer bool) {
	if err := cs.SendStatus(); err != nil {
		// Without it the viewer treats this agent as one that predates
		// status: no chunked paste and no policy indicator.
		slog.Warn("Failed to send clipboard status", "error", err.Error())
	}
	if hostToViewer {
		cs.Watch()
	}
}
