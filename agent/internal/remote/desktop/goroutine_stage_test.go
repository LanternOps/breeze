package desktop

import (
	"runtime"
	"strings"
	"testing"
)

const stageDump = `goroutine 7 [running]:
main.other()
	/x/main.go:1 +0x1

goroutine 42 [syscall, 2 minutes]:
runtime.cgocall(0x1, 0x2)
	C:/go/src/runtime/cgocall.go:167 +0x3e
syscall.SyscallN(0x7ffabcd?, {0xc0001?, 0x1?, 0x2?})
	C:/go/src/runtime/syscall_windows.go:500 +0x46
github.com/breeze-rmm/agent/internal/remote/desktop.(*gpuConverter).Convert(0xc000123456)
	C:/b/gpu_convert_windows.go:280 +0x1c
github.com/breeze-rmm/agent/internal/remote/desktop.(*Session).captureAndSendFrameGPU(0xc0001, {0x1, 0x2}, 0x3)
	C:/b/session_capture.go:1100 +0x9
github.com/breeze-rmm/agent/internal/remote/desktop.(*Session).captureLoop(...)
	C:/b/session_capture.go:270
created by github.com/breeze-rmm/agent/internal/remote/desktop.(*Session).runLoop in goroutine 1
	C:/b/session_teardown.go:10 +0x5

goroutine 420 [running]:
main.prefixMustNotMatch()
	/x/main.go:1 +0x1
`

func TestGoroutineStageNamesTheBlockedCall(t *testing.T) {
	got := goroutineStage(stageDump, 42)
	want := "syscall, 2 minutes: desktop.(*gpuConverter).Convert < desktop.(*Session).captureAndSendFrameGPU < desktop.(*Session).captureLoop"
	if got != want {
		t.Errorf("stage = %q, want %q", got, want)
	}
	if got := goroutineStage(stageDump, 4); got != "" {
		t.Errorf("unknown goroutine matched: %q", got)
	}
}

func TestCurrentGoroutineIDMatchesDump(t *testing.T) {
	id := currentGoroutineID()
	buf := make([]byte, 1<<16)
	dump := string(buf[:runtime.Stack(buf, false)])
	if id == 0 || !strings.Contains(goroutineStage(dump, id), "TestCurrentGoroutineIDMatchesDump") {
		t.Errorf("id %d not found in own dump: %q", id, goroutineStage(dump, id))
	}
}
