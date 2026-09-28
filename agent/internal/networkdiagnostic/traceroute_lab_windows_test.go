//go:build windows

package networkdiagnostic

// Lab-gated native Windows proof of the ICMP-helper trace transport (topology
// M3 W04). It sends real ICMP echo requests, so it only runs when
// BREEZE_LAB_TRACE is set; CI's Windows job skips it.
//
//	BREEZE_LAB_TRACE=1                     enable
//	BREEZE_LAB_TRACE_V6_TARGET=<ipv6>      optional IPv6 destination; default is
//	                                       2606:4700:4700::1111 when the host has a
//	                                       global (non-ULA) IPv6 address, else skipped
//	BREEZE_LAB_TRACE_UNREACHABLE=<ipv4>    optional unused on-link address, observed only
//
// Every case runs the production path: networkcontext.NewReader → NativeIO →
// sealed trace_route command → Run → executeTrace → windowsICMPTraceTransport.

import (
	"context"
	"encoding/hex"
	"encoding/json"
	"net"
	"net/netip"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/breeze-rmm/agent/internal/collectors/networkcontext"
)

func labTraceEnabled(t *testing.T) {
	t.Helper()
	if os.Getenv("BREEZE_LAB_TRACE") == "" {
		t.Skip("lab-only: set BREEZE_LAB_TRACE=1 on a real Windows host to send live ICMP probes")
	}
}

type labHost struct {
	reader     networkcontext.Reader
	io         *NativeIO
	contextKey string
}

func newLabHost(t *testing.T) labHost {
	t.Helper()
	reader := networkcontext.NewReader("lab")
	manifest, e := reader.Contexts(context.Background())
	if e != nil || len(manifest.Contexts) != 1 {
		t.Fatalf("contexts: %#v %v", manifest, e)
	}
	key := manifest.Contexts[0].ContextKey
	return labHost{reader: reader, io: &NativeIO{Reader: reader, Origin: Origin{ContextKey: key}}, contextKey: key}
}

func (h labHost) route(t *testing.T, destination netip.Addr) networkcontext.RouteSelection {
	t.Helper()
	route, e := h.io.LookupRoute(context.Background(), networkcontext.RouteLookupRequest{ContextKey: h.contextKey, Destination: destination})
	if e != nil {
		t.Fatalf("route lookup for %s: %v", destination, e)
	}
	return route
}

// labTrace runs one sealed trace_route command through the production runner
// and returns the trace step.
func labTrace(t *testing.T, h labHost, destination netip.Addr, maxHops, probes int) StepResult {
	t.Helper()
	route := h.route(t, destination)
	family := "ipv4"
	if destination.Is6() {
		family = "ipv6"
	}
	command := traceCommand(t, func(p *Plan) {
		p.Family = family
		p.Origin.ContextKey = h.contextKey
		p.Origin.InterfaceKey = ptr(route.InterfaceKey)
		p.Destinations[0].Target.Definition.Host = destination.String()
		p.Steps[1].MaxHops, p.Steps[1].ProbesPerHop = maxHops, probes
	})
	journal, e := OpenJournal(filepath.Join(t.TempDir(), "journal"))
	if e != nil {
		t.Fatal(e)
	}
	// Registered after TempDir, so it runs first: Windows cannot remove a held lock file.
	t.Cleanup(func() { _ = journal.Close() })
	io := &NativeIO{Reader: h.reader, Origin: command.Plan.Origin}
	started := time.Now()
	result := Run(context.Background(), command, journal, io)
	step := stepByID(result, traceStepID)
	encoded, _ := json.MarshalIndent(step, "", "  ")
	t.Logf("trace %s via %s (src %s, nexthop %s) in %s:\n%s", destination, route.InterfaceKey, route.SourceAddress, stringPtr(route.NextHop), time.Since(started).Round(time.Millisecond), encoded)
	if step.Details.Trace == nil {
		t.Fatalf("no trace details: state=%s reason=%s", step.State, stringPtr(step.Reason))
	}
	return step
}

