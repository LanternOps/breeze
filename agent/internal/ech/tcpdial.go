package ech

import (
	"context"
	"crypto/tls"
	"errors"
	"net"
	"sync/atomic"
	"time"
)

// TCPDialFunc opens the TCP leg of a TLS dial.
type TCPDialFunc func(ctx context.Context, network, addr string) (net.Conn, error)

// ErrTCPDialBypassed is returned by DialTLSVia when the Dialer opened its TCP
// connection without the dial it was given (its TCPDial does not honour the
// context). The connection is closed, never returned.
var ErrTCPDialBypassed = errors.New("ech: dialer bypassed the required TCP dial")

type tcpDialKey struct{}

// WithTCPDial returns a context under which a Dialer built with
// TCPDialHonouringContext opens TCP through dial instead of its default.
func WithTCPDial(ctx context.Context, dial TCPDialFunc) context.Context {
	return context.WithValue(ctx, tcpDialKey{}, dial)
}

// TCPDialHonouringContext returns an Options.TCPDial that uses the dial carried
// by WithTCPDial when present and fallback otherwise (nil fallback: a
// net.Dialer with a 15 s timeout and 30 s keep-alive, the Dialer default).
func TCPDialHonouringContext(fallback TCPDialFunc) TCPDialFunc {
	if fallback == nil {
		nd := &net.Dialer{Timeout: 15 * time.Second, KeepAlive: 30 * time.Second}
		fallback = nd.DialContext
	}
	return func(ctx context.Context, network, addr string) (net.Conn, error) {
		if dial, ok := ctx.Value(tcpDialKey{}).(TCPDialFunc); ok && dial != nil {
			return dial(ctx, network, addr)
		}
		return fallback(ctx, network, addr)
	}
}

// DialTLSVia is DialTLS with every TCP connection opened by tcp, so a caller
// that owns the TCP leg (netpolicy: one validated resolution, no unsafe
// addresses) keeps it while sharing this Dialer's per-host ECH state. It fails
// closed: a connection the Dialer opened some other way is closed and
// ErrTCPDialBypassed returned.
func (d *Dialer) DialTLSVia(tcp TCPDialFunc, base *tls.Config, nextProtos []string) func(ctx context.Context, network, addr string) (net.Conn, error) {
	inner := d.DialTLS(base, nextProtos)
	return func(ctx context.Context, network, addr string) (net.Conn, error) {
		var used atomic.Bool
		ctx = WithTCPDial(ctx, func(ctx context.Context, network, addr string) (net.Conn, error) {
			used.Store(true)
			return tcp(ctx, network, addr)
		})
		conn, err := inner(ctx, network, addr)
		if err != nil {
			return nil, err
		}
		if !used.Load() {
			_ = conn.Close()
			return nil, ErrTCPDialBypassed
		}
		return conn, nil
	}
}
