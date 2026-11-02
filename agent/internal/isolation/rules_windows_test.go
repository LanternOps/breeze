//go:build windows

package isolation

import (
	"runtime"
	"testing"
	"unsafe"
)

func TestWindowsTCPRowABI(t *testing.T) {
	// DWORD-only structures have identical SDK offsets on all three targets.
	for _, arch := range []string{"amd64", "arm64", "386"} {
		if runtime.GOARCH != arch {
			continue
		}
		var row mibTCPRow
		if unsafe.Sizeof(row) != 20 || unsafe.Offsetof(row.State) != 0 || unsafe.Offsetof(row.LocalAddr) != 4 || unsafe.Offsetof(row.LocalPort) != 8 || unsafe.Offsetof(row.RemoteAddr) != 12 || unsafe.Offsetof(row.RemotePort) != 16 {
			t.Fatalf("%s MIB_TCPROW ABI: size=%d", arch, unsafe.Sizeof(row))
		}
		var owner mibTCPRowOwnerPID
		if unsafe.Sizeof(owner) != 24 || unsafe.Offsetof(owner.mibTCPRow) != 0 || unsafe.Offsetof(owner.OwnerPID) != 20 {
			t.Fatalf("%s MIB_TCPROW_OWNER_PID ABI: size=%d", arch, unsafe.Sizeof(owner))
		}
	}
}
