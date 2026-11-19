//go:build !windows

package wakeconfig

import (
	"fmt"
	"time"

	"github.com/shirou/gopsutil/v3/host"
)

// NewWriter returns nil off Windows: there is nothing to write.
func NewWriter() Writer { return nil }

// BootID identifies the current boot off Windows: the boot time to the minute.
// Nothing writes off Windows, so it only keeps the interface whole.
func BootID() (string, error) {
	s, err := host.BootTime()
	if err != nil {
		return "", err
	}
	if s == 0 {
		return "", fmt.Errorf("boot time unavailable")
	}
	return "boottime:" + time.Unix(int64(s), 0).UTC().Truncate(time.Minute).Format(time.RFC3339), nil
}
