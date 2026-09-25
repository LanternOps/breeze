package hwhealth

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"testing"
	"time"
)

func TestSMARTFixtures(t *testing.T) {
	for _, name := range []string{"optimal", "degraded", "failed", "rebuilding-with-progress", "predictive", "missing-member", "multi-controller", "unrecognized-state", "truncated"} {
		code := 0
		if name == "missing-member" {
			code = 2
		}
		c, e := parseSMART(fixture(t, "smartctl", name+".json"), code, smartDevice{Name: "/dev/sda", Type: "sat"}, time.Unix(10, 0))
		if name == "missing-member" || name == "truncated" {
			if e == nil {
				t.Fatal(name)
			}
			continue
		}
		if e != nil {
			t.Fatal(e)
		}
		if c.PredictiveFailure != (name == "failed" || name == "predictive") {
			t.Fatalf("%s %+v", name, c)
		}
		if name == "unrecognized-state" && c.State != "unknown" {
			t.Fatal(c)
		}
		if name == "failed" && (c.SmartPassed == nil || *c.SmartPassed) {
			t.Fatal(c)
		}
	}
}

func TestSMARTCapacityFallback(t *testing.T) {
	cases := []struct {
		fixture  string
		wantSize *int64
	}{
		{"optimal", ptr(int64(1000))},
		{"nvme-no-capacity", nil},
		{"nvme-no-capacity-with-namespaces", ptr(int64(4294967296))},
		{"nvme-total-capacity-fallback", ptr(int64(4294967296))},
		{"user-capacity-zero", nil},
		{"nvme-total-capacity-zero", ptr(int64(2147483648))},
		{"nvme-total-capacity-precedence", ptr(int64(8589934592))},
		{"nvme-namespaces-zero", nil},
	}
	for _, tc := range cases {
		t.Run(tc.fixture, func(t *testing.T) {
			c, e := parseSMART(fixture(t, "smartctl", tc.fixture+".json"), 0, smartDevice{Name: "/dev/nvme0", Type: "nvme"}, time.Unix(10, 0))
			if e != nil {
				t.Fatal(e)
			}
			switch {
			case tc.wantSize == nil && c.SizeBytes != nil:
				t.Fatalf("expected nil SizeBytes, got %d", *c.SizeBytes)
			case tc.wantSize != nil && (c.SizeBytes == nil || *c.SizeBytes != *tc.wantSize):
				t.Fatalf("expected SizeBytes %d, got %+v", *tc.wantSize, c.SizeBytes)
			}
		})
	}
}

func TestSMARTExitBits(t *testing.T) {
	for bit := 0; bit < 8; bit++ {
		c, e := parseSMART(fixture(t, "smartctl", "optimal.json"), 1<<bit, smartDevice{Name: "/dev/sda", Type: "sat"}, time.Unix(1, 0))
		if (e != nil) != (bit < 3) {
			t.Fatalf("bit %d err %v", bit, e)
		}
		if bit == 3 && (c.SmartPassed == nil || *c.SmartPassed || !c.PredictiveFailure) {
			t.Fatal(c)
		}
	}
}

func TestSMARTDeviceLimit(t *testing.T) {
	count := 0
	run := func(_ context.Context, _ time.Duration, _ string, args ...string) (execResult, error) {
		if args[0] == "--scan-open" {
			rows := []string{}
			for i := 0; i < 65; i++ {
				rows = append(rows, fmt.Sprintf(`{"name":"/dev/d%d","type":"sat"}`, i))
			}
			return execResult{Stdout: []byte(`{"devices":[` + strings.Join(rows, ",") + `]}`)}, nil
		}
		count++
		return execResult{Stdout: fixture(t, "smartctl", "optimal.json")}, nil
	}
	r, e := newSMART(nil, run, time.Now).Collect(context.Background(), Availability{Available: true, Path: "smartctl"})
	if e != nil || count != 64 || r.Complete || len(r.Components) != 64 {
		t.Fatalf("%d %+v %v", count, r, e)
	}
	for _, c := range r.Components {
		if !strings.HasPrefix(c.ComponentKey, "smart:dev:") {
			t.Fatal("duplicate serial merged", c)
		}
	}
}

