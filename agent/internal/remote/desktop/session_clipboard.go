package desktop

import (
	"log/slog"

	"github.com/breeze-rmm/agent/internal/ipc"
	"github.com/breeze-rmm/agent/internal/remote/clipboard"
)

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
		slog.Debug("Failed to send clipboard status", "error", err.Error())
	}
	if hostToViewer {
		cs.Watch()
	}
}

func clipboardSummaryForIPC(in clipboard.Summary) ipc.ClipboardSummary {
	out := ipc.ClipboardSummary{Blocked: in.Blocked, Transfers: make([]ipc.ClipboardTransferCount, 0, len(in.Transfers))}
	for _, t := range in.Transfers {
		out.Transfers = append(out.Transfers, ipc.ClipboardTransferCount{
			Direction: t.Direction, Type: t.Type, Count: t.Count, Bytes: t.Bytes,
		})
	}
	return out
}

// reportClipboardSummary hands the session's clipboard counters to the audit
// hook. Called from doCleanup, so at most once per session; a session with no
// clipboard activity reports nothing.
func (s *Session) reportClipboardSummary() {
	if s.onClipboardSummary == nil || s.clipboardSync == nil {
		return
	}
	summary := s.clipboardSync.Summary()
	if summary.Blocked == 0 && len(summary.Transfers) == 0 {
		return
	}
	s.onClipboardSummary(s.id, clipboardSummaryForIPC(summary))
}
