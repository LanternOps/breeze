package tools

import (
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/breeze-rmm/agent/internal/wire"
)

// #4026: deterministic refusals carry a typed errorCode on the result envelope
// so the API stops classifying them by matching English prose.

func TestNewErrorResultCarriesTypedCode(t *testing.T) {
	res := NewErrorResult(withErrorCode(wire.ErrCodeFileTooLarge, fmt.Errorf("file too large: 9 bytes")), 1)
	if res.ErrorCode != wire.ErrCodeFileTooLarge {
		t.Fatalf("ErrorCode = %q, want %q", res.ErrorCode, wire.ErrCodeFileTooLarge)
	}
	if res.Error != "file too large: 9 bytes" {
		t.Fatalf("Error = %q; the prose must be unchanged so older APIs keep classifying it", res.Error)
	}

	raw, err := json.Marshal(res)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	var onWire map[string]any
	if err := json.Unmarshal(raw, &onWire); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if onWire["errorCode"] != "file_too_large" {
		t.Fatalf("wire errorCode = %#v, want \"file_too_large\" (raw: %s)", onWire["errorCode"], raw)
	}
}

func TestNewErrorResultCodeSurvivesWrapping(t *testing.T) {
	inner := withErrorCode(wire.ErrCodeSensitivePathDenied, errors.New("read denied on sensitive path: /x"))
	res := NewErrorResult(fmt.Errorf("failed to open path: %w", inner), 1)
	if res.ErrorCode != wire.ErrCodeSensitivePathDenied {
		t.Fatalf("ErrorCode = %q, want the wrapped code %q", res.ErrorCode, wire.ErrCodeSensitivePathDenied)
	}
}

func TestNewErrorResultOutermostCodeWins(t *testing.T) {
	inner := withErrorCode(wire.ErrCodeDirectoryTooLarge, errors.New("directory too large to clear"))
	outer := withErrorCode(wire.ErrCodeContentsUnverifiable, fmt.Errorf("delete denied: cannot verify directory contents: %w", inner))
	if got := NewErrorResult(outer, 1).ErrorCode; got != wire.ErrCodeContentsUnverifiable {
		t.Fatalf("ErrorCode = %q, want the outermost code %q", got, wire.ErrCodeContentsUnverifiable)
	}
}

func TestNewErrorResultUncodedOmitsField(t *testing.T) {
	res := NewErrorResult(errors.New("failed to read directory: boom"), 1)
	if res.ErrorCode != "" {
		t.Fatalf("ErrorCode = %q, want empty for an unclassified failure", res.ErrorCode)
	}
	raw, _ := json.Marshal(res)
	var onWire map[string]any
	_ = json.Unmarshal(raw, &onWire)
	if _, present := onWire["errorCode"]; present {
		t.Fatalf("errorCode must be omitted when unset (raw: %s)", raw)
	}
}

// TestContainmentResolveFailureIsUntagged pins the review finding on #4026: a
// fail-closed "cannot determine where X resolves" denial is an I/O fault that
// the API's prose classifier answers as a 500. Tagging it sensitive_path_denied
// would silently turn it into a 422 ("you can fix this") for new agents.
func TestContainmentResolveFailureIsUntagged(t *testing.T) {
	err := containmentDeniedf("read denied: cannot determine where %s resolves: %v", "/x", errors.New("boom"))
	if got := NewErrorResult(err, 1).ErrorCode; got != "" {
		t.Fatalf("ErrorCode = %q, want empty for a resolve failure", got)
	}
	if !isContainmentDenied(err) {
		t.Fatal("resolve failure must still be a containment denial")
	}
	tagged := withErrorCode(wire.ErrCodeSensitivePathDenied, containmentDeniedf("read denied on sensitive path (resolved): %s", "/x"))
	if !isContainmentDenied(tagged) {
		t.Fatal("isContainmentDenied must see through the codedError wrapper")
	}
	if got := NewErrorResult(tagged, 1).ErrorCode; got != wire.ErrCodeSensitivePathDenied {
		t.Fatalf("ErrorCode = %q, want %q", got, wire.ErrCodeSensitivePathDenied)
	}
}

// restoreOntoOccupiedPath trashes a file, recreates it at the original path,
// then restores — the one 409 (path_exists) path.
func restoreOntoOccupiedPath(t *testing.T, dir string) CommandResult {
	t.Helper()
	orig := getTrashDirFunc
	getTrashDirFunc = func() (string, error) { return filepath.Join(dir, ".breeze-trash"), nil }
	defer func() { getTrashDirFunc = orig }()

	target := filepath.Join(dir, "occupied.txt")
	if err := os.WriteFile(target, []byte("v1"), 0o600); err != nil {
		t.Fatal(err)
	}
	if res := DeleteFile(map[string]any{"path": target}); res.Status != "completed" {
		t.Fatalf("trash delete failed: %s", res.Error)
	}
	if err := os.WriteFile(target, []byte("v2"), 0o600); err != nil {
		t.Fatal(err)
	}
	list := TrashList(map[string]any{})
	var resp TrashListResponse
	if err := json.Unmarshal([]byte(list.Stdout), &resp); err != nil || len(resp.Items) == 0 {
		t.Fatalf("trash list: %v / %s", err, list.Stdout)
	}
	return TrashRestore(map[string]any{"trashId": resp.Items[0].TrashID})
}

