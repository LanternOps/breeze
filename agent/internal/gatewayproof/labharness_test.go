package gatewayproof

import (
	"bytes"
	"context"
	"errors"
	"maps"
	"net"
	"net/netip"
	"regexp"
	"strings"
	"testing"
	"time"
)

// These tests cover the lab harness's pure parts, which cannot otherwise run
// before a lab trip. None of them sends anything.

func labEnv(over map[string]string) func(string) string {
	env := map[string]string{
		"GATEWAYPROOF_IFACE":      "eth0",
		"GATEWAYPROOF_SOURCE":     "192.168.1.57",
		"GATEWAYPROOF_GATEWAY":    "192.168.1.1",
		"GATEWAYPROOF_EXPECT_MAC": "a4:2b:b0:11:22:9c",
	}
	maps.Copy(env, over)
	return func(k string) string { return env[k] }
}

func fakeByName(name string) (*net.Interface, error) {
	if name != "eth0" {
		return nil, errors.New("no such interface")
	}
	return &net.Interface{Name: "eth0", Index: 3}, nil
}

func TestLabConfigFromEnv(t *testing.T) {
	cfg, err := labConfigFromEnv(labEnv(nil), fakeByName)
	if err != nil {
		t.Fatal(err)
	}
	if cfg.iface != (Interface{Name: "eth0", Index: 3, Source: src}) || cfg.gateway != gw ||
		cfg.expect.String() != gwMAC.String() || cfg.planted != nil || cfg.calls != 1 || cfg.timeout != time.Second {
		t.Fatalf("defaults: %+v", cfg)
	}
	cfg, err = labConfigFromEnv(labEnv(map[string]string{
		"GATEWAYPROOF_PLANTED_MAC": "3c-37-86-aa-bb-10", "GATEWAYPROOF_CALLS": "100", "GATEWAYPROOF_TIMEOUT": "750ms",
	}), fakeByName)
	if err != nil || cfg.planted.String() != "3c:37:86:aa:bb:10" || cfg.calls != 100 || cfg.timeout != 750*time.Millisecond {
		t.Fatalf("overrides: %+v %v", cfg, err)
	}
	for name, over := range map[string]map[string]string{
		"missing iface":    {"GATEWAYPROOF_IFACE": ""},
		"unknown iface":    {"GATEWAYPROOF_IFACE": "wlan9"},
		"missing expect":   {"GATEWAYPROOF_EXPECT_MAC": ""},
		"bad source":       {"GATEWAYPROOF_SOURCE": "nope"},
		"bad planted":      {"GATEWAYPROOF_PLANTED_MAC": "zz"},
		"zero calls":       {"GATEWAYPROOF_CALLS": "0"},
		"negative timeout": {"GATEWAYPROOF_TIMEOUT": "-1s"},
	} {
		if _, err := labConfigFromEnv(labEnv(over), fakeByName); err == nil {
			t.Errorf("%s: accepted", name)
		}
	}
}

func TestLabMethod(t *testing.T) {
	for _, tc := range []struct{ goos, env, want string }{
		{"windows", "", "W1-resolve"}, {"windows", "W3", "W3-delete-sendarp"},
		{"linux", "W3", "L1-af_packet"}, {"darwin", "", "M1-bpf"},
	} {
		if got, err := labMethod(tc.goos, tc.env); err != nil || got != tc.want {
			t.Errorf("labMethod(%s, %q) = %q, %v; want %q", tc.goos, tc.env, got, err, tc.want)
		}
	}
	if _, err := labMethod("windows", "W7"); err == nil {
		t.Error("unknown Windows method accepted")
	}
}

// Criterion 6 depends on this line: the binary must report how it was built.
func TestLabCGOSettingIsReported(t *testing.T) {
	if got := cgoSetting(); got != "0" && got != "1" {
		t.Fatalf("cgoSetting() = %q, want 0 or 1 from the build info", got)
	}
}

func TestRunLab(t *testing.T) {
	planted := mustMAC("3c:37:86:aa:bb:10")
	script := []struct {
		mac net.HardwareAddr
		err error
	}{
		{gwMAC, nil},
		{planted, nil},
		{mustMAC("00:1a:8c:00:00:01"), nil},
		{nil, ErrNoAnswer},
		{nil, errors.New("gatewayproof: open AF_PACKET socket: operation not permitted")},
	}
	n := 0
	prove := func(ctx context.Context, iface Interface, gateway netip.Addr) (net.HardwareAddr, error) {
		if _, ok := ctx.Deadline(); !ok {
			t.Error("call without a deadline")
		}
		tracef(ctx, "mech=fake")
		r := script[n]
		n++
		// Spaced well past one tick of a coarse (Windows) clock, so the median is non-zero.
		time.Sleep(time.Duration(n) * 20 * time.Millisecond)
		return r.mac, r.err
	}
	var out bytes.Buffer
	cfg := labConfig{iface: Interface{Name: "eth0", Index: 3, Source: src}, gateway: gw, expect: gwMAC,
		planted: planted, calls: len(script), timeout: time.Second}
	s := runLab(cfg, prove, &out)
	if s.calls != 5 || s.ok != 3 || s.expected != 1 || s.planted != 1 || s.other != 1 || s.noAnswer != 1 || s.errors != 1 {
		t.Fatalf("summary %+v", s)
	}
	if s.median <= 0 || s.max < s.median {
		t.Fatalf("times: median %v max %v", s.median, s.max)
	}
	lines := strings.Split(strings.TrimSpace(out.String()), "\n")
	if len(lines) != 6 {
		t.Fatalf("got %d lines:\n%s", len(lines), out.String())
	}
	call := regexp.MustCompile(`^call=\d+ start=\S+ end=\S+ ms=[0-9.]+ result=(ok|no_answer|error:".*") match=(expected|planted|other|-) detail=mech=fake$`)
	for i, want := range []string{"match=expected", "match=planted", "match=other", "result=no_answer match=-", `result=error:"gatewayproof: open AF_PACKET socket: operation not permitted" match=-`} {
		if !call.MatchString(lines[i]) || !strings.Contains(lines[i], want) {
			t.Errorf("line %d = %q, want the call format with %q", i, lines[i], want)
		}
	}
	if !regexp.MustCompile(`^summary calls=5 ok=3 expected=1 planted=1 other=1 no_answer=1 errors=1 median_ms=[0-9.]+ max_ms=[0-9.]+$`).MatchString(lines[5]) {
		t.Errorf("summary line = %q", lines[5])
	}
	// The output goes into a public file: no MAC and no address, ever.
	if regexp.MustCompile(`(?i)([0-9a-f]{2}[:-]){5}[0-9a-f]{2}|(\d{1,3}\.){3}\d{1,3}`).MatchString(out.String()) {
		t.Errorf("output carries a MAC or an address:\n%s", out.String())
	}
}

func TestLabHeader(t *testing.T) {
	if got := labHeader("root", "0", "linux", "L1-af_packet"); got != "user=root cgo=0 goos=linux method=L1-af_packet" {
		t.Fatalf("header = %q", got)
	}
}
