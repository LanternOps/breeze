//go:build darwin

package networkcontext

import (
	"context"
	"encoding/binary"
	"encoding/hex"
	"errors"
	"net"
	"net/netip"
	"os"
	"strings"
	"syscall"
	"testing"
	"time"
)

// RTM_GET replies captured on macOS 27 (arm64) with the lookup's own request
// and read with read(2). Every address and MAC is replaced with a synthetic
// value of the same length, and the pid is zeroed (routeReply patches it). The
// interface index is 15 in both.
var (
	// Lookup of 203.0.113.20: default route via 192.168.1.1 on en0, source 192.168.1.57.
	capturedOffLinkReply = []string{
		// rt_msghdr: msglen 164, RTM_VERSION 5, RTM_GET, index 15, flags 0x40010843, addrs DST|GATEWAY|NETMASK|IFP|IFA, seq 1.
		"a40005040f0000004308014037000000000000000100000000000000000000000000000000000000dc050000000000000000000000000000000000000000000000000000000000000c51020000000000000000000000000000000000",
		"10020000000000000000000000000000",         // DST 0.0.0.0
		"10020000c0a801010f00000000000000",         // GATEWAY 192.168.1.1
		"00000000",                                 // NETMASK (empty: default route)
		"14120f0006030600656e30a42bb011229c000000", // IFP en0, a4:2b:b0:11:22:9c
		"10020000c0a801390000000000000000",         // IFA 192.168.1.57
	}
	// Lookup of the gateway itself: on-link, so the gateway is a link-layer
	// address (here 02:00:00:00:00:00) and there is no next hop.
	capturedOnLinkReply = []string{
		// rt_msghdr: msglen 164, RTM_VERSION 5, RTM_GET, index 15, flags 0x15020445, addrs DST|GATEWAY|IFP|IFA, seq 1.
		"a40005040f0000004504021533000000000000000100000000000000000000000000000000000000dc050000000000001973026b00000000000000000000000000000000000000000dae2700b4050000000000000000000000000000",
		"10020000c0a801010000000000000000",         // DST 192.168.1.1
		"14120f0006000600020000000000000000000000", // GATEWAY link-layer 02:00:00:00:00:00
		"14120f0006030600656e30a42bb011229c000000", // IFP en0, a4:2b:b0:11:22:9c
		"10020000c0a801390000000000000000",         // IFA 192.168.1.57
	}
)

// routeReply decodes a captured reply and stamps it with pid.
func routeReply(t *testing.T, parts []string, pid int) []byte {
	t.Helper()
	b, e := hex.DecodeString(strings.Join(parts, ""))
	if e != nil {
		t.Fatal(e)
	}
	if got := int(binary.LittleEndian.Uint16(b[0:2])); got != len(b) {
		t.Fatalf("fixture msglen=%d, bytes=%d", got, len(b))
	}
	binary.LittleEndian.PutUint32(b[16:20], uint32(pid))
	return b
}

// stubRouteSocket replaces the routing-socket read for one test.
func stubRouteSocket(t *testing.T, read func(fd int, p []byte) (int, error)) {
	t.Helper()
	previous := readRouteSocket
	readRouteSocket = read
	t.Cleanup(func() { readRouteSocket = previous })
}

// replies returns a reader that hands out each reply once, then EAGAIN.
func replies(calls *int, messages ...[]byte) func(int, []byte) (int, error) {
	return func(_ int, p []byte) (int, error) {
		*calls++
		if len(messages) == 0 {
			time.Sleep(time.Millisecond)
			return -1, syscall.EAGAIN
		}
		n := copy(p, messages[0])
		messages = messages[1:]
		return n, nil
	}
}

func darwinLookup(destination string) RouteLookupRequest {
	return RouteLookupRequest{ContextKey: "darwin:default", Destination: netip.MustParseAddr(destination)}
}

func TestLookupDarwinRouteParsesCapturedReply(t *testing.T) {
	calls := 0
	// A reply for another process comes first and must be skipped.
	stubRouteSocket(t, replies(&calls, routeReply(t, capturedOffLinkReply, os.Getpid()+1), routeReply(t, capturedOffLinkReply, os.Getpid())))
	got, e := lookupDarwinRoute(context.Background(), darwinLookup("203.0.113.20"), map[int]string{15: "if-en0"})
	if e != nil {
		t.Fatal(e)
	}
	if got.ContextKey != "darwin:default" || got.InterfaceKey != "if-en0" || got.OSIndex != 15 || got.SourceAddress != "192.168.1.57" || got.Attribution != "observed" {
		t.Fatalf("selection = %+v", got)
	}
	if got.NextHop == nil || *got.NextHop != "192.168.1.1" {
		t.Fatalf("next hop = %v", got.NextHop)
	}
	if got.Zone != nil || got.LocalPrefixes != nil {
		t.Fatalf("selection = %+v", got)
	}
	if calls != 2 {
		t.Fatalf("reads = %d, want 2", calls)
	}
}

