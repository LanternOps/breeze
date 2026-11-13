package providers

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// Network share paths are refused for a local store before anything on disk
// is touched, with a message that points the operator at an attached disk or
// S3 storage.
func TestLocalStoreRefusesNetworkSharePaths(t *testing.T) {
	paths := []string{
		`\\nas\backups\breeze`,
		`\\nas\backups`,
		`\\?\UNC\nas\backups\breeze`,
		`\\.\UNC\nas\backups\breeze`,
		`\??\UNC\nas\backups\breeze`,
		`\\?\unc\nas\backups\breeze`,
		`\\?\GLOBALROOT\Device\Mup\nas\backups\breeze`,
	}
	for _, base := range paths {
		for _, operation := range append([]string{"prepare"}, localStoreOperations...) {
			t.Run(base+"/"+operation, func(t *testing.T) {
				// A share path is not absolute outside Windows; keep any
				// directory the provider might create inside a temp dir.
				t.Chdir(t.TempDir())
				p := NewLocalProvider(base)
				source := filepath.Join(t.TempDir(), "source")
				if err := os.WriteFile(source, []byte("content"), 0o600); err != nil {
					t.Fatal(err)
				}
				var err error
				if operation == "prepare" {
					err = p.Prepare()
				} else {
					err = runLocalStoreOperation(p, operation, source, "objects/data", filepath.Join(t.TempDir(), "out"))
				}
				if !errors.Is(err, ErrNetworkShareStore) {
					t.Fatalf("%s on %q: got %v, want a network share refusal", operation, base, err)
				}
				for _, want := range []string{"network share", "attached", "S3"} {
					if !strings.Contains(err.Error(), want) {
						t.Fatalf("refusal %q does not mention %q", err.Error(), want)
					}
				}
				entries, readErr := os.ReadDir(".")
				if readErr != nil {
					t.Fatal(readErr)
				}
				if len(entries) != 0 {
					t.Fatalf("refused store path left entries in the working directory: %v", entries)
				}
			})
		}
	}
}

// The share forms are recognised in either separator style on Windows, and a
// local long-path or device form is left to the volume check.
func TestNetworkSharePathForms(t *testing.T) {
	cases := []struct {
		path        string
		windowsForm bool
		want        bool
	}{
		{`\\nas\backups`, true, true},
		{`//nas/backups/breeze`, true, true},
		{`\/nas/backups`, true, true},
		{`//?/UNC/nas/backups`, true, true},
		{`\\?\UNC\nas\backups`, false, true},
		{`\\nas\backups`, false, true},
		{`\\?\GLOBALROOT\Device\LanmanRedirector\nas\backups`, true, true},
		{`C:\BreezeBackups`, true, false},
		{`D:/BreezeBackups`, true, false},
		{`\\?\C:\BreezeBackups`, true, false},
		{`\\.\C:\BreezeBackups`, true, false},
		{`\\?\Volume{0b2f1e52-0000-0000-0000-100000000000}\BreezeBackups`, true, false},
		{`\\?\GLOBALROOT\Device\HarddiskVolume3\BreezeBackups`, true, false},
		// "//host/x" is an ordinary absolute path outside Windows.
		{`//var/backups/breeze`, false, false},
		{`/var/backups/breeze`, false, false},
		{`/mnt/nas/breeze`, false, false},
	}
	for _, tc := range cases {
		if got := isNetworkSharePath(tc.path, tc.windowsForm); got != tc.want {
			t.Errorf("isNetworkSharePath(%q, windows=%v) = %v, want %v", tc.path, tc.windowsForm, got, tc.want)
		}
	}
}

// A store on a volume the system reports as remote (a mapped network drive)
// is refused before its directory is created or checked.
func TestLocalStoreRefusesRemoteVolume(t *testing.T) {
	base := filepath.Join(t.TempDir(), "store")
	restore := setStoreVolumeIsRemoteForTest(func(path string) (bool, error) {
		if path != base {
			t.Errorf("volume check got %q, want %q", path, base)
		}
		return true, nil
	})
	defer restore()

	err := NewLocalProvider(base).Prepare()
	if !errors.Is(err, ErrNetworkShareStore) {
		t.Fatalf("Prepare on a remote volume: got %v, want a network share refusal", err)
	}
	if _, statErr := os.Lstat(base); !errors.Is(statErr, os.ErrNotExist) {
		t.Fatalf("refused store directory was created (stat error %v)", statErr)
	}
}

// A volume check that cannot decide fails closed with its own error.
func TestLocalStoreVolumeCheckErrorFailsClosed(t *testing.T) {
	base := filepath.Join(t.TempDir(), "store")
	restore := setStoreVolumeIsRemoteForTest(func(string) (bool, error) {
		return false, errors.New("volume type unavailable")
	})
	defer restore()

	err := NewLocalProvider(base).Prepare()
	if err == nil || !strings.Contains(err.Error(), "volume type unavailable") {
		t.Fatalf("Prepare with a failing volume check: got %v", err)
	}
	if _, statErr := os.Lstat(base); !errors.Is(statErr, os.ErrNotExist) {
		t.Fatalf("store directory was created despite the failed check (stat error %v)", statErr)
	}
}