// Shared by the source regression here and the full collector regression in Task 13.
func smartIdentityCases() []struct {
	name          string
	serials, keys [2]string
} {
	fallback := [2]string{"smart:dev:megaraid,0:/dev/bus/0", "smart:dev:megaraid,1:/dev/bus/0"}
	return []struct {
		name          string
		serials, keys [2]string
	}{
		{"blank", [2]string{"", ""}, fallback},
		{"whitespace", [2]string{" ", "\t"}, fallback},
		{"duplicate", [2]string{"DUP", "DUP"}, fallback},
		{"trimmed_duplicate", [2]string{" DUP ", "DUP"}, fallback},
		{"unique", [2]string{" A ", "B"}, [2]string{"smart:A", "smart:B"}},
	}
}

func smartSharedPathSource(t *testing.T, serials [2]string, reverse, failedProbe bool) Source {
	t.Helper()
	return newSMART(nil, func(_ context.Context, timeout time.Duration, path string, args ...string) (execResult, error) {
		if timeout != 15*time.Second || path != "fixture-smartctl" {
			t.Fatalf("unexpected invocation: %s %v", path, timeout)
		}
		if strings.Join(args, " ") == "--scan-open -j" {
			devices := []map[string]string{{"name": "/dev/bus/0", "type": "megaraid,0"}, {"name": "/dev/bus/0", "type": "megaraid,1"}}
			if reverse {
				devices[0], devices[1] = devices[1], devices[0]
			}
			if failedProbe {
				devices = append(devices[:1], append([]map[string]string{{"name": "/dev/bus/0", "type": "megaraid,9"}}, devices[1:]...)...)
			}
			b, e := json.Marshal(map[string]any{"devices": devices})
			if e != nil {
				t.Fatal(e)
			}
			return execResult{Stdout: b}, nil
		}
		if len(args) != 5 || strings.Join(args[:4], " ") != "-a -j /dev/bus/0 -d" {
			t.Fatalf("scan identity lost in command: %v", args)
		}
		i := 0
		switch args[4] {
		case "megaraid,0":
		case "megaraid,1":
			i = 1
		case "megaraid,9":
			return execResult{ExitCode: 2, Stdout: []byte(`{}`)}, nil
		default:
			t.Fatalf("unexpected type: %s", args[4])
		}
		b, e := json.Marshal(map[string]any{"serial_number": serials[i], "smart_status": map[string]any{"passed": i == 0}, "temperature": map[string]any{"current": 30 + i}})
		if e != nil {
			t.Fatal(e)
		}
		return execResult{Stdout: b}, nil
	}, func() time.Time { return time.Unix(100, 0) })
}

func assertSMARTIdentityRows(t *testing.T, rows []Component, keys [2]string) {
	t.Helper()
	if len(rows) != 2 {
		t.Fatalf("lost shared-path probes: %+v", rows)
	}
	for i, key := range keys {
		c := findComponent(t, rows, key)
		if c.Source != "smartctl" || c.Name != "/dev/bus/0" || c.Attributes["osDevice"] != "/dev/bus/0" || c.TemperatureC == nil || *c.TemperatureC != 30+i || c.SmartPassed == nil || *c.SmartPassed != (i == 0) || c.PredictiveFailure != (i == 1) {
			t.Fatalf("probe evidence assigned to wrong identity: %+v", c)
		}
	}
}

func TestSMARTSharedPathIdentity(t *testing.T) {
	for _, tc := range smartIdentityCases() {
		for _, reverse := range []bool{false, true} {
			for _, failedProbe := range []bool{false, true} {
				t.Run(fmt.Sprintf("%s/reverse=%t/failed=%t", tc.name, reverse, failedProbe), func(t *testing.T) {
					src := smartSharedPathSource(t, tc.serials, reverse, failedProbe)
					r, e := src.Collect(context.Background(), Availability{Available: true, Path: "fixture-smartctl"})
					if e != nil || r.Complete == failedProbe {
						t.Fatalf("%+v %v", r, e)
					}
					assertSMARTIdentityRows(t, r.Components, tc.keys)
				})
			}
		}
	}
}
