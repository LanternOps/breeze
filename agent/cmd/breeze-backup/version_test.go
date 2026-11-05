package main

import (
	"bytes"
	"testing"
)

// TestRootCmd_VersionFlagRendersStablePrefix pins the exact `breeze-backup
// --version` output the heartbeat's installedBackupVersion() parses
// (internal/heartbeat/backup_version.go, backupVersionPrefix). A drift here
// silently breaks backup version reporting without any compile-time signal,
// since the parser only ever returns "" on a mismatch.
func TestRootCmd_VersionFlagRendersStablePrefix(t *testing.T) {
	origVersion := version
	version = "9.9.9-test"
	t.Cleanup(func() { version = origVersion })
	root := newRootCmd()

	var out bytes.Buffer
	root.SetOut(&out)
	root.SetArgs([]string{"--version"})

	if err := root.Execute(); err != nil {
		t.Fatalf("Execute(--version): %v", err)
	}

	want := "Breeze Backup Version: 9.9.9-test\n"
	if got := out.String(); got != want {
		t.Fatalf("--version output = %q, want %q", got, want)
	}
}
