package isolation

import (
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
)

// The fixtures: stock-sequoia.conf is /etc/pf.conf captured verbatim from a
// Mac. The .txt snapshots are the pfctl output each scenario is EXPECTED to
// produce, built from pfctl(8) and the Internet Sharing anchors Apple documents
// in that file's header. Real pf is never run here: lab leg L3 proves them.
func pfFixture(t *testing.T, name string) string {
	t.Helper()
	b, err := os.ReadFile(filepath.Join("testdata", "pf", name))
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

// pfFixtureLive splits a .txt snapshot into the sections pfctl prints.
func pfFixtureLive(t *testing.T, name string) pfLiveState {
	t.Helper()
	sections := map[string]string{}
	current := ""
	for _, line := range strings.Split(pfFixture(t, name), "\n") {
		if rest, ok := strings.CutPrefix(line, "### pfctl "); ok {
			current = rest
			continue
		}
		sections[current] += line + "\n"
	}
	return pfLiveState{Rules: sections["-sn"] + sections["-sr"], Anchors: sections["-sA"], Interfaces: sections["-sI -v"]}
}

// fakePF models the kernel state pfctl reads and writes. An unmodelled command
// fails the test, so a forbidden invocation (pf disable, a flush outside our
// anchor) cannot pass unnoticed.
type fakePF struct {
	t            *testing.T
	conf         string
	declared     string
	egress       []string
	egressErr    error
	nat          []string
	rules        []string
	anchors      []string
	interfaces   string
	anchorExists bool
	anchorRules  string
	dropPackets  uint64
	enabled      bool
	tokens       map[string]bool
	nextToken    int
	states       []string
	killed       [][2]string
	calls        []string
	fail         map[string]error
	onCall       func(call string)
	// loadDropsHook: pfctl reports a main-ruleset load succeeded, yet the
	// result does not reference our anchor.
	loadDropsHook bool
}

func newFakePF(t *testing.T) *fakePF {
	f := &fakePF{
		t:        t,
		conf:     pfFixture(t, "stock-sequoia.conf"),
		declared: "scrub-anchor \"com.apple/*\" all fragment reassemble\nanchor \"com.apple/*\" all\nnat-anchor \"com.apple/*\" all\nrdr-anchor \"com.apple/*\" all\n",
		egress:   []string{"en0"},
		nat:      []string{`nat-anchor "com.apple/*" all`, `rdr-anchor "com.apple/*" all`},
		rules:    []string{`scrub-anchor "com.apple/*" all fragment reassemble`, `anchor "com.apple/*" all`},
		anchors:  []string{"com.apple"},
		tokens:   map[string]bool{},
		fail:     map[string]error{},
	}
	f.interfaces = "all\nen\nen0\nlo\nlo0\n"
	return f
}

// useLive replaces the kernel's main ruleset with a fixture snapshot.
func (f *fakePF) useLive(live pfLiveState) {
	f.nat, f.rules = nil, nil
	for _, line := range strings.Split(live.Rules, "\n") {
		line = strings.TrimSpace(line)
		switch {
		case line == "":
		case strings.HasPrefix(line, "nat") || strings.HasPrefix(line, "rdr") || strings.HasPrefix(line, "binat"):
			f.nat = append(f.nat, line)
		default:
			f.rules = append(f.rules, line)
		}
	}
	f.anchors = nil
	for _, line := range strings.Split(live.Anchors, "\n") {
		if line = strings.TrimSpace(line); line != "" {
			f.anchors = append(f.anchors, line)
		}
	}
	f.interfaces = live.Interfaces
}

func (f *fakePF) count(call string) int {
	n := 0
	for _, c := range f.calls {
		if c == call {
			n++
		}
	}
	return n
}

func (f *fakePF) ReadPFConf() (string, error)         { return f.conf, nil }
func (f *fakePF) EgressInterfaces() ([]string, error) { return f.egress, f.egressErr }

func (f *fakePF) Pfctl(stdin string, args ...string) (string, string, error) {
	call := strings.Join(args, " ")
	f.calls = append(f.calls, call)
	if f.onCall != nil {
		f.onCall(call)
	}
	if err := f.fail[call]; err != nil {
		return "", "pfctl: " + err.Error(), err
	}
	const anchorFlag = "-a " + pfAnchorPath + " "
	switch {
	case call == "-sn":
		return strings.Join(f.nat, "\n") + "\n", "", nil
	case call == "-sr":
		return strings.Join(f.rules, "\n") + "\n", "", nil
	case call == "-sA":
		var b strings.Builder
		for _, a := range f.anchors {
			fmt.Fprintf(&b, "  %s\n", a)
		}
		return b.String(), "", nil
	case call == "-sI -v":
		return f.interfaces, "", nil
	case call == "-nvf "+pfConfPath:
		return f.declared, "Loading anchor com.apple from /etc/pf.anchors/com.apple\n", nil
	case call == "-f -":
		// A main-ruleset load replaces everything: only what the text declares
		// survives. That is why a service-inserted anchor must refuse.
		f.rules, f.nat = nil, nil
		kept := []string{}
		for _, line := range pfLogicalLines(stdin) {
			fields := strings.Fields(line)
			switch fields[0] {
			case "scrub-anchor":
				f.rules = append(f.rules, line+" all fragment reassemble")
			case "anchor":
				if !f.loadDropsHook || !strings.Contains(line, pfAnchorPath) {
					f.rules = append(f.rules, line+" all")
				}
			case "nat-anchor", "rdr-anchor":
				f.nat = append(f.nat, line+" all")
			case "load":
				kept = append(kept, strings.Trim(fields[2], `"`))
			}
		}
		for _, a := range pfAnchorsIn(strings.Join(f.rules, "\n")) {
			kept = append(kept, strings.SplitN(a, "/", 2)[0])
		}
		f.anchors = uniqueSorted(kept)
		return "", "", nil
	case call == "-E":
		f.enabled = true
		f.nextToken++
		token := fmt.Sprintf("1234567890%d", f.nextToken)
		f.tokens[token] = true
		return "", "No ALTQ support in kernel\nALTQ related functions disabled\npf enabled\nToken : " + token + "\n", nil
	case strings.HasPrefix(call, "-X "):
		token := strings.TrimPrefix(call, "-X ")
		if !f.tokens[token] {
			return "", "pfctl: DIOCSTOPREF: No such process\n", errors.New("exit status 1")
		}
		delete(f.tokens, token)
		if len(f.tokens) == 0 {
			f.enabled = false
		}
		return "", "pf stopped\n", nil
	case call == "-s References":
		var b strings.Builder
		b.WriteString("TOKENS:\nPID      Process Name                TOKEN                     TIMESTAMP\n")
		for token := range f.tokens {
			fmt.Fprintf(&b, "1        pfctl                       %s          0 days\n", token)
		}
		return b.String(), "", nil
	case call == "-si":
		if f.enabled {
			return "Status: Enabled for 0 days 00:00:12           Debug: Urgent\n", "", nil
		}
		return "Status: Disabled for 0 days 00:00:00          Debug: Urgent\n", "", nil
	case call == "-ss":
		return strings.Join(f.states, "\n") + "\n", "", nil
	case strings.HasPrefix(call, "-k "):
		if len(args) != 4 || args[2] != "-k" {
			f.t.Errorf("-k must name both ends of a state: %q", call)
		}
		f.killed = append(f.killed, [2]string{args[1], args[3]})
		return "", "killed 1 states from 1 sources and 0 destinations\n", nil
	case call == anchorFlag+"-f -":
		f.anchorExists, f.anchorRules = true, stdin
		f.anchors = uniqueSorted(append(f.anchors, "com.breeze"))
		return "", "", nil
	case call == anchorFlag+"-F rules":
		f.anchorRules = ""
		return "", "rules cleared\nnat cleared\n0 tables deleted.\n", nil
	case call == anchorFlag+"-sr", call == anchorFlag+"-vsr":
		if !f.anchorExists {
			return "", "pfctl: DIOCGETRULES: Invalid argument\n", errors.New("exit status 1")
		}
		if call == anchorFlag+"-sr" {
			return f.anchorRules, "", nil
		}
		var b strings.Builder
		for _, line := range pfLogicalLines(f.anchorRules) {
			fmt.Fprintf(&b, "%s\n  [ Evaluations: 9         Packets: %-9d Bytes: 540         States: 0     ]\n", line, f.packetsFor(line))
			b.WriteString("  [ Inserted: uid 0 pid 77 ]\n")
		}
		return b.String(), "", nil
	}
	f.t.Errorf("unexpected pfctl invocation: %q", call)
	return "", "", errors.New("unexpected pfctl invocation")
}

func (f *fakePF) packetsFor(line string) uint64 {
	if strings.Contains(line, `label "`+pfDropLabel+`"`) {
		return f.dropPackets
	}
	return 7 // a pass rule's packets must never count as drops
}

func TestCheckCompatibleFixtures(t *testing.T) {
	for _, tc := range []struct {
		fixture string
		want    string // "" = compatible; otherwise a substring of the reason
	}{
		{"already-attached.txt", ""},
		{"internet-sharing.txt", "com.apple.internet-sharing"},
		{"set-skip-en0.txt", "set skip"},
		{"quick-pass-before.txt", "quick pass"},
	} {
		t.Run(tc.fixture, func(t *testing.T) {
			live := pfFixtureLive(t, tc.fixture)
			conf := pfFixture(t, "stock-sequoia.conf")
			anchors := liveOnlyAnchors(append(parsePFAnchorList(live.Anchors), pfAnchorsIn(live.Rules)...), conf)
			err := CheckCompatible(live.Rules+"\n"+live.Interfaces, anchors, []string{"en0"})
			assertCompatibility(t, err, tc.want)
		})
	}
}

func assertCompatibility(t *testing.T, err error, want string) {
	t.Helper()
	if want == "" {
		if err != nil {
			t.Fatalf("want compatible, got %v", err)
		}
		return
	}
	var incompatible ErrIncompatible
	if !errors.As(err, &incompatible) {
		t.Fatalf("want ErrIncompatible containing %q, got %v", want, err)
	}
	if !strings.Contains(incompatible.Reason, want) {
		t.Fatalf("reason %q does not name %q", incompatible.Reason, want)
	}
}

func TestStockConfIsCompatibleAndDeclaresOnlyApple(t *testing.T) {
	conf := pfFixture(t, "stock-sequoia.conf")
	if err := CheckCompatible(conf, nil, []string{"en0"}); err != nil {
		t.Fatalf("stock pf.conf refused: %v", err)
	}
	if got := liveOnlyAnchors([]string{"com.apple", "com.apple/250.ApplicationFirewall"}, conf); len(got) != 0 {
		t.Fatalf("Apple's anchors are declared by the stock file: %v", got)
	}
}

func TestCheckCompatibleRefusals(t *testing.T) {
	for _, tc := range []struct {
		name    string
		rules   string
		anchors []string
		egress  []string
		want    string
	}{
		{name: "set skip list covers egress", rules: "set skip on { lo0 en0 }\n", egress: []string{"en0"}, want: "set skip"},
		{name: "set skip on the driver group covers its interfaces", rules: "set skip on en\n", egress: []string{"en0"}, want: "set skip"},
		{name: "live skip flag", rules: "en0 (skip)\n", egress: []string{"en0"}, want: "set skip"},
		{name: "second egress interface", rules: "set skip on utun3\n", egress: []string{"en0", "utun3"}, want: "set skip"},
		{name: "loopback skip is harmless", rules: "set skip on lo0\nlo0 (skip)\n", egress: []string{"en0"}},
		{name: "skip on another interface is not egress", rules: "set skip on en5\n", egress: []string{"en0"}},
		{name: "no known egress: any non-loopback skip refuses", rules: "set skip on en5\n", want: "set skip"},
		{name: "no known egress: loopback skip is still harmless", rules: "set skip on lo0\n"},
		{name: "commented rule is not a rule", rules: "# set skip on en0\n# pass quick all\n", egress: []string{"en0"}},
		{name: "quick pass in a label does not count", rules: "block drop all label \"pass quick\"\n", egress: []string{"en0"}},
		{name: "quick block cannot bypass us", rules: "block drop quick all\n", egress: []string{"en0"}},
		{name: "non-quick pass cannot beat our quick block", rules: "pass in all\n", egress: []string{"en0"}},
		{name: "quick pass after our hook cannot be reached", rules: "anchor \"com.breeze/isolation\" all\npass quick all\n", egress: []string{"en0"}},
		{name: "quick pass before our hook", rules: "pass out quick all\nanchor \"com.breeze/isolation\" all\n", egress: []string{"en0"}, want: "quick pass"},
		{name: "line continuation", rules: "pass out \\\n  quick all\n", egress: []string{"en0"}, want: "quick pass"},
		{name: "rdr pass skips the filter entirely", rules: "rdr pass on en0 proto tcp from any to any port 22 -> 192.0.2.5\n", egress: []string{"en0"}, want: "quick pass"},
		{name: "rdr pass is evaluated before any filter hook", rules: "anchor \"com.breeze/isolation\" all\nrdr pass on en0 proto tcp from any to any -> 192.0.2.5\n", egress: []string{"en0"}, want: "quick pass"},
		{name: "plain rdr still reaches the filter", rules: "rdr on en0 proto tcp from any to any -> 192.0.2.5\n", egress: []string{"en0"}},
		{name: "internet sharing is not a com.apple sub-anchor", rules: "anchor \"com.apple/*\" all\n", anchors: []string{"com.apple.internet-sharing"}, egress: []string{"en0"}, want: "com.apple.internet-sharing"},
		{name: "foreign anchor a load would destroy", anchors: []string{"com.example.vendor"}, egress: []string{"en0"}, want: "com.example.vendor"},
		{name: "our own anchor", anchors: []string{"com.breeze", "com.breeze/isolation"}, egress: []string{"en0"}},
		{name: "Apple sub-anchor", anchors: []string{"com.apple", "com.apple/200.AirDrop"}, egress: []string{"en0"}},
		// No load happens once attached, so nothing can be destroyed.
		{name: "attached: a service anchor is not at risk", rules: "anchor \"com.breeze/isolation\" all\n", anchors: []string{"com.apple.internet-sharing"}, egress: []string{"en0"}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			assertCompatibility(t, CheckCompatible(tc.rules, tc.anchors, tc.egress), tc.want)
		})
	}
}

