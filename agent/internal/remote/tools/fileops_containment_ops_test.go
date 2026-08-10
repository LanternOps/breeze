package tools

import (
	"encoding/json"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

// The deny-list matches path FRAGMENTS at a component boundary, so a path built
// under t.TempDir() (".../etc/shadow") trips exactly the same rules a real
// "/etc/shadow" would — no privileged fixtures required.

// makeSensitiveFile creates <root>/etc/shadow (a deny-list match) with content.
func makeSensitiveFile(t *testing.T, root string) string {
	t.Helper()
	dir := filepath.Join(root, "etc")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	p := filepath.Join(dir, "shadow")
	if err := os.WriteFile(p, []byte("root:$6$hash:19000:0:99999:7:::\n"), 0o600); err != nil {
		t.Fatalf("write: %v", err)
	}
	return p
}

// makeSensitiveDir creates <root>/etc/ssl/private (a deny-list match) holding a key.
func makeSensitiveDir(t *testing.T, root string) string {
	t.Helper()
	dir := filepath.Join(root, "etc", "ssl", "private")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	if err := os.WriteFile(filepath.Join(dir, "server.key"), []byte("KEY"), 0o600); err != nil {
		t.Fatalf("write: %v", err)
	}
	return dir
}

// makeBenignFile creates <root>/docs/notes.txt.
func makeBenignFile(t *testing.T, root string) string {
	t.Helper()
	dir := filepath.Join(root, "docs")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	p := filepath.Join(dir, "notes.txt")
	if err := os.WriteFile(p, []byte("hello"), 0o600); err != nil {
		t.Fatalf("write: %v", err)
	}
	return p
}

// makeBenignDir creates <root>/docs holding one file.
func makeBenignDir(t *testing.T, root string) string {
	t.Helper()
	makeBenignFile(t, root)
	return filepath.Join(root, "docs")
}

// sourceGatedOp is one operation whose SOURCE/target path must be refused when
// it names a credential store. `invoke` receives the target path plus a scratch
// directory it may use for a destination.
type sourceGatedOp struct {
	name     string
	needsDir bool // target must be a directory, not a file
	// denialInResult is true for ops that report the denial inside a successful
	// result payload (a scan error) rather than failing the whole command.
	denialInResult bool
	invoke         func(t *testing.T, target, scratch string) CommandResult
}

func sourceGatedOps() []sourceGatedOp {
	return []sourceGatedOp{
		// Regressions — these two were already gated before #3397.
		{name: "read", invoke: func(_ *testing.T, target, _ string) CommandResult {
			return ReadFile(map[string]any{"path": target})
		}},
		{name: "list", needsDir: true, invoke: func(_ *testing.T, target, _ string) CommandResult {
			return ListFiles(map[string]any{"path": target})
		}},

		// #3397 — content-disclosing / content-relocating.
		{name: "copy", invoke: func(_ *testing.T, target, scratch string) CommandResult {
			return CopyFile(map[string]any{"sourcePath": target, "destPath": filepath.Join(scratch, "out")})
		}},
		{name: "copy dir", needsDir: true, invoke: func(_ *testing.T, target, scratch string) CommandResult {
			return CopyFile(map[string]any{"sourcePath": target, "destPath": filepath.Join(scratch, "outdir")})
		}},
		{name: "rename", invoke: func(_ *testing.T, target, scratch string) CommandResult {
			return RenameFile(map[string]any{"oldPath": target, "newPath": filepath.Join(scratch, "out")})
		}},
		{name: "delete to trash", invoke: func(_ *testing.T, target, _ string) CommandResult {
			return DeleteFile(map[string]any{"path": target})
		}},
		{name: "delete permanent", invoke: func(_ *testing.T, target, _ string) CommandResult {
			return DeleteFile(map[string]any{"path": target, "permanent": true})
		}},
		{name: "quarantine", invoke: func(_ *testing.T, target, scratch string) CommandResult {
			return QuarantineFile(map[string]any{"path": target, "quarantineDir": filepath.Join(scratch, "q")})
		}},
		{name: "secure delete", invoke: func(_ *testing.T, target, _ string) CommandResult {
			return SecureDeleteFile(map[string]any{"path": target})
		}},
		{name: "encrypt", invoke: func(_ *testing.T, target, _ string) CommandResult {
			return EncryptFile(map[string]any{"path": target})
		}},

		// #3397 — traversal entry points. These report the denial as a scan
		// error inside an otherwise-successful result.
		{name: "analyze filesystem root", needsDir: true, invoke: func(_ *testing.T, target, _ string) CommandResult {
			return AnalyzeFilesystem(map[string]any{"path": target, "timeoutSeconds": 5})
		}},
		{name: "analyze filesystem targetDirectories", needsDir: true, denialInResult: true,
			invoke: func(_ *testing.T, target, scratch string) CommandResult {
				return AnalyzeFilesystem(map[string]any{
					"path":              scratch,
					"scanMode":          "incremental",
					"targetDirectories": []any{target},
					"timeoutSeconds":    5,
				})
			}},
		{name: "analyze filesystem checkpoint", needsDir: true, denialInResult: true,
			invoke: func(_ *testing.T, target, scratch string) CommandResult {
				return AnalyzeFilesystem(map[string]any{
					"path":           scratch,
					"timeoutSeconds": 5,
					"checkpoint": map[string]any{
						"pendingDirs": []any{map[string]any{"path": target, "depth": 0}},
					},
				})
			}},
		{name: "scan sensitive data includePaths", needsDir: true, denialInResult: true,
			invoke: func(_ *testing.T, target, _ string) CommandResult {
				return ScanSensitiveData(map[string]any{
					"scope": map[string]any{"includePaths": []any{target}, "timeoutSeconds": 5},
				})
			}},
	}
}

// TestOperationsDenySensitiveSource is the core #3397 contract: every operation
// that reads, copies, moves or destroys file content refuses a source path that
// names a credential store. Before this fix only ReadFile and ListFiles did,
// which made CopyFile(/etc/shadow → /tmp/x) + ReadFile(/tmp/x) a complete
// bypass of the deny-list.
func TestOperationsDenySensitiveSource(t *testing.T) {
	for _, op := range sourceGatedOps() {
		t.Run(op.name, func(t *testing.T) {
			root := t.TempDir()
			scratch := t.TempDir()

			var target string
			if op.needsDir {
				target = makeSensitiveDir(t, root)
			} else {
				target = makeSensitiveFile(t, root)
			}

			res := op.invoke(t, target, scratch)

			if op.denialInResult {
				if res.Status != "completed" {
					t.Fatalf("expected a completed result carrying the denial, got status %q err %q", res.Status, res.Error)
				}
				if !strings.Contains(res.Stdout, "denied on sensitive path") {
					t.Fatalf("expected a containment denial in the result payload, got: %s", res.Stdout)
				}
			} else {
				if res.Status == "completed" {
					t.Fatalf("expected %s on a sensitive source to be denied, got a completed result", op.name)
				}
				if !strings.Contains(res.Error, "denied on sensitive path") {
					t.Fatalf("expected a containment denial, got: %q", res.Error)
				}
			}

			// The target must survive every denial — no operation may have
			// half-executed before the gate.
			if _, err := os.Stat(target); err != nil {
				t.Fatalf("sensitive target was mutated despite denial: %v", err)
			}
		})
	}
}

// TestOperationsAllowBenignSource is the other half of the contract: the gate
// must not break ordinary file management. A deny-list that also blocks
// /home/alice/notes.txt would simply be turned off in the field.
func TestOperationsAllowBenignSource(t *testing.T) {
	for _, op := range sourceGatedOps() {
		t.Run(op.name, func(t *testing.T) {
			root := t.TempDir()
			scratch := t.TempDir()

			var target string
			if op.needsDir {
				target = makeBenignDir(t, root)
			} else {
				target = makeBenignFile(t, root)
			}

			res := op.invoke(t, target, scratch)

			// EncryptFile legitimately fails without a configured key; that is
			// not a containment refusal, which is all this test asserts.
			if strings.Contains(res.Error, "denied on sensitive path") ||
				strings.Contains(res.Stdout, "denied on sensitive path") {
				t.Fatalf("benign path was refused by containment: err=%q stdout=%s", res.Error, res.Stdout)
			}
		})
	}
}

// TestOperationsDenySymlinkToSensitiveSource covers the laundering variant the
// #3395 review flagged: an innocuously-named symlink pointing at a credential
// store. EnforcePathContainment resolves the link before matching, so the
// literal name buys nothing.
func TestOperationsDenySymlinkToSensitiveSource(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("symlink creation is unreliable without privilege on Windows CI")
	}

	for _, op := range sourceGatedOps() {
		if op.denialInResult {
			// Traversal entry points are covered by the source test; the
			// symlink property is the same code path (EnforcePathContainment).
			continue
		}
		t.Run(op.name, func(t *testing.T) {
			root := t.TempDir()
			scratch := t.TempDir()

			var real string
			if op.needsDir {
				real = makeSensitiveDir(t, root)
			} else {
				real = makeSensitiveFile(t, root)
			}

			link := filepath.Join(root, "vacation-photos")
			if err := os.Symlink(real, link); err != nil {
				t.Fatalf("symlink: %v", err)
			}

			res := op.invoke(t, link, scratch)
			if res.Status == "completed" {
				t.Fatalf("expected %s through a symlink to a sensitive path to be denied", op.name)
			}
			if !strings.Contains(res.Error, "symlink") {
				t.Fatalf("expected a symlink-specific denial, got: %q", res.Error)
			}
			if _, err := os.Stat(real); err != nil {
				t.Fatalf("sensitive target was mutated despite denial: %v", err)
			}
		})
	}
}

