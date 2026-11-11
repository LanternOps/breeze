//go:build !windows

package desktop

import (
	"compress/bzip2"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"syscall"
	"time"

	"github.com/breeze-rmm/agent/internal/config"
)

// openH264Variant is one platform's pinned OpenH264 build.
type openH264Variant struct {
	libName     string
	sha256      string
	downloadURL string
	fallbackURL string
}

// Cisco OpenH264 v2.4.1 library names and SHA-256 hashes per platform.
// Hashes are of the decompressed library, verified from Cisco's distribution.
var openH264Variants = map[string]openH264Variant{
	"darwin/arm64": {
		libName:     "libopenh264-2.4.1-mac-arm64.dylib",
		sha256:      "213ff93831cfa3dd6d7ad0c3a3403a6ceedf4ac1341e1278b5b869d42fefb496",
		downloadURL: "http://ciscobinary.openh264.org/libopenh264-2.4.1-mac-arm64.dylib.bz2",
		fallbackURL: "https://github.com/nicedoc/openh264/releases/download/v2.4.1/libopenh264-2.4.1-mac-arm64.dylib.bz2",
	},
	"darwin/amd64": {
		libName:     "libopenh264-2.4.1-mac-x64.dylib",
		sha256:      "cc0ba518a63791c37571f3c851f0aa03a4fbda5410acc214ecd4f24f8d1c478e",
		downloadURL: "http://ciscobinary.openh264.org/libopenh264-2.4.1-mac-x64.dylib.bz2",
		fallbackURL: "https://github.com/nicedoc/openh264/releases/download/v2.4.1/libopenh264-2.4.1-mac-x64.dylib.bz2",
	},
	"linux/amd64": {
		libName:     "libopenh264-2.4.1-linux64.7.so",
		sha256:      "1392d21466bc638e68151b716d5b2086d54cd812afd43253f1adb5b6e0185f51",
		downloadURL: "http://ciscobinary.openh264.org/libopenh264-2.4.1-linux64.7.so.bz2",
		fallbackURL: "https://github.com/nicedoc/openh264/releases/download/v2.4.1/libopenh264-2.4.1-linux64.7.so.bz2",
	},
	"linux/arm64": {
		libName:     "libopenh264-2.4.1-linux-arm64.7.so",
		sha256:      "e8ea7e42855ceb4a90e7bd0b3abeba0c58b5f97166e8b0a30eefd58e099557a4",
		downloadURL: "http://ciscobinary.openh264.org/libopenh264-2.4.1-linux-arm64.7.so.bz2",
		fallbackURL: "https://github.com/nicedoc/openh264/releases/download/v2.4.1/libopenh264-2.4.1-linux-arm64.7.so.bz2",
	},
}

// darwinOpenH264CodecDir is where the root agent stages the codec on macOS
// for every Breeze process to load (#10870). It is a sibling of the agent
// data dir, not a child: data/ is 0700 root, so nothing under it is
// reachable by the console-user desktop helper whatever its own mode. The
// directory is 0755 root-owned and the codec 0644, so the helper can read it
// and nobody but root can replace it between the hash check and dlopen.
const darwinOpenH264CodecDir = "/Library/Application Support/Breeze/codecs"

// openH264SeamSet is every environment input findOpenH264Library reads, so
// tests can drive the root/helper and darwin/linux matrix on any host.
type openH264SeamSet struct {
	variant    func() (openH264Variant, bool)
	goos       string
	euid       func() int
	exeDir     func() (string, error)
	sharedDir  func() string // where root stages and every process loads
	legacyDir  func() string // pre-#10870 root-only copy on macOS
	tempDir    func() string // a non-root process's private download dir
	systemDirs []string
	trustTop   string // the trust walk checks up to and including this dir
	trustedUID uint32 // owner the trust walk requires (root)
	download   func(v openH264Variant, destDir string) error
}

