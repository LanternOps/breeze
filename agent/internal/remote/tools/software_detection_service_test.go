package tools

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/breeze-rmm/agent/internal/svcquery"
)

// stubServiceStatus swaps the platform service lookup for the test and records
// every name it was asked about. Not parallel-safe: it replaces a package var.
func stubServiceStatus(t *testing.T, fn func(name string) (bool, bool)) *[]string {
	t.Helper()
	orig := serviceStatusFn
	var calls []string
	serviceStatusFn = func(name string) (bool, bool) {
		calls = append(calls, name)
		return fn(name)
	}
	t.Cleanup(func() { serviceStatusFn = orig })
	return &calls
}

func TestEvaluateDetectionRules_ServiceRunning(t *testing.T) {
	tests := []struct {
		name          string
		running       bool
		supported     bool
		wantDetected  bool
		wantSupported bool
	}{
		{"running", true, true, true, true},
		{"stopped", false, true, false, true},
		{"not found", false, true, false, true},
		{"lookup error", false, false, false, false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			calls := stubServiceStatus(t, func(string) (bool, bool) { return tt.running, tt.supported })
			got := EvaluateDetectionRules([]DetectionRule{{Type: "service_running", ServiceName: "ctrld"}})
			if got.Detected != tt.wantDetected || got.Supported != tt.wantSupported {
				t.Fatalf("got %+v, want Detected=%v Supported=%v", got, tt.wantDetected, tt.wantSupported)
			}
			if len(*calls) != 1 || (*calls)[0] != "ctrld" {
				t.Fatalf("serviceStatusFn calls = %q, want exactly [ctrld]", *calls)
			}
			if !tt.wantDetected && tt.wantSupported && !strings.Contains(got.Detail, "service_running ctrld") {
				t.Fatalf("detail %q does not name the unmet clause", got.Detail)
			}
		})
	}
}

// AND semantics: a present file does not make up for a stopped service.
func TestEvaluateDetectionRules_ServiceRunningAndFileExists(t *testing.T) {
	stubServiceStatus(t, func(string) (bool, bool) { return false, true })
	path := filepath.Join(t.TempDir(), "ctrld.exe")
	if err := os.WriteFile(path, []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}
	got := EvaluateDetectionRules([]DetectionRule{
		{Type: "file_exists", Path: path},
		{Type: "service_running", ServiceName: "ctrld"},
	})
	if got.Detected || !got.Supported {
		t.Fatalf("got %+v, want supported and not detected", got)
	}
}

// A name the OS tooling could misread is never handed to it: the clause is
// unsupported (never pass, never fail), the same contract as an unknown clause.
func TestServiceRunning_RefusesUnsafeServiceNames(t *testing.T) {
	refused := map[string]string{
		"empty":            "",
		"blank":            "   ",
		"257 bytes":        strings.Repeat("x", 257),
		"invalid utf-8":    "ctrl\xffd",
		"leading dash":     "-ctrld",
		"NUL":              "a\x00b",
		"newline":          "a\nb",
		"tab":              "a\tb",
		"DEL":              "a\x7fb",
		"C1 start U+0080":  "a\u0080b",
		"NEL U+0085":       "a\u0085b",
		"C1 end U+009F":    "a\u009fb",
		"LINE SEP U+2028":  "a\u2028b",
		"PARA SEP U+2029":  "a\u2029b",
		"multibyte > 256B": strings.Repeat("\u00e9", 129), // 258 bytes, 129 runes
	}
	for label, name := range refused {
		t.Run(label, func(t *testing.T) {
			calls := stubServiceStatus(t, func(string) (bool, bool) { return true, true })
			got := EvaluateDetectionRules([]DetectionRule{{Type: "service_running", ServiceName: name}})
			if got.Supported || got.Detected {
				t.Fatalf("got %+v, want unsupported", got)
			}
			if !strings.Contains(got.Detail, "invalid service name") {
				t.Fatalf("detail = %q, want it to say invalid service name", got.Detail)
			}
			if len(*calls) != 0 {
				t.Fatalf("serviceStatusFn was called with %q for a refused name", *calls)
			}
		})
	}

	for _, name := range []string{"ctrld", "NextDNS Service", "a-b", "systemd-resolved", strings.Repeat("x", 256), "Dienst f\u00fcr \u00dcn\u00efcode"} {
		t.Run("accepts "+name[:min(len(name), 20)], func(t *testing.T) {
			calls := stubServiceStatus(t, func(string) (bool, bool) { return true, true })
			got := EvaluateDetectionRules([]DetectionRule{{Type: "service_running", ServiceName: name}})
			if !got.Supported || !got.Detected {
				t.Fatalf("got %+v, want supported+detected for an acceptable name", got)
			}
			if len(*calls) != 1 || (*calls)[0] != name {
				t.Fatalf("serviceStatusFn calls = %q, want [%q]", *calls, name)
			}
		})
	}
}

