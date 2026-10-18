//go:build linux

package yarascan

import "golang.org/x/sys/unix"

const (
	ioprioClassIdle  = 3
	ioprioClassShift = 13
	ioprioWhoProcess = 1 // with a tid, targets that single thread
	scanNice         = 10
)

// EnterBackgroundThread lowers CPU (nice +10) and I/O (idle class) priority
// of the CURRENT OS thread only. The caller must have called
// runtime.LockOSThread and must never unlock it (DECISION W02-c).
func EnterBackgroundThread() {
	tid := unix.Gettid()
	if err := unix.Setpriority(unix.PRIO_PROCESS, tid, scanNice); err != nil {
		log.Warn("could not lower scan thread CPU priority", "error", err.Error())
	}
	if _, _, errno := unix.Syscall(unix.SYS_IOPRIO_SET, ioprioWhoProcess, uintptr(tid), uintptr(ioprioClassIdle<<ioprioClassShift)); errno != 0 {
		log.Warn("could not lower scan thread I/O priority", "error", errno.Error())
	}
}
