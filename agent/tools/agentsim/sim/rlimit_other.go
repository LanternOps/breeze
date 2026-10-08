//go:build !linux && !darwin

package sim

func checkFileLimit(int) error { return nil }
