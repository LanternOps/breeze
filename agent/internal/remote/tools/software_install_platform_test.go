package tools

import (
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

// #9165: which installer file type runs on which OS is one table, shared by
// the pre-download check and executeInstaller's dispatch.
func TestInstallerSupportedOnPlatform(t *testing.T) {
	supported := map[string]string{
		"msi": "windows",
		"exe": "windows",
		"deb": "linux",
		"pkg": "darwin",
		"dmg": "darwin",
	}
	fileTypes := []string{"msi", "exe", "deb", "pkg", "dmg", "bat", "rpm", "", "MSI", " exe"}
	gooses := []string{"windows", "linux", "darwin", "freebsd", ""}

	for _, ft := range fileTypes {
		for _, goos := range gooses {
			// Exact match only, the same as executeInstaller's switch always
			// was: validateInstallInputs accepts "MSI", but the dispatch never
			// matched it, so it was refused after the download instead.
			want := supported[ft] == goos && goos != ""
			if got := installerSupportedOnPlatform(ft, goos); got != want {
				t.Errorf("installerSupportedOnPlatform(%q, %q) = %v, want %v", ft, goos, got, want)
			}
		}
	}
}

// hostInstaller returns an installer file type this host CAN run and a file
// name for it. Fixtures that exercise anything past the platform check (the
// detection gate, network policy, the stubbed download/installer) use it, so
// they keep testing what they name on every CI OS instead of stopping at
// "unsupported file type".
func hostInstaller(base string) (fileType, fileName string) {
	switch runtime.GOOS {
	case "linux":
		return "deb", base + ".deb"
	case "darwin":
		return "pkg", base + ".pkg"
	default:
		return "exe", base + ".exe"
	}
}

// unsupportedOnHost returns a file type validateInstallInputs accepts but this
// host cannot run, with a matching file name.
func unsupportedOnHost(t *testing.T) (fileType, fileName string) {
	t.Helper()
	if runtime.GOOS == "windows" {
		return "deb", "pkg.deb"
	}
	return "msi", "pkg.msi"
}

// The pairing is refused before anything is fetched or checkpointed, with the
// same message executeInstaller used to produce after the download.
func TestInstallSoftwareRefusesAnUnsupportedPairingBeforeDownloading(t *testing.T) {
	var order []string
	calls := swCheckpointProbe(t, &order)
	stubInstallPipeline(t,
		func(*http.Client, string, string) error {
			t.Fatal("downloader must not run for an installer this OS cannot run")
			return nil
		},
		func(string, string, string, []uint32) (int, string, bool, error) {
			t.Fatal("installer must not run for an installer this OS cannot run")
			return 0, "", false, nil
		},
	)
	fileType, fileName := unsupportedOnHost(t)
	p := withSoftwareBlock(installPayload("https://downloads.example.com/"+fileName, nil))
	p["fileType"] = fileType
	p["fileName"] = fileName

	res := InstallSoftware(p)

	if res.Status != "failed" || res.ExitCode != 1 {
		t.Fatalf("status = %q exit = %d, want failed/1", res.Status, res.ExitCode)
	}
	want := `unsupported file type "` + fileType + `" on ` + runtime.GOOS
	if res.Error != want {
		t.Fatalf("error = %q, want %q", res.Error, want)
	}
	if *calls != 0 || len(order) != 0 {
		t.Fatalf("attempts = %d, stages = %v; nothing may be fetched or checkpointed", *calls, order)
	}
	requireNoMutation(t, res)
	if res.StartedAt == "" {
		t.Fatal("StartedAt must still be stamped")
	}
}

// The detection gate still runs first: a package that is already present
// reports "already installed" even when the installer offered for it is for
// another OS, exactly as before #9165. Neither path fetches or checkpoints.
func TestInstallSoftwareDetectionGateStillPrecedesThePlatformCheck(t *testing.T) {
	var order []string
	calls := swCheckpointProbe(t, &order)
	recordingPipeline(t, &order, nil)
	present := filepath.Join(t.TempDir(), "acme.bin")
	if err := os.WriteFile(present, []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}
	fileType, fileName := unsupportedOnHost(t)
	p := withSoftwareBlock(installPayload("https://downloads.example.com/"+fileName, nil))
	p["fileType"] = fileType
	p["fileName"] = fileName
	p["detectionRules"] = []any{map[string]any{"type": "file_exists", "path": present}}

	res := InstallSoftware(p)

	if res.Status != "completed" {
		t.Fatalf("status = %q (error %q), want completed: the already-installed skip must win", res.Status, res.Error)
	}
	if !strings.Contains(res.Stdout, "already installed") {
		t.Fatalf("stdout = %q, want the already-installed skip", res.Stdout)
	}
	if *calls != 0 || len(order) != 0 {
		t.Fatalf("attempts = %d, stages = %v, want none", *calls, order)
	}
	requireNoMutation(t, res)
}

// The platform check runs before the network policy: a wrong-OS installer
// behind a URL the policy would also refuse reports the platform error.
func TestInstallSoftwarePlatformCheckPrecedesTheNetworkPolicy(t *testing.T) {
	stubInstallPipeline(t,
		func(*http.Client, string, string) error {
			t.Fatal("downloader must not run")
			return nil
		},
		func(string, string, string, []uint32) (int, string, bool, error) {
			t.Fatal("installer must not run")
			return 0, "", false, nil
		},
	)
	fileType, fileName := unsupportedOnHost(t)
	p := installPayload("http://downloads.example.com/"+fileName, nil)
	p["fileType"] = fileType
	p["fileName"] = fileName

	res := InstallSoftware(p)

	if want := `unsupported file type "` + fileType + `" on ` + runtime.GOOS; res.Error != want {
		t.Fatalf("error = %q, want %q", res.Error, want)
	}
}

// Many tests rely on installPayload producing an installer the host can run;
// if it ever hard-codes one type again, tests that only assert "failed" would
// go quietly vacuous on the other CI OSes.
func TestInstallPayloadFixtureIsRunnableOnThisHost(t *testing.T) {
	ft, _ := installPayload("https://downloads.example.com/x", nil)["fileType"].(string)
	if !installerSupportedOnPlatform(ft, runtime.GOOS) {
		t.Fatalf("installPayload fileType %q is not runnable on %s; use hostInstaller", ft, runtime.GOOS)
	}
}

// Input validation still runs first: a payload that is malformed AND
// wrong-OS reports the validation error, as before.
func TestInstallSoftwareInputValidationStillPrecedesThePlatformCheck(t *testing.T) {
	stubInstallPipeline(t,
		func(*http.Client, string, string) error {
			t.Fatal("downloader must not run")
			return nil
		},
		func(string, string, string, []uint32) (int, string, bool, error) {
			t.Fatal("installer must not run")
			return 0, "", false, nil
		},
	)
	fileType, fileName := unsupportedOnHost(t)
	p := installPayload("https://downloads.example.com/"+fileName, nil)
	p["fileType"] = fileType
	p["fileName"] = fileName
	p["successExitCodes"] = "nope"

	res := InstallSoftware(p)

	if res.Status != "failed" {
		t.Fatalf("status = %q, want failed", res.Status)
	}
	if !strings.Contains(res.Error, "successExitCodes") {
		t.Fatalf("error = %q: the successExitCodes error must win over the platform check", res.Error)
	}
}

// executeInstaller keeps refusing the pairing itself (defence in depth for any
// caller that skips the pre-check), from the same table and with the same text.
func TestExecuteInstallerRefusesAnUnsupportedPairing(t *testing.T) {
	fileType, fileName := unsupportedOnHost(t)
	exitCode, _, _, err := executeInstaller(filepath.Join(t.TempDir(), fileName), fileType, "", nil)
	if err == nil || exitCode != 1 {
		t.Fatalf("exit = %d err = %v, want 1 and an error", exitCode, err)
	}
	if want := `unsupported file type "` + fileType + `" on ` + runtime.GOOS; err.Error() != want {
		t.Fatalf("error = %q, want %q", err.Error(), want)
	}
}
