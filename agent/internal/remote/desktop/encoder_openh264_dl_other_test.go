//go:build !windows

package desktop

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"os"
	"path/filepath"
	"testing"
)

var fakeCodecBytes = []byte("not really a dylib, but the pinned hash says it is")

// openH264Fixture rigs findOpenH264Library's seams: a fake variant whose
// pinned hash matches fakeCodecBytes, a shared codec dir and a legacy data
// dir under top, a temp download dir, and a download stub that writes the
// fake codec. The trust walk accepts the test user as the "root" owner and
// stops at top.
type openH264Fixture struct {
	top, shared, legacy, tmp string
	downloads                []string
}

func newOpenH264Fixture(t *testing.T, goos string, euid int) *openH264Fixture {
	t.Helper()
	top := t.TempDir()
	if err := os.Chmod(top, 0o755); err != nil {
		t.Fatal(err)
	}
	f := &openH264Fixture{
		top:    top,
		shared: filepath.Join(top, "codecs"),
		legacy: filepath.Join(top, "data"),
		tmp:    filepath.Join(t.TempDir(), "breeze-openh264"),
	}
	sum := sha256.Sum256(fakeCodecBytes)
	variant := openH264Variant{libName: "libopenh264-test.dylib", sha256: hex.EncodeToString(sum[:])}

	saved := openH264Seams
	t.Cleanup(func() { openH264Seams = saved })
	openH264Seams = openH264SeamSet{
		variant:    func() (openH264Variant, bool) { return variant, true },
		goos:       goos,
		euid:       func() int { return euid },
		exeDir:     func() (string, error) { return "", errors.New("no executable dir in tests") },
		sharedDir:  func() string { return f.shared },
		legacyDir:  func() string { return f.legacy },
		tempDir:    func() string { return f.tmp },
		systemDirs: nil,
		trustTop:   top,
		trustedUID: uint32(os.Getuid()),
		download: func(v openH264Variant, dest string) error {
			f.downloads = append(f.downloads, dest)
			if err := os.MkdirAll(dest, 0o755); err != nil {
				return err
			}
			return installVerifiedLib(bytes.NewReader(fakeCodecBytes), v, dest)
		},
	}
	return f
}

func writeCodec(t *testing.T, dir string, dirMode os.FileMode, data []byte) string {
	t.Helper()
	if err := os.MkdirAll(dir, dirMode); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(dir, dirMode); err != nil {
		t.Fatal(err)
	}
	p := filepath.Join(dir, "libopenh264-test.dylib")
	if err := os.WriteFile(p, data, 0o644); err != nil {
		t.Fatal(err)
	}
	return p
}

// #10870 security review: the TCC-privileged macOS helper loads the codec
// only from the root-staged dir, and only when that dir is root-owned,
// not group/other-writable, and the file matches the pinned hash.
func TestOpenH264_HelperLoadsVerifiedRootStagedCodec(t *testing.T) {
	f := newOpenH264Fixture(t, "darwin", 501)
	want := writeCodec(t, f.shared, 0o755, fakeCodecBytes)

	got, err := findOpenH264Library()
	if err != nil {
		t.Fatalf("findOpenH264Library: %v", err)
	}
	if got != want {
		t.Fatalf("loaded %q, want the staged codec %q", got, want)
	}
	if len(f.downloads) != 0 {
		t.Fatalf("a verified staged codec must not trigger a download, got %v", f.downloads)
	}
}

func TestOpenH264_HelperRejectsUntrustedStagedCodec(t *testing.T) {
	tests := []struct {
		name  string
		setup func(t *testing.T, f *openH264Fixture)
	}{
		{
			name: "hash mismatch",
			setup: func(t *testing.T, f *openH264Fixture) {
				writeCodec(t, f.shared, 0o755, []byte("tampered"))
			},
		},
		{
			name: "group-writable codec dir",
			setup: func(t *testing.T, f *openH264Fixture) {
				writeCodec(t, f.shared, 0o775, fakeCodecBytes)
			},
		},
		{
			name: "other-writable codec file",
			setup: func(t *testing.T, f *openH264Fixture) {
				p := writeCodec(t, f.shared, 0o755, fakeCodecBytes)
				if err := os.Chmod(p, 0o666); err != nil {
					t.Fatal(err)
				}
			},
		},
		{
			name: "codec dir is a symlink",
			setup: func(t *testing.T, f *openH264Fixture) {
				real := filepath.Join(f.top, "elsewhere")
				writeCodec(t, real, 0o755, fakeCodecBytes)
				if err := os.Symlink(real, f.shared); err != nil {
					t.Fatal(err)
				}
			},
		},
		{
			name: "codec owned by another user",
			setup: func(t *testing.T, f *openH264Fixture) {
				writeCodec(t, f.shared, 0o755, fakeCodecBytes)
				openH264Seams.trustedUID = uint32(os.Getuid()) + 1
			},
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			f := newOpenH264Fixture(t, "darwin", 501)
			tt.setup(t, f)

			got, err := findOpenH264Library()
			if err != nil {
				t.Fatalf("findOpenH264Library: %v", err)
			}
			if filepath.Dir(got) != f.tmp {
				t.Fatalf("loaded %q, want a private temp download in %q", got, f.tmp)
			}
			if len(f.downloads) != 1 || f.downloads[0] != f.tmp {
				t.Fatalf("downloads = %v, want exactly one into %q", f.downloads, f.tmp)
			}
		})
	}
}

