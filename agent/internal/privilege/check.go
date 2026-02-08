package privilege

import "github.com/breeze-rmm/agent/internal/remote/tools"

// elevatedCommandTypes maps command types that require elevated (root/admin)
// privileges. Uses constants from tools package to prevent silent mismatch.
var elevatedCommandTypes = map[string]bool{
	tools.CmdReboot:            true,
	tools.CmdShutdown:          true,
	tools.CmdLock:              true,
	tools.CmdStartService:      true,
	tools.CmdStopService:       true,
	tools.CmdRestartService:    true,
	tools.CmdInstallPatches:    true,
	tools.CmdRollbackPatches:   true,
	tools.CmdRegistrySet:       true,
	tools.CmdRegistryDelete:    true,
	tools.CmdRegistryKeyCreate: true,
	tools.CmdRegistryKeyDelete: true,
	tools.CmdTaskEnable:        true,
	tools.CmdTaskDisable:       true,
	tools.CmdDownloadPatches:   true,
	tools.CmdScheduleReboot:    true,
	tools.CmdCancelReboot:      true,
}

// RequiresElevation returns true if the command type needs root/admin privileges.
func RequiresElevation(cmdType string) bool {
	return elevatedCommandTypes[cmdType]
}
