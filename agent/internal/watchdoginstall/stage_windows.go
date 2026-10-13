//go:build windows

package watchdoginstall

import "os"

// checkStageRootOwner is a no-op on Windows: ownership is not the risk here.
// The trust audit only checks the data dir's owner, not who can write it, so
// the writer check is made separately by the caller (heartbeat's
// verifyStagedWatchdog, config.VerifyProgramDataPath) right before the staged
// binary is executed.
func checkStageRootOwner(os.FileInfo) error { return nil }