// assertTruthfulHops holds for every trace: bounded, valid responders only on
// answered hops, null address + null RTT on timeouts, no invented destination.
func assertTruthfulHops(t *testing.T, step StepResult, destination netip.Addr, maxHops, probes int) {
	t.Helper()
	trace := step.Details.Trace
	if len(trace.Hops) > maxHops*probes || trace.MaxHops != maxHops || trace.ProbesPerHop != probes || trace.Protocol != "icmp_echo" {
		t.Fatalf("trace envelope out of bounds: %#v", trace)
	}
	for _, hop := range trace.Hops {
		if hop.TTL < 1 || hop.TTL > maxHops || hop.Attempt < 1 || hop.Attempt > probes {
			t.Fatalf("hop index out of bounds: %#v", hop)
		}
		switch hop.Outcome {
		case "reply", "unreachable":
			if hop.Address == nil || hop.RTTMS == nil {
				t.Fatalf("answered hop without responder/RTT: %#v", hop)
			}
			responder, e := netip.ParseAddr(*hop.Address)
			if e != nil || responder.IsUnspecified() || responder.Is4() != destination.Is4() {
				t.Fatalf("responder %q is not a valid %s address", *hop.Address, destination)
			}
			if *hop.RTTMS <= 0 || *hop.RTTMS > 1000 {
				t.Fatalf("RTT %v ms outside (0, 1000]", *hop.RTTMS)
			}
			if responder == destination && hop.Outcome == "reply" && !trace.DestinationReached {
				t.Fatalf("destination answered but not confirmed: %#v", hop)
			}
		case "timeout":
			if hop.Address != nil || hop.RTTMS != nil || hop.AttributionQuality != "unknown" {
				t.Fatalf("timeout hop carries evidence: %#v", hop)
			}
		default:
			t.Fatalf("unexpected hop outcome %q", hop.Outcome)
		}
	}
}

func answered(step StepResult) int {
	n := 0
	for _, hop := range step.Details.Trace.Hops {
		if hop.Address != nil {
			n++
		}
	}
	return n
}

func TestLabWindowsTraceCapability(t *testing.T) {
	labTraceEnabled(t)
	if !TraceSupported() {
		t.Fatal("TraceSupported() = false on a real Windows host")
	}
	transport, e := (&NativeIO{}).TraceTransport()
	if e != nil || transport == nil {
		t.Fatalf("TraceTransport: %v %v", transport, e)
	}
}

// TestLabWindowsICMPReplyLayout dumps the raw reply buffers so the documented
// ipexport.h offsets can be checked against what the OS actually wrote.
func TestLabWindowsICMPReplyLayout(t *testing.T) {
	labTraceEnabled(t)
	h := newLabHost(t)
	v4 := netip.MustParseAddr("1.1.1.1")
	route := h.route(t, v4)
	source := SourceBinding{Address: netip.MustParseAddr(route.SourceAddress), OSIndex: route.OSIndex}
	for _, ttl := range []uint8{1, 64} {
		buffer := make([]byte, icmpReplyBufferBytes)
		responder, status, rtt, e := sendEcho4(v4, source, &ipOptionInformation{TTL: ttl}, make([]byte, 32), buffer, time.Second)
		t.Logf("v4 ttl=%d responder=%s status=%d rtt=%s err=%v raw[0:40]=%s", ttl, responder, status, rtt, e, hex.EncodeToString(buffer[:40]))
		if e != nil {
			t.Fatal(e)
		}
		want := map[uint8]uint32{1: ipTTLExpiredTransit, 64: ipSuccess}[ttl]
		if status != want {
			t.Fatalf("ttl %d: status %d, want %d", ttl, status, want)
		}
		if ttl == 64 && responder != v4 {
			t.Fatalf("echo reply responder %s, want %s", responder, v4)
		}
		if ttl == 1 && (route.NextHop == nil || responder.String() != *route.NextHop) {
			t.Fatalf("ttl 1 responder %s, want the next hop %s", responder, stringPtr(route.NextHop))
		}
	}
	v6 := labV6Target(t)
	if !v6.IsValid() {
		t.Log("IPv6 reply layout: SKIPPED (no IPv6 target on this host)")
		return
	}
	route = h.route(t, v6)
	source = SourceBinding{Address: netip.MustParseAddr(route.SourceAddress), OSIndex: route.OSIndex}
	buffer := make([]byte, icmpReplyBufferBytes)
	responder, status, rtt, e := sendEcho6(v6, source, &ipOptionInformation{TTL: 64}, make([]byte, 32), buffer, time.Second)
	t.Logf("v6 hop-limit=64 responder=%s status=%d rtt=%s err=%v raw[0:40]=%s", responder, status, rtt, e, hex.EncodeToString(buffer[:40]))
	if e != nil || status != ipSuccess || responder != v6 {
		t.Fatalf("IPv6 echo reply decode: responder=%s status=%d err=%v, want %s/0", responder, status, e, v6)
	}
}

func labV6Target(t *testing.T) netip.Addr {
	t.Helper()
	if raw := os.Getenv("BREEZE_LAB_TRACE_V6_TARGET"); raw != "" {
		return netip.MustParseAddr(raw)
	}
	addrs, _ := net.InterfaceAddrs()
	for _, a := range addrs {
		if prefix, e := netip.ParsePrefix(a.String()); e == nil {
			ip := prefix.Addr()
			if ip.Is6() && !ip.Is4In6() && ip.IsGlobalUnicast() && !ip.IsPrivate() {
				return netip.MustParseAddr("2606:4700:4700::1111")
			}
		}
	}
	return netip.Addr{}
}

