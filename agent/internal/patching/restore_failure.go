package patching

import "fmt"

// restorePointCallFailed classifies one SRSetRestorePointW call from both of
// its outputs: the BOOL return and STATEMGRSTATUS.nStatus. The call can
// return TRUE with a nonzero nStatus, which the previous code (checking only
// the return value) counted as a success (#4752). The message distinguishes
// the two failure shapes.
func restorePointCallFailed(ret uintptr, nStatus uint32) (string, bool) {
	switch {
	case uint32(ret) == 0: // ret is a Win32 BOOL; only the low 32 bits are defined
		return fmt.Sprintf("SRSetRestorePointW returned FALSE (nStatus=%d)", nStatus), true
	case nStatus != 0:
		return fmt.Sprintf("SRSetRestorePointW reported nStatus=%d", nStatus), true
	default:
		return "", false
	}
}
