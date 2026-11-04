//go:build darwin

package isolation

import (
	"context"
	"errors"
	"net/netip"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
)

// All of this runs against fakePF (pfconf_test.go). Real pf is lab leg L3.

func testDarwinSpec() ResolvedSpec {
	return ResolvedSpec{
		IsolationID: "2f1d9d35-7f3b-4a70-9c55-b3a4f0a0c111",
		Generation:  1,
		Entries: []ResolvedEntry{
			{
				AllowEntry: AllowEntry{Kind: KindHost, Host: "control.example.test", Proto: ProtoTCP, Ports: []uint16{443}, Scope: ScopeBreeze},
				Addrs:      []netip.Prefix{netip.MustParsePrefix("198.51.100.7/32"), netip.MustParsePrefix("2001:db8::7/128")},
			},
			{
				AllowEntry: AllowEntry{Kind: KindHost, Host: "relay.example.test", Proto: ProtoUDPTCP, Ports: []uint16{3478, 5349}, Scope: ScopeBreeze},
				Addrs:      []netip.Prefix{netip.MustParsePrefix("203.0.113.9/32")},
			},
			{
				AllowEntry: AllowEntry{Kind: KindCIDR, CIDR: "198.51.100.0/24", Proto: ProtoUDP, Ports: []uint16{51820}, Scope: ScopeAny},
				Addrs:      []netip.Prefix{netip.MustParsePrefix("198.51.100.0/24")},
			},
		},
	}
}

func testDarwinBaseline() pfBaseline {
	return pfBaseline{
		Resolvers: []netip.Addr{netip.MustParseAddr("192.0.2.53"), netip.MustParseAddr("2001:db8::53")},
		Scoped:    []pfScopedResolver{{Address: netip.MustParseAddr("fe80::1"), Interface: "en0"}},
	}
}

func newTestDarwinIsolator(t *testing.T, f *fakePF) *darwinIsolator {
	t.Helper()
	i := newDarwinIsolator(t.TempDir())
	i.runner = func(context.Context) PFRunner { return f }
	i.baseline = func(context.Context) (pfBaseline, error) { return testDarwinBaseline(), nil }
	return i
}

func TestDarwinRulesGolden(t *testing.T) {
	want, err := os.ReadFile(filepath.Join("testdata", "pf", "isolation-anchor.golden"))
	if err != nil {
		t.Fatal(err)
	}
	if got := buildDarwinRules(testDarwinSpec(), testDarwinBaseline()); got != string(want) {
		t.Fatalf("ruleset differs from golden:\n--- got\n%s\n--- want\n%s", got, want)
	}
}

func TestDarwinRulesAreDeterministic(t *testing.T) {
	a := testDarwinSpec()
	b := testDarwinSpec()
	b.Entries[0].Addrs[0], b.Entries[0].Addrs[1] = b.Entries[0].Addrs[1], b.Entries[0].Addrs[0]
	b.Entries[0], b.Entries[2] = b.Entries[2], b.Entries[0]
	if buildDarwinRules(a, testDarwinBaseline()) != buildDarwinRules(b, testDarwinBaseline()) {
		t.Fatal("resolver answer order or allowlist order changed the ruleset")
	}
}

func TestDarwinRulesShape(t *testing.T) {
	lines := strings.Split(strings.TrimSpace(buildDarwinRules(testDarwinSpec(), testDarwinBaseline())), "\n")
	if last := lines[len(lines)-1]; last != `block drop quick all label "breeze_drop"` {
		t.Fatalf("the drop rule must come last and be quick: %q", last)
	}
	for n, line := range lines {
		// Every rule is quick: a non-quick decision here could be overridden by
		// a later rule in the main ruleset.
		if !regexp.MustCompile(`\bquick\b`).MatchString(line) {
			t.Errorf("rule %d is not quick: %q", n, line)
		}
		// pf is destination-only, so a rule must never name a program.
		if strings.Contains(line, "user") || strings.Contains(line, "group") {
			t.Errorf("rule %d pretends to scope a process: %q", n, line)
		}
		// Drop, never reject: an RST would give malware something to key off.
		if strings.Contains(line, "return") {
			t.Errorf("rule %d rejects: %q", n, line)
		}
	}
	if strings.Count(strings.Join(lines, "\n"), "breeze_drop") != 1 {
		t.Fatal("exactly one rule carries the drop label")
	}
}

