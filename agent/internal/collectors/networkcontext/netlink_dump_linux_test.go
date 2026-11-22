//go:build linux

package networkcontext

import (
	"bytes"
	"context"
	"encoding/binary"
	"errors"
	"net/netip"
	"syscall"
	"testing"
)

// netlinkDumpRoutePayload is an rtmsg plus RTA_DST, RTA_GATEWAY and RTA_OIF.
// Every payload has the same length, so two reads of n rows are the same size.
func netlinkDumpRoutePayload(dst, gateway netip.Addr, index uint32) []byte {
	p := make([]byte, 12)
	p[0] = syscall.AF_INET
	p[1] = 24
	p[4] = 254
	p[7] = 1
	p = appendLinuxAttr(p, 1, dst.AsSlice())
	p = appendLinuxAttr(p, 5, gateway.AsSlice())
	oif := make([]byte, 4)
	binary.NativeEndian.PutUint32(oif, index)
	return appendLinuxAttr(p, 4, oif)
}

func netlinkDumpMessage(typ uint16, payload []byte) []byte {
	m := make([]byte, syscall.NLMSG_HDRLEN, syscall.NLMSG_HDRLEN+len(payload))
	binary.NativeEndian.PutUint32(m, uint32(syscall.NLMSG_HDRLEN+len(payload)))
	binary.NativeEndian.PutUint16(m[4:], typ)
	binary.NativeEndian.PutUint16(m[6:], syscall.NLM_F_MULTI)
	binary.NativeEndian.PutUint32(m[8:], 1)
	return append(m, payload...)
}

func netlinkDumpDone() []byte { return netlinkDumpMessage(syscall.NLMSG_DONE, make([]byte, 4)) }

// netlinkDumpRows returns count route payloads; base offsets the last octet of
// both addresses so different reads carry different rows. Addresses stay in
// 198.51.100.0/24 and 203.0.113.0/24 (documentation ranges).
func netlinkDumpRows(base byte, count int) [][]byte {
	out := make([][]byte, count)
	for i := range out {
		dst := netip.AddrFrom4([4]byte{198, 51, 100, base + byte(i)})
		gw := netip.AddrFrom4([4]byte{203, 0, 113, base + byte(i)})
		out[i] = netlinkDumpRoutePayload(dst, gw, uint32(2+i))
	}
	return out
}

// fakeNetlinkReads fills the receiver's buffer with each read in turn, as
// Recvfrom does, from a kernel sender (pid 0).
func fakeNetlinkReads(t *testing.T, reads [][]byte) func([]byte) (int, syscall.Sockaddr, error) {
	next := 0
	return func(buf []byte) (int, syscall.Sockaddr, error) {
		if next >= len(reads) {
			t.Fatalf("receive loop asked for read %d after the dump ended", next+1)
		}
		n := copy(buf, reads[next])
		next++
		return n, &syscall.SockaddrNetlink{Family: syscall.AF_NETLINK}, nil
	}
}

func concatNetlinkMessages(payloads [][]byte, tail ...[]byte) []byte {
	var out []byte
	for _, p := range payloads {
		out = append(out, netlinkDumpMessage(syscall.RTM_NEWROUTE, p)...)
	}
	for _, m := range tail {
		out = append(out, m...)
	}
	return out
}

func assertNetlinkDumpRows(t *testing.T, got []syscall.NetlinkMessage, want [][]byte, readOf func(int) (int, int)) {
	t.Helper()
	if len(got) != len(want) {
		t.Fatalf("got %d messages, want %d", len(got), len(want))
	}
	for i := range want {
		read, row := readOf(i)
		if got[i].Header.Type != syscall.RTM_NEWROUTE || got[i].Header.Seq != 1 {
			t.Errorf("read %d row %d: header %+v", read, row, got[i].Header)
		}
		if !bytes.Equal(got[i].Data, want[i]) {
			t.Errorf("read %d row %d: payload changed after later reads\n got  %x\n want %x", read, row, got[i].Data, want[i])
		}
	}
}

