//go:build windows

package pamlifetime

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/breeze-rmm/agent/internal/config"
	"golang.org/x/sys/windows"
)

// fileDeleteChildAccess mirrors config.openMainAgentDirectoryWithShare's use of
// FILE_DELETE_CHILD, which golang.org/x/sys/windows does not export.
const fileDeleteChildAccess = 0x00000040

// TestStorePersistsLedgerWhileParentDirectoryIsPinned is the pamlifetime half of
// issue #4184. The agent pins its ConfigDir for its whole lifetime; the PAM v2
// ledger lives in that same tree and is persisted with a temp file plus
// replaceFile. When the pin withheld FILE_SHARE_WRITE, that rename failed with
// ERROR_SHARING_VIOLATION, PrepareApply returned an error, and the manager
// reported invalid_command for every pam_apply_v2 / pam_cleanup_v2.
//
// The pin here uses config.MainAgentPinnedShareMode directly, so this test also
// fails if the production pin ever drops FILE_SHARE_WRITE again.
func TestStorePersistsLedgerWhileParentDirectoryIsPinned(t *testing.T) {
	dir := t.TempDir()
	release := pinDirectoryLikeMainAgent(t, dir)
	defer release()

	ledgerPath := filepath.Join(dir, "pam-lifetime-ledger.json")
	store := NewStore(ledgerPath)

	decision, err := store.PrepareApply(validApply(1))
	if err != nil {
		t.Fatalf("PrepareApply under pinned parent directory: %v", err)
	}
	if decision != DecisionApply {
		t.Fatalf("decision = %q, want %q", decision, DecisionApply)
	}
	if _, err := os.Stat(ledgerPath); err != nil {
		t.Fatalf("ledger not persisted under pinned parent directory: %v", err)
	}

	if _, err := store.PrepareCleanup(validCleanup(2)); err != nil {
		t.Fatalf("PrepareCleanup under pinned parent directory: %v", err)
	}
}

// pinDirectoryLikeMainAgent opens dir with the exact access mask and share mode
// OpenPreparedMainAgentLockDir pins ConfigDir with. Importing the config
// package's pin entry point itself is not possible here: it resolves the live
// ConfigDir through an unexported seam and verifies the production DACL, so it
// cannot be aimed at a t.TempDir.
func pinDirectoryLikeMainAgent(t *testing.T, dir string) func() {
	t.Helper()
	path16, err := windows.UTF16PtrFromString(dir)
	if err != nil {
		t.Fatalf("UTF16PtrFromString(%s): %v", dir, err)
	}
	handle, err := windows.CreateFile(
		path16,
		windows.FILE_LIST_DIRECTORY|windows.FILE_TRAVERSE|windows.FILE_READ_ATTRIBUTES|fileDeleteChildAccess|windows.READ_CONTROL|windows.WRITE_DAC|windows.WRITE_OWNER,
		config.MainAgentPinnedShareMode,
		nil,
		windows.OPEN_EXISTING,
		windows.FILE_FLAG_OPEN_REPARSE_POINT|windows.FILE_FLAG_BACKUP_SEMANTICS,
		0,
	)
	if err != nil {
		t.Fatalf("pin %s the way the main agent does: %v", dir, err)
	}
	return func() { _ = windows.CloseHandle(handle) }
}
