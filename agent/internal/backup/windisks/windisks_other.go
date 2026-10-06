//go:build !windows

package windisks

// List is only implemented on Windows.
func List() ([]Disk, error) { return nil, ErrUnsupported }
