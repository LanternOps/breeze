package hyperv

import (
	"errors"
	"fmt"
	"strings"

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

// bcdbootFailure describes a failed bcdboot run for the instant boot result
// (#7494): the exit code when bcdboot ran, otherwise the start error, plus
// bcdboot's own output. The output is reported to the server and stored as
// jsonb, so NULs (UTF-16 console output) are dropped, line breaks folded, and
// the text bounded by truncateReported.
func bcdbootFailure(exe string, out []byte, err error) error {
	detail := strings.Join(strings.Fields(strings.ReplaceAll(string(out), "\x00", "")), " ")
	if detail != "" {
		detail = ": " + truncateReported(detail)
	}
	var exit interface{ ExitCode() int }
	if errors.As(err, &exit) && exit.ExitCode() > 0 {
		return fmt.Errorf("bcdboot (%s) exited with code %d%s", exe, exit.ExitCode(), detail)
	}
	return fmt.Errorf("bcdboot (%s): %w%s", exe, err, detail)
}
