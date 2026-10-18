//go:build !windows

package systemrestore

// nativeRestorePointAPI is a total no-op on non-Windows: no process spawn, no
// registry read, no filesystem access (#4609). Create never reaches it, since
// the environment's probe reports ErrUnsupported first.
func nativeRestorePointAPI() nativeAPI {
	return nativeAPI{
		begin: func(string) (int64, error) { return 0, ErrUnsupported },
		end:   func(int64) error { return ErrUnsupported },
	}
}
