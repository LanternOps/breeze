package eventlog

import (
	"sync"
	"testing"
)

func TestNoPanicOnAllPlatforms(t *testing.T) {
	// Calling any of these from a non-admin context on Windows, or
	// anywhere on macOS/Linux, must not panic. Registration errors
	// are silently swallowed per package contract.
	Info("BreezeAgent", "test info message")
	Warning("BreezeAgent", "test warning message")
	Error("BreezeAgent", "test error message")
}

func TestConcurrentLogging(t *testing.T) {
	// Verify concurrent calls from multiple goroutines don't panic
	// or race. On non-Windows this exercises the no-op stubs; on
	// Windows it exercises the sync.Mutex + per-source sync.Once
	// guarding lazy registration in lookupOrRegister.
	const numGoroutines = 50
	var wg sync.WaitGroup
	for i := 0; i < numGoroutines; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			Info("BreezeAgent", "concurrent info")
			Warning("BreezeAgent", "concurrent warning")
			Error("BreezeAgent", "concurrent error")
		}()
	}
	wg.Wait()
}
