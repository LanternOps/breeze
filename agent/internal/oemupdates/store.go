package oemupdates

import (
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"time"

	"github.com/breeze-rmm/agent/internal/config"
	"github.com/breeze-rmm/agent/internal/securefs"
)

// Store is the agent-owned directory that holds the run marker, downloads and
// tool logs. Vendor tools run as SYSTEM and read what is here, so standard users
// must not be able to write it: the production Store is created private through
// securefs and never follows a link.
type Store interface {
	// Key identifies the directory, so two Stores on one directory share a lock.
	Key() string
	// ReadFile returns fs.ErrNotExist when name is absent.
	ReadFile(name string) ([]byte, error)
	// WriteFile replaces name atomically and durably.
	WriteFile(name string, data []byte) error
	// Remove deletes name; an absent file is not an error.
	Remove(name string) error
	// Dir returns the absolute path of a subdirectory, created private, for files
	// a vendor process reads or writes itself.
	Dir(name string) (string, error)
}

const (
	storeDirName     = "oemupdates"
	maxStoreFileSize = 1 << 20
)

// DefaultStore is the Store under the agent's data directory.
func DefaultStore() Store {
	return NewDirStore(filepath.Join(config.GetDataDir(), storeDirName))
}

// NewDirStore returns a Store rooted at dir, which must be absolute.
func NewDirStore(dir string) Store { return &dirStore{dir: dir} }

type dirStore struct{ dir string }

var errRelativeStore = errors.New("oemupdates: store directory must be absolute")

func (s *dirStore) Key() string { return s.dir }

func (s *dirStore) ReadFile(name string) ([]byte, error) {
	if !filepath.IsAbs(s.dir) {
		return nil, errRelativeStore
	}
	f, err := securefs.OpenFile(s.dir, name)
	if err != nil {
		return nil, err
	}
	defer func() { _ = f.Close() }()
	data, err := io.ReadAll(io.LimitReader(f, maxStoreFileSize+1))
	if err != nil {
		return nil, err
	}
	if len(data) > maxStoreFileSize {
		return nil, fmt.Errorf("%s is larger than %d bytes", name, maxStoreFileSize)
	}
	return data, nil
}

func (s *dirStore) WriteFile(name string, data []byte) error {
	if !filepath.IsAbs(s.dir) {
		return errRelativeStore
	}
	if err := securefs.EnsurePrivateDir(s.dir); err != nil {
		return err
	}
	tmp, err := os.CreateTemp(s.dir, "."+filepath.Base(name)+".tmp-*")
	if err != nil {
		return err
	}
	tmpPath := tmp.Name()
	defer func() { _ = os.Remove(tmpPath) }()
	_, err = tmp.Write(data)
	if err == nil {
		err = tmp.Sync()
	}
	if closeErr := tmp.Close(); err == nil {
		err = closeErr
	}
	if err != nil {
		return err
	}
	_, err = securefs.InstallFile(s.dir, name, tmpPath, 0o600, time.Now(), nil)
	return err
}

func (s *dirStore) Remove(name string) error {
	clean, err := securefs.CleanRelative(name)
	if err != nil {
		return err
	}
	err = os.Remove(filepath.Join(s.dir, clean))
	if errors.Is(err, fs.ErrNotExist) {
		return nil
	}
	return err
}

func (s *dirStore) Dir(name string) (string, error) {
	if !filepath.IsAbs(s.dir) {
		return "", errRelativeStore
	}
	clean, err := securefs.CleanRelative(name)
	if err != nil {
		return "", err
	}
	if err := securefs.EnsurePrivateDir(s.dir); err != nil {
		return "", err
	}
	path := filepath.Join(s.dir, clean)
	if err := securefs.EnsurePrivateDir(path); err != nil {
		return "", err
	}
	return path, nil
}
