package security

import (
	"errors"
	"testing"
)

// fakeWSCHost stands in for a Windows host's Security Center surface (#10907).
// runWSCQuery is the only spawn path for the root/SecurityCenter2 query, so
// spawns counts exactly what would have been launched on a real host.
type fakeWSCHost struct {
	server      bool
	queryOut    string
	queryErr    error
	serverReads int
	spawns      int
}

func installFakeWSCHost(t *testing.T, host *fakeWSCHost) {
	t.Helper()
	prevServer, prevQuery := hostIsWindowsServer, runWSCQuery
	hostIsWindowsServer = func() bool {
		host.serverReads++
		return host.server
	}
	runWSCQuery = func() (string, error) {
		host.spawns++
		return host.queryOut, host.queryErr
	}
	t.Cleanup(func() { hostIsWindowsServer, runWSCQuery = prevServer, prevQuery })
}

// On Windows Server root/SecurityCenter2 does not exist. The query must not
// spawn, and the result must be ErrNotSupported — the error CollectStatus
// skips silently before falling through to the Defender probe — not a
// collection error that warns on every tick.
func TestWSCSkippedOnWindowsServer(t *testing.T) {
	host := &fakeWSCHost{server: true, queryErr: errors.New("wsc query failed: Invalid namespace")}
	installFakeWSCHost(t, host)

	for range 3 { // three security ticks
		products, err := getWindowsSecurityCenterProductsFor("windows")
		if !errors.Is(err, ErrNotSupported) {
			t.Fatalf("err = %v, want ErrNotSupported", err)
		}
		if products != nil {
			t.Fatalf("products = %v, want nil", products)
		}
	}
	if host.spawns != 0 {
		t.Fatalf("spawns = %d, want 0 on Windows Server", host.spawns)
	}
}

// Client Windows keeps the existing behaviour: one query per call, products
// parsed, and a real query failure surfaced as an error (not ErrNotSupported).
func TestWSCQueriedOnWorkstation(t *testing.T) {
	t.Run("products parsed", func(t *testing.T) {
		host := &fakeWSCHost{queryOut: `{"displayName":"Windows Defender","productState":397568,"timestamp":"Mon, 02 Nov 2026 10:00:00 GMT","instanceGuid":"{D68DDC3A-831F-4fae-9E44-DA132C1ACF46}"}` + "\r\n"}
		installFakeWSCHost(t, host)

		for i := 1; i <= 2; i++ {
			products, err := getWindowsSecurityCenterProductsFor("windows")
			if err != nil {
				t.Fatalf("err = %v", err)
			}
			if len(products) != 1 {
				t.Fatalf("products = %v, want 1", products)
			}
			p := products[0]
			if p.DisplayName != "Windows Defender" || p.Provider != "windows_defender" || !p.RealTimeProtection || !p.DefinitionsUpToDate || p.ProductStateHex != "0x061100" {
				t.Fatalf("product = %+v", p)
			}
			if host.spawns != i {
				t.Fatalf("spawns = %d after %d calls, want one per call", host.spawns, i)
			}
		}
	})

	t.Run("query failure surfaces", func(t *testing.T) {
		queryErr := errors.New("wsc query failed: exit status 1")
		host := &fakeWSCHost{queryErr: queryErr}
		installFakeWSCHost(t, host)

		products, err := getWindowsSecurityCenterProductsFor("windows")
		if !errors.Is(err, queryErr) || errors.Is(err, ErrNotSupported) {
			t.Fatalf("err = %v, want the query error", err)
		}
		if products != nil || host.spawns != 1 {
			t.Fatalf("products = %v, spawns = %d; want nil, 1", products, host.spawns)
		}
	})

	t.Run("no products registered", func(t *testing.T) {
		host := &fakeWSCHost{queryOut: "\r\n"}
		installFakeWSCHost(t, host)

		products, err := getWindowsSecurityCenterProductsFor("windows")
		if err != nil || products != nil {
			t.Fatalf("products = %v, err = %v; want nil, nil", products, err)
		}
	})
}

// Off Windows the query is never attempted and the product type is not read.
func TestWSCNotSupportedOffWindows(t *testing.T) {
	for _, goos := range []string{"darwin", "linux"} {
		host := &fakeWSCHost{}
		installFakeWSCHost(t, host)

		if _, err := getWindowsSecurityCenterProductsFor(goos); !errors.Is(err, ErrNotSupported) {
			t.Fatalf("%s: err = %v, want ErrNotSupported", goos, err)
		}
		if host.spawns != 0 || host.serverReads != 0 {
			t.Fatalf("%s: spawns = %d, serverReads = %d; want 0, 0", goos, host.spawns, host.serverReads)
		}
	}
}

func TestWindowsServerCheck(t *testing.T) {
	for _, tc := range []struct {
		name        string
		productType uint8
		want        bool
	}{
		{name: "workstation", productType: winProductWorkstation, want: false},
		{name: "domain controller", productType: winProductDomainController, want: true},
		{name: "server", productType: winProductServer, want: true},
		{name: "unknown reads as not server", productType: winProductUnknown, want: false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			reads := 0
			check := newWindowsServerCheck(func() uint8 {
				reads++
				return tc.productType
			})
			for range 3 {
				if got := check(); got != tc.want {
					t.Fatalf("isServer = %v, want %v", got, tc.want)
				}
			}
			if reads != 1 {
				t.Fatalf("product type read %d times, want once per process", reads)
			}
		})
	}
}