// destGatedOp is one operation whose DESTINATION must be refused when it names a
// credential store — otherwise the file browser is a credential-implant tool
// (drop an SSH authorized_keys entry, a /etc/sudoers.d file, …).
type destGatedOp struct {
	name   string
	invoke func(t *testing.T, dest, scratch string) CommandResult
}

// TestOperationsDenySensitiveDestination pins the write half of the policy.
func TestOperationsDenySensitiveDestination(t *testing.T) {
	ops := []destGatedOp{
		{name: "write", invoke: func(_ *testing.T, dest, _ string) CommandResult {
			return WriteFile(map[string]any{"path": dest, "content": "pwned"})
		}},
		{name: "copy", invoke: func(t *testing.T, dest, scratch string) CommandResult {
			return CopyFile(map[string]any{"sourcePath": makeBenignFile(t, scratch), "destPath": dest})
		}},
		{name: "rename", invoke: func(t *testing.T, dest, scratch string) CommandResult {
			return RenameFile(map[string]any{"oldPath": makeBenignFile(t, scratch), "newPath": dest})
		}},
	}

	for _, op := range ops {
		t.Run(op.name, func(t *testing.T) {
			root := t.TempDir()
			scratch := t.TempDir()
			dest := filepath.Join(root, "home", "alice", ".ssh", "authorized_keys")

			res := op.invoke(t, dest, scratch)
			if res.Status == "completed" {
				t.Fatalf("expected %s to a sensitive destination to be denied", op.name)
			}
			if !strings.Contains(res.Error, "denied on sensitive path") {
				t.Fatalf("expected a containment denial, got: %q", res.Error)
			}
			if _, err := os.Stat(dest); err == nil {
				t.Fatal("destination was created despite the denial")
			}
		})
	}
}

