package tools

import (
	"runtime"
	"strings"

	"github.com/breeze-rmm/agent/internal/wire"
)

// localPathFormError refuses a path that is not an absolute path, and the
// UNC and device-namespace forms. Every device file operation (file browser,
// scans, remediation) acts on a location an operator chose on the device, and
// none of them needs a UNC path, a device namespace, or a spelling that
// depends on the agent's working directory. Mapped drives and mounted
// network filesystems are reached through ordinary absolute paths and are not
// affected. The rules match the server's check
// (packages/shared/src/validators/devicePathFloor.ts) and, like it, accept
// both Unix and Windows absolute forms on every platform:
//
//   - a leading pair of separators (\\host\share, //host/share, \\?\..., \\.\...)
//     and the NT pass-through prefix (\??\) are refused;
//   - a drive letter must be followed by a separator (C:\Logs, not C:Logs);
//   - anything else must start with a separator.
func localPathFormError(p string) error {
	if p == "" {
		return errorCodef(wire.ErrCodeInvalidArgument, "path is required")
	}
	if strings.IndexByte(p, 0) >= 0 {
		return errorCodef(wire.ErrCodeInvalidArgument, "path contains a null byte")
	}
	norm := strings.ReplaceAll(p, `\`, "/")
	if strings.HasPrefix(norm, "//") || strings.HasPrefix(norm, "/??/") {
		return errorCodef(wire.ErrCodeInvalidArgument, "UNC and device namespace paths are not supported: %s", p)
	}
	if runtime.GOOS == "windows" && hasWindowsReservedDeviceName(norm) {
		return errorCodef(wire.ErrCodeInvalidArgument, "device names are not supported in a path: %s", p)
	}
	if len(norm) >= 2 && norm[1] == ':' && isASCIILetter(norm[0]) {
		if len(norm) == 2 || norm[2] != '/' {
			return errorCodef(wire.ErrCodeInvalidArgument, "use an absolute path (for example C:\\Logs or /var/log): %s", p)
		}
		return nil
	}
	if !strings.HasPrefix(norm, "/") {
		return errorCodef(wire.ErrCodeInvalidArgument, "use an absolute path (for example C:\\Logs or /var/log): %s", p)
	}
	return nil
}

func isASCIILetter(c byte) bool {
	return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z')
}

// hasWindowsReservedDeviceName reports whether any component of the
// forward-slashed path is a name Windows maps to a device whatever folder it
// is in (CON, NUL, COM1, LPT1, ...), with or without an extension, trailing
// dots or spaces, or a stream suffix.
func hasWindowsReservedDeviceName(norm string) bool {
	for _, c := range strings.Split(norm, "/") {
		if i := strings.IndexByte(c, ':'); i >= 0 && !(i == 1 && len(c) == 2) {
			c = c[:i]
		}
		if i := strings.IndexByte(c, '.'); i >= 0 {
			c = c[:i]
		}
		c = strings.ToUpper(strings.TrimRight(c, ". "))
		switch c {
		case "CON", "PRN", "AUX", "NUL", "CONIN$", "CONOUT$":
			return true
		}
		if len(c) == 4 && (strings.HasPrefix(c, "COM") || strings.HasPrefix(c, "LPT")) && c[3] >= '1' && c[3] <= '9' {
			return true
		}
	}
	return false
}
