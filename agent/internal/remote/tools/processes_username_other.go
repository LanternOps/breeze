//go:build !windows

package tools

import "github.com/shirou/gopsutil/v3/process"

func resolveUsername(p *process.Process) string {
	username, err := p.Username()
	if err != nil {
		return ""
	}
	return username
}
