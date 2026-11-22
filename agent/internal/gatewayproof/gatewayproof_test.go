package gatewayproof

import (
	"context"
	"errors"
	"net"
	"net/netip"
	"testing"
	"time"
)

func netip192(last byte) netip.Addr { return netip.AddrFrom4([4]byte{192, 168, 1, last}) }

// stubProve swaps the per-OS implementation for the duration of a test.
func stubProve(t *testing.T, f func(context.Context, Interface, netip.Addr) (net.HardwareAddr, error)) *int {
	t.Helper()
	calls := 0
	old := proveImpl
	proveImpl = func(ctx context.Context, iface Interface, gateway netip.Addr) (net.HardwareAddr, error) {
		calls++
		return f(ctx, iface, gateway)
	}
	t.Cleanup(func() { proveImpl = old })
	return &calls
}

var goodIface = Interface{Name: "en0", Index: 4, Source: src}

func TestProve_RejectsBadRequest(t *testing.T) {
	calls := stubProve(t, func(context.Context, Interface, netip.Addr) (net.HardwareAddr, error) {
		t.Fatal("prove reached for a bad request")
		return nil, nil
	})
	for name, tc := range map[string]struct {
		iface   Interface
		gateway netip.Addr
	}{
		"IPv6 gateway":        {goodIface, netip.MustParseAddr("fe80::1")},
		"4in6 gateway":        {goodIface, netip.MustParseAddr("::ffff:192.168.1.1")},
		"invalid gateway":     {goodIface, netip.Addr{}},
		"unspecified gateway": {goodIface, netip.IPv4Unspecified()},
		"zero Index":          {Interface{Name: "en0", Source: src}, gw},
		"invalid source":      {Interface{Name: "en0", Index: 4}, gw},
		"IPv6 source":         {Interface{Name: "en0", Index: 4, Source: netip.MustParseAddr("fe80::57")}, gw},
		"gateway == source":   {goodIface, src},
	} {
		start := time.Now()
		_, err := Prove(context.Background(), tc.iface, tc.gateway)
		if err == nil || errors.Is(err, ErrNoAnswer) {
			t.Errorf("%s: err = %v, want a request error that is not ErrNoAnswer", name, err)
		}
		// The plan says under 10 ms; 50 ms leaves room for a coarse Windows clock
		// tick under -race. calls == 0 below is what proves nothing was opened.
		if d := time.Since(start); d >= 50*time.Millisecond {
			t.Errorf("%s: took %v, want < 50ms", name, d)
		}
	}
	if *calls != 0 {
		t.Fatalf("prove called %d times", *calls)
	}
}

func TestProve_DefaultTimeout(t *testing.T) {
	stubProve(t, func(ctx context.Context, _ Interface, _ netip.Addr) (net.HardwareAddr, error) {
		if _, ok := ctx.Deadline(); !ok {
			t.Error("prove got a context without a deadline")
		}
		<-ctx.Done()
		return nil, ctx.Err()
	})
	start := time.Now()
	_, err := Prove(context.Background(), goodIface, gw)
	d := time.Since(start)
	if !errors.Is(err, ErrNoAnswer) {
		t.Fatalf("err = %v, want ErrNoAnswer", err)
	}
	if d < defaultTimeout-100*time.Millisecond || d > defaultTimeout+100*time.Millisecond {
		t.Fatalf("returned after %v, want %v ± 100ms", d, defaultTimeout)
	}
}

func TestProve_KeepsCallerDeadline(t *testing.T) {
	stubProve(t, func(ctx context.Context, _ Interface, _ netip.Addr) (net.HardwareAddr, error) {
		<-ctx.Done()
		return nil, ErrNoAnswer
	})
	ctx, cancel := context.WithTimeout(context.Background(), 150*time.Millisecond)
	defer cancel()
	start := time.Now()
	if _, err := Prove(ctx, goodIface, gw); !errors.Is(err, ErrNoAnswer) {
		t.Fatalf("err = %v, want ErrNoAnswer", err)
	}
	if d := time.Since(start); d > 600*time.Millisecond {
		t.Fatalf("returned after %v; the caller's 150ms deadline was not used", d)
	}
}

func TestProve_ResultMapping(t *testing.T) {
	boom := errors.New("boom")
	for name, tc := range map[string]struct {
		cancelFirst bool
		ret         error
		want        func(error) bool
	}{
		"ErrNoAnswer passes through": {ret: ErrNoAnswer, want: func(e error) bool { return e == ErrNoAnswer }},
		"caller cancel is context.Canceled": {cancelFirst: true, ret: context.Canceled,
			want: func(e error) bool { return errors.Is(e, context.Canceled) && !errors.Is(e, ErrNoAnswer) }},
		"OS error is wrapped": {ret: boom, want: func(e error) bool {
			return errors.Is(e, boom) && e != boom && !errors.Is(e, ErrNoAnswer) && e.Error() == "gatewayproof: boom"
		}},
	} {
		stubProve(t, func(context.Context, Interface, netip.Addr) (net.HardwareAddr, error) { return nil, tc.ret })
		ctx, cancel := context.WithTimeout(context.Background(), time.Second)
		if tc.cancelFirst {
			cancel()
		}
		_, err := Prove(ctx, goodIface, gw)
		cancel()
		if !tc.want(err) {
			t.Errorf("%s: err = %v", name, err)
		}
	}
}

func TestProve_ReturnsMAC(t *testing.T) {
	stubProve(t, func(context.Context, Interface, netip.Addr) (net.HardwareAddr, error) { return gwMAC, nil })
	mac, err := Prove(context.Background(), goodIface, gw)
	if err != nil || mac.String() != gwMAC.String() {
		t.Fatalf("Prove = %v, %v", mac, err)
	}
}
