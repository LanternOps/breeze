//go:build windows

package watchdoginstall

import "os"

// checkStageRootOwner: on Windows the stage root lives under the agent's
// ProgramData data dir, whose ACL the config trust audit already enforces
// (SYSTEM/Administrators only); files created there inherit it.
func checkStageRootOwner(os.FileInfo) error { return nil }
