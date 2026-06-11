package sessionbroker

import "fmt"

// buildUserHelperCmdLine constructs the command line passed to
// CreateProcessAsUser when the broker spawns a user-helper child. The role
// flag is always set explicitly so the child never inherits the cobra default
// — that default has been flipped twice (PR #549) and the SYSTEM-context
// helper crash-looped both times.
func buildUserHelperCmdLine(exePath, role string) string {
	return fmt.Sprintf(`"%s" user-helper --role %s`, exePath, role)
}
