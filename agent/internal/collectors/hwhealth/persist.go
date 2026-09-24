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
}

func readJSON(path string, value any) error {
	f, e := os.Open(path)
	if errors.Is(e, os.ErrNotExist) {
		return nil
	}
	if e != nil {
		return e
	}
	defer f.Close()
	b, e := io.ReadAll(io.LimitReader(f, 4*1024*1024+1))
	if e != nil {
		return e
	}
	if len(b) > 4*1024*1024 {
		return fmt.Errorf("hardware state exceeds 4 MB")
	}
	return json.Unmarshal(b, value)
}

func writeJSON(path string, value any) error {
	b, e := json.Marshal(value)
	if e != nil {
		return e
	}
	if e = os.MkdirAll(filepath.Dir(path), 0700); e != nil {
		return e
	}
	tmp := path + ".tmp"
	f, e := os.OpenFile(tmp, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0600)
	if e != nil {
		return e
	}
	defer os.Remove(tmp)
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

func reserveSequence(dir string, state *diskState) error {
	if state.Sequence == ^uint64(0) {
		return fmt.Errorf("hardware sequence exhausted")
	}
	next := *state
	next.Sequence++
	if e := writeJSON(filepath.Join(dir, "hwhealth_state.json"), next); e != nil {
		return e
	}
	*state = next
	return nil
}
