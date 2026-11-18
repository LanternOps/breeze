//go:build linux

package sessionbroker

import (
	"os"
	"strconv"
	"strings"
	"syscall"
)

// linuxDesktopPeerIdentity reads a process's start time (clock ticks since
// boot, /proc/<pid>/stat field 22) and owner uid. Together with the pid they
// identify one process: a reused pid has a different start time.
func linuxDesktopPeerIdentity(pid int) (startTime uint64, uid uint32, alive bool) {
	if pid <= 0 {
		return 0, 0, false
	}
	dir := "/proc/" + strconv.Itoa(pid)
	fi, err := os.Stat(dir)
	if err != nil {
		return 0, 0, false
	}
	st, ok := fi.Sys().(*syscall.Stat_t)
	if !ok {
		return 0, 0, false
	}
	raw, err := os.ReadFile(dir + "/stat")
	if err != nil {
		return 0, 0, false
	}
	start, ok := parseProcStatStartTime(string(raw))
	if !ok {
		return 0, 0, false
	}
	return start, st.Uid, true
}

// parseProcStatStartTime returns field 22 of /proc/<pid>/stat. The comm
// field (2) may contain spaces and parentheses, so fields are counted from
// the last ')'.
func parseProcStatStartTime(stat string) (uint64, bool) {
	i := strings.LastIndexByte(stat, ')')
	if i < 0 {
		return 0, false
	}
	fields := strings.Fields(stat[i+1:])
	// fields[0] is field 3 (state); field 22 is fields[19].
	if len(fields) < 20 {
		return 0, false
	}
	v, err := strconv.ParseUint(fields[19], 10, 64)
	if err != nil || v == 0 {
		return 0, false
	}
	return v, true
}

// killLinuxDesktopPeer sends SIGKILL to a helper that outlived its stop,
// after the caller re-checked its identity. uid 0 is never signalled.
func killLinuxDesktopPeer(pid int, uid uint32, _ uint64) {
	if pid <= 1 || uid == 0 {
		return
	}
	if err := syscall.Kill(pid, syscall.SIGKILL); err != nil && err != syscall.ESRCH {
		log.Warn("could not kill Linux desktop helper", "pid", pid, "error", err.Error())
	}
}
