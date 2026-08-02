//go:build windows

package backup

import (
	"context"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/breeze-rmm/agent/internal/backup/vss"
	"golang.org/x/sys/windows"
)

// rewritePathsForVSS is the seam that decides whether a backup actually reads
// through the shadow copy or silently reads the live volume. It could not be
// covered portably alongside originalPathsForVSS in backup_test.go: it calls
// filepath.VolumeName, which returns "" for every path on non-Windows, so the
// same table on macOS/Linux would exercise nothing but the fallback branch and
// pass vacuously. Hence a Windows-gated file.
//
// The gap this closes is specific. #2999 fixed VSS itself and added live tests
// in internal/backup/vss, but those reconstruct the shadow path by hand
// (`shadow + target[len(vol):]`) rather than calling rewritePathsForVSS. A
// divergence between that function and the key format the provider stores in
// VSSSession.ShadowPaths would leave every one of those tests green while
// production quietly backed up the live volume — the exact failure #2999 was
// about, minus the error message.

func TestRewritePathsForVSS_RoutesPathsThroughShadowRoot(t *testing.T) {
	const shadowRoot = `\\?\GLOBALROOT\Device\HarddiskVolumeShadowCopy1`
	shadowPaths := map[string]string{"C:": shadowRoot}

	tests := []struct {
		name string
		in   string
		want string
	}{
		{
			name: "nested path keeps its remainder",
			in:   `C:\Users\data\f.txt`,
			want: shadowRoot + `\Users\data\f.txt`,
		},
		{
			name: "volume root with separator",
			in:   `C:\`,
			want: shadowRoot + `\`,
		},
		{
			name: "bare volume name",
			in:   `C:`,
			want: shadowRoot,
		},
		{
			name: "unshadowed volume falls back to the live path",
			in:   `D:\other\f.txt`,
			want: `D:\other\f.txt`,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, _ := rewritePathsForVSS([]string{tt.in}, shadowPaths)
			if got[0] != tt.want {
				t.Errorf("rewritePathsForVSS(%q) = %q, want %q", tt.in, got[0], tt.want)
			}
		})
	}
}

// TestRewritePathsForVSS_KeyFormatMatchesExtractVolumes is the real regression
// guard. The provider deliberately keys VSSSession.ShadowPaths on the caller's
// original volume string ("C:", no trailing separator) even though the COM call
// itself needs a mount point ("C:\") — #2999 notes that re-keying the map would
// make this lookup miss and silently read the live volume.
//
// That contract spans two packages and is held together by nothing but string
// format, so assert it directly: every volume extractVolumes produces must be a
// key this lookup hits. If either side is re-keyed, this fails instead of
// production silently degrading.
func TestRewritePathsForVSS_KeyFormatMatchesExtractVolumes(t *testing.T) {
	paths := []string{`C:\Users\data`, `C:\Logs\app.log`, `D:\Backups`}

	// Build the shadow map exactly the way a real session would: keyed on
	// whatever extractVolumes hands the provider.
	shadowPaths := make(map[string]string)
	for i, vol := range extractVolumes(paths) {
		shadowPaths[vol] = `\\?\GLOBALROOT\Device\HarddiskVolumeShadowCopy` + string(rune('1'+i))
	}
	if len(shadowPaths) != 2 {
		t.Fatalf("extractVolumes produced %d volumes, want 2 (C: and D:)", len(shadowPaths))
	}

	rewritten, unmapped := rewritePathsForVSS(paths, shadowPaths)
	if len(unmapped) != 0 {
		t.Fatalf("every path should route through a shadow copy, but %d fell back to the live volume: %v",
			len(unmapped), unmapped)
	}
	for i, p := range rewritten {
		if p == paths[i] {
			t.Errorf("path %q was not rewritten — extractVolumes and the shadow-path lookup disagree on key format", paths[i])
		}
	}
}

// A path that falls back is a path read from the LIVE volume: in-use files
// there fail or come out torn, which is exactly the class of failure #2999
// reported. The fallback is legitimate (a volume whose snapshot failed still
// gets a best-effort live read), but it must not be invisible.
func TestRewritePathsForVSS_ReportsUnmappedPathsRatherThanFailingSilently(t *testing.T) {
	shadowPaths := map[string]string{"C:": `\\?\GLOBALROOT\Device\HarddiskVolumeShadowCopy1`}
	paths := []string{`C:\shadowed`, `D:\live`, `E:\also-live`}

	rewritten, unmapped := rewritePathsForVSS(paths, shadowPaths)

	if len(unmapped) != 2 {
		t.Fatalf("unmapped = %v, want the two unshadowed volumes reported", unmapped)
	}
	// Indices, not paths, so the caller can tell an unshadowed user volume
	// apart from the system-state staging dir it wrote itself.
	for _, idx := range unmapped {
		if idx < 0 || idx >= len(paths) {
			t.Fatalf("unmapped index %d out of range", idx)
		}
		if rewritten[idx] != paths[idx] {
			t.Errorf("unmapped path %d should be left as the original live path", idx)
		}
	}
	if unmapped[0] != 1 || unmapped[1] != 2 {
		t.Errorf("unmapped = %v, want [1 2]", unmapped)
	}
}

// TestLive_RewrittenShadowPathReadsExclusivelyLockedFile is the end-to-end
// proof that was missing: it takes a genuinely locked file, rewrites its path
// with the PRODUCTION function against a REAL shadow copy, and reads it back.
//
//	set BREEZE_VSS_LIVE=1 && go test ./internal/backup -run Live -v
func TestLive_RewrittenShadowPathReadsExclusivelyLockedFile(t *testing.T) {
	if os.Getenv("BREEZE_VSS_LIVE") != "1" {
		t.Skip("set BREEZE_VSS_LIVE=1 to run live VSS tests (needs an elevated process)")
	}

	sysRoot := os.Getenv("SystemRoot")
	if sysRoot == "" {
		sysRoot = `C:\Windows`
	}
	vol := filepath.VolumeName(sysRoot)

	dir := filepath.Join(vol+`\`, "breeze-vss-rewrite-test")
	if err := os.MkdirAll(dir, 0o700); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	defer os.RemoveAll(dir)

	target := filepath.Join(dir, "locked.txt")
	const payload = "breeze shadow-path rewrite probe"
	if err := os.WriteFile(target, []byte(payload), 0o600); err != nil {
		t.Fatalf("write: %v", err)
	}

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

	if _, err := os.ReadFile(target); err == nil {
		t.Skip("file is not actually locked on this system; cannot prove the VSS benefit")
	}

	// Drive the provider through the same entry point backup.go uses, so the
	// volume strings handed to VSS are the ones extractVolumes produces.
	volumes := extractVolumes([]string{dir})
	if len(volumes) != 1 || volumes[0] != vol {
		t.Fatalf("extractVolumes(%q) = %v, want [%q]", dir, volumes, vol)
	}

	p := vss.NewProvider(vss.DefaultConfig())
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
	defer cancel()

	session, err := p.CreateShadowCopy(ctx, volumes)
	if err != nil {
		t.Fatalf("CreateShadowCopy(%v) failed: %v", volumes, err)
	}
	defer p.ReleaseShadowCopy(session) //nolint:errcheck

	// The production rewrite — not a hand-rolled copy of it.
	rewritten, unmapped := rewritePathsForVSS([]string{target}, session.ShadowPaths)
	if len(unmapped) != 0 {
		t.Fatalf("the backup path fell back to the live volume despite an active shadow copy "+
			"(ShadowPaths=%v) — this is the silent #2999 failure mode", session.ShadowPaths)
	}
	if rewritten[0] == target {
		t.Fatalf("path was not rewritten: %q", rewritten[0])
	}

	data, err := os.ReadFile(rewritten[0])
	if err != nil {
		t.Fatalf("reading the locked file through the rewritten shadow path failed: %v", err)
	}
	if string(data) != payload {
		t.Errorf("content = %q, want %q", string(data), payload)
	}
	t.Logf("locked file unreadable directly, read OK through production-rewritten path %s", rewritten[0])
}
