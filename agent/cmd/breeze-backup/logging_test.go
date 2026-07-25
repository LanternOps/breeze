package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/breeze-rmm/agent/internal/config"
	"github.com/breeze-rmm/agent/internal/logging"
)

// TestInitLoggingWritesToFile is the regression guard for #2790: breeze-backup
// used to rely on the package-level slog default (stdout) while the agent
// spawned it with inherited stdio, which under a Windows service is NUL. Every
// line a backup run produced was discarded. The contract this pins is narrow
// and deliberate — after initLogging, a log line must land in a real file on
// disk, next to agent.log.
func TestInitLoggingWritesToFile(t *testing.T) {
	dir := t.TempDir()
	cfg := config.Default()
	cfg.LogFile = filepath.Join(dir, "agent.log")
	cfg.LogLevel = "debug"
	// No AgentID/ServerURL/AuthToken, so the shipper stays off and this test
	// makes no network calls.
	cfg.AgentID = ""
	cfg.ServerURL = ""
	cfg.AuthToken = ""

	stop := initLogging(cfg)
	defer stop()

	logging.L("backup").Info("canary line", "jobId", "test-job-1")

	backupLog := filepath.Join(dir, "backup.log")
	data, err := os.ReadFile(backupLog)
	if err != nil {
		t.Fatalf("expected %s to exist after initLogging: %v", backupLog, err)
	}
	got := string(data)
	if !strings.Contains(got, "canary line") {
		t.Errorf("backup.log missing the logged message; got:\n%s", got)
	}
	// The component tag is what makes these lines filterable via the
	// diagnostic-logs API; without it they ship as component "unknown".
	if !strings.Contains(got, "backup") {
		t.Errorf("backup.log missing the component tag; got:\n%s", got)
	}
	if !strings.Contains(got, "test-job-1") {
		t.Errorf("backup.log dropped structured attrs; got:\n%s", got)
	}
}

// TestInitLoggingHonoursDebugLevel pins that the configured level actually
// reaches the handler. The per-file upload lines added in snapshot.go are at
// debug, so a hardcoded info default would silently discard exactly the
// diagnostics this work exists to produce.
func TestInitLoggingHonoursDebugLevel(t *testing.T) {
	dir := t.TempDir()
	cfg := config.Default()
	cfg.LogFile = filepath.Join(dir, "agent.log")
	cfg.LogLevel = "debug"
	cfg.AgentID = ""
	cfg.ServerURL = ""
	cfg.AuthToken = ""

	stop := initLogging(cfg)
	defer stop()

	logging.L("backup").Debug("debug canary")

	data, err := os.ReadFile(filepath.Join(dir, "backup.log"))
	if err != nil {
		t.Fatalf("read backup.log: %v", err)
	}
	if !strings.Contains(string(data), "debug canary") {
		t.Errorf("debug line was dropped despite log_level=debug; got:\n%s", string(data))
	}
}

// TestInitLoggingWithoutCredentialsReturnsNoopStop guards the os.Exit paths in
// runBackupHelper: they call the returned stop func explicitly because defers
// do not run, so it must be safe to call when the shipper was never started.
func TestInitLoggingWithoutCredentialsReturnsNoopStop(t *testing.T) {
	dir := t.TempDir()
	cfg := config.Default()
	cfg.LogFile = filepath.Join(dir, "agent.log")
	cfg.AgentID = ""
	cfg.ServerURL = ""
	cfg.AuthToken = ""

	stop := initLogging(cfg)
	if stop == nil {
		t.Fatal("initLogging returned a nil stop func")
	}
	stop()
	stop() // idempotent: an os.Exit path may call it after a defer already did
}
