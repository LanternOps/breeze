//go:build linux

package gatewayproof

import (
	"context"
	"encoding/binary"
	"errors"
	"net"
	"net/netip"
	"os"
	"syscall"
	"testing"
	"time"
)

// TestProveLinux_WithoutRawCapability runs Prove as a user without CAP_NET_RAW
// (CI runs as a non-root user): the AF_PACKET socket is refused, so nothing is
// sent, and the refusal surfaces as EPERM rather than as ErrNoAnswer.
func TestProveLinux_WithoutRawCapability(t *testing.T) {
	if os.Geteuid() == 0 {
		t.Skip("running as root: the socket would open and a frame would be sent")
	}
	ifaces, err := net.Interfaces()
	if err != nil {
		t.Fatal(err)
	}
	var iface *net.Interface
	for i := range ifaces {
		f := ifaces[i]
		if f.Flags&net.FlagUp != 0 && f.Flags&net.FlagLoopback == 0 && len(f.HardwareAddr) == 6 {
			iface = &f
			break
		}
	}
	if iface == nil {
		t.Skip("no up, non-loopback Ethernet-like interface")
	}
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	_, err = Prove(ctx, Interface{Name: iface.Name, Index: uint32(iface.Index), Source: netip.MustParseAddr("192.168.1.57")},
		netip.MustParseAddr("192.168.1.1"))
	if !errors.Is(err, syscall.EPERM) || errors.Is(err, ErrNoAnswer) {
		t.Fatalf("err = %v, want EPERM and not ErrNoAnswer", err)
	}
}

func TestHtons(t *testing.T) {
	var b [2]byte
	binary.NativeEndian.PutUint16(b[:], htons(0x0806))
	if b != [2]byte{0x08, 0x06} {
		t.Fatalf("htons(0x0806) in memory = % x, want 08 06", b[:])
	}
}