// TestTrashRestoreDeniesForgedSensitiveDestination covers the one destination
// that is not taken from the command payload: TrashRestore reads it out of
// metadata.json, a file on disk that a preceding WriteFile could have forged.
// Without the gate, restore is an arbitrary-content-to-arbitrary-path write.
func TestTrashRestoreDeniesForgedSensitiveDestination(t *testing.T) {
	trashDir := t.TempDir()
	victim := t.TempDir()
	original := filepath.Join(victim, "home", "alice", ".ssh", "authorized_keys")

	getTrashDirFunc = func() (string, error) { return trashDir, nil }
	t.Cleanup(func() { getTrashDirFunc = getTrashDir })

	trashID := "1700000000000-forged"
	itemDir := filepath.Join(trashDir, trashID)
	if err := os.MkdirAll(itemDir, 0o700); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	meta := TrashMetadata{
		OriginalPath: original,
		TrashID:      trashID,
		DeletedAt:    "2026-08-10T00:00:00Z",
		IsDirectory:  false,
	}
	metaBytes, err := json.Marshal(meta)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	if err := os.WriteFile(filepath.Join(itemDir, "metadata.json"), metaBytes, 0o600); err != nil {
		t.Fatalf("write meta: %v", err)
	}
	if err := os.WriteFile(filepath.Join(itemDir, "content"), []byte("ssh-rsa AAAA attacker\n"), 0o600); err != nil {
		t.Fatalf("write content: %v", err)
	}

	res := TrashRestore(map[string]any{"trashId": trashID})
	if res.Status == "completed" {
		t.Fatal("expected restore to a forged sensitive destination to be denied")
	}
	if !strings.Contains(res.Error, "denied on sensitive path") {
		t.Fatalf("expected a containment denial, got: %q", res.Error)
	}
	if _, err := os.Stat(original); err == nil {
		t.Fatal("attacker content was implanted at the sensitive destination")
	}
}

