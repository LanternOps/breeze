//go:build !darwin

package updater

import "fmt"

// installViaPkg is only available on macOS.
func (u *Updater) installViaPkg(_ string) error {
	return fmt.Errorf("pkg install is only supported on macOS")
}
