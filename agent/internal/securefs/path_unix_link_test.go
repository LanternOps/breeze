//go:build linux || darwin

package securefs

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

// The absolute-prefix walk must traverse the privileged system symlinks that
// exist on a real darwin root (/var -> private/var, /tmp -> private/tmp) while
// still refusing anything a less-privileged identity could have planted or
// swapped. These cases pin that rule on both unix platforms.
func TestOpenAbsoluteDirTrustedIntermediateLinkRule(t *testing.T) {
	cases := []struct {
		name string
		// build returns the absolute base to install under.
		build   func(t *testing.T) string
		allowed bool
	}{
		{
			name: "intermediate link in a private directory is traversed",
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
			allowed: true,
		},
		{
			name: "relative intermediate link in a private directory is traversed",
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
			allowed: true,
		},
		{
			name: "intermediate link in a world-writable non-sticky directory is rejected",
			build: func(t *testing.T) string {
				root := t.TempDir()
				real := filepath.Join(root, "real")
				if err := os.Mkdir(real, 0o700); err != nil {
					t.Fatal(err)
				}
				if err := os.Symlink(real, filepath.Join(root, "link")); err != nil {
					t.Fatal(err)
				}
				if err := os.Chmod(root, 0o777); err != nil {
					t.Fatal(err)
				}
				t.Cleanup(func() { _ = os.Chmod(root, 0o700) })
				return filepath.Join(root, "link", "inner")
			},
			allowed: false,
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
			allowed: false,
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
			allowed: false,
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			base := tc.build(t)
			_, err := InstallFile(base, "file.txt", writeSource(t, "payload"), 0, time.Time{})
			if tc.allowed && err != nil {
				t.Fatalf("expected the trusted path to be usable, got %v", err)
			}
			if !tc.allowed && err == nil {
				t.Fatal("expected the untrusted path to be rejected")
			}
			if tc.allowed {
				if _, statErr := os.Stat(filepath.Join(base, "file.txt")); statErr != nil {
					t.Fatalf("positive control did not publish the file: %v", statErr)
				}
			}
		})
	}
}

// A symlink owned by another local identity is never trusted, whatever the
// permissions on the directory that holds it.
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
	base := filepath.Join(root, "link", "inner")
	if _, err := InstallFile(base, "file.txt", writeSource(t, "payload"), 0, time.Time{}); err == nil {
		t.Fatal("foreign-owned intermediate link was traversed")
	}
}
