package main

import (
	"log/slog"
	"time"

	"github.com/breeze-rmm/agent/internal/backupipc"
)

// verifyProgressInterval is how often a backup_verify / backup_test_restore
// run reports progress. Per-file reporting would be one IPC and one WS
// message per object — ~200k for the snapshots in #6598 — each costing the
// server a lookup.
const verifyProgressInterval = 30 * time.Second

// newVerifyProgressReporter returns a backup.VerifyOptions.Progress callback
// that sends at most one progress message per interval, plus one for the
// final entry, over the existing backup_progress channel (the one
// backup_run and backup_restore use). Each message is also logged, so a
// long run leaves a trail in the helper's log even if the server does not
// act on the message. send may be nil (no IPC connection).
func newVerifyProgressReporter(send func(backupipc.BackupProgress), commandID, phase string, interval time.Duration, now func() time.Time) func(done, total int) {
	last := now()
	return func(done, total int) {
		t := now()
		if done < total && t.Sub(last) < interval {
			return
		}
		last = t
		slog.Info("backup verification progress", "commandId", commandID, "phase", phase,
			"filesDone", done, "filesTotal", total)
		if send == nil {
			return
		}
		send(backupipc.BackupProgress{
			CommandID:  commandID,
			Phase:      phase,
			Current:    int64(done),
			Total:      int64(total),
			FilesDone:  done,
			FilesTotal: total,
		})
	}
}
