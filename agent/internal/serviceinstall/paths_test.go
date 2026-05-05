package serviceinstall

import (
	"os"
	"path/filepath"
	"testing"
)

func TestProtectedBinaryPathIn(t *testing.T) {
	programFiles := t.TempDir()

	got, err := ProtectedBinaryPathIn(programFiles, "breeze-agent.exe")
	if err != nil {
		t.Fatalf("ProtectedBinaryPathIn returned error: %v", err)
	}

	want := filepath.Join(programFiles, "Breeze", "breeze-agent.exe")
	if got != want {
		t.Fatalf("ProtectedBinaryPathIn = %q, want %q", got, want)
	}
}

func TestProtectedBinaryPathInRejectsInvalidInput(t *testing.T) {
	if _, err := ProtectedBinaryPathIn("", "breeze-agent.exe"); err == nil {
		t.Fatal("expected empty ProgramFiles path to be rejected")
	}
	if _, err := ProtectedBinaryPathIn(t.TempDir(), filepath.Join("nested", "agent.exe")); err == nil {
		t.Fatal("expected nested binary name to be rejected")
	}
}

func TestStageProtectedBinaryCopiesExecutableToTarget(t *testing.T) {
	dir := t.TempDir()
	source := filepath.Join(dir, "Downloads", "breeze-agent.exe")
	target := filepath.Join(dir, "Program Files", "Breeze", "breeze-agent.exe")
	if err := os.MkdirAll(filepath.Dir(source), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(source, []byte("agent-binary"), 0o755); err != nil {
		t.Fatal(err)
	}

	installedPath, copied, err := StageProtectedBinary(source, target)
	if err != nil {
		t.Fatalf("StageProtectedBinary returned error: %v", err)
	}
	if !copied {
		t.Fatal("expected source outside protected target to be copied")
	}
	if installedPath != target {
		t.Fatalf("installed path = %q, want %q", installedPath, target)
	}
	data, err := os.ReadFile(target)
	if err != nil {
		t.Fatalf("read staged executable: %v", err)
	}
	if string(data) != "agent-binary" {
		t.Fatalf("staged executable contents = %q", string(data))
	}
}

func TestStageProtectedBinaryKeepsProtectedExecutable(t *testing.T) {
	target := filepath.Join(t.TempDir(), "Program Files", "Breeze", "breeze-agent.exe")
	if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(target, []byte("agent-binary"), 0o755); err != nil {
		t.Fatal(err)
	}

	installedPath, copied, err := StageProtectedBinary(target, target)
	if err != nil {
		t.Fatalf("StageProtectedBinary returned error: %v", err)
	}
	if copied {
		t.Fatal("expected existing protected executable to be used in place")
	}
	if installedPath != target {
		t.Fatalf("installed path = %q, want %q", installedPath, target)
	}
}
