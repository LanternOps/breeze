//go:build darwin

// Platform-truth coverage for the real `codesign --verify` gate. The
// cross-platform tests in replace_binary_signature_test.go stub the seam; these
// exercise the actual implementation on the only OS where it does anything.
package updater

import (
	"errors"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
)

func copyFileForTest(t *testing.T, src, dst string) {
	t.Helper()
	in, err := os.Open(src)
	if err != nil {
		t.Fatalf("open %s: %v", src, err)
	}
	defer in.Close()
	out, err := os.OpenFile(dst, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, 0o755)
	if err != nil {
		t.Fatalf("create %s: %v", dst, err)
	}
	if _, err := io.Copy(out, in); err != nil {
		out.Close()
		t.Fatalf("copy %s -> %s: %v", src, dst, err)
	}
	if err := out.Close(); err != nil {
		t.Fatalf("close %s: %v", dst, err)
	}
}

func TestDefaultStagedSignatureCheck_Darwin(t *testing.T) {
	if _, err := exec.LookPath("codesign"); err != nil {
		t.Skip("codesign not available")
	}

	dir := t.TempDir()

	// A genuinely signed Mach-O: a copy of this test binary, ad-hoc signed so
	// the case is deterministic on both amd64 (where the Go linker does not
	// sign) and arm64 (where it does).
	signed := filepath.Join(dir, "signed-macho")
	copyFileForTest(t, os.Args[0], signed)
	if out, err := exec.Command("codesign", "--force", "--sign", "-", signed).CombinedOutput(); err != nil {
		t.Skipf("could not ad-hoc sign the test fixture: %v: %s", err, out)
	}

	// Not a Mach-O at all: `codesign --verify` reports "not signed at all".
	unsigned := filepath.Join(dir, "not-a-macho")
	if err := os.WriteFile(unsigned, []byte("#!/bin/sh\necho hi\n"), 0o755); err != nil {
		t.Fatal(err)
	}

	tests := []struct {
		name    string
		path    string
		wantErr bool
	}{
		{name: "validly signed Mach-O is accepted", path: signed, wantErr: false},
		{name: "file with no signature is rejected", path: unsigned, wantErr: true},
		{name: "missing file is rejected", path: filepath.Join(dir, "does-not-exist"), wantErr: true},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			err := defaultStagedSignatureCheck(tc.path)
			if tc.wantErr {
				if err == nil {
					t.Fatalf("defaultStagedSignatureCheck(%s) = nil, want an error", tc.path)
				}
				if !errors.Is(err, ErrCodeSignatureInvalid) {
					t.Fatalf("error %v does not wrap ErrCodeSignatureInvalid", err)
				}
				return
			}
			if err != nil {
				t.Fatalf("defaultStagedSignatureCheck(%s) = %v, want nil", tc.path, err)
			}
		})
	}
}

// TestReplaceBinary_RealSignatureGateKeepsInstalledBinary drives the whole
// replaceBinary path with the REAL gate: an unsigned staged binary must be
// refused and the installed binary left byte-identical (#3458).
func TestReplaceBinary_RealSignatureGateKeepsInstalledBinary(t *testing.T) {
	if _, err := exec.LookPath("codesign"); err != nil {
		t.Skip("codesign not available")
	}

	dir := t.TempDir()
	binaryPath := filepath.Join(dir, "breeze-agent")
	stagedPath := filepath.Join(dir, "staged")
	if err := os.WriteFile(binaryPath, []byte("installed binary"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(stagedPath, []byte("not a signed mach-o"), 0o644); err != nil {
		t.Fatal(err)
	}

	u := New(&Config{BinaryPath: binaryPath})
	err := u.replaceBinary(stagedPath)
	if !errors.Is(err, ErrCodeSignatureInvalid) {
		t.Fatalf("replaceBinary error = %v, want ErrCodeSignatureInvalid", err)
	}
	content, readErr := os.ReadFile(binaryPath)
	if readErr != nil {
		t.Fatalf("read installed binary: %v", readErr)
	}
	if string(content) != "installed binary" {
		t.Fatalf("installed binary = %q, want it untouched", string(content))
	}
}
