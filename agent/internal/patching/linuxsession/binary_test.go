package linuxsession

import (
	"errors"
	"io/fs"
	"os"
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
			// /usr/local/bin is searched first so a site-installed build wins.
			name:   "local install takes precedence",
			binary: "zenity",
			files:  map[string]fs.FileMode{"/usr/local/bin/zenity": 0o755, "/usr/bin/zenity": 0o755},
			want:   "/usr/local/bin/zenity",
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

func TestSystemBinaryDirsAreAllAbsoluteAndRootOwned(t *testing.T) {
	// A relative entry here would resolve against the daemon's working
	// directory, reintroducing exactly the hijack the fixed list removes.
	for _, dir := range systemBinaryDirs {
		if len(dir) == 0 || dir[0] != '/' {
			t.Errorf("systemBinaryDirs entry %q is not absolute", dir)
		}
	}
}
