//go:build windows

package sessionbroker

import (
	"os"
	"testing"
)

func TestOpenOwnedPeerProcessRetainsKernelBoundHandle(t *testing.T) {
	pid := uint32(os.Getpid())
	process, err := openOwnedPeerProcess(pid)
	if err != nil {
		t.Fatal(err)
	}
	if process.ProcessID() != pid {
		t.Fatalf("process PID = %d, want %d", process.ProcessID(), pid)
	}
	alive, err := process.Alive()
	if err != nil {
		t.Fatal(err)
	}
	if !alive {
		t.Fatal("current process handle reported non-live")
	}
	if err := process.Close(); err != nil {
		t.Fatal(err)
	}
	if err := process.Close(); err != nil {
		t.Fatalf("second Close: %v", err)
	}
}
