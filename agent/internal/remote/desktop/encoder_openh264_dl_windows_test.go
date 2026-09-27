//go:build windows

package desktop

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/breeze-rmm/agent/internal/config"
)

// swapVerifyProgramDataPathFn replaces the read-only ProgramData verifier
// seam and restores it after the test. Production always resolves through
// config.VerifyProgramDataPath.
func swapVerifyProgramDataPathFn(t *testing.T, fn func(string) error) {
	t.Helper()
	orig := verifyProgramDataPathFn
	verifyProgramDataPathFn = fn
	t.Cleanup(func() { verifyProgramDataPathFn = orig })
}

func swapGetDataDirFn(t *testing.T, dir string) {
	t.Helper()
	orig := getDataDirFn
	getDataDirFn = func() string { return dir }
	t.Cleanup(func() { getDataDirFn = orig })
}

func swapDownloadFn(t *testing.T, fn func(string) error) {
	t.Helper()
	orig := downloadOpenH264DLLFn
	downloadOpenH264DLLFn = fn
	t.Cleanup(func() { downloadOpenH264DLLFn = orig })
}

func TestRefuseUntrustedDataDir(t *testing.T) {
	swapVerifyProgramDataPathFn(t, func(string) error { return errors.New("owned by a standard user") })
	if err := refuseUntrustedDataDir(`C:\ProgramData\Breeze\data`); err == nil {
		t.Fatal("expected a refusal when the data directory does not verify")
	}
}

func TestRefuseUntrustedDataDir_AllowsVerifiedDir(t *testing.T) {
	swapVerifyProgramDataPathFn(t, func(string) error { return nil })
	if err := refuseUntrustedDataDir(`C:\ProgramData\Breeze\data`); err != nil {
		t.Errorf("expected no refusal for a verified data directory, got %v", err)
	}
}

// The desktop-session helper that encodes never runs the service's startup
// repair pass, so its in-memory trust record is always empty. The decision
// must come from this process's own read-only verification.
func TestRefuseUntrustedDataDir_DoesNotDependOnTheServiceRepairPass(t *testing.T) {
	dir := `C:\ProgramData\Breeze\data`
	if config.ProgramDataDirTrusted(dir) {
		t.Fatal("precondition: this test process never ran the repair pass")
	}
	var verified []string
	swapVerifyProgramDataPathFn(t, func(p string) error { verified = append(verified, p); return nil })
	if err := refuseUntrustedDataDir(dir); err != nil {
		t.Fatalf("a directory this process verified must be usable without the service pass, got %v", err)
	}
	if len(verified) != 1 || verified[0] != dir {
		t.Fatalf("expected the data directory to be verified in-process, got %v", verified)
	}
}

func TestFindOpenH264Library_RefusesUntrustedDataDir(t *testing.T) {
	dataDir := t.TempDir()
	swapGetDataDirFn(t, dataDir)
	swapVerifyProgramDataPathFn(t, func(string) error { return errors.New("is a link") })
	swapDownloadFn(t, func(string) error { t.Error("must not download into an unverified directory"); return nil })

	planted := filepath.Join(dataDir, openH264DLLName)
	if err := os.WriteFile(planted, []byte("not a real dll"), 0o644); err != nil {
		t.Fatalf("seed planted file: %v", err)
	}

	if _, err := findOpenH264Library(); err == nil {
		t.Fatal("expected findOpenH264Library to fail closed when the data dir does not verify")
	}
}

// A codec file that does not itself verify (e.g. it is a link, or a user can
// write it) is never hashed or returned, even inside a verified directory.
func TestFindOpenH264Library_SkipsUnverifiedCodecFile(t *testing.T) {
	dataDir := t.TempDir()
	swapGetDataDirFn(t, dataDir)
	candidate := filepath.Join(dataDir, openH264DLLName)
	if err := os.WriteFile(candidate, []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	swapVerifyProgramDataPathFn(t, func(p string) error {
		if p == candidate {
			return fmt.Errorf("%s is a link", p)
		}
		return nil
	})
	downloaded := false
	swapDownloadFn(t, func(string) error { downloaded = true; return errors.New("offline") })

	path, err := findOpenH264Library()
	if err == nil {
		t.Fatalf("expected no codec, got %s", path)
	}
	if !downloaded {
		t.Error("an unverified codec file must be replaced through the verified download path, not used")
	}
}

// A freshly downloaded codec must itself verify before it is handed to the
// loader.
func TestFindOpenH264Library_VerifiesDownloadedFile(t *testing.T) {
	dataDir := t.TempDir()
	swapGetDataDirFn(t, dataDir)
	candidate := filepath.Join(dataDir, openH264DLLName)
	var checks int
	swapVerifyProgramDataPathFn(t, func(p string) error {
		if p == candidate {
			checks++
			return fmt.Errorf("%s: %w", p, os.ErrNotExist)
		}
		return nil
	})
	swapDownloadFn(t, func(string) error { return nil })

	_, err := findOpenH264Library()
	if err == nil || !strings.Contains(err.Error(), "downloaded") {
		t.Fatalf("a downloaded codec that does not verify must be refused, got %v", err)
	}
	if checks < 2 {
		t.Errorf("expected the codec file to be verified before and after the download, got %d checks", checks)
	}
}
