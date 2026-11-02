//go:build darwin && !cgo

package yarac

import (
	"errors"
	"fmt"
	"unsafe"

	"golang.org/x/sys/unix"
)

// Shipped darwin agents are cgo builds (execmem_darwin.go). CGO_ENABLED=0
// darwin builds exist too: CI's darwin/amd64 compile check, `make
// build-yarac` (the API runs breeze-yarac on macOS dev boxes) and
// cross-arch dev pushes. Without cgo the csops status flags are still
// readable, so an unenforced binary — unsigned, ad-hoc or linker-signed —
// keeps the engine. The entitlements are not (SecTask needs cgo), so a binary
// whose signature enforces code signing fails closed.
func platformCodeSigning() (codeSigning, error) {
	var flags uint32
	// CS_OPS_STATUS = 0; pid 0 is the calling process.
	if _, _, errno := unix.Syscall6(unix.SYS_CSOPS, 0, 0, uintptr(unsafe.Pointer(&flags)), unsafe.Sizeof(flags), 0, 0); errno != 0 {
		return codeSigning{}, fmt.Errorf("csops(CS_OPS_STATUS) failed: %v", errno)
	}
	if flags&(csRuntime|csHard|csEnforcement) == 0 {
		return codeSigning{}, nil
	}
	return codeSigning{}, errors.New("this CGO_ENABLED=0 build enforces code signing but cannot read its entitlements")
}