// OD2 (b): pf cannot match a process, so `breeze` and `any` both install the
// same destination permit.
func TestDarwinScopeBreezeDegradesToDestinationPermit(t *testing.T) {
	spec := func(scope string) ResolvedSpec {
		return ResolvedSpec{Entries: []ResolvedEntry{{
			AllowEntry: AllowEntry{Kind: KindCIDR, CIDR: "203.0.113.0/24", Proto: ProtoTCP, Ports: []uint16{443}, Scope: scope},
			Addrs:      []netip.Prefix{netip.MustParsePrefix("203.0.113.0/24")},
		}}}
	}
	if buildDarwinRules(spec(ScopeBreeze), pfBaseline{}) != buildDarwinRules(spec(ScopeAny), pfBaseline{}) {
		t.Fatal("scope changed a destination-only rule")
	}
	if !strings.Contains(buildDarwinRules(spec(ScopeBreeze), pfBaseline{}), "pass out quick inet proto tcp from any to 203.0.113.0/24 port 443 flags S/SA keep state") {
		t.Fatal(buildDarwinRules(spec(ScopeBreeze), pfBaseline{}))
	}
}

func TestDarwinRulesSkipUnusableInput(t *testing.T) {
	spec := ResolvedSpec{Entries: []ResolvedEntry{{
		AllowEntry: AllowEntry{Kind: KindCIDR, Proto: ProtoTCP, Ports: []uint16{0, 443}, Scope: ScopeAny},
		Addrs:      []netip.Prefix{{}, netip.PrefixFrom(netip.MustParseAddr("::ffff:192.0.2.1"), 128)},
	}}}
	got := buildDarwinRules(spec, pfBaseline{Resolvers: []netip.Addr{{}, netip.MustParseAddr("0.0.0.0"), netip.MustParseAddr("224.0.0.251")}})
	for _, bad := range []string{"invalid", "::ffff", "0.0.0.0", "224.0.0.251", "port 0"} {
		if strings.Contains(got, bad) {
			t.Errorf("ruleset contains %q:\n%s", bad, got)
		}
	}
}

func TestParseScutilDNS(t *testing.T) {
	const out = `DNS configuration

resolver #1
  search domain[0] : example.test
  nameserver[0] : 192.0.2.53
  nameserver[1] : 2001:db8::53
  nameserver[2] : fe80::1%en0
  nameserver[3] : fe80::2
  if_index : 4 (en0)
  flags    : Request A records, Request AAAA records
  reach    : 0x00000002 (Reachable)

resolver #2
  domain   : local
  options  : mdns
  timeout  : 5
  flags    : Request A records, Request AAAA records
  order    : 300000

DNS configuration (for scoped queries)

resolver #1
  nameserver[0] : 192.0.2.53
  if_index : 4 (en0)

resolver #2
  nameserver[0] : 198.51.100.53
  if_index : 12 (utun3)
`
	got := parseScutilDNS(out)
	if len(got.Resolvers) != 3 || got.Resolvers[0].String() != "192.0.2.53" || got.Resolvers[1].String() != "198.51.100.53" || got.Resolvers[2].String() != "2001:db8::53" {
		t.Fatalf("resolvers %v", got.Resolvers)
	}
	if len(got.Scoped) != 2 || got.Scoped[0] != (pfScopedResolver{netip.MustParseAddr("fe80::1"), "en0"}) || got.Scoped[1] != (pfScopedResolver{netip.MustParseAddr("fe80::2"), "en0"}) {
		t.Fatalf("scoped %v", got.Scoped)
	}
	// A link-local resolver with no interface cannot be permitted safely: on
	// another link the same address is a different host.
	if got := parseScutilDNS("resolver #1\n  nameserver[0] : fe80::9\n"); len(got.Scoped)+len(got.Resolvers) != 0 {
		t.Fatalf("unscoped link-local kept: %+v", got)
	}
}

func TestDarwinApplyOrderAndTokenJournal(t *testing.T) {
	f := newFakePF(t)
	i := newTestDarwinIsolator(t, f)
	digest, err := i.Apply(context.Background(), testDarwinSpec())
	if err != nil {
		t.Fatal(err)
	}
	if digest == "" {
		t.Fatal("empty digest")
	}
	mainLoad, anchorLoad, enable := indexOfCall(f, "-f -"), indexOfCall(f, "-a "+pfAnchorPath+" -f -"), indexOfCall(f, "-E")
	kills := indexOfCall(f, "-ss")
	if mainLoad < 0 || anchorLoad < mainLoad || enable < anchorLoad || kills < enable {
		t.Fatalf("want main load, anchor load, pf reference, then state kill:\n%v", f.calls)
	}
	if f.anchorRules != buildDarwinRules(testDarwinSpec(), testDarwinBaseline()) {
		t.Fatalf("loaded anchor differs from the built ruleset:\n%s", f.anchorRules)
	}
	token, err := i.tokens.load()
	if err != nil || token == "" || !f.tokens[token] {
		t.Fatalf("token %q not journalled: %v (kernel %v)", token, err, f.tokens)
	}
}