var openH264Seams = openH264SeamSet{
	variant: func() (openH264Variant, bool) {
		v, ok := openH264Variants[runtime.GOOS+"/"+runtime.GOARCH]
		return v, ok
	},
	goos: runtime.GOOS,
	euid: os.Geteuid,
	exeDir: func() (string, error) {
		exe, err := os.Executable()
		if err != nil {
			return "", err
		}
		return filepath.Dir(exe), nil
	},
	sharedDir:  defaultOpenH264SharedDir,
	legacyDir:  config.GetDataDir,
	tempDir:    func() string { return filepath.Join(os.TempDir(), "breeze-openh264") },
	systemDirs: []string{"/usr/lib", "/usr/local/lib", "/usr/lib64"},
	trustTop:   "/",
	trustedUID: 0,
	download:   downloadOpenH264,
}

// defaultOpenH264SharedDir is the root-staged codec dir on macOS and the
// agent data dir everywhere else (unchanged on Linux).
func defaultOpenH264SharedDir() string {
	if runtime.GOOS == "darwin" {
		return darwinOpenH264CodecDir
	}
	return config.GetDataDir()
}

// findOpenH264Library searches for the OpenH264 shared library on non-Windows.
// Search order: next to the executable, the shared codec dir, standard
// library paths, then a download.
//
// Every local candidate is loaded only when its SHA-256 matches the pinned
// release hash, and the returned path is the file that was hashed. On macOS
// the shared codec dir candidate must also pass verifyRootOwnedTree: the
// desktop helper holds Screen Recording and Accessibility grants and must not
// dlopen a library from anywhere its own user (or anyone but root) can write.
//
// Only root writes the shared dir: it stages the codec there (from a verified
// pre-#10870 copy in the agent data dir if one exists, else by download).
// Any other process that finds no verified staged copy (the helper started
// before the agent staged it, or a host with no agent) downloads a private
// copy into a temp dir, as it always did, and says so at Warn. That copy is
// hash-verified as it is written but lives in a user-writable dir, so it is
// the fallback, not the steady state.
func findOpenH264Library() (string, error) {
	s := openH264Seams
	v, ok := s.variant()
	if !ok {
		return "", fmt.Errorf("OpenH264: unsupported platform %s/%s", runtime.GOOS, runtime.GOARCH)
	}

	// On macOS every candidate must sit in a root-owned tree, not only the
	// shared dir: /usr/local/{bin,lib} are often user-owned on Intel Homebrew
	// hosts, and a hash check on a file its user can swap is no gate.
	rootTree := s.goos == "darwin"

	// 1. Next to the executable.
	if dir, err := s.exeDir(); err == nil {
		if p, ok := verifiedOpenH264(dir, v, rootTree); ok {
			return p, nil
		}
	}

	// 2. The shared codec dir.
	shared := s.sharedDir()
	if p, ok := verifiedOpenH264(shared, v, rootTree); ok {
		return p, nil
	}

	// 3. Standard library paths.
	for _, dir := range s.systemDirs {
		if p, ok := verifiedOpenH264(dir, v, rootTree); ok {
			return p, nil
		}
	}

	// 4. Root stages the codec for everyone.
	if s.euid() == 0 {
		return stageOpenH264(v, shared)
	}
	// Off macOS a non-root process keeps the pre-#10870 rule: persist into
	// the shared dir when it can write it.
	if s.goos != "darwin" && isDirWritable(shared) {
		slog.Info("OpenH264 library not found locally, downloading", "lib", v.libName, "dest", shared)
		if err := s.download(v, shared); err != nil {
			return "", fmt.Errorf("auto-download OpenH264: %w", err)
		}
		return filepath.Join(shared, v.libName), nil
	}
	// Anyone else downloads a private copy and never writes the shared dir.
	tmp := s.tempDir()
	slog.Warn("OpenH264: no verified shared codec; downloading a private copy to a temp dir",
		"sharedDir", shared, "dest", tmp)
	if err := s.download(v, tmp); err != nil {
		return "", fmt.Errorf("auto-download OpenH264: %w", err)
	}
	return filepath.Join(tmp, v.libName), nil
}

// isDirWritable reports whether dir exists and this process can create a
// file in it. It never creates dir.
func isDirWritable(dir string) bool {
	f, err := os.CreateTemp(dir, ".breeze-write-check-*")
	if err != nil {
		return false
	}
	name := f.Name()
	_ = f.Close()
	_ = os.Remove(name)
	return true
}

