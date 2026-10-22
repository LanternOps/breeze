package yarac

import (
	"errors"
	"fmt"
	"os"
)

// ensureUsableStderr makes os.Stderr something the YARA-X guest can be
// instantiated with (#9253).
//
// yaraxwasm v1.1.0 builds every guest instance with
// wazero.NewModuleConfig().WithStderr(os.Stderr) (runtime_client.go:253, in
// the unexported guestProgram.newClient) and offers no option to pass a
// different writer. wazero Stats an *os.File stdio writer while instantiating
// the module, so when the process has no usable stderr the instantiation
// fails and every compile and scan reports engine_unavailable. That is the
// normal state of a Windows service: there is no console, the handle the Go
// runtime wraps as os.Stderr is invalid, and Stat fails with
// "GetFileType /dev/stderr: The handle is invalid."
//
// yaraxwasm reads the os.Stderr variable each time it creates a guest, so
// pointing it at the null device before the first engine use is enough. A
// usable stderr (a console, a test runner, a redirect set up by the process)
// is left untouched. The process's STD_ERROR_HANDLE is not changed.
//
// replaced reports whether os.Stderr was swapped and reason says why it was
// unusable; err is non-nil only when it was unusable and the null device
// could not be opened either — the engine cannot start in that case.
func ensureUsableStderr() (replaced bool, reason, err error) {
	reason = stderrProblem(os.Stderr)
	if reason == nil {
		return false, nil, nil
	}
	devNull, openErr := os.OpenFile(os.DevNull, os.O_WRONLY, 0)
	if openErr != nil {
		return false, reason, fmt.Errorf("stderr is unusable (%w) and %s could not be opened: %w", reason, os.DevNull, openErr)
	}
	// Never closed: it is the process's stderr from here on, read by every
	// later guest instantiation.
	os.Stderr = devNull
	return true, reason, nil
}

// stderrProblem returns why f cannot serve as the guest's stderr, or nil.
func stderrProblem(f *os.File) error {
	if f == nil {
		return errors.New("os.Stderr is nil")
	}
	if _, err := f.Stat(); err != nil {
		return err
	}
	return nil
}
