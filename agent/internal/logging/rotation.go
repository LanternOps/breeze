package logging

import (
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sync"
)

// RotatingWriter is a size-based log file rotator.
// It implements io.Writer and is safe for concurrent use.
type RotatingWriter struct {
	mu         sync.Mutex
	file       *os.File
	filePath   string
	maxSize    int64 // bytes
	maxBackups int
	written    int64
}

// NewRotatingWriter creates a writer that rotates when maxSizeMB is exceeded.
// maxBackups controls how many old log files to keep.
func NewRotatingWriter(filePath string, maxSizeMB int, maxBackups int) (*RotatingWriter, error) {
	if maxSizeMB <= 0 {
		maxSizeMB = 50
	}
	if maxBackups <= 0 {
		maxBackups = 3
	}

	dir := filepath.Dir(filePath)
	if err := os.MkdirAll(dir, 0700); err != nil {
		return nil, fmt.Errorf("create log directory: %w", err)
	}

	rw := &RotatingWriter{
		filePath:   filePath,
		maxSize:    int64(maxSizeMB) * 1024 * 1024,
		maxBackups: maxBackups,
	}

	if err := rw.openFile(); err != nil {
		return nil, err
	}

	return rw, nil
}

// Write implements io.Writer. Rotates the file if maxSize is exceeded.
func (rw *RotatingWriter) Write(p []byte) (int, error) {
	rw.mu.Lock()
	defer rw.mu.Unlock()

	if rw.written+int64(len(p)) > rw.maxSize {
		if err := rw.rotate(); err != nil {
			return 0, fmt.Errorf("log rotation: %w", err)
		}
	}

	n, err := rw.file.Write(p)
	rw.written += int64(n)
	return n, err
}

// Reopen closes and reopens the log file (for SIGHUP handling).
func (rw *RotatingWriter) Reopen() error {
	rw.mu.Lock()
	defer rw.mu.Unlock()

	if rw.file != nil {
		rw.file.Close()
	}
	return rw.openFile()
}

// Close closes the underlying file.
func (rw *RotatingWriter) Close() error {
	rw.mu.Lock()
	defer rw.mu.Unlock()

	if rw.file != nil {
		return rw.file.Close()
	}
	return nil
}

// TeeWriter returns an io.Writer that writes to both w1 and w2.
func TeeWriter(w1, w2 io.Writer) io.Writer {
	return io.MultiWriter(w1, w2)
}

func (rw *RotatingWriter) openFile() error {
	f, err := os.OpenFile(rw.filePath, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0600)
	if err != nil {
		return fmt.Errorf("open log file: %w", err)
	}

	info, err := f.Stat()
	if err != nil {
		f.Close()
		return fmt.Errorf("stat log file: %w", err)
	}

	rw.file = f
	rw.written = info.Size()
	return nil
}

func (rw *RotatingWriter) rotate() error {
	if rw.file != nil {
		rw.file.Close()
	}

	// Shift existing backups: .3 → delete, .2 → .3, .1 → .2
	for i := rw.maxBackups; i >= 2; i-- {
		src := rw.backupName(i - 1)
		dst := rw.backupName(i)
		if i == rw.maxBackups {
			os.Remove(dst)
		}
		os.Rename(src, dst)
	}

	// Rename current log to .1
	os.Rename(rw.filePath, rw.backupName(1))

	return rw.openFile()
}

func (rw *RotatingWriter) backupName(index int) string {
	if index == 0 {
		return rw.filePath
	}
	return fmt.Sprintf("%s.%d", rw.filePath, index)
}
