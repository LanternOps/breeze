//go:build windows

package providers

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"golang.org/x/sys/windows"
)

// The system drive is a local volume, so a store on it is not refused as a
// network drive.
func TestVolumeIsRemoteSystemDrive(t *testing.T) {
	drive := os.Getenv("SystemDrive")
	if drive == "" {
		drive = "C:"
	}
	for _, base := range []string{
		filepath.Join(drive+`\`, "BreezeBackups"),
		`\\?\` + drive + `\BreezeBackups`,
		filepath.Join(t.TempDir(), "store"),
	} {
		remote, err := volumeIsRemote(base)
		if err != nil {
			t.Fatalf("volumeIsRemote(%q): %v", base, err)
		}
		if remote {
			t.Fatalf("volumeIsRemote(%q) = true for a local volume", base)
		}
	}
}

func openDirectoryHandle(t *testing.T, path string) (windows.Handle, error) {
	t.Helper()
	p, err := windows.UTF16PtrFromString(path)
	if err != nil {
		return 0, err
	}
	return windows.CreateFile(p, windows.FILE_READ_ATTRIBUTES,
		windows.FILE_SHARE_READ|windows.FILE_SHARE_WRITE|windows.FILE_SHARE_DELETE, nil,
		windows.OPEN_EXISTING, windows.FILE_FLAG_BACKUP_SEMANTICS|windows.FILE_FLAG_OPEN_REPARSE_POINT, 0)
}

// loopbackShare returns the administrative share path for dir
// (\\localhost\C$\...), or skips when this host does not serve it to the
// test's account.
func loopbackShare(t *testing.T, dir string) string {
	t.Helper()
	volume := filepath.VolumeName(dir)
	if len(volume) != 2 || volume[1] != ':' {
		t.Skipf("temp dir %q is not on a drive letter", dir)
	}
	share := `\\localhost\` + volume[:1] + `$` + dir[len(volume):]
	if _, err := os.Stat(share); err != nil {
		t.Skipf("loopback administrative share unavailable to this account: %v", err)
	}
	return share
}

// A handle on a local directory reports a local volume; the same directory
// reached through the loopback administrative share reports a network
// volume, whatever the path looked like.
func TestNetworkVolumeHandleCheck(t *testing.T) {
	dir := t.TempDir()
	local, err := openDirectoryHandle(t, dir)
	if err != nil {
		t.Fatal(err)
	}
	defer windows.CloseHandle(local)
	remote, err := handleIsRemote(local)
	if err != nil {
		t.Fatalf("handleIsRemote(local): %v", err)
	}
	if remote {
		t.Fatalf("handleIsRemote reports %q as remote", dir)
	}

	share := loopbackShare(t, dir)
	shared, err := openDirectoryHandle(t, share)
	if err != nil {
		t.Skipf("open %q: %v", share, err)
	}
	defer windows.CloseHandle(shared)
	remote, err = handleIsRemote(shared)
	if err != nil {
		t.Fatalf("handleIsRemote(%q): %v", share, err)
	}
	if !remote {
		t.Fatalf("handleIsRemote(%q) = false for a share", share)
	}
}

// A drive letter defined to point at a share passes the spelling check (it
// is an ordinary X:\ path) and is refused by the volume handle check before
// anything is created on it.
func TestNetworkVolumeMappedDriveRefused(t *testing.T) {
	dir := t.TempDir()
	share := loopbackShare(t, dir)
	// \\localhost\C$\rest -> \Device\Mup\localhost\C$
	parts := strings.SplitN(strings.TrimPrefix(share, `\\`), `\`, 3)
	target := `\Device\Mup\` + parts[0] + `\` + parts[1]

	mask, err := windows.GetLogicalDrives()
	if err != nil {
		t.Fatal(err)
	}
	letter := ""
	for l := 'Z'; l >= 'M'; l-- {
		if mask&(1<<uint(l-'A')) == 0 {
			letter = string(l) + ":"
			break
		}
	}
	if letter == "" {
		t.Skip("no free drive letter")
	}
	name, _ := windows.UTF16PtrFromString(letter)
	targetPtr, _ := windows.UTF16PtrFromString(target)
	if err := windows.DefineDosDevice(windows.DDD_RAW_TARGET_PATH, name, targetPtr); err != nil {
		t.Skipf("define %s -> %s: %v", letter, target, err)
	}
	t.Cleanup(func() {
		_ = windows.DefineDosDevice(windows.DDD_RAW_TARGET_PATH|windows.DDD_REMOVE_DEFINITION|windows.DDD_EXACT_MATCH_ON_REMOVE, name, targetPtr)
	})

	mapped := letter + `\` + parts[2]
	if _, err := os.Stat(mapped); err != nil {
		t.Skipf("defined drive %s is not usable: %v", letter, err)
	}
	if isNetworkSharePath(mapped, true) {
		t.Fatalf("control: %q should pass the spelling check", mapped)
	}
	store := filepath.Join(mapped, "store")
	err = NewLocalProvider(store).Prepare()
	if !errors.Is(err, ErrNetworkShareStore) {
		t.Fatalf("Prepare on %q (drive mapped to %s): got %v, want a network share refusal", store, target, err)
	}
	if _, statErr := os.Lstat(filepath.Join(dir, "store")); !errors.Is(statErr, os.ErrNotExist) {
		t.Fatalf("refused store was created on the share (stat error %v)", statErr)
	}
}
