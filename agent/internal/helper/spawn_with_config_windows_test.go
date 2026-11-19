package helper

import (
	"errors"
	"testing"
)

// #10379: the default Windows spawn path has no SYSTEM fallback. The session
// does not exist, so every user-token strategy fails, and that must read as a
// wait for a user.
func TestSpawnWithConfigNoUserTokenIsAWait(t *testing.T) {
	const noSuchSession = "65000"

	pid, err := spawnWithConfig(`C:\no\such\breeze-helper.exe`, noSuchSession, `C:\no\such\helper_config.yaml`)

	if !errors.Is(err, ErrNoActiveSession) {
		t.Fatalf("err = %v, want ErrNoActiveSession", err)
	}
	if pid != 0 {
		t.Fatalf("pid = %d, want no launch", pid)
	}
}