func TestLabWindowsTraceDefaultGateway(t *testing.T) {
	labTraceEnabled(t)
	h := newLabHost(t)
	route := h.route(t, netip.MustParseAddr("1.1.1.1"))
	if route.NextHop == nil {
		t.Skip("no IPv4 default gateway")
	}
	gateway := netip.MustParseAddr(*route.NextHop)
	step := labTrace(t, h, gateway, 4, 1)
	assertTruthfulHops(t, step, gateway, 4, 1)
	if step.State != "succeeded" || !step.Details.Trace.DestinationReached || len(step.Details.Trace.Hops) != 1 || *step.Details.Trace.Hops[0].Address != gateway.String() {
		t.Fatalf("gateway trace: state=%s hops=%d", step.State, len(step.Details.Trace.Hops))
	}
}

func TestLabWindowsTracePublicIPv4(t *testing.T) {
	labTraceEnabled(t)
	h := newLabHost(t)
	destination := netip.MustParseAddr("1.1.1.1")
	step := labTrace(t, h, destination, 30, 2)
	assertTruthfulHops(t, step, destination, 30, 2)
	hops := step.Details.Trace.Hops
	if step.State != "succeeded" || !step.Details.Trace.DestinationReached || answered(step) < 2 {
		t.Fatalf("public trace: state=%s reason=%s answered=%d", step.State, stringPtr(step.Reason), answered(step))
	}
	if last := hops[len(hops)-1]; last.Address == nil || *last.Address != destination.String() {
		t.Fatalf("last hop is not the destination: %#v", last)
	}
	if step.Attribution.ActualMethod == nil || *step.Attribution.ActualMethod != "trace" || step.Attribution.LocalAddress == nil {
		t.Fatalf("attribution: %#v", step.Attribution)
	}
}

func TestLabWindowsTraceBlackholeTimesOut(t *testing.T) {
	labTraceEnabled(t)
	h := newLabHost(t)
	destination := netip.MustParseAddr("192.0.2.1") // TEST-NET-1, never answers
	step := labTrace(t, h, destination, 8, 1)
	assertTruthfulHops(t, step, destination, 8, 1)
	trace := step.Details.Trace
	timeouts := 0
	for _, hop := range trace.Hops {
		if hop.Address != nil && *hop.Address == destination.String() {
			t.Fatalf("invented destination responder: %#v", hop)
		}
		if hop.Outcome == "timeout" {
			timeouts++
		}
	}
	if trace.DestinationReached || step.State != "failed_check" {
		t.Fatalf("blackhole trace: state=%s reason=%s", step.State, stringPtr(step.Reason))
	}
	// A router may legitimately answer net-unreachable instead of staying silent;
	// otherwise the silent hops must be recorded as null-address timeouts.
	if timeouts == 0 && stringPtr(step.Reason) != "trace_destination_unreachable" {
		t.Fatalf("blackhole trace recorded no timeout hops: reason=%s", stringPtr(step.Reason))
	}
}

func TestLabWindowsTraceIPv6(t *testing.T) {
	labTraceEnabled(t)
	destination := labV6Target(t)
	if !destination.IsValid() {
		t.Skip("no global IPv6 on this host and BREEZE_LAB_TRACE_V6_TARGET unset")
	}
	h := newLabHost(t)
	step := labTrace(t, h, destination, 30, 1)
	assertTruthfulHops(t, step, destination, 30, 1)
	if step.State != "succeeded" || !step.Details.Trace.DestinationReached || answered(step) < 1 {
		t.Fatalf("IPv6 trace: state=%s reason=%s", step.State, stringPtr(step.Reason))
	}
}

// TestLabWindowsTraceUnusedOnLinkHost is observational: it records how the
// ICMP API reports an on-link address nobody owns, and only asserts truthfulness.
func TestLabWindowsTraceUnusedOnLinkHost(t *testing.T) {
	labTraceEnabled(t)
	raw := os.Getenv("BREEZE_LAB_TRACE_UNREACHABLE")
	if raw == "" {
		t.Skip("BREEZE_LAB_TRACE_UNREACHABLE unset")
	}
	destination := netip.MustParseAddr(raw)
	h := newLabHost(t)
	step := labTrace(t, h, destination, 2, 1)
	assertTruthfulHops(t, step, destination, 2, 1)
	if step.Details.Trace.DestinationReached {
		t.Fatalf("unused host confirmed as reached")
	}
}
