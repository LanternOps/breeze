//go:build windows

package vss

import (
	"context"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"golang.org/x/sys/windows"
)

// Live VSS tests. These need the real Volume Shadow Copy Service, an elevated
// process, and they create (briefly) a real shadow copy of the system volume,
// so they are opt-in:
//
//	set BREEZE_VSS_LIVE=1 && go test ./internal/backup/vss/ -run Live -v
//
// Everything in the VSS provider below CreateShadowCopy is raw COM vtable
// dispatch against a service that cannot be faked, so there is no honest unit
// test for it — a mock would only assert that our own wrong constants are
// still our own wrong constants, which is precisely what let #2999 ship. The
// checkable ABI facts are pinned in vss_windows_layout_test.go; correctness of
// the call sequence is only observable against the live service, here.

func requireLiveVSS(t *testing.T) {
	t.Helper()
	if os.Getenv("BREEZE_VSS_LIVE") != "1" {
		t.Skip("set BREEZE_VSS_LIVE=1 to run live VSS tests (needs an elevated process)")
	}
}

// systemVolume returns the volume of the Windows drive in the same form
// backup.go's extractVolumes produces: "C:", with no trailing separator.
func systemVolume(t *testing.T) string {
	t.Helper()
	sysRoot := os.Getenv("SystemRoot")
	if sysRoot == "" {
		sysRoot = `C:\Windows`
	}
	return filepath.VolumeName(sysRoot)
}

// TestLive_CreateShadowCopy_EndToEnd is the regression test for #2999. Before
// the fix, this failed at InitializeForBackup with HRESULT 0x80070057.
func TestLive_CreateShadowCopy_EndToEnd(t *testing.T) {
	requireLiveVSS(t)

	vol := systemVolume(t)
	p := NewProvider(DefaultConfig())

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
	defer cancel()

	session, err := p.CreateShadowCopy(ctx, []string{vol})
	if err != nil {
		t.Fatalf("CreateShadowCopy(%q) failed: %v", vol, err)
	}
	defer p.ReleaseShadowCopy(session) //nolint:errcheck

	if session.ID == "" {
		t.Error("session ID is empty")
	}
	// The session must be keyed by the caller's volume string, not the
	// normalised mount point — backup.go looks it up with filepath.VolumeName.
	shadow, ok := session.ShadowPaths[vol]
	if !ok {
		t.Fatalf("ShadowPaths has no entry for %q; keys=%v", vol, keysOf(session.ShadowPaths))
	}
	if !strings.HasPrefix(shadow, `\\?\GLOBALROOT\Device\HarddiskVolumeShadowCopy`) {
		t.Errorf("unexpected shadow device path %q", shadow)
	}

	// GetShadowPath must agree with the map.
	got, err := p.GetShadowPath(session, vol)
	if err != nil {
		t.Fatalf("GetShadowPath: %v", err)
	}
	if got != shadow {
		t.Errorf("GetShadowPath = %q, want %q", got, shadow)
	}

	if len(session.UnprotectedVolumes) != 0 {
		t.Errorf("expected no unprotected volumes, got %v", session.UnprotectedVolumes)
	}

	// The shadow copy must outlive CreateShadowCopy's own Release +
	// CoUninitialize + UnlockOSThread. A reviewer read the VSS docs as meaning
	// the device dies with the IVssBackupComponents object, which would make the
	// whole snapshot useless to the caller; these copies are auto-release, which
	// on Windows means reclaimed at requester *process* exit. Sleep and force a
	// GC first so this is not passing on a timing accident.
	runtime.GC()
	time.Sleep(5 * time.Second)

	// The shadow copy must actually be readable: list the Windows directory
	// through the device path.
	shadowWindows := shadow + `\Windows`
	entries, err := os.ReadDir(shadowWindows)
	if err != nil {
		t.Fatalf("reading %q through the shadow copy failed: %v", shadowWindows, err)
	}
	if len(entries) == 0 {
		t.Errorf("%q is empty through the shadow copy", shadowWindows)
	}

	t.Logf("shadow copy %s -> %s (%d entries under \\Windows, %d writers)",
		vol, shadow, len(entries), len(session.Writers))
}

// TestLive_ShadowCopyReadsExclusivelyLockedFile is the reason #2999 matters:
// without a shadow copy, in-use files (browser profiles, PST/OST, NTUSER.DAT)
// fail with ERROR_SHARING_VIOLATION. This proves the snapshot makes an
// unshareable file readable.
func TestLive_ShadowCopyReadsExclusivelyLockedFile(t *testing.T) {
	requireLiveVSS(t)

	vol := systemVolume(t)
	dir := filepath.Join(vol+`\`, "breeze-vss-test")
	if err := os.MkdirAll(dir, 0o700); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	defer os.RemoveAll(dir)

	target := filepath.Join(dir, "locked.txt")
	const payload = "breeze vss 2999 locked-file probe"
	if err := os.WriteFile(target, []byte(payload), 0o600); err != nil {
		t.Fatalf("write: %v", err)
	}

	// Re-open with no sharing at all, exactly like a running browser holds its
	// profile database.
	namePtr, err := windows.UTF16PtrFromString(target)
	if err != nil {
		t.Fatal(err)
	}
	h, err := windows.CreateFile(namePtr, windows.GENERIC_READ|windows.GENERIC_WRITE,
		0 /* no FILE_SHARE_* */, nil, windows.OPEN_EXISTING, windows.FILE_ATTRIBUTE_NORMAL, 0)
	if err != nil {
		t.Fatalf("exclusive open: %v", err)
	}
	defer windows.CloseHandle(h)

	// Sanity: the direct read must fail while the handle is held. If it does
	// not, the rest of this test proves nothing.
	if _, err := os.ReadFile(target); err == nil {
		t.Skip("file is not actually locked on this system; cannot prove the VSS benefit")
	}

	p := NewProvider(DefaultConfig())
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
	defer cancel()

	session, err := p.CreateShadowCopy(ctx, []string{vol})
	if err != nil {
		t.Fatalf("CreateShadowCopy(%q) failed: %v", vol, err)
	}
	defer p.ReleaseShadowCopy(session) //nolint:errcheck

	shadow, ok := session.ShadowPaths[vol]
	if !ok {
		t.Fatalf("no shadow path for %q", vol)
	}

	// Same rewrite backup.go performs: volume prefix -> shadow device.
	shadowTarget := shadow + target[len(vol):]
	data, err := os.ReadFile(shadowTarget)
	if err != nil {
		t.Fatalf("reading the locked file through the shadow copy failed: %v", err)
	}
	if string(data) != payload {
		t.Errorf("shadow copy content = %q, want %q", string(data), payload)
	}
	t.Logf("locked file unreadable directly, read OK through %s", shadowTarget)
}

// TestLive_CreateShadowCopy_NoVolumes checks the guard without touching VSS.
func TestLive_CreateShadowCopy_NoVolumes(t *testing.T) {
	p := NewProvider(DefaultConfig())
	if _, err := p.CreateShadowCopy(context.Background(), nil); err != ErrVSSNoVolumes {
		t.Fatalf("expected ErrVSSNoVolumes, got %v", err)
	}
}

func keysOf(m map[string]string) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	return out
}
