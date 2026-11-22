//go:build darwin

package gatewayproof

import (
	"context"
	"errors"
	"fmt"
	"net"
	"net/netip"
	"os"
	"time"
	"unsafe"

	"golang.org/x/net/bpf"
	"golang.org/x/sys/unix"
)

// bpfReadTimeout is the BIOCSRTIMEOUT slice used when Go's poller does not
// accept the device: a blocking read returns at most this late.
const bpfReadTimeout = 20 * time.Millisecond

// prove sends ARP requests through a BPF device attached to iface.Name (M1).
// It needs root; the agent's LaunchDaemon runs as root.
func prove(ctx context.Context, iface Interface, gateway netip.Addr) (net.HardwareAddr, error) {
	ifr, err := ifreqName(iface.Name)
	if err != nil {
		return nil, err
	}
	ni, err := net.InterfaceByName(iface.Name)
	if err != nil {
		return nil, fmt.Errorf("interface lookup: %w", err)
	}
	if len(ni.HardwareAddr) != 6 {
		return nil, errors.New("interface has no 6-byte hardware address")
	}
	srcMAC := ni.HardwareAddr
	c, err := openBPF(ctx, ifr)
	if err != nil {
		return nil, err
	}
	defer func() { _ = c.Close() }()
	return exchange(ctx, c, encodeRequest(srcMAC, iface.Source, gateway), func(frame []byte) (net.HardwareAddr, bool) {
		return decodeReply(frame, srcMAC, iface.Source, gateway)
	})
}

// openBPF opens the first free /dev/bpfN and configures it for one interface:
// BIOCSETIF, BIOCIMMEDIATE 1, BIOCSHDRCMPLT 1, BIOCSSEESENT 0, the ARP-reply
// filter, and a read timeout.
func openBPF(ctx context.Context, ifr [32]byte) (*bpfConn, error) {
	fd, dev, err := openFreeBPF()
	if err != nil {
		return nil, err
	}
	ok := false
	defer func() {
		if !ok {
			_ = unix.Close(fd)
		}
	}()
	tracef(ctx, "mech=bpf")
	// BIOCSETIF takes a pointer to a 32-byte struct ifreq; x/sys has no darwin
	// ifreq helper, so it is issued as a raw ioctl (no cgo).
	if err := ioctlPtr(fd, unix.BIOCSETIF, unsafe.Pointer(&ifr)); err != nil {
		tracef(ctx, "biocsetif=%d", errnoOf(err))
		return nil, fmt.Errorf("%s BIOCSETIF: %w", dev, err)
	}
	for _, opt := range []struct {
		name string
		req  uint
		val  int
	}{
		{"BIOCIMMEDIATE", unix.BIOCIMMEDIATE, 1},
		{"BIOCSHDRCMPLT", unix.BIOCSHDRCMPLT, 1},
		{"BIOCSSEESENT", unix.BIOCSSEESENT, 0},
	} {
		// These take a pointer to a u_int.
		if err := unix.IoctlSetPointerInt(fd, opt.req, opt.val); err != nil {
			return nil, fmt.Errorf("%s %s: %w", dev, opt.name, err)
		}
	}
	if err := setFilter(fd, arpReplyFilter()); err != nil {
		return nil, fmt.Errorf("%s BIOCSETF: %w", dev, err)
	}
	blen, err := unix.IoctlGetInt(fd, unix.BIOCGBLEN)
	if err != nil {
		return nil, fmt.Errorf("%s BIOCGBLEN: %w", dev, err)
	}
	if blen <= 0 || blen > 1<<24 {
		return nil, fmt.Errorf("%s BIOCGBLEN returned %d", dev, blen)
	}
	tv := unix.NsecToTimeval(bpfReadTimeout.Nanoseconds())
	if err := ioctlPtr(fd, unix.BIOCSRTIMEOUT, unsafe.Pointer(&tv)); err != nil {
		return nil, fmt.Errorf("%s BIOCSRTIMEOUT: %w", dev, err)
	}
	// os.NewFile puts a non-blocking descriptor into Go's poller when kqueue
	// accepts it. Whether it accepts a BPF device is a lab unknown; when it
	// does not, read in blocking mode with the BIOCSRTIMEOUT above.
	f := os.NewFile(uintptr(fd), dev)
	ok = true
	c := newBPFConn(f, blen)
	if c.pollable {
		tracef(ctx, "bpf_wait=deadline")
	} else {
		if err := unix.SetNonblock(fd, false); err != nil {
			_ = c.Close()
			return nil, fmt.Errorf("%s clear O_NONBLOCK: %w", dev, err)
		}
		tracef(ctx, "bpf_wait=rtimeout")
	}
	return c, nil
}

// openFreeBPF opens /dev/bpf0 upward to /dev/bpf255, skipping devices in use.
func openFreeBPF() (int, string, error) {
	var last error
	for i := range 256 {
		dev := fmt.Sprintf("/dev/bpf%d", i)
		fd, err := unix.Open(dev, unix.O_RDWR|unix.O_NONBLOCK|unix.O_CLOEXEC, 0)
		if err == nil {
			return fd, dev, nil
		}
		if errors.Is(err, unix.EBUSY) {
			last = err
			continue
		}
		return -1, "", fmt.Errorf("open %s: %w", dev, err)
	}
	return -1, "", fmt.Errorf("no free /dev/bpf device: %w", last)
}

func setFilter(fd int, prog []bpf.Instruction) error {
	raw, err := bpf.Assemble(prog)
	if err != nil {
		return err
	}
	insns := make([]unix.BpfInsn, len(raw))
	for i, r := range raw {
		insns[i] = unix.BpfInsn{Code: r.Op, Jt: r.Jt, Jf: r.Jf, K: r.K}
	}
	p := unix.BpfProgram{Len: uint32(len(insns)), Insns: &insns[0]}
	return ioctlPtr(fd, unix.BIOCSETF, unsafe.Pointer(&p))
}

// ioctlPtr issues ioctl(fd, req, arg) with unix.Syscall, which on darwin is a
// direct kernel trap (not a libSystem call) and needs no cgo. Whether that
// works for BIOCSETIF from the agent's LaunchDaemon is the plan's first M1
// unknown; the lab records it.
//
// x/sys/unix keeps its libSystem ioctlPtr unexported, and the std syscall
// package's libSystem BPF helpers (SetBpfInterface, SetBpf, SetBpfTimeout)
// are deprecated, so they are not used here.
func ioctlPtr(fd int, req uint, arg unsafe.Pointer) error {
	for {
		//nolint:staticcheck // SA1019: the plan's M1 candidate; see the comment above.
		_, _, errno := unix.Syscall(unix.SYS_IOCTL, uintptr(fd), uintptr(req), uintptr(arg))
		switch errno {
		case 0:
			return nil
		case unix.EINTR:
			continue
		}
		return errno
	}
}

func errnoOf(err error) int {
	var e unix.Errno
	if errors.As(err, &e) {
		return int(e)
	}
	return -1
}
