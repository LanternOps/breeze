//go:build !windows

package oemupdates

import (
	"errors"
	"os"
	"time"
)

type systemInfo struct{}

func (systemInfo) BiosVersion() (string, error) {
	return "", errors.New("bios version is only read on windows")
}

func (systemInfo) BootTime() (time.Time, error) {
	return time.Time{}, errors.New("boot time is only read on windows")
}

func exitCodeOf(ps *os.ProcessState) int64 { return int64(ps.ExitCode()) }
