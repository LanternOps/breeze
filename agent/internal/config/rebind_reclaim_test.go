package config

import "testing"

// #8318 review fix 7: the staged reattach set is one of the agent's own
// entries in its config folder: another account owning it means that
// account could write the folder, so the folder is replaced (and, on
// Windows, the set carried over under the secrets file's rules; see
// rebind_reclaim_windows_test.go).
func TestTheStagedRebindSetIsAnAgentConfigEntry(t *testing.T) {
	if !reclaimAgentEntries[rebindStagedFileName] {
		t.Fatalf("%s is not among the agent's own config-folder entries", rebindStagedFileName)
	}
}