// TestTrashRestoreAllowsBenignDestination guards against the gate above turning
// ordinary undelete into a dead feature.
func TestTrashRestoreAllowsBenignDestination(t *testing.T) {
	trashDir := t.TempDir()
	home := t.TempDir()

	getTrashDirFunc = func() (string, error) { return trashDir, nil }
	t.Cleanup(func() { getTrashDirFunc = getTrashDir })

	original := filepath.Join(home, "docs", "notes.txt")
	trashID := "1700000000000-notes.txt"
	itemDir := filepath.Join(trashDir, trashID)
	if err := os.MkdirAll(itemDir, 0o700); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	meta := TrashMetadata{OriginalPath: original, TrashID: trashID, DeletedAt: "2026-08-10T00:00:00Z"}
	metaBytes, err := json.Marshal(meta)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	if err := os.WriteFile(filepath.Join(itemDir, "metadata.json"), metaBytes, 0o600); err != nil {
		t.Fatalf("write meta: %v", err)
	}
	if err := os.WriteFile(filepath.Join(itemDir, "content"), []byte("hello"), 0o600); err != nil {
		t.Fatalf("write content: %v", err)
	}

	res := TrashRestore(map[string]any{"trashId": trashID})
	if res.Status != "completed" {
		t.Fatalf("expected benign restore to succeed, got: %q", res.Error)
	}
	if _, err := os.Stat(original); err != nil {
		t.Fatalf("expected the file to be restored: %v", err)
	}
}

// TestCopyDirSkipSensitiveContract pins the copyDir boolean, which is the one
// place in #3397 where getting the polarity backwards causes DATA LOSS rather
// than a leak:
//   - true  (operator-facing CopyFile): sensitive entries are omitted, so
//     copying a parent directory cannot launder credential stores into a
//     readable location.
//   - false (the fallback half of a MOVE — DeleteFile→trash, TrashRestore):
//     every entry is preserved, because the source is deleted afterwards and an
//     omitted entry would be destroyed rather than protected.
func TestCopyDirSkipSensitiveContract(t *testing.T) {
	cases := []struct {
		name           string
		skipSensitive  bool
		wantSensitive  bool
		wantBenignKept bool
	}{
		{name: "CopyFile semantics omit credential stores", skipSensitive: true, wantSensitive: false, wantBenignKept: true},
		{name: "move semantics preserve everything", skipSensitive: false, wantSensitive: true, wantBenignKept: true},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			src := t.TempDir()
			dst := filepath.Join(t.TempDir(), "copy")

			makeSensitiveFile(t, src) // <src>/etc/shadow
			makeSensitiveDir(t, src)  // <src>/etc/ssl/private/server.key
			makeBenignFile(t, src)    // <src>/docs/notes.txt

			if err := copyDir(src, dst, tc.skipSensitive); err != nil {
				t.Fatalf("copyDir: %v", err)
			}

			_, shadowErr := os.Stat(filepath.Join(dst, "etc", "shadow"))
			_, keyErr := os.Stat(filepath.Join(dst, "etc", "ssl", "private", "server.key"))
			if got := shadowErr == nil; got != tc.wantSensitive {
				t.Fatalf("copied shadow = %v, want %v", got, tc.wantSensitive)
			}
			if got := keyErr == nil; got != tc.wantSensitive {
				t.Fatalf("copied private key = %v, want %v", got, tc.wantSensitive)
			}

			if _, err := os.Stat(filepath.Join(dst, "docs", "notes.txt")); (err == nil) != tc.wantBenignKept {
				t.Fatalf("benign file present = %v, want %v", err == nil, tc.wantBenignKept)
			}
		})
	}
}