type fakeExitCoder int

func (c fakeExitCoder) Error() string { return fmt.Sprintf("exit status %d", int(c)) }
func (c fakeExitCoder) ExitCode() int { return int(c) }

// `systemctl is-active --quiet`: 0 active; 3 inactive/failed/unknown unit; 4
// no such unit. Any other exit (1: cannot talk to systemd, e.g. a container
// not booted with systemd) or a failure to run systemctl at all is NOT
// evidence that the service is stopped.
func TestClassifySystemctl(t *testing.T) {
	tests := []struct {
		name          string
		exitErr       error
		execErr       error
		wantRunning   bool
		wantSupported bool
	}{
		{"active", nil, nil, true, true},
		{"inactive exit 3", fakeExitCoder(3), nil, false, true},
		{"no such unit exit 4", fakeExitCoder(4), nil, false, true},
		{"no systemd exit 1", fakeExitCoder(1), nil, false, false},
		{"killed", fakeExitCoder(-1), nil, false, false},
		{"systemctl missing", nil, errors.New(`exec: "systemctl": executable file not found in $PATH`), false, false},
		{"timeout", nil, errors.New("context deadline exceeded"), false, false},
		{"exit error without code", errors.New("weird"), nil, false, false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			running, supported := classifySystemctl(tt.exitErr, tt.execErr)
			if running != tt.wantRunning || supported != tt.wantSupported {
				t.Fatalf("classifySystemctl = (%v, %v), want (%v, %v)", running, supported, tt.wantRunning, tt.wantSupported)
			}
		})
	}
}

// Windows SCM and macOS launchd lookups both go through svcquery.GetStatus.
// Only a lookup that PROVED absence is a clean negative (#7967).
func TestClassifyServiceLookup(t *testing.T) {
	tests := []struct {
		name          string
		info          svcquery.ServiceInfo
		err           error
		wantRunning   bool
		wantSupported bool
	}{
		{"running", svcquery.ServiceInfo{Status: svcquery.StatusRunning}, nil, true, true},
		{"stopped", svcquery.ServiceInfo{Status: svcquery.StatusStopped}, nil, false, true},
		{"disabled", svcquery.ServiceInfo{Status: svcquery.StatusDisabled}, nil, false, true},
		{"unknown state", svcquery.ServiceInfo{Status: svcquery.StatusUnknown}, nil, false, false},
		{"not found", svcquery.ServiceInfo{}, fmt.Errorf("svcquery: open service ctrld: %w", svcquery.ErrServiceNotFound), false, true},
		{"access denied", svcquery.ServiceInfo{}, errors.New("svcquery: open service ctrld: Access is denied."), false, false},
		{"launchctl failed", svcquery.ServiceInfo{}, errors.New("svcquery: launchctl list: exit status 1"), false, false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			running, supported := classifyServiceLookup(tt.info, tt.err)
			if running != tt.wantRunning || supported != tt.wantSupported {
				t.Fatalf("classifyServiceLookup = (%v, %v), want (%v, %v)", running, supported, tt.wantRunning, tt.wantSupported)
			}
		})
	}
}
