package wfp

import (
	"net/netip"
	"testing"
)

func TestFilterValidation(t *testing.T) {
	base := Filter{Key: FilterKey("test"), Name: "test", Layer: ALEConnectV4, Sublayer: SublayerKey, Action: Permit, Persistent: true}
	tests := []struct {
		name string
		edit func(*Filter)
		bad  bool
	}{
		{"persistent", func(*Filter) {}, false},
		{"both lifetimes", func(f *Filter) { f.BootTime = true }, true},
		{"boot application", func(f *Filter) {
			f.Persistent = false
			f.BootTime = true
			f.Conditions = []Condition{{Field: AppID, AppPath: "agent.exe"}}
		}, true},
		{"wrong family", func(f *Filter) {
			f.Conditions = []Condition{{Field: RemoteAddress, Address: netip.MustParsePrefix("2001:db8::/32")}}
		}, true},
		{"bad action", func(f *Filter) { f.Action = 42 }, true},
		{"flags match on port", func(f *Filter) { f.Conditions = []Condition{{Field: RemotePort, Uint: 443, Match: MatchFlagsAllSet}} }, true},
		{"unknown field", func(f *Filter) { f.Conditions = []Condition{{Field: "unknown"}} }, true},
		{"protocol overflow", func(f *Filter) { f.Conditions = []Condition{{Field: Protocol, Uint: 256}} }, true},
		{"port overflow", func(f *Filter) { f.Conditions = []Condition{{Field: RemotePort, Uint: 65536}} }, true},
		{"empty app", func(f *Filter) { f.Conditions = []Condition{{Field: AppID}} }, true},
		{"loopback flags", func(f *Filter) { f.Conditions = []Condition{{Field: Flags, Uint: 1, Match: MatchFlagsAllSet}} }, false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			f := base
			tt.edit(&f)
			if (f.Validate() != nil) != tt.bad {
				t.Fatalf("Validate=%v, bad=%v", f.Validate(), tt.bad)
			}
		})
	}
}
func TestFilterKeysStableAndDistinct(t *testing.T) {
	a := FilterKey("alpha")
	if a != FilterKey("alpha") || a == FilterKey("beta") || a == (GUID{}) {
		t.Fatal("unstable filter identity")
	}
	if a.String() != "af87ae25-0fd2-5f6b-a599-ce0ef0f865f5" {
		t.Fatalf("fixed namespace alpha key changed: %s", a)
	}
}
func TestCanonicalDigest(t *testing.T) {
	a := Filter{Key: FilterKey("a"), Name: "a", Layer: ALEConnectV4, Action: Block}
	b := a
	b.Key = FilterKey("b")
	if Digest([]Filter{a, b}) != Digest([]Filter{b, a}) {
		t.Fatal("order affects digest")
	}
	x := []FilterInfo{{Filter: a, ID: 42}, {Filter: b, ID: 99}}
	if CanonicalDigest(x) != Digest([]Filter{a, b}) {
		t.Fatal("engine identifiers affect digest")
	}
	b.Weight++
	if Digest([]Filter{a, b}) == CanonicalDigest(x) {
		t.Fatal("rule mutation invisible")
	}
}

func TestLocalInterfaceCondition(t *testing.T) {
	for _, layer := range []Layer{ALEConnectV4, ALEConnectV6, ALERecvAcceptV4, ALERecvAcceptV6} {
		f := Filter{Key: FilterKey("scoped"), Name: "scoped DNS", Layer: layer, Sublayer: SublayerKey, Action: Permit, Persistent: true, Conditions: []Condition{{Field: LocalInterface, Uint64: 0x123456789abcdef0}}}
		if err := f.Validate(); err != nil {
			t.Fatal(err)
		}
		original := Digest([]Filter{f})
		f.Conditions[0].Uint64++
		if original == Digest([]Filter{f}) {
			t.Fatal("interface scope missing from digest")
		}
		f.Conditions[0].Uint64 = 0
		if err := f.Validate(); err == nil {
			t.Fatal("zero LUID would erase interface scope")
		}
	}
}
