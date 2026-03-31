//go:build darwin && !cgo

package userhelper

func clipboardSupported() bool {
	return false
}
