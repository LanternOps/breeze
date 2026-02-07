package privilege

// ElevatedCommandTypes returns the set of command types that require elevated
// (root / administrator) privileges for proper execution.
func ElevatedCommandTypes() map[string]bool {
	return map[string]bool{
		"reboot":          true,
		"shutdown":        true,
		"lock":            true,
		"start_service":   true,
		"stop_service":    true,
		"restart_service": true,
		"install_patches": true,
		"rollback_patches": true,
		"registry_set":    true,
		"registry_delete": true,
		"task_enable":     true,
		"task_disable":    true,
	}
}

// RequiresElevation returns true if the command type needs root/admin privileges.
func RequiresElevation(cmdType string) bool {
	return ElevatedCommandTypes()[cmdType]
}
