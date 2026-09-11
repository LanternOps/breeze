package linuxsession

import (
	"errors"
	"io/fs"
	"os"
	"strings"
	"testing"
	"time"
)

type fakeFileInfo struct {
	mode fs.FileMode
}

func (f fakeFileInfo) Name() string       { return "fake" }
func (f fakeFileInfo) Size() int64        { return 0 }
func (f fakeFileInfo) Mode() fs.FileMode  { return f.mode }
func (f fakeFileInfo) ModTime() time.Time { return time.Time{} }
func (f fakeFileInfo) IsDir() bool        { return f.mode.IsDir() }
func (f fakeFileInfo) Sys() any           { return nil }

func statReturning(files map[string]fs.FileMode) func(string) (fs.FileInfo, error) {
	return func(path string) (fs.FileInfo, error) {
		mode, ok := files[path]
		if !ok {
			return nil, os.ErrNotExist
		}
		return fakeFileInfo{mode: mode}, nil
	}
}

func TestResolveSystemBinary(t *testing.T) {
	// The ownership check reads a real *syscall.Stat_t, which a fake FileInfo
	// cannot supply. It has its own tests (below, and rootOwnedAndNotGroupOr
	// WorldWritable's on Linux); here it is stubbed out so these cases exercise
	// the search order and the mode rules.
	prev := binaryOwnershipOK
	t.Cleanup(func() { binaryOwnershipOK = prev })
	binaryOwnershipOK = func(fs.FileInfo) bool { return true }

	cases := []struct {
		name    string
		binary  string
		files   map[string]fs.FileMode
		want    string
		wantErr bool
	}{
		{
			name:   "found in /usr/bin",
			binary: "zenity",
			files:  map[string]fs.FileMode{"/usr/bin/zenity": 0o755},
			want:   "/usr/bin/zenity",
		},
		{
			// Debian Policy makes /usr/local/bin root:staff mode 02775, so a
			// non-root "staff" member can write there. A binary planted in it
			// would be executed under ANOTHER signed-in user's uid, and its
			// exit code decides whether that user's reboot was postponed.
			name:    "a binary in the group-writable /usr/local/bin is never used",
			binary:  "zenity",
			files:   map[string]fs.FileMode{"/usr/local/bin/zenity": 0o755},
			wantErr: true,
		},
		{
			name:   "/usr/bin is searched before /bin",
			binary: "zenity",
			files:  map[string]fs.FileMode{"/usr/bin/zenity": 0o755, "/bin/zenity": 0o755},
			want:   "/usr/bin/zenity",
		},
		{
			// A setuid helper would regain privilege the instant it ran, making
			// the credential drop that spawned it decorative.
			name:    "a setuid binary is refused",
			binary:  "zenity",
			files:   map[string]fs.FileMode{"/usr/bin/zenity": fs.ModeSetuid | 0o755},
			wantErr: true,
		},
		{
			name:    "a setgid binary is refused",
			binary:  "zenity",
			files:   map[string]fs.FileMode{"/usr/bin/zenity": fs.ModeSetgid | 0o755},
			wantErr: true,
		},
		{
			name:    "absent",
			binary:  "zenity",
			files:   map[string]fs.FileMode{},
			wantErr: true,
		},
		{
			// Present but not executable is the same as absent: running it
			// would fail, and reporting it as found would make the caller
			// believe a dialog is available when it is not.
			name:    "present but not executable",
			binary:  "zenity",
			files:   map[string]fs.FileMode{"/usr/bin/zenity": 0o644},
			wantErr: true,
		},
		{
			name:    "directory is not a binary",
			binary:  "zenity",
			files:   map[string]fs.FileMode{"/usr/bin/zenity": fs.ModeDir | 0o755},
			wantErr: true,
		},
		{
			// A path would escape the fixed search directories, which are the
			// whole protection against running an attacker-planted binary.
			name:    "a path is refused",
			binary:  "/tmp/evil/zenity",
			files:   map[string]fs.FileMode{"/tmp/evil/zenity": 0o755},
			wantErr: true,
		},
		{
			name:    "a relative path is refused",
			binary:  "../../tmp/zenity",
			files:   map[string]fs.FileMode{},
			wantErr: true,
		},
		{name: "empty name is refused", binary: "", wantErr: true},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, err := resolveSystemBinary(tc.binary, statReturning(tc.files))
			if tc.wantErr {
				if err == nil {
					t.Fatalf("resolveSystemBinary(%q) = %q, want an error", tc.binary, got)
				}
				if !errors.Is(err, ErrBinaryNotFound) {
					t.Errorf("error %v does not wrap ErrBinaryNotFound", err)
				}
				return
			}
			if err != nil {
				t.Fatalf("resolveSystemBinary(%q) errored: %v", tc.binary, err)
			}
			if got != tc.want {
				t.Errorf("resolveSystemBinary(%q) = %q, want %q", tc.binary, got, tc.want)
			}
		})
	}
}

func TestSystemBinaryDirsAreAbsoluteAndExcludeGroupWritableDefaults(t *testing.T) {
	for _, dir := range systemBinaryDirs {
		// A relative entry would resolve against the daemon's working
		// directory, reintroducing exactly the hijack the fixed list removes.
		if len(dir) == 0 || dir[0] != '/' {
			t.Errorf("systemBinaryDirs entry %q is not absolute", dir)
		}
		// /usr/local/bin is root:staff 02775 by Debian Policy. It must never
		// come back: a "staff" member could plant a zenity there that the
		// daemon then runs inside another user's session.
		if dir == "/usr/local/bin" {
			t.Error("/usr/local/bin is group-writable by default on Debian and Ubuntu; " +
				"a local non-root account could plant the dialog binary")
		}
	}
}

func TestSafeExecPathMatchesTheResolvedSearchDirs(t *testing.T) {
	// The PATH handed to the child and the dirs we resolve from must not drift:
	// a child that re-execs something would otherwise search wider than the
	// daemon was willing to.
	want := strings.Join(systemBinaryDirs, ":")
	if safeExecPath != want {
		t.Errorf("safeExecPath = %q, want %q (the same dirs ResolveSystemBinary searches)", safeExecPath, want)
	}
}

func TestResolveSystemBinaryRejectsANonRootOwnedBinary(t *testing.T) {
	// The ownership hook is a no-op off Linux, so drive it directly rather than
	// depending on which platform the test job runs on.
	prev := binaryOwnershipOK
	t.Cleanup(func() { binaryOwnershipOK = prev })
	binaryOwnershipOK = func(fs.FileInfo) bool { return false }

	files := map[string]fs.FileMode{"/usr/bin/zenity": 0o755}
	if got, err := resolveSystemBinary("zenity", statReturning(files)); err == nil {
		t.Fatalf("resolveSystemBinary returned %q for a binary the ownership check rejected", got)
	}
}
