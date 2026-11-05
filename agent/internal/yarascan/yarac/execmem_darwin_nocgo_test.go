//go:build darwin && !cgo

package yarac

import "testing"

// A CGO_ENABLED=0 `go test` binary is linker-signed or unsigned: unenforced,
// so it must keep the engine even though it cannot read entitlements.
func TestPlatformCodeSigningNoCgoUnenforced(t *testing.T) {
	cs, err := platformCodeSigning()
	if err != nil {
		t.Fatalf("platformCodeSigning: %v", err)
	}
	if cs.enforced {
		t.Fatalf("unexpected enforced state: %+v", cs)
	}
}
