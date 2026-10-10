package desktop

import (
	"crypto/rand"
	"encoding/hex"

	"github.com/breeze-rmm/agent/internal/ipc"
	"github.com/breeze-rmm/agent/internal/remote/clipboard"
)

// clipboardSummaryForIPC converts the counters and names the segment they
// cover: this Session. Called once per Session, from teardown.
func clipboardSummaryForIPC(in clipboard.Summary) ipc.ClipboardSummary {
	out := ipc.ClipboardSummary{Blocked: in.Blocked, Transfers: make([]ipc.ClipboardTransferCount, 0, len(in.Transfers))}
	var seg [16]byte
	if _, err := rand.Read(seg[:]); err == nil {
		out.SegmentID = hex.EncodeToString(seg[:])
	} // else the service mints one

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