func TestLiveOnlyAnchors(t *testing.T) {
	conf := "anchor \"com.example.declared\"\nload anchor \"com.example.loaded\" from \"/etc/x\"\n# anchor \"com.example.comment\"\n"
	got := liveOnlyAnchors([]string{"com.example.declared", "com.example.loaded", "com.example.comment", "com.example.live", "com.example.live"}, conf)
	if strings.Join(got, ",") != "com.example.comment,com.example.live" {
		t.Fatalf("got %v", got)
	}
	// Internet Sharing is refused even in the odd case that pf.conf names it:
	// the file can declare the anchor point but cannot restore its contents.
	if got := liveOnlyAnchors([]string{"com.apple.internet-sharing"}, "anchor \"com.apple.internet-sharing\"\n"); len(got) != 1 {
		t.Fatalf("internet sharing must always be reported: %v", got)
	}
}

func TestPFAnchorsIn(t *testing.T) {
	got := pfAnchorsIn("scrub-anchor \"com.apple/*\" all\nnat-anchor \"a\" all\nrdr-anchor \"b\"\nbinat-anchor \"c\"\ndummynet-anchor \"d\"\nanchor \"e/f\" all\nload anchor \"g\" from \"/x\"\npass all\n")
	if strings.Join(got, ",") != "a,b,c,com.apple,d,e/f,g" {
		t.Fatalf("got %v", got)
	}
}

