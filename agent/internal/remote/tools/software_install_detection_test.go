package tools

import (
	"encoding/json"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func TestInstallerExitIndicatesSuccess(t *testing.T) {
	t.Parallel()

	cases := []struct {
		name     string
		fileType string
		exitCode int
		want     bool
	}{
		{"exe success", "exe", 0, true},
		{"msi success", "msi", 0, true},
		{"exe reboot required 3010", "exe", 3010, true},
		{"msi reboot required 3010", "msi", 3010, true},
		{"exe reboot initiated 1641", "exe", 1641, true},
		{"msi reboot initiated 1641", "msi", 1641, true},
		{"exe uppercase filetype still maps", "EXE", 3010, true},
		{"exe genuine failure", "exe", 1, false},
		{"msi genuine failure", "msi", 1603, false},
		// Non-Windows installer types: only 0 is success; reboot codes are
		// Windows-specific and not treated as success elsewhere.
		{"deb reboot code not success", "deb", 3010, false},
		{"pkg success", "pkg", 0, true},
	}

	for _, tc := range cases {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			if got := installerExitIndicatesSuccess(tc.fileType, tc.exitCode); got != tc.want {
				t.Fatalf("installerExitIndicatesSuccess(%q, %d) = %v, want %v", tc.fileType, tc.exitCode, got, tc.want)
			}
		})
	}
}

func TestApplyPostInstallDetection(t *testing.T) {
	t.Parallel()

	dir := t.TempDir()
	present := filepath.Join(dir, "present.txt")
	if err := os.WriteFile(present, []byte("x"), 0o600); err != nil {
		t.Fatalf("write present: %v", err)
	}
	absent := filepath.Join(dir, "absent.txt")

	t.Run("no rules → plain exit-code success", func(t *testing.T) {
		r := applyPostInstallDetection(map[string]any{"success": true}, 0, "out", nil, 0)
		if r.Status != "completed" {
			t.Fatalf("want completed, got %q", r.Status)
		}
	})

	t.Run("supported + detected → success", func(t *testing.T) {
		rules := []DetectionRule{{Type: "file_exists", Path: present}}
		r := applyPostInstallDetection(map[string]any{"success": true}, 0, "out", rules, 0)
		if r.Status != "completed" {
			t.Fatalf("want completed, got %q (err=%q)", r.Status, r.Error)
		}
	})

	t.Run("supported + not detected → failed", func(t *testing.T) {
		rules := []DetectionRule{{Type: "file_exists", Path: absent}}
		r := applyPostInstallDetection(map[string]any{"success": true}, 0, "out", rules, 0)
		if r.Status != "failed" {
			t.Fatalf("want failed, got %q", r.Status)
		}
		if !strings.Contains(r.Error, "detection rule was not satisfied") {
			t.Fatalf("expected detection-not-satisfied error, got %q", r.Error)
		}
	})

	t.Run("unsupported on this platform → keep exit-code success", func(t *testing.T) {
		// A registry clause is unsupported on the non-Windows CI host, so the
		// install must remain a success and report detectionPerformed=false.
		if runtime.GOOS == "windows" {
			t.Skip("registry clause is supported on Windows")
		}
		payload := map[string]any{"success": true}
		rules := []DetectionRule{{Type: "registry", Path: `SOFTWARE\Acme\App`}}
		r := applyPostInstallDetection(payload, 0, "out", rules, 0)
		if r.Status != "completed" {
			t.Fatalf("want completed, got %q", r.Status)
		}
		if payload["detectionPerformed"] != false {
			t.Fatalf("want detectionPerformed=false, got %v", payload["detectionPerformed"])
		}
	})
}

// When a detection rule already matches the device state, InstallSoftware must
// skip the download+install and report a skipped success — without ever touching
// the network. We point a file_exists rule at a real temp file so the pre-install
// gate fires before validateDownloadURL/download.
func TestInstallSoftwareSkipsWhenAlreadyDetected(t *testing.T) {
	t.Parallel()

	dir := t.TempDir()
	marker := filepath.Join(dir, "installed.txt")
	if err := os.WriteFile(marker, []byte("present"), 0o600); err != nil {
		t.Fatalf("write marker: %v", err)
	}

	payload := map[string]any{
		// A syntactically valid URL that must never be fetched (the skip returns
		// before validateDownloadURL/downloadFile).
		"downloadUrl":  "https://example.invalid/never-fetched.exe",
		"fileName":     "pkg.exe",
		"fileType":     "exe",
		"softwareName": "Acme",
		"version":      "1.0.0",
		"detectionRules": []any{
			map[string]any{"type": "file_exists", "path": marker},
		},
	}

	result := InstallSoftware(payload)
	if result.Status != "completed" {
		t.Fatalf("expected completed, got %q (error=%q)", result.Status, result.Error)
	}

	var data map[string]any
	if err := json.Unmarshal([]byte(result.Stdout), &data); err != nil {
		t.Fatalf("unmarshal stdout: %v (stdout=%q)", err, result.Stdout)
	}
	if data["skipped"] != true {
		t.Fatalf("expected skipped=true, got %v", data["skipped"])
	}
	if data["detectionSatisfied"] != true {
		t.Fatalf("expected detectionSatisfied=true, got %v", data["detectionSatisfied"])
	}
}

// forceReinstall must defeat the skip gate even when the package is detected, so
// the install proceeds. With an unfetchable URL the download fails — which is the
// proof the gate did NOT short-circuit.
func TestInstallSoftwareForceReinstallBypassesSkip(t *testing.T) {
	t.Parallel()

	dir := t.TempDir()
	marker := filepath.Join(dir, "installed.txt")
	if err := os.WriteFile(marker, []byte("present"), 0o600); err != nil {
		t.Fatalf("write marker: %v", err)
	}

	payload := map[string]any{
		// localhost:0 is a guaranteed-unroutable target; the download attempt
		// fails fast, proving we did not skip.
		"downloadUrl":    "https://127.0.0.1:0/pkg.exe",
		"fileName":       "pkg.exe",
		"fileType":       "exe",
		"softwareName":   "Acme",
		"version":        "1.0.0",
		"forceReinstall": true,
		"detectionRules": []any{
			map[string]any{"type": "file_exists", "path": marker},
		},
	}

	result := InstallSoftware(payload)
	if result.Status != "failed" {
		t.Fatalf("expected failed (download attempted, not skipped), got %q", result.Status)
	}
}
