package security

import (
	"errors"
	"strings"
	"testing"
	"time"
)

type fwCall struct{ name string }

// Not parallel: swaps package-level seams.
func stubFirewall(t *testing.T, major int, known bool, defaultsOut string, defaultsErr error, sfwOut string, sfwErr error) *[]fwCall {
	t.Helper()
	origRun, origVer := runFirewallCommand, macOSMajorVersion
	var calls []fwCall
	runFirewallCommand = func(_ time.Duration, name string, _ ...string) (string, error) {
		calls = append(calls, fwCall{name})
		if name == "defaults" {
			return defaultsOut, defaultsErr
		}
		return sfwOut, sfwErr
	}
	macOSMajorVersion = func() (int, bool) { return major, known }
	t.Cleanup(func() { runFirewallCommand, macOSMajorVersion = origRun, origVer })
	return &calls
}

const sfwPath = "/usr/libexec/ApplicationFirewall/socketfilterfw"

func TestFirewallDarwinModernSkipsDefaults(t *testing.T) {
	for _, major := range []int{15, 26, 27} {
		calls := stubFirewall(t, major, true, "", errors.New("domain not found"), "Firewall is enabled. (State = 1)", nil)
		on, err := getFirewallStatusDarwin()
		if err != nil || !on {
			t.Fatalf("major %d: on=%v err=%v", major, on, err)
		}
		if len(*calls) != 1 || (*calls)[0].name != sfwPath {
			t.Fatalf("major %d: calls=%v", major, *calls)
		}
	}
}

func TestFirewallDarwin14UsesDefaultsOnly(t *testing.T) {
	calls := stubFirewall(t, 14, true, "0\n", nil, "Firewall is enabled. (State = 1)", nil)
	on, err := getFirewallStatusDarwin()
	if err != nil || on {
		t.Fatalf("on=%v err=%v", on, err)
	}
	if len(*calls) != 1 || (*calls)[0].name != "defaults" {
		t.Fatalf("calls=%v", *calls)
	}
}

func TestFirewallDarwin14DefaultsFailingFallsBack(t *testing.T) {
	calls := stubFirewall(t, 14, true, "", errors.New("boom"), "Firewall is disabled. (State = 0)", nil)
	on, err := getFirewallStatusDarwin()
	if err != nil || on {
		t.Fatalf("on=%v err=%v", on, err)
	}
	if len(*calls) != 2 || (*calls)[0].name != "defaults" || (*calls)[1].name != sfwPath {
		t.Fatalf("calls=%v", *calls)
	}
}

func TestFirewallDarwinUnknownVersionKeepsOldOrder(t *testing.T) {
	calls := stubFirewall(t, 0, false, "", errors.New("boom"), "Firewall is enabled. (State = 1)", nil)
	on, err := getFirewallStatusDarwin()
	if err != nil || !on {
		t.Fatalf("on=%v err=%v", on, err)
	}
	if len(*calls) != 2 || (*calls)[0].name != "defaults" {
		t.Fatalf("calls=%v", *calls)
	}
}

func TestFirewallDarwinUndeterminedIsError(t *testing.T) {
	stubFirewall(t, 27, true, "", nil, "garbage", nil)
	if _, err := getFirewallStatusDarwin(); err == nil || !strings.Contains(err.Error(), "unable to determine firewall state") {
		t.Fatalf("err=%v", err)
	}
}

func TestParseSocketfilterfwState(t *testing.T) {
	cases := []struct {
		name, out   string
		enabled, ok bool
	}{
		{"on", "Firewall is enabled. (State = 1)", true, true},
		{"off", "Firewall is disabled. (State = 0)", false, true},
		{"essential", "Firewall is enabled. (State = 2)", true, true},
		{"localized", "Le pare-feu est active. (State = 1)", true, true},
		{"localized off", "Brandmauer ist aus. (State = 0)", false, true},
		{"english no state", "Firewall is enabled.", true, true},
		{"english disabled no state", "Firewall is disabled.", false, true},
		{"unknown number falls through to text", "Firewall is enabled. (State = 7)", true, true},
		{"unknown number no text", "(State = 7)", false, false},
		{"garbage", "nope", false, false},
		{"empty", "", false, false},
	}
	for _, c := range cases {
		en, ok := parseSocketfilterfwState(c.out)
		if en != c.enabled || ok != c.ok {
			t.Errorf("%s: got %v,%v want %v,%v", c.name, en, ok, c.enabled, c.ok)
		}
	}
}

func TestParseMacOSMajor(t *testing.T) {
	cases := map[string]struct {
		n  int
		ok bool
	}{"27.0.1": {27, true}, "15.0": {15, true}, "14": {14, true}, " 14.4\n": {14, true}, "": {0, false}, "x": {0, false}}
	for in, want := range cases {
		n, ok := parseMacOSMajor(in)
		if n != want.n || ok != want.ok {
			t.Errorf("%q: got %d,%v", in, n, ok)
		}
	}
}
