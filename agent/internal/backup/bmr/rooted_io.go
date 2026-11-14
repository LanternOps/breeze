package bmr

import (
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
)

func readRootedFile(base, name string) ([]byte, error) {
	root, err := os.OpenRoot(base)
	if err != nil {
		return nil, err
	}
	defer func() { _ = root.Close() }()
	file, err := root.Open(name)
	if err != nil {
		return nil, err
	}
	defer func() { _ = file.Close() }()
	info, err := file.Stat()
	if err != nil {
		return nil, err
	}
	if !info.Mode().IsRegular() {
		return nil, fmt.Errorf("rooted input is not a regular file")
	}
	return io.ReadAll(file)
}

func statRootedFile(base, name string) (os.FileInfo, error) {
	root, err := os.OpenRoot(base)
	if err != nil {
		return nil, err
	}
	defer func() { _ = root.Close() }()
	return root.Stat(name)
}

func stagedFilePresent(base, name string) (bool, error) {
	info, err := statRootedFile(base, name)
	if errors.Is(err, fs.ErrNotExist) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	if !info.Mode().IsRegular() {
		return false, fmt.Errorf("staged input is not a regular file")
	}
	return true, nil
}