// The helper never writes into the root-staged dir, even when it could.
func TestOpenH264_HelperNeverStagesIntoSharedDir(t *testing.T) {
	f := newOpenH264Fixture(t, "darwin", 501)
	if _, err := findOpenH264Library(); err != nil {
		t.Fatalf("findOpenH264Library: %v", err)
	}
	if _, err := os.Stat(filepath.Join(f.shared, "libopenh264-test.dylib")); !os.IsNotExist(err) {
		t.Fatalf("helper must not stage into the shared codec dir, stat err = %v", err)
	}
}

func TestOpenH264_RootStagesIntoSharedDir(t *testing.T) {
	f := newOpenH264Fixture(t, "darwin", 0)

	got, err := findOpenH264Library()
	if err != nil {
		t.Fatalf("findOpenH264Library: %v", err)
	}
	want := filepath.Join(f.shared, "libopenh264-test.dylib")
	if got != want {
		t.Fatalf("root loaded %q, want the staged %q", got, want)
	}
	if len(f.downloads) != 1 || f.downloads[0] != f.shared {
		t.Fatalf("downloads = %v, want one into the shared dir", f.downloads)
	}
	assertMode(t, f.shared, 0o755)
	assertMode(t, want, 0o644)
	// What root staged is exactly what a helper accepts.
	if err := verifyRootOwnedTree(want, f.top, uint32(os.Getuid())); err != nil {
		t.Fatalf("staged codec does not pass the helper's trust check: %v", err)
	}
}

// An upgrade from a build that kept the codec in the root-only data dir
// stages that verified copy instead of downloading again.
func TestOpenH264_RootStagesLegacyDataDirCopy(t *testing.T) {
	f := newOpenH264Fixture(t, "darwin", 0)
	writeCodec(t, f.legacy, 0o700, fakeCodecBytes)

	got, err := findOpenH264Library()
	if err != nil {
		t.Fatalf("findOpenH264Library: %v", err)
	}
	if got != filepath.Join(f.shared, "libopenh264-test.dylib") {
		t.Fatalf("root loaded %q, want the staged copy", got)
	}
	if len(f.downloads) != 0 {
		t.Fatalf("a verified legacy copy must not trigger a download, got %v", f.downloads)
	}
	assertMode(t, f.shared, 0o755)
}

func TestOpenH264_RootIgnoresTamperedLegacyCopy(t *testing.T) {
	f := newOpenH264Fixture(t, "darwin", 0)
	writeCodec(t, f.legacy, 0o700, []byte("tampered"))

	if _, err := findOpenH264Library(); err != nil {
		t.Fatalf("findOpenH264Library: %v", err)
	}
	if len(f.downloads) != 1 {
		t.Fatalf("a tampered legacy copy must be ignored and the codec downloaded, got %v", f.downloads)
	}
}

// A root-staged dir left with loose permissions by an older build or a
// manual chmod is tightened back to 0755 before staging into it.
func TestOpenH264_RootRepairsSharedDirMode(t *testing.T) {
	f := newOpenH264Fixture(t, "darwin", 0)
	if err := os.MkdirAll(f.shared, 0o777); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(f.shared, 0o777); err != nil {
		t.Fatal(err)
	}
	if _, err := findOpenH264Library(); err != nil {
		t.Fatalf("findOpenH264Library: %v", err)
	}
	assertMode(t, f.shared, 0o755)
}

// Linux keeps the codec in the agent data dir with no tree walk, but a local
// candidate is still loaded only on a pinned-hash match.
func TestOpenH264_LinuxRejectsUnverifiedDataDirCodec(t *testing.T) {
	f := newOpenH264Fixture(t, "linux", 0)
	writeCodec(t, f.shared, 0o755, []byte("tampered"))

	got, err := findOpenH264Library()
	if err != nil {
		t.Fatalf("findOpenH264Library: %v", err)
	}
	if got != filepath.Join(f.shared, "libopenh264-test.dylib") || len(f.downloads) != 1 {
		t.Fatalf("got %q with downloads %v, want the tampered file replaced by a verified download", got, f.downloads)
	}
	ok, err := verifyFileSHA256(got, openH264Seams.mustVariant(t).sha256)
	if err != nil || !ok {
		t.Fatalf("loaded file does not match the pinned hash (ok=%v err=%v)", ok, err)
	}
}

func TestVerifyRootOwnedTree(t *testing.T) {
	top := t.TempDir()
	if err := os.Chmod(top, 0o755); err != nil {
		t.Fatal(err)
	}
	uid := uint32(os.Getuid())
	p := writeCodec(t, filepath.Join(top, "codecs"), 0o755, fakeCodecBytes)

	if err := verifyRootOwnedTree(p, top, uid); err != nil {
		t.Fatalf("clean tree rejected: %v", err)
	}
	if err := verifyRootOwnedTree(p, top, uid+1); err == nil {
		t.Fatal("foreign owner accepted")
	}
	if err := os.Chmod(top, 0o757); err != nil {
		t.Fatal(err)
	}
	if err := verifyRootOwnedTree(p, top, uid); err == nil {
		t.Fatal("other-writable ancestor accepted")
	}
	if err := verifyRootOwnedTree(filepath.Join(top, "codecs", "missing"), top, uid); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("missing file: err = %v, want ErrNotExist", err)
	}
}

func assertMode(t *testing.T, path string, want os.FileMode) {
	t.Helper()
	fi, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if got := fi.Mode().Perm(); got != want {
		t.Fatalf("%s mode = %o, want %o", path, got, want)
	}
}

func (s openH264SeamSet) mustVariant(t *testing.T) openH264Variant {
	t.Helper()
	v, ok := s.variant()
	if !ok {
		t.Fatal("no variant")
	}
	return v
}
