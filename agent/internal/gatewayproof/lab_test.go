package gatewayproof

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net"
	"net/netip"
	"os"
	"os/user"
	"runtime"
	"runtime/debug"
	"slices"
	"strconv"
	"strings"
	"testing"
	"time"
)

// TestProve_Lab is the W02b lab harness. It sends real ARP requests (or asks
// iphlpapi to), so it skips unless GATEWAYPROOF_LAB=1 and runs only on the lab
// rig, launched under the agent's service account. It prints one line per
// call and never prints a MAC or an address, so its output can be pasted into
// the public evidence file.
//
// Inputs: GATEWAYPROOF_IFACE (interface name), GATEWAYPROOF_SOURCE,
// GATEWAYPROOF_GATEWAY, GATEWAYPROOF_EXPECT_MAC, GATEWAYPROOF_PLANTED_MAC
// (optional), GATEWAYPROOF_CALLS (default 1), GATEWAYPROOF_TIMEOUT (default
// 1s), GATEWAYPROOF_WINDOWS_METHOD (Windows; W1 when unset).
func TestProve_Lab(t *testing.T) {
	if os.Getenv("GATEWAYPROOF_LAB") != "1" {
		t.Skip("lab only: set GATEWAYPROOF_LAB=1 on the lab rig (sends ARP requests)")
	}
	cfg, err := labConfigFromEnv(os.Getenv, net.InterfaceByName)
	if err != nil {
		t.Fatal(err)
	}
	fmt.Println(labHeader(currentUser(), cgoSetting(), runtime.GOOS, cfg.method))
	s := runLab(cfg, Prove, os.Stdout)
	if s.planted > 0 {
		t.Errorf("%d of %d calls returned the planted MAC", s.planted, s.calls)
	}
}

type labConfig struct {
	iface   Interface
	gateway netip.Addr
	expect  net.HardwareAddr
	planted net.HardwareAddr // nil when not set
	calls   int
	timeout time.Duration
	method  string
}

func labConfigFromEnv(getenv func(string) string, byName func(string) (*net.Interface, error)) (labConfig, error) {
	cfg := labConfig{calls: 1, timeout: defaultTimeout}
	need := func(key string) (string, error) {
		v := strings.TrimSpace(getenv(key))
		if v == "" {
			return "", fmt.Errorf("%s is required", key)
		}
		return v, nil
	}
	name, err := need("GATEWAYPROOF_IFACE")
	if err != nil {
		return cfg, err
	}
	ni, err := byName(name)
	if err != nil {
		return cfg, fmt.Errorf("GATEWAYPROOF_IFACE: %w", err)
	}
	cfg.iface = Interface{Name: ni.Name, Index: uint32(ni.Index)}
	for _, a := range []struct {
		key string
		dst *netip.Addr
	}{{"GATEWAYPROOF_SOURCE", &cfg.iface.Source}, {"GATEWAYPROOF_GATEWAY", &cfg.gateway}} {
		v, err := need(a.key)
		if err != nil {
			return cfg, err
		}
		if *a.dst, err = netip.ParseAddr(v); err != nil {
			return cfg, fmt.Errorf("%s: not an address", a.key)
		}
	}
	v, err := need("GATEWAYPROOF_EXPECT_MAC")
	if err != nil {
		return cfg, err
	}
	if cfg.expect, err = net.ParseMAC(v); err != nil || len(cfg.expect) != 6 {
		return cfg, errors.New("GATEWAYPROOF_EXPECT_MAC: not a 6-byte MAC")
	}
	if v := strings.TrimSpace(getenv("GATEWAYPROOF_PLANTED_MAC")); v != "" {
		if cfg.planted, err = net.ParseMAC(v); err != nil || len(cfg.planted) != 6 {
			return cfg, errors.New("GATEWAYPROOF_PLANTED_MAC: not a 6-byte MAC")
		}
	}
	if v := strings.TrimSpace(getenv("GATEWAYPROOF_CALLS")); v != "" {
		if cfg.calls, err = strconv.Atoi(v); err != nil || cfg.calls < 1 {
			return cfg, errors.New("GATEWAYPROOF_CALLS: want a positive integer")
		}
	}
	if v := strings.TrimSpace(getenv("GATEWAYPROOF_TIMEOUT")); v != "" {
		if cfg.timeout, err = time.ParseDuration(v); err != nil || cfg.timeout <= 0 {
			return cfg, errors.New("GATEWAYPROOF_TIMEOUT: want a positive duration such as 1s")
		}
	}
	cfg.method, err = labMethod(runtime.GOOS, getenv("GATEWAYPROOF_WINDOWS_METHOD"))
	return cfg, err
}