// TestCopyFileDoesNotLaunderNestedCredentialStores is the end-to-end proof for
// the copyDir filter: gating only the copy ROOT is insufficient, because
// copying a benign parent relocates every credential store beneath it to a path
// the deny-list no longer recognises — and a plain ReadFile of the copy would
// then serve it.
func TestCopyFileDoesNotLaunderNestedCredentialStores(t *testing.T) {
	src := t.TempDir()
	dstRoot := t.TempDir()
	dst := filepath.Join(dstRoot, "exfil")

	makeSensitiveFile(t, src)
	makeBenignFile(t, src)

	res := CopyFile(map[string]any{"sourcePath": src, "destPath": dst})
	if res.Status != "completed" {
		t.Fatalf("expected the benign parent copy to succeed, got: %q", res.Error)
	}

	laundered := filepath.Join(dst, "etc", "shadow")
	if _, err := os.Stat(laundered); err == nil {
		t.Fatal("credential store was laundered into the copy destination")
	}

	// And the copy is still useful for its actual purpose.
	if _, err := os.Stat(filepath.Join(dst, "docs", "notes.txt")); err != nil {
		t.Fatalf("expected benign content to be copied: %v", err)
	}
}

// TestScanSensitiveDataSkipsCredentialStoresUnderBenignRoot proves the per-entry
// filter in the scan walk. Unlike AnalyzeFilesystem (metadata only), this walk
// opens and pattern-matches file CONTENT, so a benign include root containing a
// credential store would turn the scan into an oracle over it.
func TestScanSensitiveDataSkipsCredentialStoresUnderBenignRoot(t *testing.T) {
	root := t.TempDir()

	// Byte-identical content in two places: one inside a deny-listed directory,
	// one in an ordinary documents folder. Both carry an extension the scanner
	// accepts, so the ONLY thing that can distinguish them is containment — the
	// benign copy is the positive control that keeps this test from passing
	// vacuously if the scan silently stops matching (an earlier draft of this
	// test did exactly that: both files were skipped by the extension filter).
	body := []byte("AKIAIOSFODNN7EXAMPLE\n-----BEGIN RSA PRIVATE KEY-----\n")
	denied := filepath.Join(root, "etc", "sudoers.d", "creds.txt")
	benign := filepath.Join(root, "docs", "creds.txt")
	for _, p := range []string{denied, benign} {
		if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
			t.Fatalf("mkdir: %v", err)
		}
		if err := os.WriteFile(p, body, 0o600); err != nil {
			t.Fatalf("write: %v", err)
		}
	}

	res := ScanSensitiveData(map[string]any{
		"scope": map[string]any{"includePaths": []any{root}, "timeoutSeconds": 5},
	})
	if res.Status != "completed" {
		t.Fatalf("expected the scan to complete, got: %q", res.Error)
	}

	var parsed SensitiveDataScanResponse
	if err := json.Unmarshal([]byte(res.Stdout), &parsed); err != nil {
		t.Fatalf("unmarshal scan response: %v", err)
	}

	// Positive control: the identical benign file MUST produce findings.
	var sawBenign bool
	for _, f := range parsed.Findings {
		if f.FilePath == denied {
			t.Fatalf("scan reported a finding inside a credential store: %s", f.FilePath)
		}
		if f.FilePath == benign {
			sawBenign = true
		}
	}
	if !sawBenign {
		t.Fatalf("positive control produced no findings — the scan is not exercising the patterns: %s", res.Stdout)
	}
	if parsed.Summary.FilesScanned != 1 {
		t.Fatalf("expected exactly the benign file to be scanned, got filesScanned=%d", parsed.Summary.FilesScanned)
	}
}
