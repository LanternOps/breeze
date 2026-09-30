package securefs

import (
	"errors"
	"fmt"
	"strings"
)

// ErrInvalidWindowsName marks a path component Windows cannot store under the
// literal name it was given. Its text is the code restore results carry for a
// refused entry.
var ErrInvalidWindowsName = errors.New("invalid_windows_name")

// validWindowsComponent reports whether name can be created on Windows as
// exactly that name. It is pure and untagged so the rule is tested on every
// platform; only the Windows implementation calls it (on Linux and macOS
// "a:b" is an ordinary filename).
//
//   - ':' anywhere is refused: through the native, handle-relative create
//     this package uses, "file:name" addresses an alternate data stream of
//     "file" rather than a file of that name.
//   - a trailing '.' or ' ' is refused: Win32 name normalisation strips it, so
//     the entry would be reachable only under a different name than the one
//     recorded, and would alias its stripped twin for every other tool.
//
// "." and ".." are traversal markers, not names; the callers (CleanRelative,
// the verified-directory walk) decide those.
func validWindowsComponent(name string) error {
	switch name {
	case ".", "..":
		return nil
	case "":
		return fmt.Errorf("%w: empty path component", ErrInvalidWindowsName)
	}
	if strings.ContainsRune(name, ':') {
		return fmt.Errorf("%w: path component %q contains a stream separator (':')", ErrInvalidWindowsName, name)
	}
	if last := name[len(name)-1]; last == '.' || last == ' ' {
		return fmt.Errorf("%w: path component %q ends in a dot or space", ErrInvalidWindowsName, name)
	}
	return nil
}

// validRestoredWindowsComponent is validWindowsComponent plus the rule for a
// name taken from a backup manifest: it must not be a reserved device name.
// Short-name forms (PROGRA~1) are accepted: a recorded source path is often
// spelled that way by the backup's own configuration (a %TEMP%-derived
// profile path, say) and names the file that was backed up.
func validRestoredWindowsComponent(name string) error {
	if err := validWindowsComponent(name); err != nil {
		return err
	}
	if name == "." || name == ".." {
		return nil
	}
	if isWindowsDeviceName(name) {
		return fmt.Errorf("%w: path component %q names a device", ErrInvalidWindowsName, name)
	}
	return nil
}

// windowsDeviceNames are the names Win32 resolves to a device in every
// directory, with or without an extension.
var windowsDeviceNames = map[string]bool{
	"CON": true, "PRN": true, "AUX": true, "NUL": true, "CONIN$": true, "CONOUT$": true,
}

// isWindowsDeviceName reports whether name's base (the part before its first
// '.', trailing spaces removed) is a reserved device name, compared without
// regard to case: CON, PRN, AUX, NUL, COM1–COM9, LPT1–LPT9 (and their
// superscript-digit forms ¹ ² ³), CONIN$, CONOUT$.
func isWindowsDeviceName(name string) bool {
	base := name
	if i := strings.IndexByte(base, '.'); i >= 0 {
		base = base[:i]
	}
	base = strings.ToUpper(strings.TrimRight(base, " "))
	if windowsDeviceNames[base] {
		return true
	}
	for _, prefix := range []string{"COM", "LPT"} {
		rest, ok := strings.CutPrefix(base, prefix)
		if !ok {
			continue
		}
		switch rest {
		case "1", "2", "3", "4", "5", "6", "7", "8", "9", "\u00b9", "\u00b2", "\u00b3":
			return true
		}
	}
	return false
}

// ValidateWindowsComponents applies validRestoredWindowsComponent to every component
// of a relative path, splitting on both separators Windows accepts. Empty
// components (doubled separators) are skipped, as the walk skips them. It is
// exported for restore consumers that write outside this package on Windows;
// strip the volume of an absolute path first (the volume is not a
// component). It applies the Windows rule on every platform — callers decide
// when it is relevant. It does not decide ".." traversal.
func ValidateWindowsComponents(path string) error {
	for _, component := range strings.FieldsFunc(path, func(r rune) bool { return r == '\\' || r == '/' }) {
		if err := validRestoredWindowsComponent(component); err != nil {
			return err
		}
	}
	return nil
}
