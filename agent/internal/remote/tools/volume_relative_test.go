package tools

import (
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"testing"
)

// mockHandlePaths makes OpenFile see the given final path (DOS spelling) and
// volume path (volume GUID spelling) for every handle.
func mockHandlePaths(t *testing.T, dos, volume string) {
	t.Helper()
	origDOS, origVol := handleFinalPath, handleVolumePath
	handleFinalPath = func(*os.File) (string, error) {
		if dos == "" {
			return "", errors.New("no DOS path")
		}
		return dos, nil
	}
	handleVolumePath = func(*os.File) (string, bool) { return volume, volume != "" }
	t.Cleanup(func() { handleFinalPath, handleVolumePath = origDOS, origVol })
}

// A file on a volume mounted at a folder is judged from that volume's root,
// whichever DOS spelling the handle reports: the folder spelling
// (C:\Data\Archive\...), the volume's own drive letter, or none.
func TestOpenFileJudgesTheVolumeRelativePath(t *testing.T) {
	const guid = `\\?\Volume{3f2504e0-4f89-11d3-9a0c-0305e82c3301}\`
	p := filepath.Join(t.TempDir(), "secrets.yaml")
	writeScanFixture(t, p, "x")
	cases := []struct {
		name, dos, volume string
		skipped           bool
	}{
		{"folder spelling", `C:\Data\Archive\ProgramData\Breeze\secrets.yaml`, guid + `ProgramData\Breeze\secrets.yaml`, true},
		{"drive letter", `D:\ProgramData\Breeze\secrets.yaml`, guid + `ProgramData\Breeze\secrets.yaml`, true},
		{"no DOS path", "", guid + `Windows\System32\config\SAM`, true},
		{"ordinary file", `C:\Data\Archive\Reports\q3.xlsx`, guid + `Reports\q3.xlsx`, false},
	}
	for _, tc := range cases {
		mockHandlePaths(t, tc.dos, tc.volume)
		f, _, err := NewScanScope().OpenFile(p, nil)
		if f != nil {
			_ = f.Close()
		}
		if got := errors.Is(err, ErrScanSkipped); got != tc.skipped {
			t.Errorf("%s: skipped=%v (err=%v), want %v", tc.name, got, err, tc.skipped)
		}
	}
}

// A second name of a protected file on a mounted volume is refused: the
// protected files are also recorded at the top of each volume a scan meets.
func TestScanRecordsProtectedFilesOfMountedVolumes(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("volume tops come from mount points on Windows (runtime test)")
	}
	base := t.TempDir()
	vol := filepath.Join(base, "mnt")
	shadow := filepath.Join(vol, "etc", "shadow")
	writeScanFixture(t, shadow, "x")
	link := filepath.Join(vol, "home", "notes.txt")
	if err := os.MkdirAll(filepath.Dir(link), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.Link(shadow, link); err != nil {
		t.Skipf("hard links not available here: %v", err)
	}
	canonicalVol := vol
	if resolved, ok := resolveForContainment(vol); ok {
		canonicalVol = resolved
	}
	orig := loadMountTable
	loadMountTable = func() ([]string, bool) { return []string{"/", canonicalVol}, true }
	t.Cleanup(func() { loadMountTable = orig })

	f, _, err := NewScanScope().OpenFile(link, lstatT(t, link))
	if f != nil {
		_ = f.Close()
	}
	if !errors.Is(err, ErrScanSkipped) {
		t.Fatalf("a second name of the mounted volume's protected file was read (err=%v)", err)
	}
}

// The file browser refuses a second name of a mounted volume's protected
// file too.
func TestReadFileRefusesOtherNameOnMountedVolume(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("volume tops come from mount points on Windows (runtime test)")
	}
	base := t.TempDir()
	vol := filepath.Join(base, "mnt")
	shadow := filepath.Join(vol, "etc", "shadow")
	writeScanFixture(t, shadow, "x")
	link := filepath.Join(vol, "home", "notes.txt")
	if err := os.MkdirAll(filepath.Dir(link), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.Link(shadow, link); err != nil {
		t.Skipf("hard links not available here: %v", err)
	}
	canonicalVol := vol
	if resolved, ok := resolveForContainment(vol); ok {
		canonicalVol = resolved
	}
	orig := loadMountTable
	loadMountTable = func() ([]string, bool) { return []string{"/", canonicalVol}, true }
	t.Cleanup(func() { loadMountTable = orig })

	if result := ReadFile(map[string]any{"path": link}); result.Status != "failed" {
		t.Fatalf("status=%s, want a refusal", result.Status)
	}
}
