package heartbeat

import (
	"bytes"
	"os"
	"testing"
	"time"

	"github.com/breeze-rmm/agent/internal/config"
)

// #8318 maintainer review: an mTLS renewal still in flight when a reattach
// swaps the identity on disk must not write its certificate (SaveTo writes
// mtls_* from h.config, the retired source's). The swap is simulated by the
// flag rebindSwap sets under h.mu, raised while the server is answering; the
// config files are snapshotted at that moment and must be unchanged after.
func TestRenewalCompletingAfterARebindSwapWritesNothing(t *testing.T) {
	cases := []struct {
		name   string
		legacy bool
		during string // "renew" or "confirm"
	}{
		{"swap during renew: the pending certificate is not staged", false, "renew"},
		{"swap during confirm: the confirmed certificate is not promoted", false, "confirm"},
		{"swap during a legacy renew: the certificate is not written", true, "renew"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			srv := newMTLSRenewalServer(t)
			srv.legacyRenewResponse = tc.legacy
			h, cfgPath := newMTLSTestHeartbeat(t, srv.URL)
			oldCertPEM := h.config.MtlsCertPEM
			var atSwap map[string][]byte
			swap := func() {
				h.rebind.swapped.Store(true)
				atSwap = snapshotConfigFiles(t, cfgPath)
			}
			if tc.during == "renew" {
				srv.onRenew = swap
			} else {
				srv.onConfirm = swap
			}

			h.handleCertRenewal()

			if atSwap == nil {
				t.Fatal("the swap hook never ran")
			}
			if !sameFiles(snapshotConfigFiles(t, cfgPath), atSwap) {
				t.Fatal("a renewal completing after the swap wrote the config files")
			}
			if h.pendingMTLSCertOnDisk.Load() && tc.during == "renew" {
				t.Fatal("a refused stage armed a renewal retry")
			}
			if h.config.MtlsCertPEM != oldCertPEM {
				t.Fatal("the unsaved certificate was left active in memory")
			}
			if _, confirm, _ := srv.counts(); tc.during == "renew" && confirm != 0 {
				t.Fatalf("confirm calls = %d: an unstaged certificate must never be confirmed", confirm)
			}
		})
	}
}

// The discard path (a pending certificate that can never be confirmed) is
// refused the same way, and arms no retry.
func TestClearPendingAfterARebindSwapWritesNothing(t *testing.T) {
	srv := newMTLSRenewalServer(t)
	h, cfgPath := newMTLSTestHeartbeat(t, srv.URL)
	h.config.PendingMTLSCertificate, h.config.PendingMTLSPrivateKey = "P", "K"
	h.config.PendingMTLSCertificateID = "cert-old"
	h.config.PendingMTLSExpiresAt = time.Now().Add(-time.Hour)
	// On disk before the swap, so an unguarded clear would change the files.
	if err := config.SaveTo(h.config, cfgPath); err != nil {
		t.Fatalf("SaveTo: %v", err)
	}
	h.rebind.swapped.Store(true)
	before := snapshotConfigFiles(t, cfgPath)

	h.clearPendingMTLSCert()

	if !sameFiles(snapshotConfigFiles(t, cfgPath), before) {
		t.Fatal("clearPendingMTLSCert wrote the config files after the swap")
	}
	if h.pendingMTLSCertOnDisk.Load() {
		t.Fatal("a refused save armed a retry")
	}
}

// Without a swap the same renewal still saves: the guard is no blanket refusal.
func TestRenewalWithoutARebindSwapStillSaves(t *testing.T) {
	srv := newMTLSRenewalServer(t)
	h, cfgPath := newMTLSTestHeartbeat(t, srv.URL)
	before := snapshotConfigFiles(t, cfgPath)

	h.handleCertRenewal()

	if sameFiles(snapshotConfigFiles(t, cfgPath), before) {
		t.Fatal("a normal renewal wrote nothing")
	}
	loaded, err := config.Load(cfgPath)
	if err != nil {
		t.Fatalf("config.Load: %v", err)
	}
	if loaded.MtlsCertPEM != srv.renewCertPEM {
		t.Fatal("a normal renewal did not persist the promoted certificate")
	}
}

func snapshotConfigFiles(t *testing.T, cfgPath string) map[string][]byte {
	t.Helper()
	out := map[string][]byte{}
	for _, p := range []string{cfgPath, secretsPathFor(cfgPath)} {
		b, err := os.ReadFile(p)
		if err != nil && !os.IsNotExist(err) {
			t.Fatalf("read %s: %v", p, err)
		}
		out[p] = b
	}
	return out
}

func sameFiles(a, b map[string][]byte) bool {
	if len(a) != len(b) {
		return false
	}
	for k, v := range a {
		if !bytes.Equal(b[k], v) {
			return false
		}
	}
	return true
}