func TestLiveRulesNotDeclared(t *testing.T) {
	declared := "@0 pass in all\nblock drop   in all\nanchor \"x\" all\n"
	if got := liveRulesNotDeclared("anchor \"foreign\" all\nscrub-anchor \"y\" all\n", declared); len(got) != 0 {
		t.Fatalf("anchors are CheckCompatible's business: %v", got)
	}
	if got := liveRulesNotDeclared("block  drop in all\n", declared); len(got) != 0 {
		t.Fatalf("whitespace differs only: %v", got)
	}
	got := liveRulesNotDeclared("block drop in all\nblock drop out on en0 all\n", declared)
	if len(got) != 1 || got[0] != "block drop out on en0 all" {
		t.Fatalf("got %v", got)
	}
}

func TestAttachOnceLoadsStockRulesetOnceWithOurAnchorFirst(t *testing.T) {
	f := newFakePF(t)
	if err := AttachOnce(f); err != nil {
		t.Fatal(err)
	}
	if got := f.count("-f -"); got != 1 {
		t.Fatalf("main ruleset loads = %d\n%v", got, f.calls)
	}
	present, err := ParentHookPresent(f)
	if err != nil || !present {
		t.Fatalf("hook present=%v err=%v", present, err)
	}
	// Ahead of Apple's filter anchor, whose run-time sub-anchors could
	// otherwise pass a packet quick before our drop is evaluated.
	want := []string{`scrub-anchor "com.apple/*" all fragment reassemble`, `anchor "com.breeze/isolation" all`, `anchor "com.apple/*" all`}
	if strings.Join(f.rules, "\n") != strings.Join(want, "\n") {
		t.Fatalf("filter order: %v", f.rules)
	}
	if strings.Join(f.anchors, ",") != "com.apple,com.breeze" {
		t.Fatalf("load dropped an anchor: %v", f.anchors)
	}
}

