//go:build windows

package isolation

import (
	"context"
	"net/netip"
	"os"
	"testing"

	"github.com/breeze-rmm/agent/internal/isolation/wfp"
)

// This explicitly opted-in lab test installs only a TEST-NET destination block;
// it never applies the full host-isolation policy on the Windows test runner.
func TestWindowsIsolatorLiveReleaseAndVerify(t *testing.T) {
	if os.Getenv("BREEZE_WFP_TEST") != "1" {
		t.Skip("requires elevated Windows lab and BREEZE_WFP_TEST=1")
	}
	ctx := context.Background()
	i := newWindowsIsolator(nil)
	owned, err := i.Owned(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if owned {
		t.Skip("existing Breeze isolation must not be altered by a test")
	}
	s, err := wfp.OpenSession()
	if err != nil {
		t.Fatal(err)
	}
	defer closeWindowsSession(s)
	f := wfp.Filter{Key: wfp.FilterKey("isolation-integration-test"), Name: "Breeze isolation integration test", Layer: wfp.ALEConnectV4, Sublayer: wfp.SublayerKey, Weight: 1, Action: wfp.Block, Persistent: true,
		Conditions: []wfp.Condition{{Field: wfp.RemoteAddress, Address: netip.MustParsePrefix("192.0.2.0/24")}}}
	if err := s.Tx(func(tx *wfp.Tx) error {
		if err := tx.AddProvider(true); err != nil {
			return err
		}
		if err := tx.AddSublayer(wfp.SublayerWeight, true); err != nil {
			return err
		}
		_, err := tx.AddFilter(f)
		return err
	}); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := i.Release(ctx); err != nil {
			t.Errorf("cleanup WFP: %v", err)
		}
	})
	owned, err = i.Owned(ctx)
	if err != nil || !owned {
		t.Fatalf("Owned: %v %v", owned, err)
	}
	digest, err := i.Verify(ctx, ResolvedSpec{})
	if err != nil || digest != Digest(wfp.Digest([]wfp.Filter{f})) {
		t.Fatalf("Verify: %s %v", digest, err)
	}
	if err := i.Release(ctx); err != nil {
		t.Fatal(err)
	}
	if owned, err := i.Owned(ctx); err != nil || owned {
		t.Fatalf("released: %v %v", owned, err)
	}
}
