package desktop

import (
	"runtime"
	"strconv"
	"strings"
)

// Naming where a goroutine is stuck (#12624). A session loop that does not
// exit is usually inside a driver or COM call, so the only record of which one
// is its stack. These helpers run only when a stop has already timed out.

const (
	goroutineStageFrames  = 4
	goroutineDumpMaxBytes = 4 << 20
)

// currentGoroutineID returns the calling goroutine's id as it appears in
// stack dumps, or 0 if it cannot be read.
func currentGoroutineID() uint64 {
	var buf [64]byte
	header := string(buf[:runtime.Stack(buf[:], false)])
	fields := strings.Fields(header)
	if len(fields) < 2 {
		return 0
	}
	id, err := strconv.ParseUint(fields[1], 10, 64)
	if err != nil {
		return 0
	}
	return id
}

// allGoroutineStacks dumps every goroutine's stack. It stops the world for the
// duration, so it must not be used on a normal path.
func allGoroutineStacks() string {
	for size := 256 << 10; ; size *= 2 {
		buf := make([]byte, size)
		if n := runtime.Stack(buf, true); n < size || size >= goroutineDumpMaxBytes {
			return string(buf[:n])
		}
	}
}

// goroutineStage reduces goroutine id's block in dump to its state and the
// innermost few functions, innermost first, leaving out the Go runtime and
// syscall plumbing. Function names only: no arguments, pointers or paths.
// Returns "" when the goroutine is not in the dump.
func goroutineStage(dump string, id uint64) string {
	prefix := "goroutine " + strconv.FormatUint(id, 10) + " ["
	for _, block := range strings.Split(dump, "\n\n") {
		block = strings.TrimLeft(block, "\n")
		if !strings.HasPrefix(block, prefix) {
			continue
		}
		lines := strings.Split(block, "\n")
		state, _, _ := strings.Cut(strings.TrimPrefix(lines[0], prefix), "]")
		var frames []string
		for _, line := range lines[1:] {
			if strings.HasPrefix(line, "\t") || strings.HasPrefix(line, "created by ") {
				continue
			}
			name := stackFuncName(line)
			if name == "" || isGoPlumbing(name) {
				continue
			}
			frames = append(frames, name)
			if len(frames) == goroutineStageFrames {
				break
			}
		}
		if len(frames) == 0 {
			return state
		}
		return state + ": " + strings.Join(frames, " < ")
	}
	return ""
}

// stackFuncName turns a stack line such as
// "a/b/desktop.(*Session).captureLoop(0xc000...)" into
// "desktop.(*Session).captureLoop".
func stackFuncName(line string) string {
	// The argument list opens at the last "(" that is not a receiver's.
	// Arguments hold no parentheses, so that is the last one in the line.
	end := strings.LastIndex(line, "(")
	if end <= 0 {
		return ""
	}
	name := line[:end]
	return name[strings.LastIndex(name, "/")+1:]
}

func isGoPlumbing(name string) bool {
	return strings.HasPrefix(name, "runtime.") || strings.HasPrefix(name, "syscall.")
}
