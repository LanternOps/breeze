//go:build windows

package oemupdates

func hpSMBIOSIdentity() (string, string, error) { return readSMBIOSIdentity() }