// An attached-disk store keeps working with the volume check in place.
func TestLocalStoreAcceptsLocalVolume(t *testing.T) {
	base := filepath.Join(t.TempDir(), "store")
	p := NewLocalProvider(base)
	if err := p.Prepare(); err != nil {
		t.Fatalf("Prepare on a local volume: %v", err)
	}
}

// The volume decision is made from what the system reports for the opened
// volume or store handle, not from how the path is spelled.
func TestRemoteVolumeDecision(t *testing.T) {
	const (
		deviceDisk            = 0x07
		deviceDiskFileSystem  = 0x08
		deviceNetwork         = 0x12
		deviceNetworkFS       = 0x14
		deviceNetworkRedirect = 0x28
		deviceDFSFileSystem   = 0x35
		deviceDFSVolume       = 0x36
		remoteDevice          = 0x10
		removableMedia        = 0x01
	)
	cases := []struct {
		name   string
		info   volumeDeviceInfo
		ntPath string
		want   bool
	}{
		{"local disk", volumeDeviceInfo{DeviceType: deviceDisk}, `\Device\HarddiskVolume3\BreezeBackups`, false},
		{"local disk file system", volumeDeviceInfo{DeviceType: deviceDiskFileSystem}, `\Device\HarddiskVolume3\`, false},
		{"removable USB disk", volumeDeviceInfo{DeviceType: deviceDisk, Characteristics: removableMedia}, `\Device\HarddiskVolume9\Vault`, false},
		{"remote device characteristic", volumeDeviceInfo{DeviceType: deviceDisk, Characteristics: remoteDevice}, `\Device\HarddiskVolume3\x`, true},
		{"network file system", volumeDeviceInfo{DeviceType: deviceNetworkFS}, "", true},
		{"network device", volumeDeviceInfo{DeviceType: deviceNetwork}, "", true},
		{"network redirector", volumeDeviceInfo{DeviceType: deviceNetworkRedirect}, "", true},
		{"DFS file system", volumeDeviceInfo{DeviceType: deviceDFSFileSystem}, "", true},
		{"DFS volume", volumeDeviceInfo{DeviceType: deviceDFSVolume}, "", true},
		{"multiple UNC provider path", volumeDeviceInfo{DeviceType: deviceDisk}, `\Device\Mup\nas\backups\breeze`, true},
		{"multiple UNC provider path, any case", volumeDeviceInfo{DeviceType: deviceDisk}, `\device\MUP\nas\backups`, true},
		{"WebDAV through the provider", volumeDeviceInfo{DeviceType: deviceDisk}, `\Device\Mup\nas@SSL\DavWWWRoot\breeze`, true},
		{"redirector path", volumeDeviceInfo{DeviceType: deviceDisk}, `\Device\LanmanRedirector\;Z:0000000000012345\nas\backups`, true},
		{"a local volume named like the provider", volumeDeviceInfo{DeviceType: deviceDisk}, `\Device\HarddiskVolume3\Device\Mup\x`, false},
	}
	for _, tc := range cases {
		if got := remoteVolume(tc.info, tc.ntPath); got != tc.want {
			t.Errorf("%s: remoteVolume(%+v, %q) = %v, want %v", tc.name, tc.info, tc.ntPath, got, tc.want)
		}
	}
}

// After the store root is opened, the opened directory itself is checked: a
// root that turns out to be on a network volume is refused by every
// operation, and a check that cannot decide fails closed.
func TestLocalStoreRefusesOpenedRootOnRemoteVolume(t *testing.T) {
	for _, operation := range append([]string{"prepare"}, localStoreOperations...) {
		t.Run(operation, func(t *testing.T) {
			root := privateStoreTempDir(t)
			restore := setStoreRootIsRemoteForTest(func(*os.Root) (bool, error) { return true, nil })
			defer restore()
			p := NewLocalProvider(root)
			source := filepath.Join(t.TempDir(), "source")
			if err := os.WriteFile(source, []byte("content"), 0o600); err != nil {
				t.Fatal(err)
			}
			var err error
			if operation == "prepare" {
				err = p.Prepare()
			} else {
				err = runLocalStoreOperation(p, operation, source, "objects/data", filepath.Join(t.TempDir(), "out"))
			}
			if !errors.Is(err, ErrNetworkShareStore) {
				t.Fatalf("%s: got %v, want a network share refusal", operation, err)
			}
			if _, statErr := os.Lstat(filepath.Join(root, "objects")); !errors.Is(statErr, os.ErrNotExist) {
				t.Fatalf("%s wrote into a store on a network volume (stat error %v)", operation, statErr)
			}
		})
	}

	t.Run("check error", func(t *testing.T) {
		root := privateStoreTempDir(t)
		restore := setStoreRootIsRemoteForTest(func(*os.Root) (bool, error) { return false, errors.New("volume information unavailable") })
		defer restore()
		err := NewLocalProvider(root).Prepare()
		if err == nil || !strings.Contains(err.Error(), "volume information unavailable") {
			t.Fatalf("Prepare with a failing store volume check: got %v", err)
		}
	})
}
