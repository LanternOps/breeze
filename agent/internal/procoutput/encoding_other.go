//go:build !windows

package procoutput

func decodeWindowsConsoleBytes(_ []byte) (string, bool) {
	return "", false
}