func TestPFAttachText(t *testing.T) {
	stock := pfFixture(t, "stock-sequoia.conf")
	got := pfAttachText(stock)
	if want := strings.Replace(stock, "anchor \"com.apple/*\"\nload", pfHookLine+"\nanchor \"com.apple/*\"\nload", 1); got != want {
		t.Fatalf("got:\n%s", got)
	}
	// Every original line survives, in order: nothing is rewritten.
	if strings.Replace(got, pfHookLine+"\n", "", 1) != stock {
		t.Fatal("the load text is not the file plus one line")
	}
	for _, tc := range []struct{ conf, want string }{
		{"", pfHookLine + "\n"},
		{"set skip on lo0\n", "set skip on lo0\n" + pfHookLine + "\n"},
		{"# anchor \"x\"\nblock drop all\n", "# anchor \"x\"\n" + pfHookLine + "\nblock drop all\n"},
		{"nat on en0 \\\n  pass from any to any\npass all\n", "nat on en0 \\\n  pass from any to any\n" + pfHookLine + "\npass all\n"},
		{"rdr-anchor \"r\"\nanchor \"a\"\n", "rdr-anchor \"r\"\n" + pfHookLine + "\nanchor \"a\"\n"},
	} {
		if got := pfAttachText(tc.conf); got != tc.want {
			t.Errorf("pfAttachText(%q) = %q, want %q", tc.conf, got, tc.want)
		}
	}
}

