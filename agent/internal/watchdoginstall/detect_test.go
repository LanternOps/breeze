package watchdoginstall

import (
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"syscall"
	"testing"
	"time"
)

// fakeFS maps path → entry; missing paths are ENOENT; errs override.
type fakeFS struct {
	files map[string]bool // value: isDir
	errs  map[string]error
}

type fakeInfo struct {
	name string
	dir  bool
}

func (f fakeInfo) Name() string       { return f.name }
func (f fakeInfo) Size() int64        { return 1 }
func (f fakeInfo) Mode() fs.FileMode  { return 0o755 }
func (f fakeInfo) ModTime() time.Time { return time.Time{} }
func (f fakeInfo) IsDir() bool        { return f.dir }
func (f fakeInfo) Sys() any           { return nil }

func (f fakeFS) stat(p string) (fs.FileInfo, error) {
	if err, ok := f.errs[p]; ok {
		return nil, err
	}
	if dir, ok := f.files[p]; ok {
		return fakeInfo{name: filepath.Base(p), dir: dir}, nil
	}
	return nil, &fs.PathError{Op: "stat", Path: p, Err: fs.ErrNotExist}
}

const (
	tInit = "/run/systemd/system"
	tBin  = "/usr/local/bin/breeze-watchdog"
	tBin2 = "/Library/Breeze/bin/breeze-watchdog"
	tUnit = "/etc/systemd/system/breeze-watchdog.service"
)

var errPerm = &fs.PathError{Op: "stat", Path: "x", Err: syscall.EACCES}

func TestDetect_Files(t *testing.T) {
	cases := []struct {
		name string
		fs   fakeFS
		init string
		bins []string
		want Status
	}{
		{"both present", fakeFS{files: map[string]bool{tInit: true, tBin: false, tUnit: false}}, tInit, []string{tBin}, StatusRegistered},
		{"binary only", fakeFS{files: map[string]bool{tInit: true, tBin: false}}, tInit, []string{tBin}, StatusMissing},
		{"unit only", fakeFS{files: map[string]bool{tInit: true, tUnit: false}}, tInit, []string{tBin}, StatusMissing},
		{"neither", fakeFS{files: map[string]bool{tInit: true}}, tInit, []string{tBin}, StatusMissing},
		{"non-systemd linux", fakeFS{files: map[string]bool{tBin: false, tUnit: false}}, tInit, []string{tBin}, StatusUnsupported},
		{"init marker unreadable", fakeFS{files: map[string]bool{tBin: false, tUnit: false}, errs: map[string]error{tInit: errPerm}}, tInit, []string{tBin}, StatusUnknown},
		{"binary stat EACCES, unit present", fakeFS{files: map[string]bool{tInit: true, tUnit: false}, errs: map[string]error{tBin: errPerm}}, tInit, []string{tBin}, StatusUnknown},
		{"unit stat EACCES, binary present", fakeFS{files: map[string]bool{tInit: true, tBin: false}, errs: map[string]error{tUnit: errPerm}}, tInit, []string{tBin}, StatusUnknown},
		{"binary is a directory", fakeFS{files: map[string]bool{tInit: true, tBin: true, tUnit: false}}, tInit, []string{tBin}, StatusUnknown},
		{"darwin legacy binary only", fakeFS{files: map[string]bool{tBin: false, tUnit: false}}, "", []string{tBin2, tBin}, StatusRegistered},
		{"darwin trusted binary", fakeFS{files: map[string]bool{tBin2: false, tUnit: false}}, "", []string{tBin2, tBin}, StatusRegistered},
		{"darwin trusted EACCES legacy present", fakeFS{files: map[string]bool{tBin: false, tUnit: false}, errs: map[string]error{tBin2: errPerm}}, "", []string{tBin2, tBin}, StatusRegistered},
		{"darwin no binary", fakeFS{files: map[string]bool{tUnit: false}}, "", []string{tBin2, tBin}, StatusMissing},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := detectFiles(tc.fs.stat, tc.init, tc.bins, tUnit); got != tc.want {
				t.Fatalf("got %s want %s", got, tc.want)
			}
		})
	}
}

func TestDetect_Windows(t *testing.T) {
	const bin = `C:\Program Files\Breeze\breeze-watchdog.exe`
	exists := func() (bool, error) { return true, nil }
	notExists := func() (bool, error) { return false, nil }
	scmErr := func() (bool, error) { return false, errors.New("access denied") }
	withBin := fakeFS{files: map[string]bool{bin: false}}
	noBin := fakeFS{}
	cases := []struct {
		name string
		fs   fakeFS
		svc  ServiceProbe
		want Status
	}{
		{"registered", withBin, exists, StatusRegistered},
		{"binary without service", withBin, notExists, StatusMissing},
		{"service without binary", noBin, exists, StatusMissing},
		{"scm error with binary", withBin, scmErr, StatusUnknown},
		{"scm error without binary", noBin, scmErr, StatusMissing},
		{"nil probe", withBin, nil, StatusUnknown},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := detectService(tc.fs.stat, bin, tc.svc); got != tc.want {
				t.Fatalf("got %s want %s", got, tc.want)
			}
		})
	}
}

// TestDetect_WindowsBinaryWithoutService is the audit-row-6d proof: a protected
// binary copied by an interrupted install, with no SCM entry, reads Missing so
// the next attempt completes the registration.
func TestDetect_WindowsBinaryWithoutService(t *testing.T) {
	const bin = `C:\Program Files\Breeze\breeze-watchdog.exe`
	got := detectService(fakeFS{files: map[string]bool{bin: false}}.stat, bin, func() (bool, error) { return false, nil })
	if got != StatusMissing {
		t.Fatalf("got %s want missing", got)
	}
}

// The real Detect must be callable on the test host and return a defined value
// without mutating anything.
func TestDetect_RealHostIsReadOnly(t *testing.T) {
	switch s := Detect(os.Stat); s {
	case StatusRegistered, StatusMissing, StatusUnsupported, StatusUnknown:
	default:
		t.Fatalf("undefined status %d", s)
	}
}
