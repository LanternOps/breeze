package bmr

import (
	"encoding/json"
	"testing"
)

func TestRecoveryConfigSerialization(t *testing.T) {
	cfg := RecoveryConfig{
		RecoveryToken: "brz_rec_abc123",
		ServerURL:     "https://api.breeze.example.com",
		SnapshotID:    "snapshot-20260329T120000Z-abcd",
		DeviceID:      "d1234567-abcd-efgh-ijkl-000000000001",
		TargetPaths: map[string]string{
			"/opt/app/data": "/mnt/restore/app/data",
		},
	}

	data, err := json.Marshal(cfg)
	if err != nil {
		t.Fatalf("marshal RecoveryConfig: %v", err)
	}

	var decoded RecoveryConfig
	if err := json.Unmarshal(data, &decoded); err != nil {
		t.Fatalf("unmarshal RecoveryConfig: %v", err)
	}

	if decoded.RecoveryToken != cfg.RecoveryToken {
		t.Errorf("RecoveryToken: got %q, want %q", decoded.RecoveryToken, cfg.RecoveryToken)
	}
	if decoded.ServerURL != cfg.ServerURL {
		t.Errorf("ServerURL: got %q, want %q", decoded.ServerURL, cfg.ServerURL)
	}
	if decoded.SnapshotID != cfg.SnapshotID {
		t.Errorf("SnapshotID: got %q, want %q", decoded.SnapshotID, cfg.SnapshotID)
	}
	if decoded.DeviceID != cfg.DeviceID {
		t.Errorf("DeviceID: got %q, want %q", decoded.DeviceID, cfg.DeviceID)
	}
	if len(decoded.TargetPaths) != 1 {
		t.Fatalf("TargetPaths length: got %d, want 1", len(decoded.TargetPaths))
	}
	if decoded.TargetPaths["/opt/app/data"] != "/mnt/restore/app/data" {
		t.Errorf("TargetPaths override wrong: got %q", decoded.TargetPaths["/opt/app/data"])
	}
}

func TestRecoveryConfigNoTargetPaths(t *testing.T) {
	cfg := RecoveryConfig{
		RecoveryToken: "tok",
		ServerURL:     "https://example.com",
		SnapshotID:    "snap-1",
		DeviceID:      "dev-1",
	}

	data, err := json.Marshal(cfg)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}

	// targetPaths should be omitted when nil.
	var raw map[string]json.RawMessage
	if err := json.Unmarshal(data, &raw); err != nil {
		t.Fatalf("unmarshal raw: %v", err)
	}
	if _, exists := raw["targetPaths"]; exists {
		t.Error("expected targetPaths to be omitted when nil")
	}
}

func TestRecoveryResultSerialization(t *testing.T) {
	result := RecoveryResult{
		Status:          "completed",
		FilesRestored:   42,
		BytesRestored:   1024 * 1024 * 500,
		StateApplied:    true,
		DriversInjected: 3,
		Validated:       true,
		Warnings:        []string{"minor warning 1"},
	}

	data, err := json.Marshal(result)
	if err != nil {
		t.Fatalf("marshal RecoveryResult: %v", err)
	}

	var decoded RecoveryResult
	if err := json.Unmarshal(data, &decoded); err != nil {
		t.Fatalf("unmarshal RecoveryResult: %v", err)
	}

	if decoded.Status != "completed" {
		t.Errorf("Status: got %q, want %q", decoded.Status, "completed")
	}
	if decoded.FilesRestored != 42 {
		t.Errorf("FilesRestored: got %d, want 42", decoded.FilesRestored)
	}
	if decoded.BytesRestored != 1024*1024*500 {
		t.Errorf("BytesRestored: got %d, want %d", decoded.BytesRestored, 1024*1024*500)
	}
	if !decoded.StateApplied {
		t.Error("StateApplied: expected true")
	}
	if decoded.DriversInjected != 3 {
		t.Errorf("DriversInjected: got %d, want 3", decoded.DriversInjected)
	}
	if !decoded.Validated {
		t.Error("Validated: expected true")
	}
	if len(decoded.Warnings) != 1 {
		t.Fatalf("Warnings length: got %d, want 1", len(decoded.Warnings))
	}
}

