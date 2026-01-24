//go:build windows

package tools

import (
	"fmt"
	"syscall"
	"time"
	"unsafe"

	"golang.org/x/sys/windows"
)

var (
	modKernel32                  = windows.NewLazySystemDLL("kernel32.dll")
	modPsapi                     = windows.NewLazySystemDLL("psapi.dll")
	modAdvapi32                  = windows.NewLazySystemDLL("advapi32.dll")
	procCreateToolhelp32Snapshot = modKernel32.NewProc("CreateToolhelp32Snapshot")
	procProcess32First           = modKernel32.NewProc("Process32FirstW")
	procProcess32Next            = modKernel32.NewProc("Process32NextW")
	procGetProcessMemoryInfo     = modPsapi.NewProc("GetProcessMemoryInfo")
	procGetProcessTimes          = modKernel32.NewProc("GetProcessTimes")
	procOpenProcessToken         = modAdvapi32.NewProc("OpenProcessToken")
	procGetTokenInformation      = modAdvapi32.NewProc("GetTokenInformation")
	procLookupAccountSidW        = modAdvapi32.NewProc("LookupAccountSidW")
)

const (
	TH32CS_SNAPPROCESS = 0x00000002
	MAX_PATH           = 260
)

// PROCESSENTRY32W structure for Windows process enumeration
type processEntry32W struct {
	Size              uint32
	Usage             uint32
	ProcessID         uint32
	DefaultHeapID     uintptr
	ModuleID          uint32
	Threads           uint32
	ParentProcessID   uint32
	PriorityClassBase int32
	Flags             uint32
	ExeFile           [MAX_PATH]uint16
}

// PROCESS_MEMORY_COUNTERS structure
type processMemoryCounters struct {
	cb                         uint32
	PageFaultCount             uint32
	PeakWorkingSetSize         uintptr
	WorkingSetSize             uintptr
	QuotaPeakPagedPoolUsage    uintptr
	QuotaPagedPoolUsage        uintptr
	QuotaPeakNonPagedPoolUsage uintptr
	QuotaNonPagedPoolUsage     uintptr
	PagefileUsage              uintptr
	PeakPagefileUsage          uintptr
}

// ListProcesses returns all running processes on Windows
func (pm *ProcessManager) ListProcesses() ([]Process, error) {
	pm.mu.Lock()
	defer pm.mu.Unlock()

	// Create a snapshot of all processes
	handle, _, err := procCreateToolhelp32Snapshot.Call(TH32CS_SNAPPROCESS, 0)
	if handle == uintptr(syscall.InvalidHandle) {
		return nil, fmt.Errorf("failed to create process snapshot: %w", err)
	}
	defer windows.CloseHandle(windows.Handle(handle))

	var processes []Process

	var entry processEntry32W
	entry.Size = uint32(unsafe.Sizeof(entry))

	// Get first process
	ret, _, _ := procProcess32First.Call(handle, uintptr(unsafe.Pointer(&entry)))
	if ret == 0 {
		return nil, fmt.Errorf("no processes found")
	}

	for {
		proc := processFromEntry(&entry)
		
		// Enrich with additional details
		enrichWindowsProcess(&proc)
		
		processes = append(processes, proc)

		// Get next process
		entry.Size = uint32(unsafe.Sizeof(entry))
		ret, _, _ = procProcess32Next.Call(handle, uintptr(unsafe.Pointer(&entry)))
		if ret == 0 {
			break
		}
	}

	return processes, nil
}

// processFromEntry creates a Process from a Windows process entry
func processFromEntry(entry *processEntry32W) Process {
	name := windows.UTF16ToString(entry.ExeFile[:])
	
	return Process{
		PID:       int(entry.ProcessID),
		Name:      name,
		ParentPID: int(entry.ParentProcessID),
		Status:    "running", // Windows processes in snapshot are running
	}
}

