//go:build windows

// The Windows trust check of the pending-restart record (#12827), run for
// real on a temp directory. Only the data directory's ACL verification is
// injected (trustDataDirForTest): it runs at agent start on the real
// ProgramData folders and cannot be run on a temp directory. Everything the
// check does with the file itself is exercised here.
package patching

import (
	"errors"
	"os"
	"path/filepath"
	"testing"
)

func TestWindowsTrustedReadReadsARecordInAVerifiedDirectory(t *testing.T) {
	dir := t.TempDir()
	trustDataDirForTest(t, dir)
	path := filepath.Join(dir, deferralLedgerFile)
	if err := os.WriteFile(path, []byte(`{"used":1}`), 0o600); err != nil {
		t.Fatal(err)
	}
	data, err := readTrustedRecordFile(path)
	if err != nil || string(data) != `{"used":1}` {
		t.Fatalf("readTrustedRecordFile = %q, %v", data, err)
	}
}

// The real config.ProgramDataDirTrusted, not the seam: a directory the agent
// start never verified is refused (fail closed).
func TestWindowsTrustedReadRefusesAnUnverifiedDirectory(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, deferralLedgerFile)
	if err := os.WriteFile(path, []byte(`{"used":1}`), 0o600); err != nil {
		t.Fatal(err)
	}
	_, err := readTrustedRecordFile(path)
	if _, untrusted := errors.AsType[*untrustedRecordError](err); !untrusted {
		t.Fatalf("readTrustedRecordFile in an unverified directory = %v, want an untrusted-record refusal", err)
	}
}

func TestWindowsTrustedReadRefusesALink(t *testing.T) {
	dir := t.TempDir()
	trustDataDirForTest(t, dir)
	target := filepath.Join(t.TempDir(), "elsewhere.json")
	if err := os.WriteFile(target, []byte(`{"used":0}`), 0o600); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(dir, deferralLedgerFile)
	if err := os.Symlink(target, path); err != nil {
		t.Fatalf("creating a symbolic link (the CI runner is allowed to): %v", err)
	}
	_, err := readTrustedRecordFile(path)
	if _, untrusted := errors.AsType[*untrustedRecordError](err); !untrusted {
		t.Fatalf("readTrustedRecordFile through a link = %v, want an untrusted-record refusal", err)
	}
}

func TestWindowsTrustedReadRefusesADirectoryInPlaceOfTheRecord(t *testing.T) {
	dir := t.TempDir()
	trustDataDirForTest(t, dir)
	path := filepath.Join(dir, deferralLedgerFile)
	if err := os.Mkdir(path, 0o700); err != nil {
		t.Fatal(err)
	}
	_, err := readTrustedRecordFile(path)
	if _, untrusted := errors.AsType[*untrustedRecordError](err); !untrusted {
		t.Fatalf("readTrustedRecordFile on a directory = %v, want an untrusted-record refusal", err)
	}
}

func TestWindowsTrustedReadReportsAMissingRecord(t *testing.T) {
	dir := t.TempDir()
	trustDataDirForTest(t, dir)
	_, err := readTrustedRecordFile(filepath.Join(dir, deferralLedgerFile))
	if !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("readTrustedRecordFile on a missing record = %v, want not-exist", err)
	}
}

func TestWindowsTrustedReadRefusesAnOversizedRecord(t *testing.T) {
	dir := t.TempDir()
	trustDataDirForTest(t, dir)
	path := filepath.Join(dir, deferralLedgerFile)
	if err := os.WriteFile(path, make([]byte, maxRecordBytes+1), 0o600); err != nil {
		t.Fatal(err)
	}
	_, err := readTrustedRecordFile(path)
	if _, untrusted := errors.AsType[*untrustedRecordError](err); !untrusted {
		t.Fatalf("readTrustedRecordFile on an oversized record = %v, want an untrusted-record refusal", err)
	}
}
