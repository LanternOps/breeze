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
	rootCmd.Version = version
	defer func() {
		version = origVersion
		rootCmd.Version = origVersion
	}()

	var out bytes.Buffer
	rootCmd.SetOut(&out)
	rootCmd.SetArgs([]string{"--version"})

	if err := rootCmd.Execute(); err != nil {
		t.Fatalf("rootCmd.Execute(--version): %v", err)
	}

	want := "Breeze Backup Version: 9.9.9-test\n"
	if got := out.String(); got != want {
		t.Fatalf("--version output = %q, want %q", got, want)
	}
}