// The plan's central rule: the second apply must never load the main ruleset,
// because that load is what destroys anchors other services inserted.
func TestAttachOnceSecondApplyNeverLoadsTheMainRuleset(t *testing.T) {
	f := newFakePF(t)
	for n := 0; n < 3; n++ {
		if err := AttachOnce(f); err != nil {
			t.Fatal(err)
		}
	}
	if got := f.count("-f -"); got != 1 {
		t.Fatalf("main ruleset loaded %d times:\n%v", got, f.calls)
	}
}

func TestAttachOnceAlreadyAttachedLoadsNothing(t *testing.T) {
	f := newFakePF(t)
	f.useLive(pfFixtureLive(t, "already-attached.txt"))
	if err := AttachOnce(f); err != nil {
		t.Fatal(err)
	}
	if got := f.count("-f -"); got != 0 {
		t.Fatalf("main ruleset loaded %d times", got)
	}
}

func TestAttachOnceRefusalsDestroyNothing(t *testing.T) {
	for _, tc := range []struct {
		fixture string
		want    string
	}{
		{"internet-sharing.txt", "com.apple.internet-sharing"},
		{"set-skip-en0.txt", "set skip"},
		{"quick-pass-before.txt", "quick pass"},
	} {
		t.Run(tc.fixture, func(t *testing.T) {
			f := newFakePF(t)
			f.useLive(pfFixtureLive(t, tc.fixture))
			before := strings.Join(append(append([]string{}, f.rules...), f.anchors...), "\n")
			assertCompatibility(t, AttachOnce(f), tc.want)
			if got := f.count("-f -"); got != 0 {
				t.Fatalf("refused, but loaded the main ruleset %d times", got)
			}
			if after := strings.Join(append(append([]string{}, f.rules...), f.anchors...), "\n"); after != before {
				t.Fatalf("refused, but the ruleset changed:\n%s\n---\n%s", before, after)
			}
		})
	}
}

