//go:build !windows

package heartbeat

// verifyStagedWatchdog: the unix stage root is owner/mode-checked by
// watchdoginstall (checkStageRootOwner); no extra ACL gate applies.
func verifyStagedWatchdog(string) error { return nil }
