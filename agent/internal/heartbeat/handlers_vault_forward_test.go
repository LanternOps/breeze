package heartbeat

import "testing"

// TestVaultCommandsAreRoutedToBackupHelper pins #8385. The API queues
// vault_sync (POST /backup/vault/:id/sync, trigger_vault_sync) and
// vault_configure (vault create/update/deactivate, configure_vault), and the
// backup helper implements all three vault commands. The agent had no handler
// for any of them, so each came back as "unknown command type".
func TestVaultCommandsAreRoutedToBackupHelper(t *testing.T) {
	for _, cmdType := range []string{"vault_sync", "vault_status", "vault_configure"} {
		t.Run(cmdType, func(t *testing.T) {
			if _, ok := handlerRegistry[cmdType]; !ok {
				t.Fatalf("%q has no agent handler, so the agent answers it as an unknown command instead of forwarding it to the backup helper", cmdType)
			}
		})
	}
}
