package ech

import (
	"context"
	"errors"
	"net"
	"net/http"
	"sync/atomic"
	"testing"
	"time"
)

// The process-wide dialer must open TCP through a ctx-carried dial when one is
// present. netpolicy depends on this: its policy dialer (single resolution,
// address validation) has to be the TCP leg of every ECH-dialer handshake.
func TestShared_TCPDialHonoursContext(t *testing.T) {
	t.Cleanup(SetSharedForTest(nil))
	var called atomic.Bool
	sentinel := errors.New("ctx dial used")
	ctx := WithTCPDial(context.Background(), func(context.Context, string, string) (net.Conn, error) {
		called.Store(true)
		return nil, sentinel
	})
	_, err := Shared().opts.TCPDial(ctx, "tcp", "never-resolved.invalid:443")
	if !called.Load() || !errors.Is(err, sentinel) {
		t.Fatalf("shared TCPDial ignored the context dial: called=%v err=%v", called.Load(), err)
	}
}

func TestTCPDialHonouringContext_FallsBackWithoutOverride(t *testing.T) {
	var fallback atomic.Bool
	dial := TCPDialHonouringContext(func(context.Context, string, string) (net.Conn, error) {
		fallback.Store(true)
		return nil, errors.New("fallback")
	})
	_, _ = dial(context.Background(), "tcp", "x.invalid:443")
	if !fallback.Load() {
		t.Fatal("fallback not used when the context carries no dial")
	}
}

func TestDialTLSVia_OpensTCPThroughGivenDial(t *testing.T) {
	addr, pool := startTLSServer(t, []string{dialHost}, nil, http.HandlerFunc(func(http.ResponseWriter, *http.Request) {}))
	d := New(Options{
		TCPDial: TCPDialHonouringContext(func(context.Context, string, string) (net.Conn, error) {
			return nil, errors.New("fallback must not be used")
		}),
		Resolver:      NewResolver(nil, "http://127.0.0.1:1/dns-query"),
		LocalEnabled:  true,
		ServerEnabled: true,
	})
	var via atomic.Int32
	tcp := func(ctx context.Context, network, _ string) (net.Conn, error) {
		via.Add(1)
		return (&net.Dialer{Timeout: 5 * time.Second}).DialContext(ctx, network, addr)
	}
	conn, err := d.DialTLSVia(tcp, baseCfg(pool), []string{"http/1.1"})(context.Background(), "tcp", dialAddr)
	if err != nil {
		t.Fatalf("DialTLSVia: %v", err)
	}
	conn.Close()
	if via.Load() != 1 {
		t.Fatalf("given dial used %d times, want 1", via.Load())
	}
}

// A Dialer whose TCPDial ignores the context would open TCP on its own path
// (for netpolicy: around the SSRF checks). DialTLSVia must refuse that
// connection rather than hand it to the caller.
func TestDialTLSVia_FailsClosedWhenDialerIgnoresContext(t *testing.T) {
	addr, pool := startTLSServer(t, []string{dialHost}, nil, http.HandlerFunc(func(http.ResponseWriter, *http.Request) {}))
	d := New(Options{
		TCPDial: func(ctx context.Context, network, _ string) (net.Conn, error) {
			return (&net.Dialer{Timeout: 5 * time.Second}).DialContext(ctx, network, addr)
		},
		Resolver:      NewResolver(nil, "http://127.0.0.1:1/dns-query"),
		LocalEnabled:  true,
		ServerEnabled: true,
	})
	tcp := func(context.Context, string, string) (net.Conn, error) {
		t.Error("given dial unexpectedly used")
		return nil, errors.New("unexpected")
	}
	base := baseCfg(pool)
	conn, err := d.DialTLSVia(tcp, base, []string{"http/1.1"})(context.Background(), "tcp", dialAddr)
	if err == nil {
		conn.Close()
		t.Fatal("DialTLSVia returned a connection opened outside the given TCP dial")
	}
	if !errors.Is(err, ErrTCPDialBypassed) {
		t.Fatalf("err = %v, want ErrTCPDialBypassed", err)
	}
}
