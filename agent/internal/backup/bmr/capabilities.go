package bmr

// CapabilitySnapshotFileMembershipV1 is the wire capability string that
// signals this agent build can restrict cross-snapshot object downloads to
// the server-verified membership index instead of trusting manifest object
// keys implicitly. MUST match
// apps/api/src/services/backupObjectKey.ts's
// BACKUP_SNAPSHOT_FILE_MEMBERSHIP_CAPABILITY constant exactly — never spell
// either side inline (Global Constraint, Part 0).
const CapabilitySnapshotFileMembershipV1 = "snapshot-file-membership-v1"

// ClientCapabilities returns the capability strings this agent build sends
// on every /bmr/recover/authenticate and /bmr/recover/exchange request.
func ClientCapabilities() []string {
	return []string{CapabilitySnapshotFileMembershipV1}
}

// HasCapability reports whether name is present in list.
func HasCapability(list []string, name string) bool {
	for _, c := range list {
		if c == name {
			return true
		}
	}
	return false
}