// TestFileOpsRefusalsCarryErrorCode exercises real handlers so the tags are
// proven at the emitting sites, not just in the helper.
func TestFileOpsRefusalsCarryErrorCode(t *testing.T) {
	dir := t.TempDir()
	srcDir := filepath.Join(dir, "src")
	if err := os.MkdirAll(srcDir, 0o755); err != nil {
		t.Fatal(err)
	}
	missing := filepath.Join(dir, "missing")
	keychains := filepath.Join(dir, "Library", "Keychains")
	if err := os.MkdirAll(keychains, 0o755); err != nil {
		t.Fatal(err)
	}
	big := filepath.Join(dir, "big.bin")
	if err := os.WriteFile(big, make([]byte, maxFileReadSize+1), 0o600); err != nil {
		t.Fatal(err)
	}

	cases := []struct {
		name string
		run  func() CommandResult
		want wire.CommandErrorCode
	}{
		{"read: path required", func() CommandResult { return ReadFile(map[string]any{}) }, wire.ErrCodeInvalidArgument},
		{"read: unsupported encoding", func() CommandResult {
			return ReadFile(map[string]any{"path": big, "encoding": "utf16"})
		}, wire.ErrCodeUnsupportedEncoding},
		{"read: directory", func() CommandResult { return ReadFile(map[string]any{"path": srcDir}) }, wire.ErrCodePathIsDirectory},
		{"read: too large", func() CommandResult { return ReadFile(map[string]any{"path": big}) }, wire.ErrCodeFileTooLarge},
		{"read: sensitive path", func() CommandResult { return ReadFile(map[string]any{"path": keychains}) }, wire.ErrCodeSensitivePathDenied},
		{"copy: source missing", func() CommandResult {
			return CopyFile(map[string]any{"sourcePath": missing, "destPath": filepath.Join(dir, "dst")})
		}, wire.ErrCodePathNotFound},
		{"copy: into itself", func() CommandResult {
			return CopyFile(map[string]any{"sourcePath": srcDir, "destPath": filepath.Join(srcDir, "inner")})
		}, wire.ErrCodeCopyIntoSelf},
		{"rename: source missing", func() CommandResult {
			return RenameFile(map[string]any{"oldPath": missing, "newPath": filepath.Join(dir, "renamed")})
		}, wire.ErrCodePathNotFound},
		{"rename: newPath required", func() CommandResult {
			return RenameFile(map[string]any{"oldPath": srcDir})
		}, wire.ErrCodeInvalidArgument},
		{"delete: path missing", func() CommandResult {
			return DeleteFile(map[string]any{"path": missing, "permanent": true})
		}, wire.ErrCodePathNotFound},
		{"mkdir: path required", func() CommandResult { return MakeDirectory(map[string]any{}) }, wire.ErrCodeInvalidArgument},
		{"trash restore: id required", func() CommandResult { return TrashRestore(map[string]any{}) }, wire.ErrCodeInvalidArgument},
		{"trash restore: unknown id", func() CommandResult {
			return TrashRestore(map[string]any{"trashId": "no-such-item"})
		}, wire.ErrCodePathNotFound},
		{"mkdir: system path", func() CommandResult {
			return MakeDirectory(map[string]any{"path": deniedSystemPaths[0]})
		}, wire.ErrCodeSystemPathDenied},
		{"delete: recursive top-level", func() CommandResult {
			return DeleteFile(map[string]any{"path": "/breeze-4026-guard-probe-does-not-exist", "recursive": true, "permanent": true})
		}, wire.ErrCodeTopLevelDeleteDenied},
		{"write: payload too large", func() CommandResult {
			return WriteFile(map[string]any{"path": filepath.Join(dir, "w.txt"), "content": strings.Repeat("x", MaxFileWriteSize+1)})
		}, wire.ErrCodePayloadTooLarge},
		{"write: base64 payload too large", func() CommandResult {
			return WriteFile(map[string]any{
				"path":     filepath.Join(dir, "w.bin"),
				"encoding": "base64",
				"content":  base64.StdEncoding.EncodeToString(make([]byte, MaxFileWriteSize+1)),
			})
		}, wire.ErrCodePayloadTooLarge},
		{"trash restore: destination occupied", func() CommandResult {
			return restoreOntoOccupiedPath(t, dir)
		}, wire.ErrCodePathExists},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			res := tc.run()
			if res.Status != "failed" {
				t.Fatalf("Status = %q, want failed (error %q)", res.Status, res.Error)
			}
			if res.ErrorCode != tc.want {
				t.Fatalf("ErrorCode = %q, want %q (error %q)", res.ErrorCode, tc.want, res.Error)
			}
		})
	}
}
