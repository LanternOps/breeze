//go:build linux || darwin

package securefs

import (
	"os"
	"path/filepath"
	"runtime"
	"testing"
	"time"
)

// The absolute-prefix walk must traverse the privileged system symlinks that
// exist on a real darwin root (/var -> private/var, /tmp -> private/tmp) while
// still refusing anything a less-privileged identity could have planted or
// swapped. On Linux those paths are ordinary directories, so no link is
// followed at any depth — the behaviour accepted in the original fix.
//
// Everything here is constructed from the test's OWN uid, so the limit of the
// rule is proven in CI (which runs as an unprivileged user), not only under
// root.
func TestOpenAbsoluteDirIntermediateLinkRule(t *testing.T) {
	darwin := runtime.GOOS == "darwin"
	cases := []struct {
		name string
		// build returns the absolute base to install under.
		build func(t *testing.T) string
		// allowed on darwin; Linux refuses every link in the prefix.
		allowedOnDarwin bool
	}{
		{
			name: "intermediate link in a private directory",
			build: func(t *testing.T) string {
				root := t.TempDir()
				real := filepath.Join(root, "real")
				if err := os.Mkdir(real, 0o700); err != nil {
					t.Fatal(err)
				}
				if err := os.Symlink(real, filepath.Join(root, "link")); err != nil {
					t.Fatal(err)
				}
				return filepath.Join(root, "link", "inner")
			},
			allowedOnDarwin: true,
		},
		{
			name: "relative intermediate link in a private directory",
			build: func(t *testing.T) string {
				root := t.TempDir()
				if err := os.Mkdir(filepath.Join(root, "real"), 0o700); err != nil {
					t.Fatal(err)
				}
				if err := os.Symlink("real", filepath.Join(root, "link")); err != nil {
					t.Fatal(err)
				}
				return filepath.Join(root, "link", "inner")
			},
			allowedOnDarwin: true,
		},
		{
			name: "intermediate link in a world-writable non-sticky directory",
			build: func(t *testing.T) string {
				return worldWritableLinkBase(t, 0o777)
			},
			allowedOnDarwin: false,
		},
		{
			// The sticky branch exists for root-owned links in /tmp-like
			// directories. A link owned by an ordinary uid must NOT qualify,
			// even though sticky stops others replacing it.
			name: "self-owned intermediate link in a sticky world-writable directory",
			build: func(t *testing.T) string {
				if os.Geteuid() == 0 {
					t.Skip("running as root would make the link root-owned, which is the trusted case")
				}
				return worldWritableLinkBase(t, os.ModeSticky|0o777)
			},
			allowedOnDarwin: false,
		},
		{
			name: "link target climbing with ..",
			build: func(t *testing.T) string {
				root := t.TempDir()
				sub := filepath.Join(root, "sub")
				if err := os.Mkdir(sub, 0o700); err != nil {
					t.Fatal(err)
				}
				if err := os.Mkdir(filepath.Join(root, "sibling"), 0o700); err != nil {
					t.Fatal(err)
				}
				if err := os.Symlink("../sibling", filepath.Join(sub, "link")); err != nil {
					t.Fatal(err)
				}
				return filepath.Join(sub, "link", "inner")
			},
			allowedOnDarwin: false,
		},
		{
			name: "final component link is never traversed",
			build: func(t *testing.T) string {
				root := t.TempDir()
				real := filepath.Join(root, "real")
				if err := os.Mkdir(real, 0o700); err != nil {
					t.Fatal(err)
				}
				if err := os.Symlink(real, filepath.Join(root, "link")); err != nil {
					t.Fatal(err)
				}
				return filepath.Join(root, "link")
			},
			allowedOnDarwin: false,
		},
		{
			name: "link cycle fails closed instead of looping",
			build: func(t *testing.T) string {
				root := t.TempDir()
				if err := os.Symlink("b", filepath.Join(root, "a")); err != nil {
					t.Fatal(err)
				}
				if err := os.Symlink("a", filepath.Join(root, "b")); err != nil {
					t.Fatal(err)
				}
				return filepath.Join(root, "a", "inner")
			},
			allowedOnDarwin: false,
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			base := tc.build(t)
			want := darwin && tc.allowedOnDarwin
			_, err := InstallFile(base, "file.txt", writeSource(t, "payload"), 0, time.Time{})
			if want && err != nil {
				t.Fatalf("expected the trusted path to be usable on darwin, got %v", err)
			}
			if !want && err == nil {
				t.Fatalf("path was accepted; on %s this link must be refused", runtime.GOOS)
			}
			if want {
				if _, statErr := os.Stat(filepath.Join(base, "file.txt")); statErr != nil {
					t.Fatalf("positive control did not publish the file: %v", statErr)
				}
			}
		})
	}
}

