//go:build windows

package state

import (
	"io"
	"os"

	"golang.org/x/sys/windows"
)

// readStateFile opens the file with FILE_SHARE_DELETE, unlike os.ReadFile.
// The watchdog reads agent.state every few seconds while the agent replaces
// it once per heartbeat via MoveFileEx(REPLACE_EXISTING); a reader handle
// opened without FILE_SHARE_DELETE makes that rename fail with
// ERROR_SHARING_VIOLATION, starving the heartbeat update the watchdog itself
// depends on (2026-07-22 US prod restart-storm incident).
func readStateFile(path string) ([]byte, error) {
	p, err := windows.UTF16PtrFromString(path)
	if err != nil {
		return nil, &os.PathError{Op: "open", Path: path, Err: err}
	}
	h, err := windows.CreateFile(
		p,
		windows.GENERIC_READ,
		windows.FILE_SHARE_READ|windows.FILE_SHARE_WRITE|windows.FILE_SHARE_DELETE,
		nil,
		windows.OPEN_EXISTING,
		windows.FILE_ATTRIBUTE_NORMAL,
		0,
	)
	if err != nil {
		// windows.ERROR_FILE_NOT_FOUND / ERROR_PATH_NOT_FOUND satisfy
		// os.IsNotExist through PathError, matching os.ReadFile semantics
		// that Read relies on for its missing-file contract.
		return nil, &os.PathError{Op: "open", Path: path, Err: err}
	}
	f := os.NewFile(uintptr(h), path)
	defer f.Close()
	return io.ReadAll(f)
}
