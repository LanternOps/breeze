//go:build !windows

package config

import (
	"runtime"
)

func configDir() string {
	if runtime.GOOS == "darwin" {
		return "/Library/Application Support/Breeze"
	}
	return "/etc/breeze"
}
