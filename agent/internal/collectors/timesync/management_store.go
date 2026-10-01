package timesync

import (
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"time"
)

const managementFile = "timesync-management.json"
const managementLimit = 1024 * 1024

func loadManagement(path string) (ManagementState, error) {
	s := ManagementState{Version: 1}
	f, e := os.Open(path)
	if os.IsNotExist(e) {
		return s, nil
	}
	if e != nil {
		return s, e
	}
	defer func() { _ = f.Close() }()
	b, e := io.ReadAll(io.LimitReader(f, managementLimit+1))
	if e != nil {
		return s, e
	}
	if len(b) > managementLimit {
		return s, fmt.Errorf("management state exceeds 1 MiB")
	}
	if e = json.Unmarshal(b, &s); e != nil {
		return ManagementState{Version: 1}, e
	}
	if s.Version != 1 {
		return ManagementState{Version: 1}, fmt.Errorf("unsupported management state version")
	}
	if s.Settings != nil {
		if e = ValidateSettings(*s.Settings); e != nil {
			return ManagementState{Version: 1}, e
		}
	}
	return s, nil
}
func saveManagement(path string, s ManagementState) error {
	b, e := json.Marshal(s)
	if e != nil {
		return e
	}
	if len(b) > managementLimit {
		return fmt.Errorf("management state exceeds 1 MiB")
	}
	if e = os.MkdirAll(filepath.Dir(path), 0700); e != nil {
		return e
	}
	f, e := os.CreateTemp(filepath.Dir(path), "timesync-management-*.tmp")
	if e != nil {
		return e
	}
	name := f.Name()
	defer func() { _ = os.Remove(name) }()
	if e = f.Chmod(0600); e != nil {
		_ = f.Close()
		return e
	}
	if _, e = f.Write(b); e != nil {
		_ = f.Close()
		return e
	}
	if e = f.Sync(); e != nil {
		_ = f.Close()
		return e
	}
	if e = f.Close(); e != nil {
		return e
	}
	for attempt := 0; attempt < 4; attempt++ {
		if attempt > 0 {
			time.Sleep(25 * time.Millisecond << uint(attempt-1))
		}
		if e = os.Rename(name, path); e == nil {
			return nil
		}
	}
	return fmt.Errorf("replace management state after 4 attempts: %w", e)
}
