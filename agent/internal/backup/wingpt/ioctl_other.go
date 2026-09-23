//go:build !windows

package wingpt

import "errors"

// errUnsupportedPlatform is returned by every live-IOCTL function on a
// non-Windows GOOS so the package still builds and links everywhere (the
// rebuild engine's platform table never calls these off Windows — see W06b
// Task 8's hostPlatform/platformPhases — but every OTHER package in this
// module (including this one) must still cross-compile cleanly for every
// GOOS the agent ships to).
var errUnsupportedPlatform = errors.New("wingpt: disk IOCTLs are only supported on windows")

func ReadLayout(diskNumber int) (Layout, error)        { return Layout{}, errUnsupportedPlatform }
func WriteLayout(diskNumber int, l Layout) error       { return errUnsupportedPlatform }
func CreateDisk(diskNumber int, diskGUID string) error { return errUnsupportedPlatform }
func DeleteLayout(diskNumber int) error                { return errUnsupportedPlatform }
func UpdateProperties(diskNumber int) error            { return errUnsupportedPlatform }
func SetPartitionAttributes(diskNumber, number int, attrs uint64) error {
	return errUnsupportedPlatform
}
