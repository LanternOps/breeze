//go:build !windows

package sessionbroker

import "fmt"

// SpawnProcessInSession is only implemented on Windows.
func SpawnProcessInSession(_ string, _ uint32) error {
	return fmt.Errorf("SpawnProcessInSession not supported on this platform")
}
