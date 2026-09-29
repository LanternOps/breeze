package hyperv

import (
	"fmt"

	"github.com/breeze-rmm/agent/internal/backup/hosttool"
)

// bcdbootCommand is instant boot's boot-file step: the host's own
// bcdboot.exe, by absolute path from the host's System32
// (hosttool.SystemTool), copying the restored system's boot files from
// <letter>:\Windows. It is never a bare name resolved through PATH and never
// a binary from the restored volume, the same rule the rebuild engine
// follows for bcdboot. driveLetter is the single letter
// mountAndPartitionVHDX returned; anything else is refused.
func bcdbootCommand(driveLetter string) (exe string, args []string, err error) {
	if len(driveLetter) != 1 {
		return "", nil, fmt.Errorf("invalid drive letter %q", driveLetter)
	}
	if c := driveLetter[0] | 0x20; c < 'a' || c > 'z' {
		return "", nil, fmt.Errorf("invalid drive letter %q", driveLetter)
	}
	vol := driveLetter + ":"
	return hosttool.SystemTool("bcdboot.exe"), []string{vol + `\Windows`, "/s", vol, "/f", "UEFI"}, nil
}
