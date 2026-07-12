package workspaceindex

import (
	"io/fs"
	"os"
	"path/filepath"
	"strings"
)

type localFS struct {
	base string
}

// NewLocalFS returns a SourceFS rooted at base.
func NewLocalFS(base string) SourceFS {
	absBase, err := filepath.Abs(base)
	if err != nil {
		absBase = filepath.Clean(base)
	}
	return &localFS{base: absBase}
}

func (l *localFS) ReadDir(name string) ([]fs.DirEntry, error) {
	fullPath, err := l.resolve(name)
	if err != nil {
		return nil, &fs.PathError{Op: "readdir", Path: name, Err: err}
	}
	return os.ReadDir(fullPath)
}

func (l *localFS) Stat(name string) (fs.FileInfo, error) {
	fullPath, err := l.resolve(name)
	if err != nil {
		return nil, &fs.PathError{Op: "lstat", Path: name, Err: err}
	}
	return os.Lstat(fullPath)
}

func (l *localFS) resolve(name string) (string, error) {
	if filepath.IsAbs(name) || filepath.VolumeName(name) != "" {
		return "", fs.ErrInvalid
	}

	fullPath := filepath.Join(l.base, filepath.Clean(name))
	rel, err := filepath.Rel(l.base, fullPath)
	if err != nil || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) || filepath.IsAbs(rel) {
		return "", fs.ErrInvalid
	}
	return fullPath, nil
}