// enrichWindowsProcess adds additional details to a Windows process
func enrichWindowsProcess(proc *Process) {
	// Open the process to get more information
	handle, err := windows.OpenProcess(
		windows.PROCESS_QUERY_LIMITED_INFORMATION|windows.PROCESS_VM_READ,
		false,
		uint32(proc.PID),
	)
	if err != nil {
		return
	}
	defer windows.CloseHandle(handle)

	// Get memory information
	var memCounters processMemoryCounters
	memCounters.cb = uint32(unsafe.Sizeof(memCounters))
	ret, _, _ := procGetProcessMemoryInfo.Call(
		uintptr(handle),
		uintptr(unsafe.Pointer(&memCounters)),
		uintptr(memCounters.cb),
	)
	if ret != 0 {
		proc.MemoryMB = float64(memCounters.WorkingSetSize) / (1024 * 1024)
	}

	// Get process times for CPU calculation and start time
	var creationTime, exitTime, kernelTime, userTime windows.Filetime
	ret, _, _ = procGetProcessTimes.Call(
		uintptr(handle),
		uintptr(unsafe.Pointer(&creationTime)),
		uintptr(unsafe.Pointer(&exitTime)),
		uintptr(unsafe.Pointer(&kernelTime)),
		uintptr(unsafe.Pointer(&userTime)),
	)
	if ret != 0 {
		proc.StartTime = filetimeToTime(creationTime).Format(time.RFC3339)
		proc.CPUPercent = calculateWindowsCPU(handle, kernelTime, userTime)
	}

	// Get process command line
	proc.CommandLine = getProcessCommandLine(handle)

	// Get process user
	proc.User = getProcessUser(handle)
}

// filetimeToTime converts Windows FILETIME to Go time.Time
func filetimeToTime(ft windows.Filetime) time.Time {
	nsec := int64(ft.HighDateTime)<<32 + int64(ft.LowDateTime)
	// Windows FILETIME epoch is January 1, 1601
	// Go time epoch is January 1, 1970
	// Difference is 116444736000000000 100-nanosecond intervals
	nsec -= 116444736000000000
	nsec *= 100
	return time.Unix(0, nsec)
}

// calculateWindowsCPU calculates CPU percentage for a Windows process
func calculateWindowsCPU(handle windows.Handle, kernelTime, userTime windows.Filetime) float64 {
	// Wait a short time and measure again
	time.Sleep(100 * time.Millisecond)

	var creationTime2, exitTime2, kernelTime2, userTime2 windows.Filetime
	ret, _, _ := procGetProcessTimes.Call(
		uintptr(handle),
		uintptr(unsafe.Pointer(&creationTime2)),
		uintptr(unsafe.Pointer(&exitTime2)),
		uintptr(unsafe.Pointer(&kernelTime2)),
		uintptr(unsafe.Pointer(&userTime2)),
	)
	if ret == 0 {
		return 0
	}

	kernel1 := int64(kernelTime.HighDateTime)<<32 + int64(kernelTime.LowDateTime)
	user1 := int64(userTime.HighDateTime)<<32 + int64(userTime.LowDateTime)
	kernel2 := int64(kernelTime2.HighDateTime)<<32 + int64(kernelTime2.LowDateTime)
	user2 := int64(userTime2.HighDateTime)<<32 + int64(userTime2.LowDateTime)

	cpuTime := float64((kernel2 - kernel1) + (user2 - user1))
	// Convert from 100-nanosecond intervals to percentage over elapsed time
	// 100ms = 1,000,000 100-nanosecond intervals
	return (cpuTime / 1000000) * 100
}

// getProcessCommandLine retrieves the command line for a process
func getProcessCommandLine(handle windows.Handle) string {
	// Try to query process image name as fallback
	var buf [windows.MAX_PATH]uint16
	size := uint32(len(buf))
	
	err := windows.QueryFullProcessImageName(handle, 0, &buf[0], &size)
	if err == nil {
		return windows.UTF16ToString(buf[:size])
	}

	return ""
}

