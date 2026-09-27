package sessionbroker

import (
	"errors"
	"os"
	"path/filepath"
	"testing"
	"time"
)

// These cover the install-location gate on the on-miss allowlist refresh in
// verifyPeerBinaryHash: a changed binary at an allowlisted path is re-hashed
// only when its file and directory can be modified by administrators alone.

// newTrustGateBroker returns a broker whose allowlisted helper path is the
// supplied file and whose allowlist was computed from it, as at startup.
func newTrustGateBroker(t *testing.T, helper string) (*Broker, *time.Time) {
	t.Helper()
	b := New(filepath.Join(t.TempDir(), "broker.sock"), nil)
	b.helperPathsFn = func() []string { return []string{helper} }
	now := time.Unix(1_800_000_000, 0)
	b.nowFn = func() time.Time { return now }
	b.selfHashes = b.computeAllowedHashes()
	if b.allowedHashCount() != 1 {
		t.Fatal("seed allowlist")
	}
	return b, &now
}

// swapInstallTrusted replaces the install-location gate and records the paths
// it was asked about.
func swapInstallTrusted(t *testing.T, fn func(string) error) *[]string {
	t.Helper()
	var asked []string
	orig := helperBinaryInstallTrustedFn
	helperBinaryInstallTrustedFn = func(p string) error {
		asked = append(asked, p)
		return fn(p)
	}
	t.Cleanup(func() { helperBinaryInstallTrustedFn = orig })
	return &asked
}

func writeHelperBinary(t *testing.T, path, content string) string {
	t.Helper()
	if err := os.WriteFile(path, []byte(content), 0o755); err != nil {
		t.Fatalf("write %s: %v", path, err)
	}
	sum, err := hashFileSHA256(path)
	if err != nil {
		t.Fatalf("hash %s: %v", path, err)
	}
	return sum
}

func TestVerifyPeerBinaryHash_KnownHashSkipsInstallGate(t *testing.T) {
	helper := filepath.Join(t.TempDir(), "breeze-helper")
	writeHelperBinary(t, helper, "v1")
	b, _ := newTrustGateBroker(t, helper)
	asked := swapInstallTrusted(t, func(string) error { return nil })

	if _, ok, err := b.verifyPeerBinaryHash(helper); err != nil || !ok {
		t.Fatalf("an allowlisted hash must be admitted: ok=%v err=%v", ok, err)
	}
	if len(*asked) != 0 {
		t.Errorf("a known hash must not reach the install gate, consulted for %v", *asked)
	}
}

func TestVerifyPeerBinaryHash_ChangedBinaryInTrustedLocationAdmitted(t *testing.T) {
	helper := filepath.Join(t.TempDir(), "breeze-helper")
	writeHelperBinary(t, helper, "v1")
	b, _ := newTrustGateBroker(t, helper)
	newSum := writeHelperBinary(t, helper, "v2")
	asked := swapInstallTrusted(t, func(string) error { return nil })

	if _, ok, _ := b.verifyPeerBinaryHash(helper); !ok {
		t.Fatal("a changed binary in an administrator-only location must be admitted without an agent restart")
	}
	if len(*asked) != 1 {
		t.Fatalf("the install gate must be consulted exactly once, got %v", *asked)
	}
	if !b.isAllowedBinaryHash(newSum) {
		t.Error("the refreshed allowlist must contain the new hash")
	}
}

func TestVerifyPeerBinaryHash_UserWritableLocationRefused(t *testing.T) {
	helper := filepath.Join(t.TempDir(), "breeze-helper")
	oldSum := writeHelperBinary(t, helper, "v1")
	b, _ := newTrustGateBroker(t, helper)
	newSum := writeHelperBinary(t, helper, "replaced")
	swapInstallTrusted(t, func(string) error { return errors.New("writable by a non-administrator") })

	if _, ok, _ := b.verifyPeerBinaryHash(helper); ok {
		t.Fatal("a binary whose file or directory a non-administrator can modify must not be admitted by a refresh")
	}
	if b.isAllowedBinaryHash(newSum) {
		t.Error("a refused refresh must not add the new hash")
	}
	if !b.isAllowedBinaryHash(oldSum) {
		t.Error("a refused refresh must leave the existing allowlist untouched")
	}
	b.hashRefreshMu.Lock()
	consumed := !b.lastHashMissRefresh.IsZero()
	b.hashRefreshMu.Unlock()
	if consumed {
		t.Error("a refused peer must not take the refresh rate-limit slot")
	}
}

func TestVerifyPeerBinaryHash_RefusedGateDoesNotBlockLaterRefresh(t *testing.T) {
	helper := filepath.Join(t.TempDir(), "breeze-helper")
	writeHelperBinary(t, helper, "v1")
	b, _ := newTrustGateBroker(t, helper)

	trusted := false
	swapInstallTrusted(t, func(string) error {
		if !trusted {
			return errors.New("untrusted owner")
		}
		return nil
	})
	writeHelperBinary(t, helper, "v2")
	if _, ok, _ := b.verifyPeerBinaryHash(helper); ok {
		t.Fatal("untrusted location must be refused")
	}
	trusted = true
	if _, ok, _ := b.verifyPeerBinaryHash(helper); !ok {
		t.Fatal("a refused peer must not use up the refresh window of a later, legitimate one")
	}
}

func TestVerifyPeerBinaryHash_NonAllowlistedPathSkipsInstallGate(t *testing.T) {
	helper := filepath.Join(t.TempDir(), "breeze-helper")
	writeHelperBinary(t, helper, "v1")
	b, _ := newTrustGateBroker(t, helper)
	other := filepath.Join(t.TempDir(), "breeze-helper")
	writeHelperBinary(t, other, "elsewhere")
	asked := swapInstallTrusted(t, func(string) error { return nil })

	if _, ok, _ := b.verifyPeerBinaryHash(other); ok {
		t.Fatal("a binary outside the allowlisted paths must never be admitted")
	}
	if len(*asked) != 0 {
		t.Errorf("a non-allowlisted path must be refused before the install gate, consulted for %v", *asked)
	}
}