// verifiedOpenH264 returns dir/libName when it matches the pinned hash and,
// with requireRootTree, when it and every directory above it are root-owned
// real directories/files that no group or other can write. A missing file is
// silent; anything else that disqualifies a present file is warned about.
func verifiedOpenH264(dir string, v openH264Variant, requireRootTree bool) (string, bool) {
	p := filepath.Join(dir, v.libName)
	if requireRootTree {
		if err := verifyRootOwnedTree(p, openH264Seams.trustTop, openH264Seams.trustedUID); err != nil {
			if !errors.Is(err, os.ErrNotExist) {
				slog.Warn("OpenH264: ignoring a staged codec that is not root-owned and protected", "path", p, "error", err.Error())
			}
			return "", false
		}
	}
	ok, err := verifyFileSHA256(p, v.sha256)
	if err != nil {
		if !errors.Is(err, os.ErrNotExist) {
			slog.Warn("OpenH264: cannot verify a local codec, ignoring", "path", p, "error", err.Error())
		}
		return "", false
	}
	if !ok {
		slog.Warn("OpenH264: local codec failed checksum verification, ignoring", "path", p)
		return "", false
	}
	return p, true
}

// verifyRootOwnedTree checks path and every ancestor up to and including top:
// each must exist, not be a symlink, be owned by uid, and grant no group or
// other write. It never changes anything. A missing path returns an error
// wrapping os.ErrNotExist.
func verifyRootOwnedTree(path, top string, uid uint32) error {
	p := filepath.Clean(path)
	top = filepath.Clean(top)
	for {
		fi, err := os.Lstat(p)
		if err != nil {
			return err
		}
		if fi.Mode()&os.ModeSymlink != 0 {
			return fmt.Errorf("%s is a symlink", p)
		}
		st, ok := fi.Sys().(*syscall.Stat_t)
		if !ok {
			return fmt.Errorf("%s: cannot read owner", p)
		}
		if st.Uid != uid {
			return fmt.Errorf("%s is owned by uid %d, want %d", p, st.Uid, uid)
		}
		if fi.Mode().Perm()&0o022 != 0 {
			return fmt.Errorf("%s is group- or other-writable (%o)", p, fi.Mode().Perm())
		}
		if p == top {
			return nil
		}
		parent := filepath.Dir(p)
		if parent == p {
			return fmt.Errorf("%s is not under %s", path, top)
		}
		p = parent
	}
}

// stageOpenH264 is root's step 4: make the shared dir, then fill it from a
// verified legacy copy or a download.
func stageOpenH264(v openH264Variant, shared string) (string, error) {
	s := openH264Seams
	if s.goos == "darwin" {
		if err := ensureOpenH264CodecDir(shared, s.trustedUID); err != nil {
			slog.Error("OpenH264: cannot stage the codec for the desktop helper; it will download a private copy on each start",
				"dir", shared, "error", err.Error())
			return "", fmt.Errorf("stage OpenH264: %w", err)
		}
		// A pre-#10870 build kept the codec in the root-only data dir.
		if legacy, ok := verifiedOpenH264(s.legacyDir(), v, false); ok {
			err := copyVerifiedLib(legacy, v, shared)
			if err == nil {
				slog.Info("OpenH264: staged the existing codec for helpers", "from", legacy, "dir", shared)
				return filepath.Join(shared, v.libName), nil
			}
			slog.Warn("OpenH264: could not stage the existing codec, downloading", "from", legacy, "dir", shared, "error", err.Error())
		}
	}
	slog.Info("OpenH264 library not found locally, downloading", "lib", v.libName, "dest", shared)
	if err := s.download(v, shared); err != nil {
		if s.goos == "darwin" {
			slog.Error("OpenH264: could not stage the codec for the desktop helper; retrying later, helpers download a private copy meanwhile",
				"dir", shared, "error", err.Error())
		}
		return "", fmt.Errorf("auto-download OpenH264: %w", err)
	}
	return filepath.Join(shared, v.libName), nil
}

