//go:build windows

package heartbeat

import (
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
	"time"
)

// TestSupportSelfCleanupHelperProcess is not a test: it is the stand-in
// support client that TestSupportSelfCleanupRemovesExecutableAndFolderAfterExit
// runs. It holds its support log open, as the real client does until it
// exits, then exits.
func TestSupportSelfCleanupHelperProcess(t *testing.T) {
	hold := os.Getenv("BREEZE_SUPPORT_CLEANUP_HOLD")
	if hold == "" {
		return
	}
	f, err := os.OpenFile(hold, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o600)
	if err != nil {
		os.Exit(2)
	}
	_, _ = f.WriteString("held")
	time.Sleep(4 * time.Second)
	os.Exit(0)
}

// TestSupportSelfCleanupRemovesExecutableAndFolderAfterExit runs the real
// post-exit cleanup (cmd.exe) against a running stand-in client that holds a
// file open in its support folder. While it runs, neither the executable nor
// the folder can go; once it exits, both are removed. This is what makes a
// technician End and a closed console window leave nothing behind, even when
// the process still held files when it ended.
func TestSupportSelfCleanupRemovesExecutableAndFolderAfterExit(t *testing.T) {
	dir := t.TempDir()
	self, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	// Both names contain %OS% (always set on Windows) and %i (the cleanup's
	// loop variable): cmd.exe would replace either if a path reached it
	// unprotected, and the cleanup would then look for a different file and
	// folder and leave these behind.
	exe := filepath.Join(dir, "breeze-support-TEST1234-%OS%-%i.exe")
	copyTestFile(t, self, exe)

	ws := filepath.Join(dir, "breeze-support-%OS%-%i-99999")
	if err := os.MkdirAll(filepath.Join(ws, "data"), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(ws, "data", "audit.jsonl"), []byte("{}\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	logPath := filepath.Join(ws, "support.log")

	child := exec.Command(exe, "-test.run=^TestSupportSelfCleanupHelperProcess$")
	child.Env = append(os.Environ(), "BREEZE_SUPPORT_CLEANUP_HOLD="+logPath)
	if err := child.Start(); err != nil {
		t.Fatalf("start stand-in client: %v", err)
	}
	waitUntil(t, 10*time.Second, "the stand-in client to open its log", func() bool {
		b, err := os.ReadFile(logPath)
		return err == nil && string(b) == "held"
	})

	if err := startSupportSelfDelete(exe, ws); err != nil {
		t.Fatalf("startSupportSelfDelete: %v", err)
	}
	time.Sleep(1500 * time.Millisecond)
	if _, err := os.Stat(exe); err != nil {
		t.Fatalf("the executable went while its process was still running: %v", err)
	}
	if _, err := os.Stat(logPath); err != nil {
		t.Fatalf("the held log went while its process was still running: %v", err)
	}

	if err := child.Wait(); err != nil {
		t.Fatalf("stand-in client: %v", err)
	}
	waitUntil(t, 20*time.Second, "the executable and support folder to be removed after exit", func() bool {
		_, exeErr := os.Stat(exe)
		_, wsErr := os.Stat(ws)
		return os.IsNotExist(exeErr) && os.IsNotExist(wsErr)
	})
}

func copyTestFile(t *testing.T, from, to string) {
	t.Helper()
	in, err := os.Open(from)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = in.Close() }()
	out, err := os.Create(to)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := io.Copy(out, in); err != nil {
		_ = out.Close()
		t.Fatal(err)
	}
	if err := out.Close(); err != nil {
		t.Fatal(err)
	}
}

func waitUntil(t *testing.T, timeout time.Duration, what string, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		if cond() {
			return
		}
		time.Sleep(200 * time.Millisecond)
	}
	t.Fatalf("timed out after %s waiting for %s", timeout, what)
}
