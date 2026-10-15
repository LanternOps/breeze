package pamlifetime

import "fmt"

func tokenInspectionFailure(pid uint32, err error) error {
	if err == nil {
		return nil
	}
	return fmt.Errorf("inspect process %d token while verifying PAM token absence: %w", pid, err)
}

// isKernelSystemIdentity recognizes only the fixed kernel System process on
// supported Windows releases. A user process called System, a different PID,
// or an unexpected parent must still have its token inspected. This exception
// is needed because OpenProcess rejects the kernel process even as LocalSystem.
func isKernelSystemIdentity(pid, parentPID uint32, imageName string) bool {
	return pid == 4 && parentPID == 0 && imageName == "System"
}
