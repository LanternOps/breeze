package pamlifetime

import "fmt"

func tokenInspectionFailure(pid uint32, err error) error {
	if err == nil {
		return nil
	}
	return fmt.Errorf("inspect process %d token while verifying PAM token absence: %w", pid, err)
}
