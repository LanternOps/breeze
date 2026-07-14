//go:build windows

package sessionbroker

import (
	"fmt"
	"sync"

	"golang.org/x/sys/windows"
)

const windowsProcessStillActive = 259

type windowsOwnedPeerProcess struct {
	pid    uint32
	mu     sync.Mutex
	handle windows.Handle
}

func openOwnedPeerProcess(pid uint32) (ownedPeerProcess, error) {
	handle, err := windows.OpenProcess(
		windows.PROCESS_QUERY_LIMITED_INFORMATION|windows.SYNCHRONIZE|windows.PROCESS_TERMINATE,
		false,
		pid,
	)
	if err != nil {
		return nil, fmt.Errorf("OpenProcess(%d): %w", pid, err)
	}
	return &windowsOwnedPeerProcess{pid: pid, handle: handle}, nil
}

func (p *windowsOwnedPeerProcess) ProcessID() uint32 { return p.pid }

func (p *windowsOwnedPeerProcess) Alive() (bool, error) {
	p.mu.Lock()
	handle := p.handle
	p.mu.Unlock()
	if handle == 0 {
		return false, nil
	}
	var code uint32
	if err := windows.GetExitCodeProcess(handle, &code); err != nil {
		return false, err
	}
	return code == windowsProcessStillActive, nil
}

func (p *windowsOwnedPeerProcess) Terminate() error {
	p.mu.Lock()
	handle := p.handle
	p.mu.Unlock()
	if handle == 0 {
		return nil
	}
	alive, err := p.Alive()
	if err != nil || !alive {
		return err
	}
	return windows.TerminateProcess(handle, 1)
}

func (p *windowsOwnedPeerProcess) Close() error {
	p.mu.Lock()
	handle := p.handle
	p.handle = 0
	p.mu.Unlock()
	if handle == 0 {
		return nil
	}
	return windows.CloseHandle(handle)
}
