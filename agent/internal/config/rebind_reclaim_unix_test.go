//go:build !windows

package config

import "testing"

// #8318 review fix 7: on Unix the reclaim treats the staged reattach set as a
// config file with the secrets file's mode (a world-writable one of root's
// is fixed to 0600, another account's is set aside, never read).
func TestReclaimKnowsTheStagedRebindSet(t *testing.T) {
	if mode, ok := reclaimConfigFileModes[rebindStagedFileName]; !ok || mode != 0o600 {
		t.Fatalf("reclaim mode for %s = %o (known %v), want 0600", rebindStagedFileName, mode, ok)
	}
}
