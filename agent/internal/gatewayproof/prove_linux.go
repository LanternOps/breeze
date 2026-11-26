//go:build linux

package gatewayproof

import (
	"context"
	"encoding/binary"
	"errors"
	"fmt"
	"net"
	"net/netip"
	"time"

	"golang.org/x/sys/unix"
)

// prove sends ARP requests on an AF_PACKET socket bound to iface.Index (L1).
// It needs CAP_NET_RAW; the agent's systemd unit runs as root, unsandboxed.
func prove(ctx context.Context, iface Interface, gateway netip.Addr) (net.HardwareAddr, error) {
	ni, err := net.InterfaceByIndex(int(iface.Index))
	if err != nil {
		return nil, fmt.Errorf("interface index %d: %w", iface.Index, err)
	}
	if len(ni.HardwareAddr) != 6 {
		return nil, fmt.Errorf("interface index %d has no 6-byte hardware address", iface.Index)
	}
	srcMAC := ni.HardwareAddr
	c, err := openPacketConn(int(iface.Index))
	if err != nil {
		return nil, err
	}
	defer func() { _ = c.Close() }()
	tracef(ctx, "mech=af_packet")
	return exchange(ctx, c, encodeRequest(srcMAC, iface.Source, gateway), func(frame []byte) (net.HardwareAddr, bool) {
		return decodeReply(frame, srcMAC, iface.Source, gateway)
	})
}

// packetConn is a frameConn over an AF_PACKET SOCK_RAW socket that receives
// ARP frames on one interface.
type packetConn struct {
	fd      int
	ifindex int
	buf     []byte
}

func openPacketConn(ifindex int) (*packetConn, error) {
	proto := htons(unix.ETH_P_ARP)
	fd, err := unix.Socket(unix.AF_PACKET, unix.SOCK_RAW|unix.SOCK_CLOEXEC, int(proto))
	if err != nil {
		return nil, fmt.Errorf("open AF_PACKET socket: %w", err)
	}
	if err := unix.Bind(fd, &unix.SockaddrLinklayer{Protocol: proto, Ifindex: ifindex}); err != nil {
		_ = unix.Close(fd)
		return nil, fmt.Errorf("bind AF_PACKET socket: %w", err)
	}
	return &packetConn{fd: fd, ifindex: ifindex, buf: make([]byte, 1514)}, nil
}

func (c *packetConn) WriteFrame(frame []byte) error {
	to := &unix.SockaddrLinklayer{
		Protocol: htons(unix.ETH_P_ARP),
		Ifindex:  c.ifindex,
		Halen:    6,
		Addr:     [8]byte{0xff, 0xff, 0xff, 0xff, 0xff, 0xff},
	}
	for {
		err := unix.Sendto(c.fd, frame, 0, to)
		if !errors.Is(err, unix.EINTR) {
			return err
		}
	}
}

// ReadFrame honours the frameConn contract: poll with a zero timeout still
// reports a frame that is already queued.
func (c *packetConn) ReadFrame(deadline time.Time) ([]byte, error) {
	for {
		wait := time.Until(deadline)
		ms := 0
		if wait > 0 {
			ms = int((wait + time.Millisecond - 1) / time.Millisecond) // round up: never wake early
		}
		fds := []unix.PollFd{{Fd: int32(c.fd), Events: unix.POLLIN}}
		n, err := unix.Poll(fds, ms)
		if errors.Is(err, unix.EINTR) {
			continue
		}
		if err != nil {
			return nil, fmt.Errorf("poll: %w", err)
		}
		if n == 0 {
			if time.Now().Before(deadline) {
				continue // woke early; wait out the rest
			}
			return nil, errReadTimeout
		}
		if fds[0].Revents&(unix.POLLERR|unix.POLLNVAL) != 0 {
			return nil, fmt.Errorf("poll: socket error (revents %#x)", fds[0].Revents)
		}
		m, _, err := unix.Recvfrom(c.fd, c.buf, unix.MSG_DONTWAIT)
		switch {
		case errors.Is(err, unix.EINTR), errors.Is(err, unix.EAGAIN):
			continue
		case err != nil:
			return nil, fmt.Errorf("recvfrom: %w", err)
		}
		return append([]byte(nil), c.buf[:m]...), nil
	}
}

func (c *packetConn) Close() error { return unix.Close(c.fd) }

// htons converts a host-order value to network order, as the AF_PACKET
// protocol field expects.
func htons(v uint16) uint16 {
	var b [2]byte
	binary.BigEndian.PutUint16(b[:], v)
	return binary.NativeEndian.Uint16(b[:])
}
