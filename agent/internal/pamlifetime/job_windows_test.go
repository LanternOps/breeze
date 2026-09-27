//go:build windows

package pamlifetime

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// writePinTargetFixture writes a small regular file under t.TempDir() and
// returns its path plus its SHA-256 hex digest, for use as a PinTarget
// fixture.
func writePinTargetFixture(t *testing.T, content string) (string, string) {
	t.Helper()
	dir := t.TempDir()
	path := filepath.Join(dir, "target.exe")
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatalf("write fixture: %v", err)
	}
	sum := sha256.Sum256([]byte(content))
	return path, hex.EncodeToString(sum[:])
}

// TestPinTargetRejectsMissingExpectedHash reproduces the case where the
// server dispatches an apply command with no target hash (e.g. because the
// agent's own hash capture failed when the elevation request was recorded).
// PinTarget must refuse to pin the target rather than silently skip
// verification, since a nil/blank expected hash means a file swapped after
// a human approved the (path-only) request would go undetected.
func TestPinTargetRejectsMissingExpectedHash(t *testing.T) {
	path, _ := writePinTargetFixture(t, "hello world")
	prim := &nativeWindowsPrimitives{}

	if _, _, release, err := prim.PinTarget(context.Background(), path, nil); err == nil {
		if release != nil {
			release()
		}
		t.Fatal("PinTarget succeeded with a nil expected hash; want a fail-closed error")
	}
}

// TestPinTargetRejectsBlankExpectedHash is the same as above but for a
// present, empty-after-trim expected hash (e.g. an empty string or
// whitespace-only value round-tripped through the command payload).
func TestPinTargetRejectsBlankExpectedHash(t *testing.T) {
	path, _ := writePinTargetFixture(t, "hello world")
	prim := &nativeWindowsPrimitives{}
	blank := "   "

	if _, _, release, err := prim.PinTarget(context.Background(), path, &blank); err == nil {
		if release != nil {
			release()
		}
		t.Fatal("PinTarget succeeded with a blank expected hash; want a fail-closed error")
	}
}

// TestPinTargetRejectsMismatchedHash is the control for the swap scenario:
// a present expected hash that does not match the file on disk must still
// be refused (this behavior predates this change; kept here alongside the
// nil/blank cases for a single point of PinTarget coverage).
func TestPinTargetRejectsMismatchedHash(t *testing.T) {
	path, _ := writePinTargetFixture(t, "hello world")
	prim := &nativeWindowsPrimitives{}
	wrong := strings.Repeat("a", 64)

	if _, _, release, err := prim.PinTarget(context.Background(), path, &wrong); err == nil {
		if release != nil {
			release()
		}
		t.Fatal("PinTarget succeeded with a mismatched expected hash; want an error")
	}
}

// TestPinTargetAcceptsMatchingHash is the positive control: a correct,
// present expected hash must still pin successfully.
func TestPinTargetAcceptsMatchingHash(t *testing.T) {
	path, wantHash := writePinTargetFixture(t, "hello world")
	prim := &nativeWindowsPrimitives{}

	canonical, hash, release, err := prim.PinTarget(context.Background(), path, &wantHash)
	if err != nil {
		t.Fatalf("PinTarget returned error for a matching hash: %v", err)
	}
	defer release()
	if hash != wantHash {
		t.Fatalf("PinTarget hash = %q, want %q", hash, wantHash)
	}
	if canonical == "" {
		t.Fatal("PinTarget returned an empty canonical path")
	}
}
