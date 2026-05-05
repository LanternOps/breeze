//go:build !windows

package serviceinstall

func HardenProtectedBinaryACL(binaryPath string) error {
	return nil
}
