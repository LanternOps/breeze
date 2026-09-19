//go:build !windows

package executor

import (
	"os"
	"os/user"
	"path/filepath"
	"syscall"
	"testing"
)

func TestPrepareScriptForRunAsTransfersPrivateTreeToTarget(t *testing.T) {
	current, err := user.Current()
	if err != nil {
		t.Fatal(err)
	}
	t.Setenv("TMPDIR", t.TempDir())
	scriptPath, err := WriteScriptFile("echo synthetic", ScriptTypeBash)
	if err != nil {
		t.Fatal(err)
	}
	defer CleanupScript(scriptPath)

	if err := prepareScriptForRunAs(scriptPath, current.Username); err != nil {
		t.Fatalf("prepare script for current named user: %v", err)
	}
	for _, path := range []string{filepath.Dir(scriptPath), scriptPath} {
		info, err := os.Stat(path)
		if err != nil {
			t.Fatal(err)
		}
		if info.Mode().Perm()&0o077 != 0 {
			t.Fatalf("%s became accessible to identities other than its owner: mode %o", path, info.Mode().Perm())
		}
	}
}

func TestPrepareScriptForRunAsRejectsUnknownIdentity(t *testing.T) {
	if err := prepareScriptForRunAs("/not/used", "breeze-user-that-must-not-exist-9f80d19b"); err == nil {
		t.Fatal("unknown runAs identity was accepted")
	}
}

func TestPrepareScriptForRunAsDoesNotFollowScriptSymlink(t *testing.T) {
	if os.Geteuid() != 0 {
		t.Skip("root-to-unprivileged ownership assertion requires root")
	}
	target, err := user.Lookup("nobody")
	if err != nil {
		t.Skipf("nobody account unavailable: %v", err)
	}
	t.Setenv("TMPDIR", t.TempDir())
	scriptPath, err := WriteScriptFile("echo synthetic", ScriptTypeBash)
	if err != nil {
		t.Fatal(err)
	}
	defer CleanupScript(scriptPath)

	outside := filepath.Join(t.TempDir(), "root-owned")
	if err := os.WriteFile(outside, []byte("outside"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(scriptPath); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, scriptPath); err != nil {
		t.Fatal(err)
	}

	if err := prepareScriptForRunAs(scriptPath, target.Username); err == nil {
		t.Fatal("script symlink was accepted")
	}
	info, err := os.Stat(outside)
	if err != nil {
		t.Fatal(err)
	}
	stat, ok := info.Sys().(*syscall.Stat_t)
	if !ok {
		t.Fatal("outside file ownership unavailable")
	}
	if stat.Uid != 0 {
		t.Fatalf("root-owned outside file was transferred to uid %d", stat.Uid)
	}
}
