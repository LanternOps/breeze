package tools

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"runtime"
	"testing"
	"time"

	"github.com/breeze-rmm/agent/internal/systemrestore"
)

const swTestRequestID = "9d1e2f3a-4b5c-4d6e-8f70-81a2b3c4d5e6"

var fakeInstallerBytes = []byte("installer")

func fakeInstallerChecksum() string {
	sum := sha256.Sum256(fakeInstallerBytes)
	return hex.EncodeToString(sum[:])
}

// swCheckpointProbe swaps the package's createRestorePoint seam for one test,
// appending "checkpoint" to order on each call. Not parallel-safe.
func swCheckpointProbe(t *testing.T, order *[]string) *int {
	t.Helper()
	calls := 0
	prev := createRestorePoint
	createRestorePoint = func(_ context.Context, req systemrestore.Request) systemrestore.Outcome {
		calls++
		if order != nil {
			*order = append(*order, "checkpoint")
		}
		return systemrestore.Outcome{Status: systemrestore.StatusCreated, RequestID: req.RequestID, AttemptedAt: "t"}
	}
	t.Cleanup(func() { createRestorePoint = prev })
	return &calls
}

func withSoftwareBlock(p map[string]any) map[string]any {
	p[systemrestore.PayloadKey] = map[string]any{
		"v":         float64(systemrestore.SupportedVersion),
		"requestId": swTestRequestID,
		"enabled":   true,
		"label":     "Breeze: install Acme",
	}
	return p
}

// recordingPipeline stubs download (writes the fake installer) and the
// installer, appending each stage to order.
func recordingPipeline(t *testing.T, order *[]string, installErr error) {
	t.Helper()
	stubInstallPipeline(t,
		func(_ *http.Client, _ string, dest string) error {
			*order = append(*order, "download")
			return os.WriteFile(dest, fakeInstallerBytes, 0o600)
		},
		func(string, string, string, []uint32) (int, string, bool, error) {
			*order = append(*order, "installer")
			if installErr != nil {
				return 1, "boom", false, installErr
			}
			return 0, "ok", false, nil
		},
	)
}

func requireNoMutation(t *testing.T, res CommandResult) {
	t.Helper()
	if res.RestorePoint == nil || res.RestorePoint.Status != systemrestore.StatusSkippedNoMutation || res.RestorePoint.RequestID != swTestRequestID {
		t.Fatalf("RestorePoint = %+v, want skipped_no_mutation for the stamped requestId", res.RestorePoint)
	}
}

func TestInstallSoftwareCheckpointsAfterDownloadAndBeforeTheInstaller(t *testing.T) {
	var order []string
	calls := swCheckpointProbe(t, &order)
	recordingPipeline(t, &order, nil)
	p := withSoftwareBlock(installPayload("https://downloads.example.com/pkg.exe", nil))
	p["checksum"] = fakeInstallerChecksum()

	res := InstallSoftware(p)

	if res.Status != "completed" {
		t.Fatalf("status = %q (error %q)", res.Status, res.Error)
	}
	if want := []string{"download", "checkpoint", "installer"}; !reflect.DeepEqual(order, want) {
		t.Fatalf("order = %v, want %v", order, want)
	}
	if *calls != 1 {
		t.Fatalf("attempts = %d, want 1", *calls)
	}
	if res.RestorePoint == nil || res.RestorePoint.Status != systemrestore.StatusCreated || res.RestorePoint.RequestID != swTestRequestID {
		t.Fatalf("RestorePoint = %+v, want created", res.RestorePoint)
	}
	if res.StartedAt == "" {
		t.Fatal("StartedAt must still be stamped")
	}
}

func TestInstallSoftwareReportsTheCheckpointWhenTheInstallerFails(t *testing.T) {
	var order []string
	swCheckpointProbe(t, &order)
	recordingPipeline(t, &order, errors.New("installer exited with code 1"))
	res := InstallSoftware(withSoftwareBlock(installPayload("https://downloads.example.com/pkg.exe", nil)))
	if res.Status != "failed" {
		t.Fatalf("status = %q, want failed", res.Status)
	}
	if res.RestorePoint == nil || res.RestorePoint.Status != systemrestore.StatusCreated {
		t.Fatalf("RestorePoint = %+v: a checkpoint taken before a failed install must still be reported", res.RestorePoint)
	}
}

