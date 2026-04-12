//go:build windows

package terminal

import (
	"fmt"
	"unsafe"

	"golang.org/x/sys/windows"
)

var (
	kernel32DLL             = windows.NewLazySystemDLL("kernel32.dll")
	procCreatePseudoConsole = kernel32DLL.NewProc("CreatePseudoConsole")
	procResizePseudoConsole = kernel32DLL.NewProc("ResizePseudoConsole")
	procClosePseudoConsole  = kernel32DLL.NewProc("ClosePseudoConsole")
)

const (
	_PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE = 0x00020016
	_EXTENDED_STARTUPINFO_PRESENT        = 0x00080000
)

// conptyAvailable returns true if the ConPTY API is present (Windows 10 1809+).
func conptyAvailable() bool {
	return procCreatePseudoConsole.Find() == nil
}

// packCoord packs columns (X) and rows (Y) into a single uintptr matching
// the COORD struct layout: low 16 bits = X, high 16 bits = Y.
func packCoord(cols, rows uint16) uintptr {
	return uintptr(uint32(cols) | (uint32(rows) << 16))
}

// createConPTY creates a Windows pseudo console of the given size.
// hInput is the read-end of the input pipe; hOutput is the write-end of the
// output pipe. Returns the HPCON handle.
func createConPTY(cols, rows uint16, hInput, hOutput windows.Handle) (uintptr, error) {
	var hPC uintptr
	r, _, _ := procCreatePseudoConsole.Call(
		packCoord(cols, rows),
		uintptr(hInput),
		uintptr(hOutput),
		0,
		uintptr(unsafe.Pointer(&hPC)),
	)
	if int32(r) < 0 { // HRESULT: negative = failure
		return 0, fmt.Errorf("CreatePseudoConsole failed: hr=0x%08x", uint32(r))
	}
	return hPC, nil
}

// resizeConPTY resizes an existing pseudo console.
func resizeConPTY(hPC uintptr, cols, rows uint16) error {
	r, _, _ := procResizePseudoConsole.Call(hPC, packCoord(cols, rows))
	if int32(r) < 0 {
		return fmt.Errorf("ResizePseudoConsole failed: hr=0x%08x", uint32(r))
	}
	return nil
}

// closeConPTY closes the pseudo console handle.
func closeConPTY(hPC uintptr) {
	procClosePseudoConsole.Call(hPC)
}

// startProcessWithConPTY creates a child process attached to the given ConPTY.
// Returns the process handle, thread handle, and process ID.
func startProcessWithConPTY(hPC uintptr, commandLine string) (windows.Handle, windows.Handle, uint32, error) {
	// Allocate and initialize a proc thread attribute list with 1 entry.
	attrContainer, err := windows.NewProcThreadAttributeList(1)
	if err != nil {
		return 0, 0, 0, fmt.Errorf("NewProcThreadAttributeList: %w", err)
	}
	defer attrContainer.Delete()

	// Associate the pseudo console with the attribute list.
	if err := attrContainer.Update(
		_PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE,
		unsafe.Pointer(hPC),
		unsafe.Sizeof(hPC),
	); err != nil {
		return 0, 0, 0, fmt.Errorf("UpdateProcThreadAttribute: %w", err)
	}

	// Build STARTUPINFOEXW.
	si := windows.StartupInfoEx{
		ProcThreadAttributeList: attrContainer.List(),
	}
	si.Cb = uint32(unsafe.Sizeof(si))

	cmdLine, err := windows.UTF16PtrFromString(commandLine)
	if err != nil {
		return 0, 0, 0, err
	}

	var pi windows.ProcessInformation
	if err := windows.CreateProcess(
		nil,
		cmdLine,
		nil, nil,
		false,
		_EXTENDED_STARTUPINFO_PRESENT,
		nil, nil,
		&si.StartupInfo,
		&pi,
	); err != nil {
		return 0, 0, 0, fmt.Errorf("CreateProcess: %w", err)
	}

	return pi.Process, pi.Thread, pi.ProcessId, nil
}
