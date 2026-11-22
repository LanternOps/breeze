// Package gatewayproof obtains a layer-2 answer from the default gateway that
// was produced during the call: an entry that was only cached before the call
// never counts.
//
// Linux sends an ARP request on an AF_PACKET socket and macOS on a BPF device;
// both use the pure-Go frame codec and send-and-wait loop in this package's
// untagged files. Windows, where user-mode code cannot send a raw Ethernet
// frame without a driver, asks iphlpapi to resolve the neighbour. Every file
// builds with CGO_ENABLED=0.
package gatewayproof

import (
	"context"
	"errors"
	"fmt"
	"net"
	"net/netip"
	"time"
)

// Interface names the interface the proof is taken on.
//
// Name is used on macOS only (the BSD name for BIOCSETIF); Linux and Windows
// use Index. Source is the interface's IPv4 address, sent as the ARP sender.
type Interface struct {
	Name   string
	Index  uint32
	Source netip.Addr
}

// ErrNoAnswer is returned when the deadline passes without a matching answer
// from the gateway. It is the deadline outcome only: a caller that cancels gets
// context.Canceled, and a bad request or an OS error is a wrapped error.
var ErrNoAnswer = errors.New("gatewayproof: no answer from gateway")

// defaultTimeout applies when the caller's context has no deadline.
const defaultTimeout = time.Second

// resendInterval is how often the request is repeated while waiting.
const resendInterval = 250 * time.Millisecond

// errReadTimeout is returned by frameConn.ReadFrame when its deadline passes
// with no frame available.
var errReadTimeout = errors.New("gatewayproof: read timeout")

// proveImpl is the per-OS implementation; tests replace it.
var proveImpl = prove

// Prove obtains a layer-2 answer from gateway on the named interface during
// this call. An entry that was only cached before the call does not count.
//
// It uses the caller's deadline, or defaultTimeout when ctx has none. The
// result is the gateway's MAC; ErrNoAnswer when the deadline passes first;
// context.Canceled when the caller cancels; any other error wrapped with
// "gatewayproof:".
func Prove(ctx context.Context, iface Interface, gateway netip.Addr) (net.HardwareAddr, error) {
	if err := validate(iface, gateway); err != nil {
		return nil, err
	}
	if _, ok := ctx.Deadline(); !ok {
		var cancel context.CancelFunc
		ctx, cancel = context.WithTimeout(ctx, defaultTimeout)
		defer cancel()
	}
	mac, err := proveImpl(ctx, iface, gateway)
	if err == nil {
		return mac, nil
	}
	switch {
	case errors.Is(err, ErrNoAnswer):
		return nil, ErrNoAnswer
	case errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded):
		// Classify by the context, not by what the implementation returned.
		if errors.Is(ctx.Err(), context.Canceled) {
			return nil, context.Canceled
		}
		if ctx.Err() != nil {
			return nil, ErrNoAnswer
		}
	}
	return nil, fmt.Errorf("gatewayproof: %w", err)
}

func validate(iface Interface, gateway netip.Addr) error {
	switch {
	case !gateway.Is4() || gateway.IsUnspecified():
		return errors.New("gatewayproof: gateway is not an IPv4 address")
	case !iface.Source.Is4() || iface.Source.IsUnspecified():
		return errors.New("gatewayproof: source is not an IPv4 address")
	case iface.Index == 0:
		return errors.New("gatewayproof: interface index is 0")
	case gateway == iface.Source:
		return errors.New("gatewayproof: gateway equals source")
	}
	return nil
}
