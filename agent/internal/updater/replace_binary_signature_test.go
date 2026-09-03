package updater

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// stubStagedSignatureCheck replaces the code-signature gate for the duration of
// a test and restores the real implementation afterwards.
func stubStagedSignatureCheck(t *testing.T, fn func(path string) error) {
	t.Helper()
	prev := verifyStagedBinarySignature
	verifyStagedBinarySignature = fn
	t.Cleanup(func() { verifyStagedBinarySignature = prev })
}

// TestReplaceBinary_SignatureGate pins the #3458 contract: a staged binary that
// fails code-signature verification is REFUSED, and the refusal leaves the
// installed binary byte-for-byte untouched. The updater used to "repair" this
// by ad-hoc signing the new binary in place, which gave the agent a fresh code
// identity on every update and silently invalidated its macOS TCC grants.
func TestReplaceBinary_SignatureGate(t *testing.T) {
	const installed = "installed binary v1"
	const staged = "staged binary v2"

	tests := []struct {
		name        string
		verifyErr   error
		wantErr     bool
		wantContent string
	}{
		{
			name:        "valid signature installs the staged binary",
			verifyErr:   nil,
			wantErr:     false,
			wantContent: staged,
		},
		{
			name:        "invalid signature refuses the update and keeps the installed binary",
			verifyErr:   ErrCodeSignatureInvalid,
			wantErr:     true,
			wantContent: installed,
		},
		{
			name:        "wrapped signature error is still refused",
			verifyErr:   errors.New("codesign: " + ErrCodeSignatureInvalid.Error()),
			wantErr:     true,
			wantContent: installed,
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			dir := t.TempDir()
			binaryPath := filepath.Join(dir, "breeze-agent")
			stagedPath := filepath.Join(dir, "staged")
			if err := os.WriteFile(binaryPath, []byte(installed), 0o755); err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(stagedPath, []byte(staged), 0o644); err != nil {
				t.Fatal(err)
			}

			var gotPath string
			stubStagedSignatureCheck(t, func(path string) error {
				gotPath = path
				return tc.verifyErr
			})

			u := New(&Config{BinaryPath: binaryPath})
			err := u.replaceBinary(stagedPath)

			if tc.wantErr && err == nil {
				t.Fatalf("replaceBinary: expected an error, got nil")
			}
			if !tc.wantErr && err != nil {
				t.Fatalf("replaceBinary: unexpected error: %v", err)
			}
			// The gate must inspect the STAGED file, never the installed one:
			// checking after the copy is what made the old code ad-hoc sign a
			// binary it had already put live.
			if gotPath != stagedPath {
				t.Fatalf("signature gate inspected %q, want the staged path %q", gotPath, stagedPath)
			}
			content, readErr := os.ReadFile(binaryPath)
			if readErr != nil {
				t.Fatalf("read installed binary: %v", readErr)
			}
			if string(content) != tc.wantContent {
				t.Fatalf("installed binary = %q, want %q", string(content), tc.wantContent)
			}
		})
	}
}

// TestReplaceBinary_SignatureRejectionIsClassifiable pins that the refusal is
// reported with the ErrCodeSignatureInvalid sentinel, which is what
// heartbeat.doUpgrade matches on to log the actionable message and start the
// per-version retry cooldown instead of re-downloading every heartbeat.
func TestReplaceBinary_SignatureRejectionIsClassifiable(t *testing.T) {
	dir := t.TempDir()
	binaryPath := filepath.Join(dir, "breeze-agent")
	stagedPath := filepath.Join(dir, "staged")
	if err := os.WriteFile(binaryPath, []byte("installed"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(stagedPath, []byte("staged"), 0o644); err != nil {
		t.Fatal(err)
	}

	stubStagedSignatureCheck(t, func(string) error {
		return ErrCodeSignatureInvalid
	})

	u := New(&Config{BinaryPath: binaryPath})
	err := u.replaceBinary(stagedPath)
	if !errors.Is(err, ErrCodeSignatureInvalid) {
		t.Fatalf("replaceBinary error = %v, want it to wrap ErrCodeSignatureInvalid", err)
	}
	if !isCodeSignatureErr(err) {
		t.Fatalf("isCodeSignatureErr(%v) = false, want true", err)
	}
	if isCodeSignatureErr(errors.New("some other failure")) {
		t.Fatal("isCodeSignatureErr matched an unrelated error")
	}
}

// TestReplaceBinary_NoAdHocSigning is the direct regression guard for #3458:
// the updater must not shell out to `codesign --force --sign -` anywhere. An
// ad-hoc signature's designated requirement is the per-build code-directory
// hash, so applying one to a shipped build changes the agent's code identity on
// every update and macOS drops the TCC grants keyed to the previous identity.
func TestReplaceBinary_NoAdHocSigning(t *testing.T) {
	source, err := os.ReadFile("updater.go")
	if err != nil {
		t.Fatalf("read updater.go: %v", err)
	}
	for _, forbidden := range []string{`"--force", "--sign", "-"`, `"--sign", "-"`} {
		if strings.Contains(string(source), forbidden) {
			t.Fatalf("updater.go still ad-hoc signs the binary (found %s); see #3458", forbidden)
		}
	}
}