// getProcessUser retrieves the username of the process owner
func getProcessUser(handle windows.Handle) string {
	var token windows.Token
	err := windows.OpenProcessToken(handle, windows.TOKEN_QUERY, &token)
	if err != nil {
		return ""
	}
	defer token.Close()

	// Get token user
	tokenUser, err := token.GetTokenUser()
	if err != nil {
		return ""
	}

	// Look up the account name
	var nameLen, domainLen uint32
	var sidUse uint32
	
	// First call to get buffer sizes
	procLookupAccountSidW.Call(
		0,
		uintptr(unsafe.Pointer(tokenUser.User.Sid)),
		0,
		uintptr(unsafe.Pointer(&nameLen)),
		0,
		uintptr(unsafe.Pointer(&domainLen)),
		uintptr(unsafe.Pointer(&sidUse)),
	)

	if nameLen == 0 {
		return ""
	}

	nameBuf := make([]uint16, nameLen)
	domainBuf := make([]uint16, domainLen)

	ret, _, _ := procLookupAccountSidW.Call(
		0,
		uintptr(unsafe.Pointer(tokenUser.User.Sid)),
		uintptr(unsafe.Pointer(&nameBuf[0])),
		uintptr(unsafe.Pointer(&nameLen)),
		uintptr(unsafe.Pointer(&domainBuf[0])),
		uintptr(unsafe.Pointer(&domainLen)),
		uintptr(unsafe.Pointer(&sidUse)),
	)

	if ret == 0 {
		return ""
	}

	domain := windows.UTF16ToString(domainBuf)
	name := windows.UTF16ToString(nameBuf)

	if domain != "" {
		return domain + "\\" + name
	}
	return name
}

// KillProcess terminates a process by PID on Windows
func (pm *ProcessManager) KillProcess(pid int) error {
	pm.mu.Lock()
	defer pm.mu.Unlock()

	if pid <= 0 {
		return fmt.Errorf("%w: invalid pid %d", ErrProcessNotFound, pid)
	}

	// Open the process with terminate permission
	handle, err := windows.OpenProcess(windows.PROCESS_TERMINATE, false, uint32(pid))
	if err != nil {
		if err == windows.ERROR_INVALID_PARAMETER {
			return ErrProcessNotFound
		}
		if err == windows.ERROR_ACCESS_DENIED {
			return ErrAccessDenied
		}
		return fmt.Errorf("%w: failed to open process: %v", ErrKillFailed, err)
	}
	defer windows.CloseHandle(handle)

	// Terminate the process
	err = windows.TerminateProcess(handle, 1)
	if err != nil {
		if err == windows.ERROR_ACCESS_DENIED {
			return ErrAccessDenied
		}
		return fmt.Errorf("%w: %v", ErrKillFailed, err)
	}

	return nil
}

// GetProcessDetails returns detailed information for a single process on Windows
func (pm *ProcessManager) GetProcessDetails(pid int) (*Process, error) {
	pm.mu.Lock()
	defer pm.mu.Unlock()

	if pid <= 0 {
		return nil, fmt.Errorf("%w: invalid pid %d", ErrProcessNotFound, pid)
	}

	// Create a snapshot to find the process
	handle, _, err := procCreateToolhelp32Snapshot.Call(TH32CS_SNAPPROCESS, 0)
	if handle == uintptr(syscall.InvalidHandle) {
		return nil, fmt.Errorf("failed to create process snapshot: %w", err)
	}
	defer windows.CloseHandle(windows.Handle(handle))

	var entry processEntry32W
	entry.Size = uint32(unsafe.Sizeof(entry))

	ret, _, _ := procProcess32First.Call(handle, uintptr(unsafe.Pointer(&entry)))
	if ret == 0 {
		return nil, ErrProcessNotFound
	}

	for {
		if int(entry.ProcessID) == pid {
			proc := processFromEntry(&entry)
			enrichWindowsProcess(&proc)
			return &proc, nil
		}

		entry.Size = uint32(unsafe.Sizeof(entry))
		ret, _, _ = procProcess32Next.Call(handle, uintptr(unsafe.Pointer(&entry)))
		if ret == 0 {
			break
		}
	}

	return nil, ErrProcessNotFound
}
