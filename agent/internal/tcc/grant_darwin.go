//go:build darwin

// Package tcc provides read-only probes of macOS TCC (Transparency, Consent,
// and Control) permission state, used for permission REPORTING only.
//
// This package deliberately does not write to the TCC database. An earlier
// "self-heal" path inserted grant rows via a sqlite3 subprocess, which Apple
// does not support: on macOS 13+ the write is attributed to the sqlite3
// subprocess (no FDA) and is inert, and on macOS 12 it wrote path-keyed rows
// without a csreq code-identity binding, causing re-prompt storms. See #3380.
package tcc

import (
	"errors"
	"os"

	"github.com/breeze-rmm/agent/internal/logging"
)

var log = logging.L("tcc")

// systemTCCDBPath is the system-level TCC database managed by macOS.
// Only processes with Full Disk Access (or root) can open it.
const systemTCCDBPath = "/Library/Application Support/com.apple.TCC/TCC.db"

// CheckFDA reports whether the agent daemon itself holds Full Disk Access,
// by attempting to open the system TCC database in-process. macOS attributes
// the permission check to the binary issuing the open() call, so this reflects
// the daemon's own effective grant. It must NOT shell out to sqlite3: on
// macOS 13+ the check is attributed to the sqlite3 subprocess, which holds no
// FDA, so a subprocess-based query is denied regardless of the agent's grant
// (issue #3380).
//
// This is used as a daemon-side fallback when the user helper's probe returns
// false — which happens on macOS 12 where even FDA-granted user-context
// processes cannot open the system TCC database.
//
// Returns false (without error) when not root or when the database cannot be
// opened, so callers can safely treat the result as a best-effort check.
func CheckFDA() bool {
	if os.Getuid() != 0 {
		log.Debug("CheckFDA skipped — not running as root")
		return false
	}
	return checkFDAAtPath(systemTCCDBPath)
}

// checkFDAAtPath probes Full Disk Access by opening dbPath in-process.
// Permission errors mean FDA is denied; other errors (e.g. ENOENT if Apple
// moves the DB in a future macOS version) are logged and treated as denied.
func checkFDAAtPath(dbPath string) bool {
	f, err := os.Open(dbPath)
	if err != nil {
		if !errors.Is(err, os.ErrPermission) {
			log.Warn("CheckFDA probe got unexpected error (not permission denied)",
				"path", dbPath, "error", err.Error())
		}
		return false
	}
	f.Close()
	return true
}