func TestLookupDarwinRouteOnLinkReplyHasNoNextHop(t *testing.T) {
	calls := 0
	stubRouteSocket(t, replies(&calls, routeReply(t, capturedOnLinkReply, os.Getpid())))
	got, e := lookupDarwinRoute(context.Background(), darwinLookup("192.168.1.1"), map[int]string{15: "if-en0"})
	if e != nil {
		t.Fatal(e)
	}
	if got.InterfaceKey != "if-en0" || got.SourceAddress != "192.168.1.57" || got.Attribution != "observed" {
		t.Fatalf("selection = %+v", got)
	}
	if got.NextHop != nil {
		t.Fatalf("link-layer gateway surfaced as next hop %q", *got.NextHop)
	}
}

func TestLookupDarwinRouteReturnsReadError(t *testing.T) {
	calls := 0
	stubRouteSocket(t, func(int, []byte) (int, error) { calls++; return -1, syscall.EBADF })
	_, e := lookupDarwinRoute(context.Background(), darwinLookup("203.0.113.20"), map[int]string{15: "if-en0"})
	if !errors.Is(e, syscall.EBADF) {
		t.Fatalf("error = %v, want EBADF", e)
	}
	if calls != 1 {
		t.Fatalf("reads = %d, want 1", calls)
	}
}

func TestLookupDarwinRouteRetriesEAGAINAndEINTRUntilDeadline(t *testing.T) {
	calls := 0
	stubRouteSocket(t, func(int, []byte) (int, error) {
		calls++
		time.Sleep(time.Millisecond) // stands in for SO_RCVTIMEO
		if calls%2 == 0 {
			return -1, syscall.EINTR
		}
		return -1, syscall.EAGAIN
	})
	started := time.Now()
	_, e := lookupDarwinRoute(context.Background(), darwinLookup("203.0.113.20"), map[int]string{15: "if-en0"})
	if !errors.Is(e, context.DeadlineExceeded) {
		t.Fatalf("error = %v, want deadline exceeded", e)
	}
	if elapsed := time.Since(started); elapsed < routeReplyDeadline || elapsed > routeReplyDeadline+8*time.Second {
		t.Fatalf("gave up after %v, want the %v deadline", elapsed, routeReplyDeadline)
	}
	if calls < 2 {
		t.Fatalf("reads = %d, want retries", calls)
	}
}

func TestLookupDarwinRouteStopsOnCancelledContext(t *testing.T) {
	calls := 0
	stubRouteSocket(t, replies(&calls))
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	_, e := lookupDarwinRoute(ctx, darwinLookup("203.0.113.20"), map[int]string{15: "if-en0"})
	if !errors.Is(e, context.Canceled) {
		t.Fatalf("error = %v, want cancelled", e)
	}
	if calls != 0 {
		t.Fatalf("reads = %d, want 0", calls)
	}
}

// The production read against the kernel's routing socket. The loopback route
// exists on every Mac, so this needs no network and no privileges. With
// recvfrom(2) it failed with EAFNOSUPPORT (#12484).
func TestLookupDarwinRouteReadsKernelReply(t *testing.T) {
	loopback, e := net.InterfaceByName("lo0")
	if e != nil {
		t.Skip("no lo0:", e)
	}
	got, e := lookupDarwinRoute(context.Background(), darwinLookup("127.0.0.1"), map[int]string{loopback.Index: "lo0"})
	if e != nil {
		t.Fatal(e)
	}
	if got.InterfaceKey != "lo0" || got.SourceAddress != "127.0.0.1" {
		t.Fatalf("selection = %+v", got)
	}
}

// Live lookup through the reader the agent uses. Opt in with
// NETWORKCONTEXT_ROUTE_LIVE=1 on a Mac with a default route.
func TestLiveDarwinRouteLookup(t *testing.T) {
	if os.Getenv("NETWORKCONTEXT_ROUTE_LIVE") != "1" {
		t.Skip("explicit opt-in required: NETWORKCONTEXT_ROUTE_LIVE=1")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	reader, ok := NewReader("live").(*DarwinReader)
	if !ok {
		t.Fatal("NewReader is not the Darwin reader")
	}
	got, e := reader.LookupRoute(ctx, darwinLookup("203.0.113.20"))
	if e != nil {
		t.Fatal(e)
	}
	if got.InterfaceKey == "" {
		t.Fatalf("empty interface: %+v", got)
	}
	t.Logf("interfaceKey=%s attribution=%s hasNextHop=%t hasSource=%t", got.InterfaceKey, got.Attribution, got.NextHop != nil, got.SourceAddress != "")
}
