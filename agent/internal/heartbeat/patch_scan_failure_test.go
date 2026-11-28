package heartbeat

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/breeze-rmm/agent/internal/config"
	"github.com/breeze-rmm/agent/internal/httputil"
	"github.com/breeze-rmm/agent/internal/patching"
)

// windowsUpdateStub is a provider whose scan succeeds with one patch, so a
// failed winget pass is a PARTIAL failure rather than a total one.
type windowsUpdateStub struct{ heartbeatMockProvider }

func (windowsUpdateStub) ID() string { return "windows-update" }
func (windowsUpdateStub) Scan() ([]patching.AvailablePatch, error) {
	return []patching.AvailablePatch{{ID: "KB5000001", Title: "Cumulative Update", Provider: "windows-update", KBNumber: "KB5000001"}}, nil
}

// #12835: when the SYSTEM machine-scope winget pass fails, the patch_scan
// command result must carry a sanitized reason — on the success envelope AND on
// the failed one — because that stored result is what the device Patches tab
// reads. Before the fix the error never left the agent and the tab showed
// "No pending third-party updates."
func TestPatchScanResultCarriesThirdPartyScanFailure(t *testing.T) {
	tests := []struct {
		name       string
		source     string
		withWU     bool
		wantStatus string
	}{
		{name: "full scan, winget is the only provider", wantStatus: "failed"},
		{name: "targeted third_party scan", source: "third_party", withWU: true, wantStatus: "failed"},
		{name: "full scan, another provider succeeded", withWU: true, wantStatus: "completed"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				_, _ = io.ReadAll(r.Body)
				w.WriteHeader(http.StatusOK)
			}))
			defer ts.Close()

			h := New(&config.Config{AgentID: "agent-1", ServerURL: ts.URL, AuthToken: "token"})
			h.retryCfg = httputil.RetryConfig{MaxRetries: 0}
			winget := patching.NewSystemWingetProvider(`C:\wg\winget.exe`,
				func(string, []string, time.Duration) (string, string, int, error) {
					return "", `C:\Users\bob\secret`, 3221225781, nil
				})
			providers := []patching.PatchProvider{winget}
			if tt.withWU {
				providers = append(providers, &windowsUpdateStub{})
			}
			h.patchMgr = patching.NewPatchManager(providers...)

			payload := map[string]any{}
			if tt.source != "" {
				payload["source"] = tt.source
			}
			res := handlePatchScan(h, Command{ID: "cmd-1", Type: "patch_scan", Payload: payload})
			if res.Status != tt.wantStatus {
				t.Fatalf("status = %q, want %q (error %q)", res.Status, tt.wantStatus, res.Error)
			}
			var data map[string]any
			if err := json.Unmarshal([]byte(res.Stdout), &data); err != nil {
				t.Fatalf("result stdout %q is not JSON: %v", res.Stdout, err)
			}
			got, _ := data["thirdPartyScanFailure"].(string)
			if !strings.Contains(got, "0xC0000135") || !strings.Contains(got, "DLL not found") {
				t.Fatalf("thirdPartyScanFailure = %q, want the sanitized 0xC0000135 reason", got)
			}
			// The pre-existing free-text `warning` field still carries the raw
			// error; the new field is the sanitized one the UI renders.
			if strings.Contains(got, "bob") {
				t.Fatalf("thirdPartyScanFailure leaks winget's stderr: %q", got)
			}
		})
	}
}

func TestPatchScanResultOmitsThirdPartyScanFailureOnSuccess(t *testing.T) {
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.ReadAll(r.Body)
		w.WriteHeader(http.StatusOK)
	}))
	defer ts.Close()
	h := New(&config.Config{AgentID: "agent-1", ServerURL: ts.URL, AuthToken: "token"})
	h.retryCfg = httputil.RetryConfig{MaxRetries: 0}
	h.patchMgr = patching.NewPatchManager(patching.NewSystemWingetProvider(`C:\wg\winget.exe`,
		func(string, []string, time.Duration) (string, string, int, error) {
			return "Name    Id               Version  Available Source\n" + strings.Repeat("-", 50) +
				"\nFirefox Mozilla.Firefox   1.0      2.0       winget\n", "", 0, nil
		}))
	res := handlePatchScan(h, Command{ID: "cmd-1", Type: "patch_scan", Payload: map[string]any{}})
	if res.Status != "completed" {
		t.Fatalf("status = %q (%s)", res.Status, res.Error)
	}
	if strings.Contains(res.Stdout, "thirdPartyScanFailure") {
		t.Fatalf("a clean scan must not report a failure: %s", res.Stdout)
	}
}
