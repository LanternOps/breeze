package main

import (
	"os"
	"testing"

	"github.com/breeze-rmm/agent/internal/backup/rebuild"
)

// TestMain pins the rebuild engine's host platform to Linux: this package's
// rebuild tests drive the Linux engine through rebuildSystemForTest on any
// dev host.
func TestMain(m *testing.M) {
	rebuild.SetHostPlatformForTest("linux")
	os.Exit(m.Run())
}