func worldWritableLinkBase(t *testing.T, mode os.FileMode) string {
	t.Helper()
	root := t.TempDir()
	real := filepath.Join(root, "real")
	if err := os.Mkdir(real, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(real, filepath.Join(root, "link")); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(root, mode); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.Chmod(root, 0o700) })
	return filepath.Join(root, "link", "inner")
}

// Linux must refuse a link in the absolute prefix even in the shape darwin
// trusts, so the relaxation cannot silently leak across platforms.
func TestLinuxRefusesEveryIntermediateLink(t *testing.T) {
	if runtime.GOOS != "linux" {
		t.Skip("asserts the Linux-only policy")
	}
	if trustedIntermediateLinksAllowed {
		t.Fatal("the trusted-link relaxation is compiled in on Linux")
	}
	root := t.TempDir()
	real := filepath.Join(root, "real")
	if err := os.Mkdir(real, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(real, filepath.Join(root, "link")); err != nil {
		t.Fatal(err)
	}
	if _, err := InstallFile(filepath.Join(root, "link", "inner"), "file.txt", writeSource(t, "payload"), 0, time.Time{}); err == nil {
		t.Fatal("Linux traversed an intermediate symlink in the absolute prefix")
	}
}

// Root-only variants: these prove the owner branches directly, and are
// ADDITIONAL to the non-root coverage above rather than the sole coverage.
func TestOpenAbsoluteDirRejectsForeignOwnedIntermediateLink(t *testing.T) {
	if os.Geteuid() != 0 {
		t.Skip("planting a foreign-owned symlink requires root")
	}
	root := t.TempDir()
	real := filepath.Join(root, "real")
	if err := os.Mkdir(real, 0o700); err != nil {
		t.Fatal(err)
	}
	link := filepath.Join(root, "link")
	if err := os.Symlink(real, link); err != nil {
		t.Fatal(err)
	}
	if err := os.Lchown(link, 65534, 65534); err != nil {
		t.Fatal(err)
	}
	if _, err := InstallFile(filepath.Join(root, "link", "inner"), "file.txt", writeSource(t, "payload"), 0, time.Time{}); err == nil {
		t.Fatal("foreign-owned intermediate link was traversed")
	}
}

func TestOpenAbsoluteDirRejectsLinkInForeignOwnedDirectory(t *testing.T) {
	if os.Geteuid() != 0 {
		t.Skip("re-owning a directory requires root")
	}
	root := t.TempDir()
	holder := filepath.Join(root, "holder")
	if err := os.Mkdir(holder, 0o700); err != nil {
		t.Fatal(err)
	}
	real := filepath.Join(holder, "real")
	if err := os.Mkdir(real, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(real, filepath.Join(holder, "link")); err != nil {
		t.Fatal(err)
	}
	if err := os.Chown(holder, 65534, 65534); err != nil {
		t.Fatal(err)
	}
	if _, err := InstallFile(filepath.Join(holder, "link", "inner"), "file.txt", writeSource(t, "payload"), 0, time.Time{}); err == nil {
		t.Fatal("link in a foreign-owned directory was traversed")
	}
}