func indexOfCall(f *fakePF, call string) int {
	for n, c := range f.calls {
		if c == call {
			return n
		}
	}
	return -1
}

// A refresh re-applies constantly (every re-resolve). It must not pile up pf
// references, and must not touch the main ruleset.
func TestDarwinSecondApplyReusesReferenceAndOnlyTouchesTheAnchor(t *testing.T) {
	f := newFakePF(t)
	i := newTestDarwinIsolator(t, f)
	first, err := i.Apply(context.Background(), testDarwinSpec())
	if err != nil {
		t.Fatal(err)
	}
	second, err := i.Apply(context.Background(), testDarwinSpec())
	if err != nil {
		t.Fatal(err)
	}
	if first != second {
		t.Fatal("re-applying identical rules changed the digest")
	}
	if got := f.count("-f -"); got != 1 {
		t.Fatalf("main ruleset loaded %d times", got)
	}
	if got := f.count("-E"); got != 1 || len(f.tokens) != 1 {
		t.Fatalf("pf references taken %d, held %d", got, len(f.tokens))
	}
}

// pf can be off while the kernel still lists our token. Keeping that reference
// would leave rules loaded that do nothing, reported as a successful apply.
func TestDarwinApplyReenablesPfWhenItsTokenIsStillListed(t *testing.T) {
	f, i, _ := appliedDarwin(t)
	old := firstToken(f)
	f.enabled = false
	if _, err := i.Apply(context.Background(), testDarwinSpec()); err != nil {
		t.Fatal(err)
	}
	token, _ := i.tokens.load()
	if !f.enabled || token == old || !f.tokens[token] {
		t.Fatalf("enabled %v token %q (was %q) kernel %v", f.enabled, token, old, f.tokens)
	}
}

// After a reboot, or an admin disabling pf, the journalled token no longer
// exists. Apply must take a new one, or pf stays off with rules that do nothing.
func TestDarwinApplyReplacesAStaleToken(t *testing.T) {
	f := newFakePF(t)
	i := newTestDarwinIsolator(t, f)
	if err := i.tokens.save("999"); err != nil {
		t.Fatal(err)
	}
	if _, err := i.Apply(context.Background(), testDarwinSpec()); err != nil {
		t.Fatal(err)
	}
	token, _ := i.tokens.load()
	if token == "999" || !f.tokens[token] || !f.enabled {
		t.Fatalf("token %q, kernel %v, enabled %v", token, f.tokens, f.enabled)
	}
}