// A load replaces the live main ruleset with /etc/pf.conf. So the file has to
// be acceptable too, and live rules it would not restore must not be destroyed.
func TestAttachOnceChecksWhatTheLoadWouldInstallAndLose(t *testing.T) {
	t.Run("pf.conf would install a quick pass", func(t *testing.T) {
		f := newFakePF(t)
		f.conf += "\npass out quick all\n"
		assertCompatibility(t, AttachOnce(f), "quick pass")
		if got := f.count("-f -"); got != 0 {
			t.Fatalf("loaded %d times", got)
		}
	})
	t.Run("pf.conf would install a set skip", func(t *testing.T) {
		f := newFakePF(t)
		f.conf = "set skip on en0\n" + f.conf
		assertCompatibility(t, AttachOnce(f), "set skip")
	})
	t.Run("an admin's rule the file would not restore", func(t *testing.T) {
		f := newFakePF(t)
		f.rules = append(f.rules, "block drop in on en0 inet proto tcp from any to any port = 445")
		assertCompatibility(t, AttachOnce(f), "port = 445")
		if got := f.count("-f -"); got != 0 {
			t.Fatalf("loaded %d times", got)
		}
	})
	t.Run("a rule the file does restore", func(t *testing.T) {
		f := newFakePF(t)
		rule := "block drop in on en0 inet proto tcp from any to any port = 445"
		f.rules = append(f.rules, rule)
		f.declared += rule + "\n"
		if err := AttachOnce(f); err != nil {
			t.Fatal(err)
		}
	})
}

func TestAttachOnceFailures(t *testing.T) {
	sentinel := errors.New("boom")
	for _, call := range []string{"-sr", "-sn", "-sA", "-sI -v", "-nvf " + pfConfPath, "-f -"} {
		t.Run(call, func(t *testing.T) {
			f := newFakePF(t)
			f.fail[call] = sentinel
			err := AttachOnce(f)
			if !errors.Is(err, sentinel) {
				t.Fatalf("got %v", err)
			}
			var incompatible ErrIncompatible
			if errors.As(err, &incompatible) {
				t.Fatalf("a pfctl failure is not a refusal: %v", err)
			}
		})
	}
	t.Run("egress lookup", func(t *testing.T) {
		f := newFakePF(t)
		f.egressErr = sentinel
		if err := AttachOnce(f); !errors.Is(err, sentinel) {
			t.Fatalf("got %v", err)
		}
	})
	t.Run("load reported success but the hook is absent", func(t *testing.T) {
		f := newFakePF(t)
		f.loadDropsHook = true
		if err := AttachOnce(f); err == nil || !strings.Contains(err.Error(), "not attached") {
			t.Fatalf("got %v", err)
		}
	})
}

func TestParentHookPresentNeedsTheExactAnchor(t *testing.T) {
	for rules, want := range map[string]bool{
		`anchor "com.breeze/isolation" all`:  true,
		`anchor "com.breeze/isolation"`:      true,
		`anchor "com.breeze/isolation2" all`: false,
		// A qualified anchor enforces on only part of the traffic: not attached.
		`anchor "com.breeze/isolation" in all`:       false,
		`anchor "com.breeze/isolation" on en0 all`:   false,
		`anchor "com.breeze/isolation" out inet all`: false,
		`nat-anchor "com.breeze/isolation"`:          false,
		`# anchor "com.breeze/isolation" all`:        false,
		`anchor "com.apple/*" all`:                   false,
	} {
		f := newFakePF(t)
		f.rules = []string{rules}
		got, err := ParentHookPresent(f)
		if err != nil || got != want {
			t.Errorf("%s: got %v err %v, want %v", rules, got, err, want)
		}
	}
}

// The plan's tripwire. The pf reference count exists so that one user cannot
// turn pf off under another; this package only ever releases its own reference.
// Comments are in scope too, so nobody can talk themselves into it later.
func TestNoPfDisableAnywhereInThePackage(t *testing.T) {
	needle := regexp.MustCompile(`pfctl\s+-d\b|"-d"`)
	err := filepath.WalkDir(".", func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if d.IsDir() {
			if d.Name() == "testdata" {
				return filepath.SkipDir
			}
			return nil
		}
		if !strings.HasSuffix(path, ".go") || path == "pfconf_test.go" {
			return nil
		}
		b, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		if loc := needle.FindIndex(b); loc != nil {
			t.Errorf("%s disables pf: %q", path, b[loc[0]:loc[1]])
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
}
