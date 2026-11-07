//go:build !windows

package security

func readWindowsProductType() uint8 { return winProductUnknown }