func TestRecoveryResultFailedWithError(t *testing.T) {
	result := RecoveryResult{
		Status: "failed",
		Error:  "disk full",
	}

	data, err := json.Marshal(result)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}

	var decoded RecoveryResult
	if err := json.Unmarshal(data, &decoded); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}

	if decoded.Status != "failed" {
		t.Errorf("Status: got %q, want %q", decoded.Status, "failed")
	}
	if decoded.Error != "disk full" {
		t.Errorf("Error: got %q, want %q", decoded.Error, "disk full")
	}
	if decoded.Warnings != nil {
		t.Error("Warnings: expected nil for omitempty")
	}
}

func TestValidationResultSerialization(t *testing.T) {
	tests := []struct {
		name   string
		result ValidationResult
	}{
		{
			name: "all_passed",
			result: ValidationResult{
				Passed:          true,
				ServicesRunning: true,
				NetworkUp:       true,
				CriticalFiles:   true,
			},
		},
		{
			name: "partial_failure",
			result: ValidationResult{
				Passed:          false,
				ServicesRunning: true,
				NetworkUp:       false,
				CriticalFiles:   true,
				Failures:        []string{"network connectivity check failed"},
			},
		},
		{
			name: "all_failed",
			result: ValidationResult{
				Passed:          false,
				ServicesRunning: false,
				NetworkUp:       false,
				CriticalFiles:   false,
				Failures: []string{
					"network down",
					"missing /etc/passwd",
					"sshd not running",
				},
			},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			data, err := json.Marshal(tt.result)
			if err != nil {
				t.Fatalf("marshal: %v", err)
			}

			var decoded ValidationResult
			if err := json.Unmarshal(data, &decoded); err != nil {
				t.Fatalf("unmarshal: %v", err)
			}

			if decoded.Passed != tt.result.Passed {
				t.Errorf("Passed: got %v, want %v", decoded.Passed, tt.result.Passed)
			}
			if decoded.ServicesRunning != tt.result.ServicesRunning {
				t.Errorf("ServicesRunning: got %v, want %v", decoded.ServicesRunning, tt.result.ServicesRunning)
			}
			if decoded.NetworkUp != tt.result.NetworkUp {
				t.Errorf("NetworkUp: got %v, want %v", decoded.NetworkUp, tt.result.NetworkUp)
			}
			if decoded.CriticalFiles != tt.result.CriticalFiles {
				t.Errorf("CriticalFiles: got %v, want %v", decoded.CriticalFiles, tt.result.CriticalFiles)
			}
			if len(decoded.Failures) != len(tt.result.Failures) {
				t.Errorf("Failures count: got %d, want %d", len(decoded.Failures), len(tt.result.Failures))
			}
		})
	}
}

func TestVMRestoreConfigSerialization(t *testing.T) {
	cfg := VMRestoreConfig{
		SnapshotID: "snap-123",
		Hypervisor: "hyperv",
		VMName:     "test-vm",
		MemoryMB:   4096,
		CPUCount:   2,
		DiskSizeGB: 100,
	}

	data, err := json.Marshal(cfg)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}

	var decoded VMRestoreConfig
	if err := json.Unmarshal(data, &decoded); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}

	if decoded.Hypervisor != "hyperv" {
		t.Errorf("Hypervisor: got %q, want %q", decoded.Hypervisor, "hyperv")
	}
	if decoded.MemoryMB != 4096 {
		t.Errorf("MemoryMB: got %d, want 4096", decoded.MemoryMB)
	}
}

func TestVMEstimateSerialization(t *testing.T) {
	est := VMEstimate{
		RecommendedMemoryMB: 8192,
		RecommendedCPU:      4,
		RequiredDiskGB:      250,
		Platform:            "windows",
		OSVersion:           "Windows Server 2022",
	}

	data, err := json.Marshal(est)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}

	var decoded VMEstimate
	if err := json.Unmarshal(data, &decoded); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}

	if decoded.RecommendedMemoryMB != 8192 {
		t.Errorf("RecommendedMemoryMB: got %d, want 8192", decoded.RecommendedMemoryMB)
	}
	if decoded.RequiredDiskGB != 250 {
		t.Errorf("RequiredDiskGB: got %d, want 250", decoded.RequiredDiskGB)
	}
	if decoded.Platform != "windows" {
		t.Errorf("Platform: got %q, want %q", decoded.Platform, "windows")
	}
}
