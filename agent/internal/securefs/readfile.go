package securefs

import "os"

// OpenFile opens an existing regular file beneath base for reading with the
// same never-follow walk StatFile uses: a symbolic link or reparse point at
// any component, including the final one, is refused. The caller closes the
// returned file.
func OpenFile(base, relative string) (*os.File, error) {
	clean, err := CleanRelative(relative)
	if err != nil {
		return nil, err
	}
	return openFileRead(base, clean)
}