// #12505: a dump arrives as several reads into one buffer. Messages kept from
// an earlier read must not change when a later read reuses that buffer.
func TestReceiveNetlinkDumpKeepsEveryReadIntact(t *testing.T) {
	const perRead = 8
	first, second := netlinkDumpRows(0, perRead), netlinkDumpRows(100, perRead)
	reads := [][]byte{concatNetlinkMessages(first), concatNetlinkMessages(second), netlinkDumpDone()}
	if len(reads[0]) != len(reads[1]) {
		t.Fatalf("fixture: reads are %d and %d bytes, want equal", len(reads[0]), len(reads[1]))
	}
	got, err := receiveNetlinkDump(context.Background(), fakeNetlinkReads(t, reads))
	if err != nil {
		t.Fatal(err)
	}
	// Expected bytes are rebuilt, not shared with the slices the fake copied from.
	want := append(netlinkDumpRows(0, perRead), netlinkDumpRows(100, perRead)...)
	assertNetlinkDumpRows(t, got, want, func(i int) (int, int) { return 1 + i/perRead, i % perRead })
}

func TestReceiveNetlinkDumpRowsAndDoneInOneRead(t *testing.T) {
	const rows = 5
	reads := [][]byte{concatNetlinkMessages(netlinkDumpRows(10, rows), netlinkDumpDone())}
	got, err := receiveNetlinkDump(context.Background(), fakeNetlinkReads(t, reads))
	if err != nil {
		t.Fatal(err)
	}
	assertNetlinkDumpRows(t, got, netlinkDumpRows(10, rows), func(i int) (int, int) { return 1, i })
}

// #12505, live: the route the kernel selects for a documentation address must
// also be in the route dump. LookupRoute does not report the matched prefix, so
// this accepts any IPv4 route that covers the destination (normally 0.0.0.0/0)
// with the same gateway on the same interface. Read-only; netlink only.
func TestLinuxRoutesContainLookedUpGatewayRoute(t *testing.T) {
	ctx := context.Background()
	r, ok := NewReader("epoch").(*LinuxReader)
	if !ok {
		t.Fatal("NewReader is not a LinuxReader")
	}
	manifest, err := r.Contexts(ctx)
	if err != nil || len(manifest.Contexts) != 1 {
		t.Fatal(manifest, err)
	}
	scope := manifest.Contexts[0]
	destination := netip.MustParseAddr("203.0.113.20")
	sel, err := r.LookupRoute(ctx, RouteLookupRequest{Destination: destination, ContextKey: scope.ContextKey})
	if errors.Is(err, syscall.ENETUNREACH) || errors.Is(err, syscall.EHOSTUNREACH) {
		t.Skipf("host has no route to %s: %v", destination, err)
	}
	if err != nil {
		t.Fatalf("LookupRoute: %v", err)
	}
	if sel.NextHop == nil {
		t.Skipf("route to %s has no gateway (on-link or no default route)", destination)
	}
	routes, err := r.Routes(ctx, Context{ContextKey: scope.ContextKey, Families: []string{"ipv4"}})
	if err != nil {
		t.Fatalf("Routes: %v", err)
	}
	for _, row := range routes.Rows {
		prefix, e := netip.ParsePrefix(row.DestinationPrefix)
		if e != nil || !prefix.Contains(destination) {
			continue
		}
		for _, hop := range row.NextHops {
			if hop.Address != nil && *hop.Address == *sel.NextHop && hop.InterfaceKey != nil && *hop.InterfaceKey == sel.InterfaceKey {
				return
			}
		}
	}
	covering := 0
	for _, row := range routes.Rows {
		if p, e := netip.ParsePrefix(row.DestinationPrefix); e == nil && p.Contains(destination) {
			covering++
		}
	}
	// Addresses are not printed: CI logs are public.
	t.Fatalf("LookupRoute selected a gateway route for %s, but Routes (%d IPv4 rows, %d covering it) has no route with that gateway on that interface", destination, len(routes.Rows), covering)
}
