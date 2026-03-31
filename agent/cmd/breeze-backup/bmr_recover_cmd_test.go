package main

import (
	"testing"

	"github.com/breeze-rmm/agent/internal/backup/bmr"
)

func TestBMRRecoverCommandParsesFlags(t *testing.T) {
	origRunner := runBMRRecovery
	defer func() { runBMRRecovery = origRunner }()

	var gotCfg bmr.RecoveryConfig
	runBMRRecovery = func(cfg bmr.RecoveryConfig) (*bmr.RecoveryResult, error) {
		gotCfg = cfg
		return &bmr.RecoveryResult{Status: "completed"}, nil
	}

	cmd := newBMRRecoverCommand()
	cmd.SetArgs([]string{
		"--token", "brz_rec_test",
		"--server", "https://api.example.com",
		"--target-path", "/src/data=/dst/data",
	})

	if err := cmd.Execute(); err != nil {
		t.Fatalf("Execute: %v", err)
	}
	if gotCfg.RecoveryToken != "brz_rec_test" {
		t.Fatalf("RecoveryToken = %q, want brz_rec_test", gotCfg.RecoveryToken)
	}
	if gotCfg.ServerURL != "https://api.example.com" {
		t.Fatalf("ServerURL = %q, want https://api.example.com", gotCfg.ServerURL)
	}
	if gotCfg.TargetPaths["/src/data"] != "/dst/data" {
		t.Fatalf("TargetPaths = %#v, want override", gotCfg.TargetPaths)
	}
}

func TestBMRRecoverCommandRejectsBadTargetPath(t *testing.T) {
	cmd := newBMRRecoverCommand()
	cmd.SetArgs([]string{
		"--token", "brz_rec_test",
		"--server", "https://api.example.com",
		"--target-path", "missing-separator",
	})

	if err := cmd.Execute(); err == nil {
		t.Fatal("expected Execute to fail for malformed target-path")
	}
}
