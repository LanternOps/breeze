//go:build windows

package helper

import (
	"fmt"
	"path/filepath"
	"strings"

	"golang.org/x/sys/windows"
)

// stillActive is STILL_ACTIVE, what GetExitCodeProcess reports while the
// process runs. A process may also exit with 259 itself, so a 259 is confirmed
// with a zero-timeout wait before it is read as "running".
const stillActive = 259

type windowsExitProbe struct {
	h windows.Handle
}

// openExitProbe opens pid with just enough access to read its exit code and
// wait on it, then checks the image path on that same handle so a recycled PID
// is never probed in place of Assist.
func openExitProbe(pid int, binaryPath string) (exitProbe, error) {
	if pid <= 0 {
		return nil, fmt.Errorf("invalid pid %d", pid)
	}
	h, err := windows.OpenProcess(windows.PROCESS_QUERY_LIMITED_INFORMATION|windows.SYNCHRONIZE, false, uint32(pid))
	if err != nil {
		return nil, fmt.Errorf("OpenProcess(%d): %w", pid, err)
	}
	buf := make([]uint16, windows.MAX_PATH)
	size := uint32(len(buf))
	if err := windows.QueryFullProcessImageName(h, 0, &buf[0], &size); err != nil {
		_ = windows.CloseHandle(h)
		return nil, fmt.Errorf("QueryFullProcessImageName(%d): %w", pid, err)
	}
	if !strings.EqualFold(filepath.Clean(windows.UTF16ToString(buf[:size])), filepath.Clean(binaryPath)) {
		_ = windows.CloseHandle(h)
		return nil, fmt.Errorf("pid %d is not breeze assist", pid)
	}
	return &windowsExitProbe{h: h}, nil
}

func (p *windowsExitProbe) exitCode() (uint32, bool, error) {
	var code uint32
	if err := windows.GetExitCodeProcess(p.h, &code); err != nil {
		return 0, false, err
	}
	if code != stillActive {
		return code, true, nil
	}
	ev, err := windows.WaitForSingleObject(p.h, 0)
	if err != nil {
		return 0, false, err
	}
	return code, ev == windows.WAIT_OBJECT_0, nil
}

func (p *windowsExitProbe) close() {
	if p.h != 0 {
		_ = windows.CloseHandle(p.h)
		p.h = 0
	}
}
