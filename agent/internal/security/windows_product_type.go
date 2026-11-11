package security

import "sync"

// Windows product type (#10907).
//
// Some Windows interfaces exist only on client SKUs. root/SecurityCenter2 is
// one: on every Windows Server SKU (Server Core and domain controllers
// included) the namespace is absent, so querying it fails on every security
// tick, forever. Probes for those interfaces check hostIsWindowsServer and
// skip their spawn on Server.

// Values of OSVERSIONINFOEXW.wProductType.
const (
	winProductUnknown          uint8 = 0
	winProductWorkstation      uint8 = 1 // VER_NT_WORKSTATION
	winProductDomainController uint8 = 2 // VER_NT_DOMAIN_CONTROLLER
	winProductServer           uint8 = 3 // VER_NT_SERVER
)

// newWindowsServerCheck returns a check that reads the product type once and
// caches the answer for the life of the process: the product type cannot
// change without an OS reinstall. An unknown product type (non-Windows, or a
// value Windows never returns) reads as "not Server", so callers keep running
// their probes rather than hiding anything.
func newWindowsServerCheck(readProductType func() uint8) func() bool {
	return sync.OnceValue(func() bool {
		pt := readProductType()
		isServer := pt == winProductServer || pt == winProductDomainController
		if isServer {
			log.Debug("Windows Server detected; skipping client-only Windows Security Center probe",
				"productType", pt)
		}
		return isServer
	})
}

// hostIsWindowsServer reports whether this host runs a Windows Server SKU.
// A variable so tests can stand in a fake host.
var hostIsWindowsServer = newWindowsServerCheck(readWindowsProductType)
