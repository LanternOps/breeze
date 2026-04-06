# Agent Result Validation Register

High-risk agent result paths that mutate operator-visible recovery state.

| command_type | ingest_path | handler_exists | current_handler | current_validation | linked_state_mutations | risk | target_schema | notes |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `backup_restore` | websocket orphaned result path | yes | `processOrphanedCommandResult()` -> restore job update | none on `result.result` | `restore_jobs` updated directly | high | restore result schema | No `device_commands` row; command id is the restore job id |
| `vm_restore_from_backup` | websocket, agent REST | yes | `handleVmRestoreResult()` | none on `result.result` | `restore_jobs` updated via command linkage | high | restore result schema | DR may also dispatch this type |
| `vm_instant_boot` | websocket, agent REST | yes | `handleVmRestoreResult()` | none on `result.result` | `restore_jobs` updated via command linkage | high | restore result schema | DR may also dispatch this type |
| `hyperv_restore` | websocket, agent REST | partial | DR result path only | none on `result.result` | `dr_executions.results` reconciliation only | high | restore/DR result schema | No restore-job update path |
| `mssql_restore` | websocket, agent REST | partial | DR result path only | none on `result.result` | `dr_executions.results` reconciliation only | high | restore/DR result schema | No restore-job update path |
| `bmr_recover` | websocket, agent REST | partial | DR result path only | none on `result.result` | `dr_executions.results` reconciliation only | high | restore/DR result schema | BMR command family, not normal file restore |
| `backup_verify` | websocket, agent REST | yes | `handleBackupVerificationResult()` / `processBackupVerificationResult()` | parsed JSON only, no schema validation | verification rows and readiness state | high | verification result schema | Completed results should carry structured verification JSON |
| `backup_test_restore` | websocket, agent REST | yes | `handleBackupVerificationResult()` / `processBackupVerificationResult()` | parsed JSON only, no schema validation | verification rows and readiness state | high | verification result schema | Same pipeline as integrity verification |
| `vault_sync` | websocket, agent REST, websocket auto-sync | yes | `handleVaultSyncResult()` / `applyVaultSyncCommandResult()` | stdout JSON parse only, permissive | `local_vaults`, `vault_snapshot_inventory` | high | vault sync result schema | Needs shared validation before persistence |