// A corrupt token file must not make isolation impossible forever: the token
// in it can never be released, so a new reference replaces it.
func TestDarwinApplySurvivesACorruptTokenFile(t *testing.T) {
	f := newFakePF(t)
	i := newTestDarwinIsolator(t, f)
	if err := os.MkdirAll(filepath.Dir(i.tokens.path), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(i.tokens.path, []byte("not a number"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := i.Apply(context.Background(), testDarwinSpec()); err != nil {
		t.Fatal(err)
	}
	token, err := i.tokens.load()
	if err != nil || !f.tokens[token] {
		t.Fatalf("token %q err %v kernel %v", token, err, f.tokens)
	}
}

// If the token cannot be journalled, nothing could ever release that reference,
// so it goes straight back rather than leaking.
func TestDarwinApplyGivesBackAReferenceItCannotJournal(t *testing.T) {
	f := newFakePF(t)
	i := newTestDarwinIsolator(t, f)
	blocker := filepath.Join(t.TempDir(), "file")
	if err := os.WriteFile(blocker, nil, 0o600); err != nil {
		t.Fatal(err)
	}
	i.tokens.path = filepath.Join(blocker, "token") // its parent is a file
	if _, err := i.Apply(context.Background(), testDarwinSpec()); err == nil || !strings.Contains(err.Error(), "journal") {
		t.Fatalf("got %v", err)
	}
	if len(f.tokens) != 0 {
		t.Fatalf("leaked a pf reference: %v", f.tokens)
	}
}

func TestDarwinApplyRefusalTouchesNothing(t *testing.T) {
	f := newFakePF(t)
	f.useLive(pfFixtureLive(t, "internet-sharing.txt"))
	i := newTestDarwinIsolator(t, f)
	_, err := i.Apply(context.Background(), testDarwinSpec())
	var incompatible ErrIncompatible
	if !errors.As(err, &incompatible) || !strings.Contains(incompatible.Reason, pfInternetSharingAnchor) {
		t.Fatalf("got %v", err)
	}
	for _, call := range f.calls {
		for _, write := range []string{"-f -", "-F", "-E", "-X", "-k"} {
			if strings.Contains(call, write) {
				t.Errorf("refusal ran a writing command: %q", call)
			}
		}
	}
}

func TestDarwinApplyFailures(t *testing.T) {
	sentinel := errors.New("boom")
	for _, call := range []string{"-a " + pfAnchorPath + " -f -", "-a " + pfAnchorPath + " -sr", "-E", "-ss"} {
		t.Run(call, func(t *testing.T) {
			f := newFakePF(t)
			f.fail[call] = sentinel
			i := newTestDarwinIsolator(t, f)
			if _, err := i.Apply(context.Background(), testDarwinSpec()); !errors.Is(err, sentinel) {
				t.Fatalf("got %v", err)
			}
		})
	}
	t.Run("baseline", func(t *testing.T) {
		f := newFakePF(t)
		i := newTestDarwinIsolator(t, f)
		i.baseline = func(context.Context) (pfBaseline, error) { return pfBaseline{}, sentinel }
		if _, err := i.Apply(context.Background(), testDarwinSpec()); !errors.Is(err, sentinel) {
			t.Fatalf("got %v", err)
		}
		if len(f.calls) != 0 {
			t.Fatalf("touched pf before reading the baseline: %v", f.calls)
		}
	})
	t.Run("cancelled", func(t *testing.T) {
		f := newFakePF(t)
		i := newTestDarwinIsolator(t, f)
		ctx, cancel := context.WithCancel(context.Background())
		cancel()
		if _, err := i.Apply(ctx, testDarwinSpec()); !errors.Is(err, context.Canceled) {
			t.Fatalf("got %v", err)
		}
	})
	t.Run("no token in the output", func(t *testing.T) {
		f := newFakePF(t)
		i := newTestDarwinIsolator(t, f)
		wrapped := &tokenlessPF{fakePF: f}
		i.runner = func(context.Context) PFRunner { return wrapped }
		if _, err := i.Apply(context.Background(), testDarwinSpec()); err == nil || !strings.Contains(err.Error(), "token") {
			t.Fatalf("got %v", err)
		}
	})
	t.Run("readback lost the drop rule", func(t *testing.T) {
		f := newFakePF(t)
		i := newTestDarwinIsolator(t, f)
		wrapped := &truncatingPF{fakePF: f}
		i.runner = func(context.Context) PFRunner { return wrapped }
		if _, err := i.Apply(context.Background(), testDarwinSpec()); err == nil || !strings.Contains(err.Error(), pfDropLabel) {
			t.Fatalf("got %v", err)
		}
	})
}

type tokenlessPF struct{ *fakePF }

func (p *tokenlessPF) Pfctl(stdin string, args ...string) (string, string, error) {
	stdout, stderr, err := p.fakePF.Pfctl(stdin, args...)
	if strings.Join(args, " ") == "-E" {
		return stdout, "pf enabled\n", err
	}
	return stdout, stderr, err
}

type truncatingPF struct{ *fakePF }

func (p *truncatingPF) Pfctl(stdin string, args ...string) (string, string, error) {
	stdout, stderr, err := p.fakePF.Pfctl(stdin, args...)
	if strings.Join(args, " ") == "-a "+pfAnchorPath+" -sr" {
		return "pass quick all no state\n", stderr, err
	}
	return stdout, stderr, err
}

func TestDarwinApplyKillsOnlyUnpermittedStates(t *testing.T) {
	f := newFakePF(t)
	f.states = []string{
		"ALL tcp 192.0.2.10:54001 -> 198.51.100.7:443       ESTABLISHED:ESTABLISHED", // control plane
		"ALL tcp 2001:db8::10[54002] -> 2001:db8::7[443]       ESTABLISHED:ESTABLISHED",
		"ALL udp 192.0.2.10:54003 -> 192.0.2.53:53       MULTIPLE:SINGLE",                // DNS to a resolver
		"ALL udp 192.0.2.10:68 -> 192.0.2.1:67       MULTIPLE:SINGLE",                    // DHCP
		"ALL tcp 127.0.0.1:50000 -> 127.0.0.1:50001       ESTABLISHED:ESTABLISHED",       // loopback
		"ALL tcp 192.0.2.10:54004 -> 203.0.113.66:4444       ESTABLISHED:ESTABLISHED",    // attacker C2
		"ALL tcp 192.0.2.10:54005 -> 198.51.100.7:8080       ESTABLISHED:ESTABLISHED",    // permitted host, other port
		"ALL udp 192.0.2.10:54006 -> 203.0.113.67:53       MULTIPLE:SINGLE",              // DNS, not to a resolver
		"ALL tcp 192.0.2.10:22 <- 203.0.113.68:50000       ESTABLISHED:ESTABLISHED",      // inbound SSH
		"ALL tcp 192.0.2.10:443 <- 198.51.100.7:50001       ESTABLISHED:ESTABLISHED",     // inbound from an allowed host
		"ALL tcp 2001:db8::10[54007] -> 2001:db8::99[443]       ESTABLISHED:ESTABLISHED", // v6, not permitted
		"ALL tcp 192.0.2.10:54008 (192.0.2.11:54008) -> 203.0.113.70:80       ESTABLISHED:ESTABLISHED",
		"ALL tcp 192.0.2.10:54009 -> 203.0.113.66:4445       ESTABLISHED:ESTABLISHED", // same pair as the C2
	}
	i := newTestDarwinIsolator(t, f)
	if _, err := i.Apply(context.Background(), testDarwinSpec()); err != nil {
		t.Fatal(err)
	}
	got := map[[2]string]int{}
	for _, k := range f.killed {
		got[k]++
	}
	want := [][2]string{
		{"192.0.2.10", "203.0.113.66"},
		{"192.0.2.10", "198.51.100.7"},
		{"192.0.2.10", "203.0.113.67"},
		{"203.0.113.68", "192.0.2.10"}, // inbound: -k takes the state's origin first
		{"198.51.100.7", "192.0.2.10"},
		{"2001:db8::10", "2001:db8::99"},
		{"192.0.2.10", "203.0.113.70"},
	}
	if len(got) != len(want) {
		t.Fatalf("killed %v, want %v", f.killed, want)
	}
	for _, k := range want {
		if got[k] != 1 {
			t.Errorf("want one kill of %v, got %d (%v)", k, got[k], f.killed)
		}
	}
}

// IPsec and GRE have no ports. A VPN must not make a Mac impossible to isolate,
// and its tunnel to an unpermitted peer must still be cut.
func TestDarwinApplyHandlesPortlessStates(t *testing.T) {
	f := newFakePF(t)
	f.states = []string{
		"ALL esp 192.0.2.10 -> 203.0.113.80       MULTIPLE:MULTIPLE",
		"ALL gre 2001:db8::10 <- 2001:db8::80       MULTIPLE:MULTIPLE",
	}
	if _, err := newTestDarwinIsolator(t, f).Apply(context.Background(), testDarwinSpec()); err != nil {
		t.Fatal(err)
	}
	if len(f.killed) != 2 || f.killed[0] != [2]string{"192.0.2.10", "203.0.113.80"} || f.killed[1] != [2]string{"2001:db8::80", "2001:db8::10"} {
		t.Fatalf("killed %v", f.killed)
	}
}

func TestDarwinApplyFailsWhenStatesCannotBeJudgedOrKilled(t *testing.T) {
	t.Run("unparseable state", func(t *testing.T) {
		f := newFakePF(t)
		f.states = []string{"ALL tcp what is this"}
		if _, err := newTestDarwinIsolator(t, f).Apply(context.Background(), testDarwinSpec()); err == nil {
			t.Fatal("an attacker's connection might survive, but apply reported success")
		}
	})
	t.Run("kill refused", func(t *testing.T) {
		f := newFakePF(t)
		f.states = []string{"ALL tcp 192.0.2.10:54004 -> 203.0.113.66:4444       ESTABLISHED:ESTABLISHED"}
		sentinel := errors.New("no")
		f.fail["-k 192.0.2.10 -k 203.0.113.66"] = sentinel
		if _, err := newTestDarwinIsolator(t, f).Apply(context.Background(), testDarwinSpec()); !errors.Is(err, sentinel) {
			t.Fatalf("got %v", err)
		}
	})
}

func appliedDarwin(t *testing.T) (*fakePF, *darwinIsolator, Digest) {
	t.Helper()
	f := newFakePF(t)
	i := newTestDarwinIsolator(t, f)
	digest, err := i.Apply(context.Background(), testDarwinSpec())
	if err != nil {
		t.Fatal(err)
	}
	return f, i, digest
}

func TestDarwinVerify(t *testing.T) {
	t.Run("unchanged rules return Apply's digest", func(t *testing.T) {
		_, i, digest := appliedDarwin(t)
		got, err := i.Verify(context.Background(), testDarwinSpec())
		if err != nil || got != digest {
			t.Fatalf("got %q err %v, want %q", got, err, digest)
		}
	})
	t.Run("changed rules change the digest", func(t *testing.T) {
		f, i, digest := appliedDarwin(t)
		f.anchorRules += "pass quick all no state\n"
		got, err := i.Verify(context.Background(), testDarwinSpec())
		if err == nil && got == digest {
			t.Fatal("a tampered anchor verified")
		}
	})
	t.Run("detached hook is drift, and verify loads nothing", func(t *testing.T) {
		f, i, _ := appliedDarwin(t)
		f.rules = []string{`anchor "com.apple/*" all`}
		loads := f.count("-f -")
		if _, err := i.Verify(context.Background(), testDarwinSpec()); err == nil || !strings.Contains(err.Error(), "hook") {
			t.Fatalf("got %v", err)
		}
		if f.count("-f -") != loads {
			t.Fatal("Verify reloaded the main ruleset; only a fenced Apply may")
		}
	})
	t.Run("pf disabled by an admin is drift", func(t *testing.T) {
		f, i, _ := appliedDarwin(t)
		f.enabled = false
		if _, err := i.Verify(context.Background(), testDarwinSpec()); err == nil || !strings.Contains(err.Error(), "not enabled") {
			t.Fatalf("got %v", err)
		}
	})
	t.Run("emptied anchor is drift", func(t *testing.T) {
		f, i, _ := appliedDarwin(t)
		f.anchorRules = ""
		if _, err := i.Verify(context.Background(), testDarwinSpec()); err == nil {
			t.Fatal("an empty anchor verified")
		}
	})
	// Nothing was reloaded and the anchor still holds its rules, but traffic now
	// never reaches them. The negative probe only sees the control plane's path.
	t.Run("a set skip added later is drift", func(t *testing.T) {
		f, i, _ := appliedDarwin(t)
		f.interfaces = "all\nen\nen0 (skip)\nlo\nlo0\n"
		_, err := i.Verify(context.Background(), testDarwinSpec())
		var incompatible ErrIncompatible
		if !errors.As(err, &incompatible) || !strings.Contains(incompatible.Reason, "en0") {
			t.Fatalf("got %v", err)
		}
	})
	t.Run("a quick pass added ahead of the hook is drift", func(t *testing.T) {
		f, i, _ := appliedDarwin(t)
		f.rules = append([]string{"pass out quick all flags S/SA keep state"}, f.rules...)
		_, err := i.Verify(context.Background(), testDarwinSpec())
		var incompatible ErrIncompatible
		if !errors.As(err, &incompatible) || !strings.Contains(incompatible.Reason, "quick pass") {
			t.Fatalf("got %v", err)
		}
	})
	// Once attached no load happens, so Internet Sharing starting later is not
	// a reason to report drift: its anchors are not at risk.
	t.Run("a service anchor added later is not drift", func(t *testing.T) {
		f, i, digest := appliedDarwin(t)
		f.anchors = append(f.anchors, pfInternetSharingAnchor)
		f.rules = append(f.rules, `anchor "`+pfInternetSharingAnchor+`" all`)
		got, err := i.Verify(context.Background(), testDarwinSpec())
		if err != nil || got != digest {
			t.Fatalf("got %q err %v", got, err)
		}
	})
	t.Run("pfctl failure is reported", func(t *testing.T) {
		f, i, _ := appliedDarwin(t)
		sentinel := errors.New("boom")
		f.fail["-si"] = sentinel
		if _, err := i.Verify(context.Background(), testDarwinSpec()); !errors.Is(err, sentinel) {
			t.Fatalf("got %v", err)
		}
	})
}

func TestDarwinDropObservedUsesTheLabelCounterDelta(t *testing.T) {
	f, i, _ := appliedDarwin(t)
	f.dropPackets = 5
	mark, err := i.Mark(context.Background())
	if err != nil || mark.Value != 5 {
		t.Fatalf("mark %+v err %v", mark, err)
	}
	// Permitted traffic moves pass-rule counters only.
	if dropped, err := i.DropObserved(context.Background(), mark); err != nil || dropped {
		t.Fatalf("dropped %v err %v without the drop counter moving", dropped, err)
	}
	f.dropPackets = 6
	if dropped, err := i.DropObserved(context.Background(), mark); err != nil || !dropped {
		t.Fatalf("dropped %v err %v", dropped, err)
	}
}

func TestDarwinMarkErrors(t *testing.T) {
	t.Run("no drop rule installed", func(t *testing.T) {
		f, i, _ := appliedDarwin(t)
		f.anchorRules = "pass quick all no state\n"
		if _, err := i.Mark(context.Background()); err == nil {
			t.Fatal("a missing drop rule cannot be observed")
		}
	})
	t.Run("pfctl failure", func(t *testing.T) {
		f, i, _ := appliedDarwin(t)
		sentinel := errors.New("boom")
		f.fail["-a "+pfAnchorPath+" -vsr"] = sentinel
		if _, err := i.Mark(context.Background()); !errors.Is(err, sentinel) {
			t.Fatalf("got %v", err)
		}
	})
	t.Run("drop rule with no counter", func(t *testing.T) {
		if _, err := parsePFDropPackets(`block drop quick all label "breeze_drop"` + "\n"); err == nil {
			t.Fatal("a rule with no counter line must not read as zero")
		}
	})
}

func TestDarwinReleaseFlushesThenReleasesOurReferenceOnly(t *testing.T) {
	f, i, _ := appliedDarwin(t)
	token, _ := i.tokens.load()
	f.tokens["1111"] = true // another product's reference
	if err := i.Release(context.Background()); err != nil {
		t.Fatal(err)
	}
	flush, release := indexOfCall(f, "-a "+pfAnchorPath+" -F rules"), indexOfCall(f, "-X "+token)
	if flush < 0 || release < flush {
		t.Fatalf("want flush, then -X:\n%v", f.calls)
	}
	if !f.tokens["1111"] || !f.enabled {
		t.Fatal("released someone else's pf reference")
	}
	if got, err := i.tokens.load(); err != nil || got != "" {
		t.Fatalf("token kept after release: %q %v", got, err)
	}
	// The hook stays: an empty anchor is harmless, and removing it would mean a
	// second main-ruleset load.
	if got := f.count("-f -"); got != 1 {
		t.Fatalf("release loaded the main ruleset (%d loads)", got)
	}
	if present, _ := ParentHookPresent(f); !present {
		t.Fatal("release removed the hook")
	}
	if owned, err := i.Owned(context.Background()); err != nil || owned {
		t.Fatalf("owned %v err %v after release", owned, err)
	}
}

func TestDarwinReleaseEdgeCases(t *testing.T) {
	t.Run("nothing installed touches nothing", func(t *testing.T) {
		f := newFakePF(t)
		i := newTestDarwinIsolator(t, f)
		if err := i.Release(context.Background()); err != nil {
			t.Fatal(err)
		}
		for _, call := range f.calls {
			if strings.Contains(call, "-F") || strings.Contains(call, "-X") || strings.Contains(call, "-f ") {
				t.Errorf("wrote while nothing was installed: %q", call)
			}
		}
	})
	t.Run("flush failure keeps the token and fails", func(t *testing.T) {
		f, i, _ := appliedDarwin(t)
		sentinel := errors.New("boom")
		f.fail["-a "+pfAnchorPath+" -F rules"] = sentinel
		if err := i.Release(context.Background()); !errors.Is(err, sentinel) {
			t.Fatalf("got %v", err)
		}
		if token, _ := i.tokens.load(); token == "" {
			t.Fatal("lost the token while rules remain")
		}
		if f.count("-X "+firstToken(f)) != 0 {
			t.Fatal("released the reference while rules remain")
		}
	})
	t.Run("rules that survive the flush fail the release", func(t *testing.T) {
		f, i, _ := appliedDarwin(t)
		f.onCall = func(call string) {
			if call == "-X "+firstToken(f) {
				f.anchorRules = "block drop quick all\n"
			}
		}
		if err := i.Release(context.Background()); err == nil {
			t.Fatal("a release must not report success it cannot observe")
		}
	})
	t.Run("a token the kernel no longer holds is forgotten", func(t *testing.T) {
		f, i, _ := appliedDarwin(t)
		for token := range f.tokens {
			delete(f.tokens, token)
		}
		if err := i.Release(context.Background()); err != nil {
			t.Fatal(err)
		}
		if token, _ := i.tokens.load(); token != "" {
			t.Fatalf("stale token kept: %q", token)
		}
	})
	t.Run("a token the kernel still holds fails the release", func(t *testing.T) {
		f, i, _ := appliedDarwin(t)
		token := firstToken(f)
		f.fail["-X "+token] = errors.New("busy")
		if err := i.Release(context.Background()); err == nil {
			t.Fatal("the reference is still held")
		}
		if got, _ := i.tokens.load(); got != token {
			t.Fatalf("token lost: %q", got)
		}
	})
	t.Run("an engine error is never absence", func(t *testing.T) {
		f, i, _ := appliedDarwin(t)
		sentinel := errors.New("boom")
		f.fail["-a "+pfAnchorPath+" -sr"] = sentinel
		f.fail["-sA"] = sentinel
		if err := i.Release(context.Background()); !errors.Is(err, sentinel) {
			t.Fatalf("got %v", err)
		}
	})
	// The first attempt flushed, then failed to give back the reference. The
	// retry finds an empty anchor and must still release it.
	t.Run("a retry after the flush still releases the reference", func(t *testing.T) {
		f, i, _ := appliedDarwin(t)
		token := firstToken(f)
		f.fail["-X "+token] = errors.New("busy")
		if err := i.Release(context.Background()); err == nil {
			t.Fatal("the reference is still held")
		}
		delete(f.fail, "-X "+token)
		flushes := f.count("-a " + pfAnchorPath + " -F rules")
		if err := i.Release(context.Background()); err != nil {
			t.Fatal(err)
		}
		if f.tokens[token] {
			t.Fatal("retry left the reference held")
		}
		if got := f.count("-a " + pfAnchorPath + " -F rules"); got != flushes {
			t.Fatal("flushed an empty anchor again")
		}
	})
	// A crash between -E and journalling the token: rules, but no token. Flush;
	// there is nothing we may release, and pf staying on with an empty anchor is safe.
	t.Run("rules with no journalled token", func(t *testing.T) {
		f, i, _ := appliedDarwin(t)
		if err := i.tokens.clear(); err != nil {
			t.Fatal(err)
		}
		if err := i.Release(context.Background()); err != nil {
			t.Fatal(err)
		}
		if f.anchorRules != "" {
			t.Fatal("rules remain")
		}
		for _, call := range f.calls {
			if strings.HasPrefix(call, "-X") {
				t.Fatalf("released a reference it does not know: %q", call)
			}
		}
	})
	t.Run("a corrupt token file is forgotten without releasing anything", func(t *testing.T) {
		f, i, _ := appliedDarwin(t)
		if err := os.WriteFile(i.tokens.path, []byte("garbage"), 0o600); err != nil {
			t.Fatal(err)
		}
		if err := i.Release(context.Background()); err != nil {
			t.Fatal(err)
		}
		if _, err := os.Stat(i.tokens.path); !os.IsNotExist(err) {
			t.Fatalf("token file kept: %v", err)
		}
		for _, call := range f.calls {
			if strings.HasPrefix(call, "-X") {
				t.Fatalf("released from a corrupt file: %q", call)
			}
		}
	})
}

func firstToken(f *fakePF) string {
	for token := range f.tokens {
		return token
	}
	return ""
}

func TestDarwinOwned(t *testing.T) {
	t.Run("never isolated: no anchor exists", func(t *testing.T) {
		f := newFakePF(t)
		owned, err := newTestDarwinIsolator(t, f).Owned(context.Background())
		if err != nil || owned {
			t.Fatalf("owned %v err %v", owned, err)
		}
	})
	t.Run("rules installed", func(t *testing.T) {
		_, i, _ := appliedDarwin(t)
		owned, err := i.Owned(context.Background())
		if err != nil || !owned {
			t.Fatalf("owned %v err %v", owned, err)
		}
	})
	t.Run("the anchor read fails but pf still lists it: not absence", func(t *testing.T) {
		f, i, _ := appliedDarwin(t)
		f.fail["-a "+pfAnchorPath+" -sr"] = errors.New("boom")
		if owned, err := i.Owned(context.Background()); err == nil {
			t.Fatalf("owned %v with no error", owned)
		}
	})
	t.Run("pf is unreachable: not absence", func(t *testing.T) {
		f := newFakePF(t)
		f.fail["-a "+pfAnchorPath+" -sr"] = errors.New("permission denied")
		f.fail["-sA"] = errors.New("permission denied")
		if owned, err := newTestDarwinIsolator(t, f).Owned(context.Background()); err == nil {
			t.Fatalf("owned %v with no error", owned)
		}
	})
}

func TestPFTokenStoreIsPrivateAndDurable(t *testing.T) {
	store := pfTokenStore{path: filepath.Join(t.TempDir(), "nested", "token")}
	if got, err := store.load(); err != nil || got != "" {
		t.Fatalf("missing store: %q %v", got, err)
	}
	if err := store.save("42"); err != nil {
		t.Fatal(err)
	}
	info, err := os.Stat(store.path)
	if err != nil || info.Mode().Perm() != 0o600 {
		t.Fatalf("mode %v err %v", info.Mode(), err)
	}
	if got, err := store.load(); err != nil || got != "42" {
		t.Fatalf("got %q %v", got, err)
	}
	if err := store.clear(); err != nil {
		t.Fatal(err)
	}
	if err := store.clear(); err != nil {
		t.Fatalf("clearing twice: %v", err)
	}
}