// ensureOpenH264CodecDir creates the macOS shared codec dir 0755 and repairs
// a looser mode. It refuses a symlink, a non-directory, or a directory owned
// by anyone but uid (root) rather than staging through it.
func ensureOpenH264CodecDir(dir string, uid uint32) error {
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}
	fi, err := os.Lstat(dir)
	if err != nil {
		return err
	}
	if fi.Mode()&os.ModeSymlink != 0 || !fi.IsDir() {
		return fmt.Errorf("%s is not a real directory", dir)
	}
	st, ok := fi.Sys().(*syscall.Stat_t)
	if !ok {
		return fmt.Errorf("%s: cannot read owner", dir)
	}
	if st.Uid != uid {
		return fmt.Errorf("%s is owned by uid %d, want %d", dir, st.Uid, uid)
	}
	if fi.Mode().Perm() != 0o755 {
		return os.Chmod(dir, 0o755)
	}
	return nil
}

// copyVerifiedLib installs a verified local copy into destDir through the
// same hash-checked temp-then-rename path as a download.
func copyVerifiedLib(src string, v openH264Variant, destDir string) error {
	f, err := os.Open(src)
	if err != nil {
		return err
	}
	defer func() { _ = f.Close() }()
	return installVerifiedLib(f, v, destDir)
}

func downloadOpenH264(v openH264Variant, destDir string) error {
	if err := os.MkdirAll(destDir, 0o755); err != nil {
		return fmt.Errorf("create dest dir: %w", err)
	}

	var lastErr error
	for _, url := range []string{v.downloadURL, v.fallbackURL} {
		if err := downloadAndVerifyLib(url, v, destDir); err != nil {
			slog.Warn("OpenH264 download failed, trying next source", "url", url, "error", err.Error())
			lastErr = err
			continue
		}
		return nil
	}
	return lastErr
}

func downloadAndVerifyLib(url string, v openH264Variant, destDir string) error {
	client := &http.Client{Timeout: 120 * time.Second}
	resp, err := client.Get(url)
	if err != nil {
		return fmt.Errorf("download %s: %w", url, err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("download %s: HTTP %d", url, resp.StatusCode)
	}
	return installVerifiedLib(bzip2.NewReader(resp.Body), v, destDir)
}

// installVerifiedLib writes src to a unique temp file in destDir (mode 0644), checks
// its SHA-256 against the pinned hash, and only then renames it into place.
func installVerifiedLib(src io.Reader, v openH264Variant, destDir string) error {
	hasher := sha256.New()

	// A unique temp name (O_EXCL, never followed through a planted link):
	// two root stagers (the agent and the login-window helper) must not
	// truncate each other's half-written file before its rename.
	f, err := os.CreateTemp(destDir, v.libName+".tmp-*")
	if err != nil {
		return fmt.Errorf("create tmp file: %w", err)
	}
	tmpPath := f.Name()
	// The file mode is masked by umask; a helper must be able to read it.
	if err := f.Chmod(0o644); err != nil {
		_ = f.Close()
		_ = os.Remove(tmpPath)
		return fmt.Errorf("chmod tmp file: %w", err)
	}

	// Limit decompressed size to prevent decompression bombs (libraries are ~2-5MB)
	const maxLibSize = 20 * 1024 * 1024
	written, err := io.Copy(f, io.LimitReader(io.TeeReader(src, hasher), maxLibSize))
	f.Close()
	if err != nil {
		os.Remove(tmpPath)
		return fmt.Errorf("decompress: %w", err)
	}

	hash := hex.EncodeToString(hasher.Sum(nil))
	if hash != v.sha256 {
		os.Remove(tmpPath)
		return fmt.Errorf("SHA-256 mismatch: got %s, expected %s", hash, v.sha256)
	}

	finalPath := filepath.Join(destDir, v.libName)
	if err := os.Rename(tmpPath, finalPath); err != nil {
		os.Remove(tmpPath)
		return fmt.Errorf("rename: %w", err)
	}

	slog.Info("OpenH264 library installed and verified",
		"path", finalPath, "size", written, "sha256", hash)
	return nil
}

// openH264StagesForHelpers reports whether this process stages the codec for
// other processes to load: the root agent on macOS (#10870).
func openH264StagesForHelpers() bool {
	return openH264Seams.goos == "darwin" && openH264Seams.euid() == 0
}
