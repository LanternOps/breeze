//go:build !windows

package providers

import "os"

// volumeIsRemote is decided by path spelling alone outside Windows; mounted
// network filesystems are subject to the store's ownership and access checks.
func volumeIsRemote(string) (bool, error) {
	return false, nil
}

// rootIsRemote: see volumeIsRemote.
func rootIsRemote(*os.Root) (bool, error) {
	return false, nil
}
