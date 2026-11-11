package isolation

import (
	"net/netip"
	"strings"
	"testing"

	"github.com/breeze-rmm/agent/internal/isolation/wfp"
)

// BFE reads back only the native app ID; the requested filter also carries the
// path it was resolved from. The readback must still match, and must notice a
// changed app ID.
func TestWindowsReadbackMatchesAppIDWithoutPath(t *testing.T) {
	spec, bins, baseline := windowsRuleFixture()
	rules := buildWindowsRules(spec, bins, nil, baseline)
	installed := make([]wfp.FilterInfo, len(rules))
	sawApp := false
	for n := range rules {
		f := rules[n]
		f.Conditions = append([]wfp.Condition(nil), f.Conditions...)
		for c := range rules[n].Conditions {
			if rules[n].Conditions[c].Field == wfp.AppID {
				rules[n].Conditions[c].AppID = []byte("app:" + rules[n].Conditions[c].AppPath)
				f.Conditions[c] = wfp.Condition{Field: wfp.AppID, AppID: []byte("app:" + rules[n].Conditions[c].AppPath)}
				sawApp = true
			}
		}
		installed[n] = wfp.FilterInfo{Filter: f, ID: uint64(n + 1)}
	}
	if !sawApp {
		t.Fatal("fixture has no app-scoped permit")
	}
	if err := validateWindowsReadback(rules, installed); err != nil {
		t.Fatalf("readback without app path rejected: %v", err)
	}
	for n := range installed {
		for c := range installed[n].Conditions {
			if installed[n].Conditions[c].Field == wfp.AppID {
				installed[n].Conditions[c].AppID = []byte("app:other")
				if err := validateWindowsReadback(rules, installed); err == nil {
					t.Fatal("changed app ID accepted")
				}
				return
			}
		}
	}
}

// An unknown scope or protocol must produce no permit at all: never a
// destination-only permit for every process, never a wider protocol set.
func TestWindowsRulesUnknownScopeAndProtocolFailClosed(t *testing.T) {
	addr := netip.MustParsePrefix("192.0.2.10/32")
	for _, entry := range []AllowEntry{
		{Kind: KindHost, Host: "control.example.test", Proto: ProtoTCP, Ports: []uint16{443}, Scope: "everything"},
		{Kind: KindHost, Host: "control.example.test", Proto: "sctp", Ports: []uint16{443}, Scope: ScopeBreeze},
		{Kind: KindHost, Host: "control.example.test", Proto: "sctp", Ports: []uint16{443}, Scope: ScopeAny},
	} {
		rules := buildWindowsRules(ResolvedSpec{Entries: []ResolvedEntry{{AllowEntry: entry, Addrs: []netip.Prefix{addr}}}}, []string{`C:\Program Files\Breeze\breeze-agent.exe`}, nil, Baseline{})
		for _, f := range rules {
			if strings.HasPrefix(f.Name, "allow/") {
				t.Fatalf("entry %+v produced permit %+v", entry, f)
			}
		}
	}
}
