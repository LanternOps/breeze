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

// ValidateWindowsComponents applies validWindowsComponent to every component
// of a relative path, splitting on both separators Windows accepts. Empty
// components (doubled separators) are skipped, as the walk skips them. It is
// exported for restore consumers that write outside this package on Windows;
// strip the volume of an absolute path first (the volume is not a
// component). It applies the Windows rule on every platform — callers decide
// when it is relevant. It does not decide ".." traversal.
func ValidateWindowsComponents(path string) error {
	for _, component := range strings.FieldsFunc(path, func(r rune) bool { return r == '\\' || r == '/' }) {
		if err := validWindowsComponent(component); err != nil {
			return err
		}
	}
	return nil
}
