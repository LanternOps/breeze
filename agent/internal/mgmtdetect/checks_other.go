//go:build !windows && !darwin

package mgmtdetect

func (d *checkDispatcher) checkRegistryValue(_ string) bool {
	return false
}

func (d *checkDispatcher) checkLaunchDaemon(_ string) bool {
	return false
}
