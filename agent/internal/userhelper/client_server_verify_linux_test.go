//go:build linux

package userhelper

import (
	"errors"
	"os"
	"testing"

	"github.com/breeze-rmm/agent/internal/ipc"
)

// On Linux the default verifier refuses a broker that is not root. CI runs
// unprivileged, so a listener this test owns is exactly such a server.
func TestDialIPC_LinuxRefusesNonRootServer(t *testing.T) {
	if os.Getuid() == 0 {
		t.Skip("running as root: a self-owned listener is a root server")
	}
	ln, sock := listenShortUnix(t)
	go func() {
		c, err := ln.Accept()
		if err == nil {
			buf := make([]byte, 1)
			_, _ = c.Read(buf)
			_ = c.Close()
		}
	}()
	client := NewWithOptions(sock, ipc.HelperRoleUser, ipc.HelperBinaryUserHelper, "")
	conn, err := client.dialIPC()
	if conn != nil {
		_ = conn.Close()
		t.Fatal("dialIPC accepted a non-root broker")
	}
	if !errors.Is(err, ipc.ErrUnixServerNotRoot) {
		t.Fatalf("dialIPC err = %v, want ErrUnixServerNotRoot", err)
	}
}
