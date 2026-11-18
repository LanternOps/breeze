//go:build !windows

package authenticode

import (
	"errors"
	"testing"
)

// Off Windows nothing can be verified, so both entry points must refuse. A nil
// here would read as "this binary is trusted" to any cross-platform caller.
func TestVerifyIsUnsupportedOffWindows(t *testing.T) {
	if _, err := Verify("/bin/sh"); !errors.Is(err, ErrUnsupported) {
		t.Fatalf("Verify err = %v, want ErrUnsupported", err)
	}
	if err := VerifyChain("/bin/sh"); !errors.Is(err, ErrUnsupported) {
		t.Fatalf("VerifyChain err = %v, want ErrUnsupported", err)
	}
}
