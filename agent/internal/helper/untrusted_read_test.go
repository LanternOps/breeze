package helper

import (
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestReadStatusParsesRegularFile(t *testing.T) {
	dir := t.TempDir()
	content := "version: 1.2.3\nchat_active: true\nlast_activity: 2026-11-04T12:00:00Z\npid: 42\n"
	if err := os.WriteFile(filepath.Join(dir, "helper_status.yaml"), []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}
	s, err := ReadStatus(filepath.Join(dir, "helper_config.yaml"))
	if err != nil {
		t.Fatal(err)
	}
	if s.Version != "1.2.3" || !s.ChatActive || s.PID != 42 || s.LastActivity.IsZero() {
		t.Fatalf("parsed wrong: %+v", s)
	}
}

func TestReadStatusMissingFileIsNotExist(t *testing.T) {
	_, err := ReadStatus(filepath.Join(t.TempDir(), "helper_config.yaml"))
	if !errors.Is(err, fs.ErrNotExist) {
		t.Fatalf("got %v", err)
	}
}

func TestReadStatusRefusesOversize(t *testing.T) {
	dir := t.TempDir()
	big := "pid: 7\npad: " + strings.Repeat("A", maxUntrustedFileBytes) + "\n"
	if err := os.WriteFile(filepath.Join(dir, "helper_status.yaml"), []byte(big), 0o600); err != nil {
		t.Fatal(err)
	}
	s, err := ReadStatus(filepath.Join(dir, "helper_config.yaml"))
	if err == nil {
		t.Fatalf("accepted oversize file: %+v", s)
	}
	if strings.Contains(err.Error(), "AAAA") {
		t.Fatal("error leaks content")
	}
}

func TestReadStatusAtLimitStillReads(t *testing.T) {
	dir := t.TempDir()
	prefix := "pid: 7\npad: "
	content := prefix + strings.Repeat("A", maxUntrustedFileBytes-len(prefix)-1) + "\n"
	if len(content) != maxUntrustedFileBytes {
		t.Fatalf("setup: %d", len(content))
	}
	if err := os.WriteFile(filepath.Join(dir, "helper_status.yaml"), []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}
	s, err := ReadStatus(filepath.Join(dir, "helper_config.yaml"))
	if err != nil {
		t.Fatal(err)
	}
	if s.PID != 7 {
		t.Fatalf("got %+v", s)
	}
}

func TestUntrustedReadsRefuseDirectory(t *testing.T) {
	dir := t.TempDir()
	for _, name := range []string{"helper_status.yaml", "helper_config.yaml"} {
		if err := os.Mkdir(filepath.Join(dir, name), 0o700); err != nil {
			t.Fatal(err)
		}
	}
	config := filepath.Join(dir, "helper_config.yaml")
	if _, err := ReadStatus(config); !errors.Is(err, errNotRegularFile) {
		t.Fatalf("ReadStatus: got %v", err)
	}
	if _, err := readBranding(config); !errors.Is(err, errNotRegularFile) {
		t.Fatalf("readBranding: got %v", err)
	}
	if err := stripBranding(config); !errors.Is(err, errNotRegularFile) {
		t.Fatalf("stripBranding: got %v", err)
	}
}
