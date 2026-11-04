//go:build !windows

package journal

import "os"

// restrictFile makes the journal temp file owner-only (0600) regardless of
// the process umask, before any content is written.
func restrictFile(f *os.File, _ string) error {
	return f.Chmod(0o600)
}

// syncDir fsyncs the directory so the rename itself is durable.
func syncDir(dir string) error {
	d, err := os.Open(dir)
	if err != nil {
		return err
	}
	defer func() { _ = d.Close() }()
	return d.Sync()
}