// labMethod names the mechanism the harness exercises on goos.
func labMethod(goos, windowsMethodEnv string) (string, error) {
	switch goos {
	case "windows":
		m, err := parseWindowsMethod(windowsMethodEnv)
		if err != nil {
			return "", err
		}
		return m.String(), nil
	case "linux":
		return "L1-af_packet", nil
	case "darwin":
		return "M1-bpf", nil
	}
	return "", fmt.Errorf("no gateway proof on %s", goos)
}

func currentUser() string {
	u, err := user.Current()
	if err != nil {
		return "unknown"
	}
	return u.Username
}

// cgoSetting is CGO_ENABLED as recorded in the binary's build info, or
// "unknown" when the binary carries none.
func cgoSetting() string {
	bi, ok := debug.ReadBuildInfo()
	if !ok {
		return "unknown"
	}
	for _, s := range bi.Settings {
		if s.Key == "CGO_ENABLED" {
			return s.Value
		}
	}
	return "unknown"
}

func labHeader(username, cgo, goos, method string) string {
	return fmt.Sprintf("user=%s cgo=%s goos=%s method=%s", username, cgo, goos, method)
}

type labCall struct {
	n          int
	start, end time.Time
	mac        net.HardwareAddr
	err        error
	trace      string
}

func (c labCall) duration() time.Duration { return c.end.Sub(c.start) }

func classify(mac, expect, planted net.HardwareAddr) string {
	switch {
	case mac == nil:
		return "-"
	case slices.Equal(mac, expect):
		return "expected"
	case planted != nil && slices.Equal(mac, planted):
		return "planted"
	}
	return "other"
}

func resultText(c labCall) string {
	switch {
	case c.err == nil:
		return "ok"
	case errors.Is(c.err, ErrNoAnswer):
		return "no_answer"
	}
	return "error:" + strconv.Quote(c.err.Error())
}

func formatCall(c labCall, match string) string {
	return fmt.Sprintf("call=%d start=%s end=%s ms=%s result=%s match=%s detail=%s",
		c.n, c.start.UTC().Format(time.RFC3339Nano), c.end.UTC().Format(time.RFC3339Nano),
		formatMS(c.duration()), resultText(c), match, c.trace)
}

func formatMS(d time.Duration) string {
	return strconv.FormatFloat(float64(d)/float64(time.Millisecond), 'f', 1, 64)
}

type labSummary struct {
	calls, ok, expected, planted, other, noAnswer, errors int
	median, max                                           time.Duration
}

func (s labSummary) String() string {
	return fmt.Sprintf("summary calls=%d ok=%d expected=%d planted=%d other=%d no_answer=%d errors=%d median_ms=%s max_ms=%s",
		s.calls, s.ok, s.expected, s.planted, s.other, s.noAnswer, s.errors, formatMS(s.median), formatMS(s.max))
}

// runLab makes cfg.calls back-to-back calls of prove, each with its own
// cfg.timeout, writes one line per call and the summary line to out, and
// returns the summary.
func runLab(cfg labConfig, prove func(context.Context, Interface, netip.Addr) (net.HardwareAddr, error), out io.Writer) labSummary {
	var s labSummary
	durations := make([]time.Duration, 0, cfg.calls)
	for n := 1; n <= cfg.calls; n++ {
		ctx, tr := withTrace(context.Background())
		ctx, cancel := context.WithTimeout(ctx, cfg.timeout)
		c := labCall{n: n, start: time.Now()}
		c.mac, c.err = prove(ctx, cfg.iface, cfg.gateway)
		c.end = time.Now()
		cancel()
		c.trace = tr.String()
		match := classify(c.mac, cfg.expect, cfg.planted)
		_, _ = fmt.Fprintln(out, formatCall(c, match))

		s.calls++
		switch {
		case c.err == nil:
			s.ok++
		case errors.Is(c.err, ErrNoAnswer):
			s.noAnswer++
		default:
			s.errors++
		}
		switch match {
		case "expected":
			s.expected++
		case "planted":
			s.planted++
		case "other":
			s.other++
		}
		durations = append(durations, c.duration())
	}
	slices.Sort(durations)
	if k := len(durations); k > 0 {
		s.max = durations[k-1]
		s.median = durations[k/2]
		if k%2 == 0 {
			s.median = (durations[k/2-1] + durations[k/2]) / 2
		}
	}
	_, _ = fmt.Fprintln(out, s.String())
	return s
}
