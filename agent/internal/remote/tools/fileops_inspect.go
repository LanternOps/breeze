package tools

import (
	"errors"
	"io/fs"
	"os"
)

// Opening a path only to ask the kernel about it (its stored spelling, its
// final path) must never open a device node or a FIFO: opening a device can
// have effects of its own (a watchdog device, for one), and a FIFO can block.
// openForInspection therefore opens p only after Lstat shows a folder or a
// regular file, with a per-platform open that does not reach a device even
// if the path changes in between (O_PATH on Linux; on macOS no link at any
// component and no blocking), and confirms afterwards that the handle is the
// object that was checked.

// testHookInspectOpen, when set by a test, is called just before an
// inspection open.
var testHookInspectOpen func(path string)

var errNotInspectable = errors.New("not a folder or a regular file")

func inspectableInfo(info fs.FileInfo) bool {
	return info.IsDir() || info.Mode().IsRegular()
}

func openForInspection(p string) (*os.File, error) {
	info, err := os.Lstat(p)
	if err != nil {
		return nil, err
	}
	if !inspectableInfo(info) {
		return nil, errNotInspectable
	}
	if testHookInspectOpen != nil {
		testHookInspectOpen(p)
	}
	f, err := openInspectHandle(p, info.IsDir())
	if err != nil {
		return nil, err
	}
	st, err := f.Stat()
	if err != nil || !inspectableInfo(st) || !os.SameFile(info, st) || requireDiskHandle(f) != nil {
		_ = f.Close()
		return nil, errNotInspectable
	}
	return f, nil
}
