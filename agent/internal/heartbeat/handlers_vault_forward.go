package heartbeat

import (
	"time"

	"github.com/breeze-rmm/agent/internal/remote/tools"
)

// The local vault lives in the backup helper (cmd/breeze-backup exec_vault.go).
// The agent only forwards these commands over IPC.
func init() {
	handlerRegistry[tools.CmdVaultSync] = handleVaultSync
	handlerRegistry[tools.CmdVaultStatus] = handleVaultStatus
	handlerRegistry[tools.CmdVaultConfigure] = handleVaultConfigure
}

// handleVaultSync copies a whole snapshot from primary storage into the vault
// and verifies it, so it gets the same bound as a restore.
func handleVaultSync(h *Heartbeat, cmd Command) tools.CommandResult {
	return forwardToBackupHelper(h, cmd, 60*time.Minute)
}

func handleVaultStatus(h *Heartbeat, cmd Command) tools.CommandResult {
	return forwardToBackupHelper(h, cmd, 2*time.Minute)
}

func handleVaultConfigure(h *Heartbeat, cmd Command) tools.CommandResult {
	return forwardToBackupHelper(h, cmd, 2*time.Minute)
}
