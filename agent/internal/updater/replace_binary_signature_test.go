package updater

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/breeze-rmm/agent/internal/secmem"
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
			name:        "any non-sentinel verify failure is still refused",
			verifyErr:   errors.New("codesign: exit status 1"),
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
	entries, err := os.ReadDir(".")
	if err != nil {
		t.Fatalf("read package dir: %v", err)
	}
	scanned := 0
	for _, entry := range entries {
		name := entry.Name()
		if entry.IsDir() || !strings.HasSuffix(name, ".go") || strings.HasSuffix(name, "_test.go") {
			continue
		}
		source, readErr := os.ReadFile(name)
		if readErr != nil {
			t.Fatalf("read %s: %v", name, readErr)
		}
		scanned++
		for _, forbidden := range []string{`"--force", "--sign", "-"`, `"--sign", "-"`, `"--sign", adHoc`} {
			if strings.Contains(string(source), forbidden) {
				t.Fatalf("%s ad-hoc signs the binary (found %s); the updater must never manufacture a signature — see #3458", name, forbidden)
			}
		}
	}
	if scanned == 0 {
		t.Fatal("scanned no source files — the guard would pass vacuously")
	}
}

// TestUpdateFromURL_SignatureRejectionSurvivesToTheCaller drives the public
// entry point, not just replaceBinary. heartbeat.doUpgrade matches on
// errors.Is(err, ErrCodeSignatureInvalid), so a future re-wrap that loses the
// sentinel (errors.New(err.Error()), say) would silently disable the
// classification, the actionable log line and the retry cooldown. It also pins
// that the refusal does NOT roll back: nothing was written, so rewriting the
// live binary from the backup would be pure risk.
func TestUpdateFromURL_SignatureRejectionSurvivesToTheCaller(t *testing.T) {
	const installed = "installed binary v1"
	staged := []byte("staged binary v2")

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write(staged)
	}))
	defer srv.Close()

	dir := t.TempDir()
	binaryPath := filepath.Join(dir, "breeze-agent")
	backupPath := filepath.Join(dir, "breeze-agent.backup")
	if err := os.WriteFile(binaryPath, []byte(installed), 0o755); err != nil {
		t.Fatal(err)
	}

	stubStagedSignatureCheck(t, func(string) error { return ErrCodeSignatureInvalid })

	u := New(&Config{
		ServerURL:  staticServerURL(srv.URL),
		AuthToken:  secmem.NewSecureString("tok"),
		BinaryPath: binaryPath,
		BackupPath: backupPath,
	})
	u.client = srv.Client()

	sum := sha256.Sum256(staged)
	err := u.UpdateFromURL(srv.URL, hex.EncodeToString(sum[:]), UpdateOptions{})
	if !errors.Is(err, ErrCodeSignatureInvalid) {
		t.Fatalf("UpdateFromURL error = %v, want it to wrap ErrCodeSignatureInvalid", err)
	}

	content, readErr := os.ReadFile(binaryPath)
	if readErr != nil {
		t.Fatalf("read installed binary: %v", readErr)
	}
	if string(content) != installed {
		t.Fatalf("installed binary = %q, want it untouched", string(content))
	}
}

// The two remedy branches differ by which entry point refused the update, and a
// swapped one would only surface mid-incident in an agent log.
func TestCodeSignatureRejectionFields(t *testing.T) {
	tests := []struct {
		name          string
		targetVersion string
		wantPairs     map[string]string
		wantRemedy    string
		wantNoKey     string
	}{
		{
			name:          "control-plane upgrade names the version",
			targetVersion: "0.109.0",
			wantPairs:     map[string]string{"targetVersion": "0.109.0"},
			wantRemedy:    "republish this version",
		},
		{
			name:          "dev push has no version and points at the build",
			targetVersion: "",
			wantRemedy:    "sign the dev binary",
			wantNoKey:     "targetVersion",
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			fields := codeSignatureRejectionFields(tc.targetVersion, ErrCodeSignatureInvalid)
			if len(fields)%2 != 0 {
				t.Fatalf("fields must be key/value pairs, got %d entries", len(fields))
			}
			got := map[string]string{}
			for i := 0; i < len(fields); i += 2 {
				key, _ := fields[i].(string)
				value, _ := fields[i+1].(string)
				got[key] = value
			}
			for key, want := range tc.wantPairs {
				if got[key] != want {
					t.Errorf("field %q = %q, want %q", key, got[key], want)
				}
			}
			if tc.wantNoKey != "" {
				if _, present := got[tc.wantNoKey]; present {
					t.Errorf("field %q should not be present, got %q", tc.wantNoKey, got[tc.wantNoKey])
				}
			}
			if !strings.Contains(got["remedy"], tc.wantRemedy) {
				t.Errorf("remedy = %q, want it to mention %q", got["remedy"], tc.wantRemedy)
			}
			if got["action"] == "" {
				t.Error("action field missing")
			}
		})
	}
}
