//go:build !darwin

package heartbeat

// ensureDarwinHelperIPCGroupMembership is a no-op off macOS. Linux adds logged-in
// users to the breeze group in scripts/install/install-linux.sh; Windows helpers
// use a named pipe with its own SDDL rather than a filesystem group.
func ensureDarwinHelperIPCGroupMembership() {}
