package rebuild

import (
	"context"
	"os"
	"path/filepath"
	"testing"

	"github.com/breeze-rmm/agent/internal/backup/layout"
)

// bitlockerRun: a run whose restored root VOLUME (ruling C1) is a fresh
// directory and whose rootDir folder mount is a separate, empty one.
func bitlockerRun(t *testing.T, kind TargetKind, bitlocker bool) *run {
	t.Helper()
	lay := testLayoutWindows()
	if bitlocker {
		lay.Disks[0].Partitions[2].Encryption = layout.EncryptionBitLocker
	}
	dir := t.TempDir()
	rootDir := filepath.Join(dir, "mnt", "root")
	if err := os.MkdirAll(rootDir, 0o700); err != nil {
		t.Fatal(err)
	}
	return &run{opts: Options{Target: Target{Kind: kind}}, rootVolume: filepath.Join(dir, "vol-root"), rootDir: rootDir, result: &Result{}, layout: lay}
}

func intentPath(r *run) string {
	return filepath.Join(r.rootVolume, "ProgramData", "Breeze", "data", "post-restore-actions.json")
}

// R23: the intent file is EXACTLY the Global Constraint's bytes.
func TestWinEncryption_BitLockerDiskTargetWritesIntent(t *testing.T) {
	r := bitlockerRun(t, TargetDisk, true)
	if err := winEncryption(context.Background(), r); err != nil {
		t.Fatal(err)
	}
	b, err := os.ReadFile(intentPath(r))
	if err != nil {
		t.Fatal(err)
	}
	const want = `{"schemaVersion":1,"bitlocker":{"reencrypt":true,"volume":"C:"},"winre":{"enable":false,"reason":"recovery partition contents were not backed up"}}`
	if string(b) != want {
		t.Fatalf("intent = %s, want %s", b, want)
	}
	if len(r.warnings) != 1 || r.warnings[0] != "volume C: was BitLocker-protected at backup; it is restored unencrypted; re-encryption on first boot arrives with the Windows recovery media (W07)" {
		t.Fatalf("warnings = %v", r.warnings)
	}
	if r.recorded(PhaseEncryption) {
		t.Fatal("a written intent is a completed phase, not a skipped row")
	}
	assertRootDirUntouched(t, r)
}

// R24.
func TestWinEncryption_BitLockerVhdxSkipped(t *testing.T) {
	r := bitlockerRun(t, TargetVHDX, true)
	if err := winEncryption(context.Background(), r); err != nil {
		t.Fatal(err)
	}
	if last := r.result.Phases[len(r.result.Phases)-1]; last.Phase != PhaseEncryption || last.Status != PhaseSkipped || last.Message != "rehearsal image left unencrypted" {
		t.Fatalf("phase row = %+v", last)
	}
	if _, err := os.Stat(intentPath(r)); !os.IsNotExist(err) {
		t.Fatal("no intent file for a vhdx rehearsal")
	}
}

func TestWinEncryption_NotBitLockerSkipped(t *testing.T) {
	r := bitlockerRun(t, TargetDisk, false)
	if err := winEncryption(context.Background(), r); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(intentPath(r)); !os.IsNotExist(err) {
		t.Fatal("no intent file for an unencrypted source")
	}
	if !r.recorded(PhaseEncryption) || r.result.Phases[0].Status != PhaseSkipped {
		t.Fatalf("expected a skipped encryption row: %+v", r.result.Phases)
	}
	if len(r.warnings) != 0 {
		t.Fatalf("warnings = %v", r.warnings)
	}
}

func TestRootIsBitLocker(t *testing.T) {
	if rootIsBitLocker(&run{}) {
		t.Fatal("no layout is not BitLocker")
	}
	if !rootIsBitLocker(bitlockerRun(t, TargetDisk, true)) || rootIsBitLocker(bitlockerRun(t, TargetDisk, false)) {
		t.Fatal("rootIsBitLocker must follow the root partition's encryption")
	}
}
