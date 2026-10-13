//go:build windows

package heartbeat

import (
	"path/filepath"
	"testing"
)

// The production verifier must be the ProgramData trust chain check: a path
// outside the agent's data dir (where a Users-Modify ACE could never be
// audited) is refused. The Users-Modify ACE refusal itself is covered by
// config's TestUserWorkspaceCodecTrust* suite against VerifyProgramDataPath.
func TestVerifyStagedWatchdogRefusesPathOutsideDataDir(t *testing.T) {
	staged := filepath.Join(t.TempDir(), "breeze-watchdog.exe")
	if err := verifyStagedWatchdog(staged); err == nil {
		t.Fatal("verifyStagedWatchdog accepted a path outside the agent ProgramData tree")
	}
}
