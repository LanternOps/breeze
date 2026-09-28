package tools

import (
	"errors"
	"net/http"
	"os"
	"reflect"
	"testing"
)

// stubInstallPipeline swaps the download and installer seams for the duration
// of one test. Not parallel-safe: callers must not use t.Parallel().
func stubInstallPipeline(t *testing.T, download func(*http.Client, string, string) error, execute func(string, string, string, []uint32) (int, string, bool, error)) {
	t.Helper()
	origDownload, origExecute := downloadFileFn, executeInstallerFn
	t.Cleanup(func() {
		downloadFileFn, executeInstallerFn = origDownload, origExecute
	})
	downloadFileFn = download
	executeInstallerFn = execute
}

type stageRecorder struct{ stages []string }

func (r *stageRecorder) report(stage string) { r.stages = append(r.stages, stage) }

func TestInstallSoftwareWithProgress_ReportsDownloadThenInstall(t *testing.T) {
	rec := &stageRecorder{}
	var stagesAtDownload, stagesAtInstall []string
	stubInstallPipeline(t,
		func(_ *http.Client, _ string, dest string) error {
			stagesAtDownload = append([]string(nil), rec.stages...)
			return os.WriteFile(dest, []byte("installer"), 0o600)
		},
		func(string, string, string, []uint32) (int, string, bool, error) {
			stagesAtInstall = append([]string(nil), rec.stages...)
			return 0, "ok", false, nil
		},
	)

	result := InstallSoftwareWithProgress(installPayload("https://downloads.example.com/pkg.exe", nil), rec.report)

	if result.Status != "completed" {
		t.Fatalf("status = %q (error %q), want completed", result.Status, result.Error)
	}
	// Each stage is reported BEFORE the work it names begins, so the server
	// learns "downloading" while the download is running, not after it.
	if !reflect.DeepEqual(stagesAtDownload, []string{ProgressStageDownloading}) {
		t.Fatalf("stages when download began = %v, want [downloading]", stagesAtDownload)
	}
	if !reflect.DeepEqual(stagesAtInstall, []string{ProgressStageDownloading, ProgressStageInstalling}) {
		t.Fatalf("stages when installer began = %v, want [downloading installing]", stagesAtInstall)
	}
}

func TestInstallSoftwareWithProgress_FailedDownloadNeverReportsInstalling(t *testing.T) {
	rec := &stageRecorder{}
	stubInstallPipeline(t,
		func(*http.Client, string, string) error { return errors.New("connection reset") },
		func(string, string, string, []uint32) (int, string, bool, error) {
			t.Fatal("installer must not run after a failed download")
			return 0, "", false, nil
		},
	)

	result := InstallSoftwareWithProgress(installPayload("https://downloads.example.com/pkg.exe", nil), rec.report)

	if result.Status != "failed" {
		t.Fatalf("status = %q, want failed", result.Status)
	}
	if !reflect.DeepEqual(rec.stages, []string{ProgressStageDownloading}) {
		t.Fatalf("stages = %v, want [downloading]", rec.stages)
	}
}

func TestInstallSoftwareWithProgress_RejectedPayloadReportsNothing(t *testing.T) {
	rec := &stageRecorder{}
	// Cleartext URL: refused by network policy before anything starts.
	result := InstallSoftwareWithProgress(installPayload("http://downloads.example.com/pkg.exe", nil), rec.report)

	if result.Status != "failed" {
		t.Fatalf("status = %q, want failed", result.Status)
	}
	if len(rec.stages) != 0 {
		t.Fatalf("stages = %v, want none", rec.stages)
	}
}

func TestInstallSoftwareWithProgress_ManagerPathReportsInstalling(t *testing.T) {
	rec := &stageRecorder{}
	payload := map[string]any{
		"softwareName":  "Acme",
		"installMethod": map[string]any{"kind": "winget", "packageId": "Acme.App"},
	}

	InstallSoftwareWithProgress(payload, rec.report)

	if !reflect.DeepEqual(rec.stages, []string{ProgressStageInstalling}) {
		t.Fatalf("stages = %v, want [installing]", rec.stages)
	}
}

func TestInstallSoftwareWithProgress_NilReporterIsSafe(t *testing.T) {
	stubInstallPipeline(t,
		func(_ *http.Client, _ string, dest string) error {
			return os.WriteFile(dest, []byte("installer"), 0o600)
		},
		func(string, string, string, []uint32) (int, string, bool, error) { return 0, "ok", false, nil },
	)

	if result := InstallSoftwareWithProgress(installPayload("https://downloads.example.com/pkg.exe", nil), nil); result.Status != "completed" {
		t.Fatalf("status = %q (error %q), want completed", result.Status, result.Error)
	}
}
