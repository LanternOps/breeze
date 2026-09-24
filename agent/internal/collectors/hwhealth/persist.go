package hwhealth

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"time"
)

type diskState struct {
	Sequence       uint64            `json:"sequence"`
	Next           Kind              `json:"next"`
	LastNone       time.Time         `json:"lastNone"`
	MDMembers      map[string]string `json:"mdMembers"`
	VendorTopology vendorTopology    `json:"vendorTopology,omitempty"`
	BMCLastRun     time.Time         `json:"bmcLastRun"`
}

const maxHardwareStateBytes = 4 * 1024 * 1024

func readJSON(path string, value any) error {
	f, e := os.Open(path)
	if errors.Is(e, os.ErrNotExist) {
		return nil
	}
	if e != nil {
		return e
	}
	// Read-only handle: every byte we use has already been read, so a Close
	// error cannot lose data. Closing before return also matters on Windows,
	// where loadState may rename this file right after a failed read.
	defer func() { _ = f.Close() }()
	b, e := io.ReadAll(io.LimitReader(f, maxHardwareStateBytes+1))
	if e != nil {
		return e
	}
	if len(b) > maxHardwareStateBytes {
		return fmt.Errorf("hardware state exceeds 4 MiB")
	}
	return json.Unmarshal(b, value)
}

func writeJSON(path string, value any) error {
	b, e := json.Marshal(value)
	if e != nil {
		return e
	}
	if len(b) > maxHardwareStateBytes {
		return fmt.Errorf("hardware state exceeds 4 MiB")
	}
	if e = os.MkdirAll(filepath.Dir(path), 0700); e != nil {
		return e
	}
	tmp := path + ".tmp"
	f, e := os.OpenFile(tmp, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0600)
	if e != nil {
		return e
	}
	// Best-effort cleanup of the temporary file on any failed step. After a
	// successful rename it no longer exists (ErrNotExist), and a leftover .tmp
	// is truncated by O_TRUNC on the next write, so the error is irrelevant.
	defer func() { _ = os.Remove(tmp) }()
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
		if e = os.Rename(tmp, path); e == nil {
			return nil
		}
	}
	return fmt.Errorf("replace hardware state after 4 attempts: %w", e)
}

// writeStateFile is a package-level seam over writeJSON for the hardware
// state file specifically, so tests can inject a transient write failure on
// just the first call (e.g. the BMC attempt-gate persist) while leaving a
// later call (e.g. the end-of-Run persist) to hit the real filesystem.
var writeStateFile = writeJSON

func reserveSequence(dir string, state *diskState) error {
	if state.Sequence == ^uint64(0) {
		return fmt.Errorf("hardware sequence exhausted")
	}
	next := *state
	next.Sequence++
	if e := writeStateFile(filepath.Join(dir, "hwhealth_state.json"), next); e != nil {
		return e
	}
	*state = next
	return nil
}
