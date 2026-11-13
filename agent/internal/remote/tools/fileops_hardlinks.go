package tools

import (
	"fmt"
	"os"
)

// otherHardLinksError fails when the open regular file f has more than one
// name. Hard links are not visible in a path, so the other names may sit in a
// location this path's checks never saw (another user's folder, a protected
// store). Operations that read a file on a user's behalf, or overwrite one in
// place, refuse such a file, the same rule diagnostic grants apply. A link
// count that cannot be read is treated as a refusal.
func otherHardLinksError(verb, displayPath string, f *os.File) error {
	info, err := f.Stat()
	if err != nil {
		return fmt.Errorf("%s refused: cannot stat %s: %w", verb, displayPath, err)
	}
	if !info.Mode().IsRegular() {
		return nil
	}
	n, err := linkCountOfFile(f, info)
	if err != nil {
		return fmt.Errorf("%s refused: cannot read the link count of %s: %w", verb, displayPath, err)
	}
	if n > 1 {
		return fmt.Errorf("%s refused: %s has %d hard links, and its other names cannot be checked", verb, displayPath, n)
	}
	return nil
}
