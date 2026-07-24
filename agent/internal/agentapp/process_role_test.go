package agentapp

import (
	"os"
	"reflect"
	"testing"
	"time"

	"github.com/breeze-rmm/agent/internal/ipc"
)

func TestCurrentProcessStartupCapturesDiagnosticRoleMetadata(t *testing.T) {
	startup := currentProcessStartup("user-helper", "user", false)

	if startup.PID != os.Getpid() {
		t.Fatalf("PID = %d, want %d", startup.PID, os.Getpid())
	}
	if startup.Binary == "" || startup.ExecutablePath == "" {
		t.Fatalf("executable metadata missing: %+v", startup)
	}
	if startup.LaunchMode != "user-helper" || startup.HelperRole != "user" {
		t.Fatalf("role metadata = (%q, %q)", startup.LaunchMode, startup.HelperRole)
	}
	if !startup.MainBinaryFallback || startup.CompanionHelper {
		t.Fatalf("helper provenance = fallback:%v companion:%v", startup.MainBinaryFallback, startup.CompanionHelper)
	}
	if startup.Version != version || startup.CreatedAt.IsZero() {
		t.Fatalf("version/creation metadata = (%q, %v)", startup.Version, startup.CreatedAt)
	}
}

func TestClassifyProcess(t *testing.T) {
	tests := []struct {
		name, command string
		role          ipc.HelperRole
		exe           string
		service       bool
		wantMode      string
		wantFallback  bool
	}{
		{"SCM main", "run", "", "breeze-agent.exe", true, "service-run", false},
		{"console main", "run", "", "breeze-agent.exe", false, "console-run", false},
		{"companion user", "user-helper", "user", "breeze-user-helper.exe", false, "user-helper", false},
		{"fallback user", "user-helper", "user", "breeze-agent.exe", false, "user-helper", true},
		{"renamed fallback user", "user-helper", "user", "breeze-agent-0.70.exe", false, "user-helper", true},
		{"companion system", "user-helper", "system", "breeze-user-helper.exe", false, "system-helper", false},
		{"empty helper role", "user-helper", "", "breeze-agent.exe", false, "other", false},
		{"invalid helper role", "user-helper", "invalid", "breeze-agent.exe", false, "other", false},
		{"status", "status", "", "breeze-agent.exe", false, "other", false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			mode, fallback := classifyProcess(tt.command, tt.role, tt.exe, tt.service)
			if mode != tt.wantMode || fallback != tt.wantFallback {
				t.Fatalf("got (%q,%v), want (%q,%v)", mode, fallback, tt.wantMode, tt.wantFallback)
			}
		})
	}
}

func TestProcessStartupFieldsContainsOnlyDiagnosticMetadata(t *testing.T) {
	createdAt := time.Date(2026, 7, 14, 12, 0, 0, 0, time.UTC)
	startup := ProcessStartup{
		Binary:             "breeze-agent.exe",
		ExecutablePath:     `C:\Program Files\Breeze\breeze-agent.exe`,
		PID:                42,
		ParentPID:          7,
		WindowsSessionID:   3,
		LaunchMode:         "user-helper",
		HelperRole:         "user",
		LifecycleKey:       "3:user",
		CompanionHelper:    false,
		MainBinaryFallback: true,
		Version:            "0.70.0",
		CreatedAt:          createdAt,
	}
	want := map[string]any{
		"binary":             startup.Binary,
		"executablePath":     startup.ExecutablePath,
		"pid":                startup.PID,
		"parentPid":          startup.ParentPID,
		"windowsSessionId":   startup.WindowsSessionID,
		"launchMode":         startup.LaunchMode,
		"helperRole":         startup.HelperRole,
		"lifecycleKey":       startup.LifecycleKey,
		"companionHelper":    startup.CompanionHelper,
		"mainBinaryFallback": startup.MainBinaryFallback,
		"version":            startup.Version,
		"createdAt":          startup.CreatedAt,
	}
	fields := processStartupFields(startup)
	if !reflect.DeepEqual(fields, want) {
		t.Fatalf("processStartupFields() = %#v, want %#v", fields, want)
	}
	for _, forbidden := range []string{"authToken", "token", "password", "secret"} {
		if _, ok := fields[forbidden]; ok {
			t.Fatalf("startup diagnostic fields contain forbidden key %q", forbidden)
		}
	}
}