func TestInstallSoftwareSkipsCheckpointWhenAlreadyInstalled(t *testing.T) {
	// The pre-install detection gate returns before any mutation, so it must
	// not consume the day's one restore point -- but an enabled request still
	// reports an outcome.
	var order []string
	calls := swCheckpointProbe(t, &order)
	recordingPipeline(t, &order, nil)
	present := filepath.Join(t.TempDir(), "acme.exe")
	if err := os.WriteFile(present, []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}
	p := withSoftwareBlock(installPayload("https://downloads.example.com/pkg.exe", nil))
	p["detectionRules"] = []any{map[string]any{"type": "file_exists", "path": present}}

	res := InstallSoftware(p)

	if res.Status != "completed" {
		t.Fatalf("status = %q (error %q)", res.Status, res.Error)
	}
	if *calls != 0 || len(order) != 0 {
		t.Fatalf("attempts = %d, stages = %v; an already-installed package must touch nothing", *calls, order)
	}
	requireNoMutation(t, res)
}

func TestInstallSoftwareSkipsCheckpointWhenValidationRejects(t *testing.T) {
	cases := map[string]func(p map[string]any){
		"checksum mismatch":   func(p map[string]any) { p["checksum"] = "00" + fakeInstallerChecksum()[2:] },
		"unsupported type":    func(p map[string]any) { p["fileType"] = "bat"; p["fileName"] = "pkg.bat" },
		"bad exit codes":      func(p map[string]any) { p["successExitCodes"] = "nope" },
		"cleartext URL":       func(p map[string]any) { p["downloadUrl"] = "http://downloads.example.com/pkg.exe" },
		"missing downloadUrl": func(p map[string]any) { delete(p, "downloadUrl") },
	}
	for name, mutate := range cases {
		t.Run(name, func(t *testing.T) {
			var order []string
			calls := swCheckpointProbe(t, &order)
			recordingPipeline(t, &order, nil)
			p := withSoftwareBlock(installPayload("https://downloads.example.com/pkg.exe", nil))
			mutate(p)
			res := InstallSoftware(p)
			if res.Status != "failed" {
				t.Fatalf("status = %q, want failed", res.Status)
			}
			if *calls != 0 {
				t.Fatalf("attempts = %d, want 0 when the command is refused", *calls)
			}
			requireNoMutation(t, res)
		})
	}
}

func TestInstallSoftwareWithNoBlockTakesNoCheckpoint(t *testing.T) {
	var order []string
	calls := swCheckpointProbe(t, &order)
	recordingPipeline(t, &order, nil)
	res := InstallSoftware(installPayload("https://downloads.example.com/pkg.exe", nil))
	if res.Status != "completed" {
		t.Fatalf("status = %q (error %q)", res.Status, res.Error)
	}
	if *calls != 0 || res.RestorePoint != nil {
		t.Fatalf("attempts = %d, RestorePoint = %+v -- a missing block means disabled", *calls, res.RestorePoint)
	}
}

func wingetPayloadWithBlock() map[string]any {
	return withSoftwareBlock(map[string]any{
		"installMethod": map[string]any{"kind": "winget", "packageId": "Google.Chrome"},
		"versionMode":   "latest",
		"softwareName":  "Chrome",
	})
}

