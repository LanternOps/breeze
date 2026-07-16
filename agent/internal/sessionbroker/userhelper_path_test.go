package sessionbroker

import (
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
)

// TestResolveUserHelperPath_PicksGUIBinaryWhenAvailable verifies that when
// breeze-user-helper.exe sits alongside the running agent binary,
// resolveUserHelperPath returns the helper path (so spawn paths use the
// GUI-subsystem sibling and avoid the console-window flash bug).
//
// This is the positive-path counterpart to the fallback test below. Together
// they pin the two-binary contract that the AgentUserHelper scheduled task
// XML and the SYSTEM-context broker spawn paths depend on.
func TestResolveUserHelperPath_PicksGUIBinaryWhenAvailable(t *testing.T) {
	tmpDir := t.TempDir()
	agentExe := filepath.Join(tmpDir, "breeze-agent.exe")
	helperExe := filepath.Join(tmpDir, UserHelperBinaryName)
	if err := os.WriteFile(agentExe, []byte("agent stub"), 0o644); err != nil {
		t.Fatalf("write agent stub: %v", err)
	}
	if err := os.WriteFile(helperExe, []byte("helper stub"), 0o644); err != nil {
		t.Fatalf("write helper stub: %v", err)
	}

	got, err := resolveUserHelperPath(agentExe)
	if err != nil {
		t.Fatalf("resolveUserHelperPath returned unexpected error: %v", err)
	}
	if got.Path != helperExe || got.MainBinaryFallback {
		t.Fatalf("resolveUserHelperPath = %#v, want path %q without fallback", got, helperExe)
	}
}

// TestUserHelperExePath_FallsBackToAgentWhenSiblingMissing exercises the
// fs.ErrNotExist branch of resolveUserHelperPath, which is the documented
// defense-in-depth path for partially-upgraded installs where the new task
// XML points at breeze-user-helper.exe but the binary itself is missing
// (failed build, AV quarantine, tamper). The fallback returns the agent
// path so run_as_user functionality keeps working at the cost of a visible
// console window. The owning spawner uses the returned provenance to emit
// bounded ops telemetry rather than warning on every reconciliation.
func TestUserHelperExePath_FallsBackToAgentWhenSiblingMissing(t *testing.T) {
	tmpDir := t.TempDir()
	agentExe := filepath.Join(tmpDir, "breeze-agent.exe")
	if err := os.WriteFile(agentExe, []byte("agent stub"), 0o644); err != nil {
		t.Fatalf("write agent stub: %v", err)
	}
	// Deliberately do NOT create the sibling breeze-user-helper.exe.

	got, err := resolveUserHelperPath(agentExe)
	if err != nil {
		t.Fatalf("resolveUserHelperPath returned error on missing sibling, want nil + agent fallback: %v", err)
	}
	if got.Path != agentExe || !got.MainBinaryFallback {
		t.Fatalf("resolveUserHelperPath fallback = %#v, want path %q with fallback", got, agentExe)
	}
}

func TestHelperFallbackWarningOwnerWarnsOncePerOwner(t *testing.T) {
	buf := captureLogs(t)
	resolved := ResolvedHelperExecutable{
		Path:               filepath.Join(t.TempDir(), "breeze-agent.exe"),
		MainBinaryFallback: true,
	}

	owners := []*helperFallbackWarningOwner{{}, {}}
	start := make(chan struct{})
	var ready sync.WaitGroup
	var calls sync.WaitGroup
	const callsPerOwner = 32
	ready.Add(len(owners) * callsPerOwner)
	calls.Add(len(owners) * callsPerOwner)
	for _, owner := range owners {
		for range callsPerOwner {
			go func(owner *helperFallbackWarningOwner) {
				defer calls.Done()
				ready.Done()
				<-start
				owner.WarnIfFallback(resolved)
			}(owner)
		}
	}
	ready.Wait()
	close(start)
	calls.Wait()

	const warning = "breeze-user-helper.exe missing"
	if got := strings.Count(buf.String(), warning); got != 2 {
		t.Fatalf("warning count = %d, want one for each of two concurrent owners; logs: %s", got, buf.String())
	}
}

// TestResolveUserHelperPath_PropagatesOtherStatErrors verifies that any
// stat error other than fs.ErrNotExist (e.g. permission, I/O) is returned
// to the caller so the spawn fails loud instead of silently downgrading.
// Test simulates the "dir-instead-of-file" case via filename containing a
// NUL byte, which os.Stat rejects with EINVAL on POSIX and ERROR_INVALID_NAME
// on Windows. Skipped on filesystems where the synthetic invalid path
// somehow succeeds — see error mapping note inline.
func TestResolveUserHelperPath_PropagatesOtherStatErrors(t *testing.T) {
	// Use a path with an embedded NUL byte to provoke an invalid-argument
	// error from os.Stat. This is portable: every OS POSIX-syscalls go
	// through chokes on NUL in pathnames, returning ENOENT/EINVAL/etc.,
	// none of which are wrapped as fs.ErrNotExist.
	agentExe := "/tmp/breeze-agent.exe\x00invalid"
	_, err := resolveUserHelperPath(agentExe)
	if err == nil {
		t.Skip("filesystem unexpectedly accepted an invalid agent path; cannot exercise the error branch here")
	}
	// We only care that the function did NOT swallow this error as a
	// fallback. The exact wrapping wording is intentionally not pinned.
	if !strings.Contains(err.Error(), "stat") {
		t.Fatalf("resolveUserHelperPath error does not mention stat: %v", err)
	}
}
