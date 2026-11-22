//go:build darwin

package gatewayproof

import (
	"context"
	"errors"
	"net"
	"net/netip"
)

func prove(ctx context.Context, iface Interface, gateway netip.Addr) (net.HardwareAddr, error) {
	return nil, errors.New("gatewayproof: not implemented")
}