func TestInstallViaManagerCheckpointsBeforeTheManagerMutates(t *testing.T) {
	var order []string
	calls := swCheckpointProbe(t, &order)
	deps, runner := testManagerDeps(t, map[string]fakeManagerResponse{
		"list":    {stdout: "No installed package found matching input criteria.\n", code: 1},
		"install": {stdout: "Successfully installed", code: 0},
	}, nil)
	run := deps.run
	deps.run = func(name string, args []string, timeout time.Duration) (string, string, int, error) {
		if len(args) > 0 {
			order = append(order, args[0])
		}
		return run(name, args, timeout)
	}

	res := installViaManager(wingetPayloadWithBlock(), deps)

	mustDecodeSuccess(t, res)
	if *calls != 1 || len(runner.installCalls()) != 1 {
		t.Fatalf("attempts = %d, installs = %d; want 1 and 1", *calls, len(runner.installCalls()))
	}
	if want := []string{"list", "checkpoint", "install"}; !reflect.DeepEqual(order, want) {
		t.Fatalf("order = %v, want %v (probe, then checkpoint, then the mutation)", order, want)
	}
	if res.RestorePoint == nil || res.RestorePoint.Status != systemrestore.StatusCreated {
		t.Fatalf("RestorePoint = %+v", res.RestorePoint)
	}
}

func TestInstallViaManagerSkipsCheckpointWhenAlreadyInstalled(t *testing.T) {
	calls := swCheckpointProbe(t, nil)
	deps, _ := testManagerDeps(t, map[string]fakeManagerResponse{
		"list": {stdout: "Name  Id             Version\nChrome Google.Chrome 1.0\n", code: 0},
	}, nil)
	res := installViaManager(wingetPayloadWithBlock(), deps)
	mustDecodeSuccess(t, res)
	if *calls != 0 {
		t.Fatalf("attempts = %d, want 0", *calls)
	}
	requireNoMutation(t, res)
}

func TestInstallViaManagerSkipsCheckpointWhenWingetIsUnavailable(t *testing.T) {
	calls := swCheckpointProbe(t, nil)
	deps, _ := testManagerDeps(t, nil, errors.New("not found"))
	if _, err := exec.LookPath("winget"); err == nil {
		t.Skip("winget is on PATH on this host")
	}
	res := installViaManager(wingetPayloadWithBlock(), deps)
	if res.Status != "failed" || *calls != 0 {
		t.Fatalf("status = %q, attempts = %d", res.Status, *calls)
	}
	requireNoMutation(t, res)
}

func TestInstallViaManagerBrewCheckpointsBeforeEnsure(t *testing.T) {
	var order []string
	calls := swCheckpointProbe(t, &order)
	deps, _ := testManagerDeps(t, nil, nil)
	deps.brewEnsure = func(kind, name, softwareName string) (string, bool, error) {
		order = append(order, "brew")
		return "installed", false, nil
	}
	p := withSoftwareBlock(map[string]any{
		"installMethod": map[string]any{"kind": "homebrew_cask", "packageId": "firefox"},
	})
	res := installViaManager(p, deps)
	mustDecodeSuccess(t, res)
	if *calls != 1 || !reflect.DeepEqual(order, []string{"checkpoint", "brew"}) {
		t.Fatalf("attempts = %d, order = %v", *calls, order)
	}
}

func TestInstallViaManagerInvalidPackageIDTakesNoCheckpoint(t *testing.T) {
	calls := swCheckpointProbe(t, nil)
	deps, _ := testManagerDeps(t, nil, nil)
	p := withSoftwareBlock(map[string]any{"installMethod": map[string]any{"kind": "winget", "packageId": "bad id; rm"}})
	res := installViaManager(p, deps)
	if res.Status != "failed" || *calls != 0 {
		t.Fatalf("status = %q, attempts = %d", res.Status, *calls)
	}
	requireNoMutation(t, res)
}

func TestInstallSoftwareManagerBranchReportsExactlyOnce(t *testing.T) {
	// InstallSoftwareWithProgress hands the manager path the SAME checkpoint,
	// so the outer and inner return paths cannot disagree or double-take.
	if runtime.GOOS == "windows" {
		t.Skip("default manager deps would reach a real winget here")
	}
	calls := swCheckpointProbe(t, nil)
	p := withSoftwareBlock(map[string]any{
		"installMethod": map[string]any{"kind": "winget", "packageId": "Google.Chrome"},
	})
	res := InstallSoftware(p)
	// Non-Windows: winget is unavailable before any mutation.
	if *calls != 0 {
		t.Fatalf("attempts = %d, want 0", *calls)
	}
	requireNoMutation(t, res)
}
