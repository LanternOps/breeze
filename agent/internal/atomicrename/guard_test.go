package atomicrename

import (
	"io/fs"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
)

// fileRenameInfoExUse matches a hand-rolled Win32 FileRenameInfoEx rename: the
// info-class constant or the POSIX-semantics flag it is always paired with.
var fileRenameInfoExUse = regexp.MustCompile(`FileRenameInfoEx|fileRenameInfoExClass|fileRenamePosixSemantics|FILE_RENAME_POSIX_SEMANTICS`)

// fileRenameInfoExOwners may build the rename themselves.
//
//   - internal/atomicrename owns the path-based rename and its pre-1607
//     fallback (#8858, #8860).
//   - internal/securefs renames handle-relative through NtSetInformationFile
//     (FileRenameInformationEx, class 65) with its own latched fallback to
//     class 10; a path-based helper cannot express a RootDirectory rename.
var fileRenameInfoExOwners = []string{
	filepath.Join("internal", "atomicrename") + string(filepath.Separator),
	filepath.Join("internal", "securefs") + string(filepath.Separator),
}

// TestFileRenameInfoExOnlyInOwners keeps a new caller from copying the
// FileRenameInfoEx rename without the build-gated MoveFileEx fallback. Windows
// 10 2015 LTSB (build 10240) refuses class 22, so a copy without the fallback
// fails every write there (#8858 for agent.state, #8860 for the PAM ledger).
func TestFileRenameInfoExOnlyInOwners(t *testing.T) {
	root, err := filepath.Abs(filepath.Join("..", ".."))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(root, "go.mod")); err != nil {
		t.Fatalf("agent module root not found at %s: %v", root, err)
	}
	scanned := 0
	err = filepath.WalkDir(root, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if d.IsDir() {
			switch d.Name() {
			case "vendor", "testdata", "node_modules", ".git":
				return filepath.SkipDir
			}
			return nil
		}
		if !strings.HasSuffix(path, ".go") || strings.HasSuffix(path, "_test.go") {
			return nil
		}
		rel, err := filepath.Rel(root, path)
		if err != nil {
			return err
		}
		scanned++
		for _, owner := range fileRenameInfoExOwners {
			if strings.HasPrefix(rel, owner) {
				return nil
			}
		}
		raw, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		if loc := fileRenameInfoExUse.FindIndex(raw); loc != nil {
			t.Errorf("%s uses %q directly; call atomicrename.Replace so pre-1607 Windows falls back to MoveFileEx", rel, raw[loc[0]:loc[1]])
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	if scanned < 100 {
		t.Fatalf("scanned only %d Go files under %s; the guard is not looking at the agent tree", scanned, root)
	}
}
