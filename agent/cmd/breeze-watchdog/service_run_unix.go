//go:build !windows

package main

func isWindowsService() bool { return false }

func runAsWindowsService() error { return nil }
