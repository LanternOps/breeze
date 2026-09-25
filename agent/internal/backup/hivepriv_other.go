//go:build !windows

package backup

// AcquireHivePrivileges has no token to adjust off Windows; its release is
// a no-op (see hivepriv_windows.go).
func AcquireHivePrivileges() (release func(), err error) {
	return func() {}, nil
}
