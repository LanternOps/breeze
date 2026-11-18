package isolation

import (
	"context"
	"fmt"
	"net/netip"
	"testing"
)

func addrs(ss ...string) []netip.Addr {
	out := make([]netip.Addr, 0, len(ss))
	for _, s := range ss {
		out = append(out, netip.MustParseAddr(s))
	}
	return out
}

func TestResolverMergesFreshFirstAndKeepsOld(t *testing.T) {
	l := &fakeLookup{addrs: map[string][]netip.Addr{}, fail: map[string]bool{}}
	l.set(controlHost, "192.0.2.10", "2001:db8::10")
	r := NewResolver(l.lookup)
	got, err := r.Resolve(context.Background(), []string{controlHost})
	if err != nil {
		t.Fatal(err)
	}
	if fmt.Sprint(got[controlHost]) != fmt.Sprint(addrs("192.0.2.10", "2001:db8::10")) {
		t.Fatalf("first resolve = %v", got[controlHost])
	}

	l.set(controlHost, "192.0.2.11")
	got, err = r.Resolve(context.Background(), []string{controlHost})
	if err != nil {
		t.Fatal(err)
	}
	want := addrs("192.0.2.11", "192.0.2.10", "2001:db8::10")
	if fmt.Sprint(got[controlHost]) != fmt.Sprint(want) {
		t.Fatalf("after rotation = %v, want %v (fresh first, old kept)", got[controlHost], want)
	}
}

func TestResolverCapsAtSixteen(t *testing.T) {
	l := &fakeLookup{addrs: map[string][]netip.Addr{}, fail: map[string]bool{}}
	r := NewResolver(l.lookup)
	for i := 0; i < 20; i++ {
		l.set(controlHost, fmt.Sprintf("192.0.2.%d", i+1))
		if _, err := r.Resolve(context.Background(), []string{controlHost}); err != nil {
			t.Fatal(err)
		}
	}
	got, _ := r.Resolve(context.Background(), []string{controlHost})
	if len(got[controlHost]) != MaxAddrsPerHost {
		t.Fatalf("kept %d addresses, want %d", len(got[controlHost]), MaxAddrsPerHost)
	}
	if got[controlHost][0] != netip.MustParseAddr("192.0.2.20") {
		t.Fatalf("newest address not first: %v", got[controlHost])
	}
	for _, a := range got[controlHost] {
		if a == netip.MustParseAddr("192.0.2.1") {
			t.Fatal("the oldest address survived past the cap")
		}
	}
}

func TestResolverFailureNeverDropsWorkingAddresses(t *testing.T) {
	l := &fakeLookup{addrs: map[string][]netip.Addr{}, fail: map[string]bool{}}
	l.set(controlHost, "192.0.2.10")
	r := NewResolver(l.lookup)
	if _, err := r.Resolve(context.Background(), []string{controlHost}); err != nil {
		t.Fatal(err)
	}
	l.setFail(controlHost, true)
	got, err := r.Resolve(context.Background(), []string{controlHost})
	if err != nil {
		t.Fatalf("a failure with a last-known-good set must not error: %v", err)
	}
	if fmt.Sprint(got[controlHost]) != fmt.Sprint(addrs("192.0.2.10")) {
		t.Fatalf("after failure = %v", got[controlHost])
	}
	// An empty answer is a failure too, not a reason to drop the set.
	l.setFail(controlHost, false)
	l.set(controlHost)
	got, err = r.Resolve(context.Background(), []string{controlHost})
	if err != nil || len(got[controlHost]) != 1 {
		t.Fatalf("empty answer dropped the set: %v %v", got, err)
	}
}

func TestResolverFailureWithoutHistoryErrors(t *testing.T) {
	l := &fakeLookup{addrs: map[string][]netip.Addr{}, fail: map[string]bool{}}
	l.set(controlHost, "192.0.2.10")
	r := NewResolver(l.lookup)
	got, err := r.Resolve(context.Background(), []string{controlHost, "missing.example.test"})
	if err == nil {
		t.Fatal("an unresolvable host with no history must fail")
	}
	if len(got[controlHost]) != 1 {
		t.Fatalf("the resolvable host was dropped: %v", got)
	}
}

func TestResolverFiltersAndNormalises(t *testing.T) {
	l := &fakeLookup{addrs: map[string][]netip.Addr{}, fail: map[string]bool{}}
	l.set(controlHost, "0.0.0.0", "::", "::ffff:192.0.2.10", "224.0.0.1", "192.0.2.10")
	r := NewResolver(l.lookup)
	got, err := r.Resolve(context.Background(), []string{controlHost})
	if err != nil {
		t.Fatal(err)
	}
	if fmt.Sprint(got[controlHost]) != fmt.Sprint(addrs("192.0.2.10")) {
		t.Fatalf("got %v, want only 192.0.2.10 (unmapped, deduplicated, no unspecified/multicast)", got[controlHost])
	}
}

func TestResolverLiteralAndSeed(t *testing.T) {
	l := &fakeLookup{addrs: map[string][]netip.Addr{}, fail: map[string]bool{}}
	r := NewResolver(l.lookup)
	got, err := r.Resolve(context.Background(), []string{"2001:db8::7", "192.0.2.9"})
	if err != nil {
		t.Fatal(err)
	}
	if got["2001:db8::7"][0] != netip.MustParseAddr("2001:db8::7") || l.calls != 0 {
		t.Fatalf("literal hosts must not be looked up: %v calls=%d", got, l.calls)
	}

	r.Seed(relayHost, addrs("198.51.100.5"))
	l.setFail(relayHost, true)
	got, err = r.Resolve(context.Background(), []string{relayHost})
	if err != nil || len(got[relayHost]) != 1 {
		t.Fatalf("seeded host not used on failure: %v %v", got, err)
	}
}
