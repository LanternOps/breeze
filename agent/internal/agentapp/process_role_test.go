package agentapp

import (
	"reflect"
	"testing"
	"time"
)

func TestClassifyProcess(t *testing.T) {
	tests := []struct {
		name, command, role, exe string
		service                  bool
		wantMode                 string
		wantFallback             bool
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
